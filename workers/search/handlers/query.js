/**
 * @fileoverview Search query handler with SWR caching.
 *
 * Handles two request shapes:
 *
 *   Single-entity (flat response):
 *     GET /search?q=...&entity=net&mode=...
 *     → {data: [{id, name, entity_type, score}], meta: {count, mode}}
 *
 *   Multi-entity (grouped response):
 *     GET /search?q=...&entities=net,ix,fac&mode=...
 *     → {data: {net: [...], ix: [...], fac: [...]}, meta: {mode, counts: {net: N, ...}}}
 *
 * Multi-entity runs one D1 LIKE query per requested entity type in parallel
 * inside a single queryFn closure, so the full grouped result is one SWR
 * cache entry — not N separate entries. The frontend's typeahead and search
 * page both use the multi-entity path to reduce round-trips.
 *
 * Query parameters are parsed from the raw query string using tokenizeString()
 * (§1: no new URL(); §2: no regex on hot path). The deterministic cache key
 * is derived via buildSearchKey() which SHA-256 hashes normalised parameters
 * and scopes by auth tier.
 */

import { tokenizeString } from '../../core/utils.js';
import { encoder, jsonError, serveSearch } from '../http.js';
import { buildSearchKey, withSearchSWR, SEARCH_EMPTY_SENTINEL, SEARCH_MULTI_EMPTY_SENTINEL } from '../cache.js';
import { SEARCH_ENTITY_TAGS, getPrimaryField } from '../entities.js';
import { isSemanticEnabled, resolveSemanticIds } from './semantic.js';
import { handleKeyword } from './keyword.js';

/** Default and maximum result limits. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Parses and validates search query parameters from a raw query string.
 *
 * Accepts either:
 *   - `entity=net` (singular) → single-entity mode, flat response
 *   - `entities=net,ix,fac` (plural, CSV) → multi-entity mode, grouped response
 *
 * When both are present, `entities` takes precedence.
 *
 * Uses tokenizeString with delimiter='&' (unlimited splits) for the outer
 * key-value pairs, then tokenizeString with delimiter='=' and maxParts=2
 * for each individual pair. §1: no new URL(). §2: no regex.
 *
 * @param {string} queryString - Raw query string (without leading '?').
 * @returns {{
 *   q: string,
 *   entityList: string[],
 *   isMulti: boolean,
 *   mode: string,
 *   limit: number,
 *   skip: number,
 *   error: string|null
 * }} Parsed parameters or error message.
 */
function parseSearchParams(queryString) {
    let q = '';
    let entitySingular = '';
    let entitiesRaw = '';
    let mode = 'auto';
    let limit = DEFAULT_LIMIT;
    let skip = 0;

    // Outer split on '&' — unlimited parts. Iterate values with for-of.
    const pairs = tokenizeString(queryString, '&', -1);
    for (const pair of Object.values(pairs)) {
        // Inner split on '=' — at most 2 parts so values containing '=' are preserved.
        const kv = tokenizeString(pair, '=', 2);
        const k = kv.p0;
        const v = kv.p1 === undefined ? '' : decodeURIComponent(kv.p1.replaceAll('+', ' '));
        if (k === 'q')           q = v;
        else if (k === 'entity')   entitySingular = v;
        else if (k === 'entities') entitiesRaw = v;
        else if (k === 'mode')     mode = v;
        else if (k === 'limit')  { const n = Number.parseInt(v, 10); if (!Number.isNaN(n)) limit = n; }
        else if (k === 'skip')   { const n = Number.parseInt(v, 10); if (!Number.isNaN(n)) skip = n; }
    }

    if (!q) return { q, entityList: [], isMulti: false, mode, limit, skip, error: 'Missing required parameter: q' };

    // Resolve entity list: `entities` (plural CSV) takes precedence over `entity` (singular).
    const isMulti = entitiesRaw !== '';
    /** @type {string[]} */
    let entityList;

    if (isMulti) {
        // Parse and validate the CSV list. §2: no regex — split on comma using tokenizeString.
        const parts = tokenizeString(entitiesRaw, ',', -1);
        entityList = [];
        for (const tag of Object.values(parts)) {
            const t = tag.trim();
            if (!SEARCH_ENTITY_TAGS.has(t)) {
                return { q, entityList: [], isMulti, mode, limit, skip, error: `Unknown entity type: ${t}` };
            }
            entityList.push(t);
        }
        if (entityList.length === 0) {
            return { q, entityList: [], isMulti, mode, limit, skip, error: 'Missing required parameter: entities' };
        }
    } else {
        if (!entitySingular) {
            return { q, entityList: [], isMulti, mode, limit, skip, error: 'Missing required parameter: entity or entities' };
        }
        if (!SEARCH_ENTITY_TAGS.has(entitySingular)) {
            return { q, entityList: [], isMulti, mode, limit, skip, error: `Unknown entity type: ${entitySingular}` };
        }
        entityList = [entitySingular];
    }

    if (mode !== 'keyword' && mode !== 'semantic' && mode !== 'auto') {
        return { q, entityList, isMulti, mode, limit, skip, error: `Invalid mode: ${mode}` };
    }
    if (limit < 1 || limit > MAX_LIMIT) limit = DEFAULT_LIMIT;
    if (skip < 0) skip = 0;

    return { q, entityList, isMulti, mode, limit, skip, error: null };
}

/**
 * Builds a D1 query that hydrates entities by ID list while preserving
 * vector-distance ranking via a SQL CASE expression.
 *
 * The id list comes from resolveSemanticIds() as a comma-separated string
 * (e.g. "694,12,387"). The CASE expression assigns each id its ordinal
 * position in the list so ORDER BY relevance_rank ASC matches vector rank.
 *
 * @param {D1Database} db - D1 database session.
 * @param {string} entityTag - Entity type (e.g. "net").
 * @param {string} idList - Comma-separated entity IDs in rank order.
 * @param {number} limit - Maximum rows to return.
 * @returns {Promise<{id: number, name: string, entity_type: string, score: number}[]>}
 *   Hydrated result rows (empty array if no matches).
 */
async function hydrateSemanticIds(db, entityTag, idList, limit) {
    const table = `peeringdb_${entityTag}`;
    const primaryField = getPrimaryField(entityTag);

    // Build CASE expression for relevance sort. §3: index-based for loop (i needed for THEN value).
    const ids = idList.split(',');
    let caseExpr = 'CASE id';
    for (let i = 0; i < ids.length; i++) {
        caseExpr += ` WHEN ${ids[i]} THEN ${i}`;
    }
    caseExpr += ' ELSE 999 END';

    const sql =
        `SELECT id, ${primaryField} AS name, status FROM ${table}` +
        ` WHERE id IN (${idList}) AND status != 'deleted'` +
        ` ORDER BY ${caseExpr} ASC LIMIT ?`;

    const result = await db.prepare(sql).bind(limit).all();
    if (!result.success || result.results.length === 0) return [];

    const rows = result.results;
    /** @type {{id: number, name: string, entity_type: string, score: number}[]} */
    const data = [];
    for (let i = 0; i < rows.length; i++) {
        const score = 1 - i / rows.length;
        data.push({
            id: /** @type {number} */ (rows[i].id),
            name: /** @type {string} */ (rows[i].name) || '',
            entity_type: entityTag,
            score: Math.round(score * 100) / 100,
        });
    }
    return data;
}

/**
 * Runs a keyword or semantic search for a single entity type.
 *
 * Returns a flat result array. Used by both the single-entity path
 * (where the array is encoded directly) and the multi-entity path
 * (where results from all entity types are collected and grouped).
 *
 * Returning an empty array rather than null so multi-entity callers
 * can assemble the grouped object without null checks per entry.
 *
 * @param {D1Database} db - D1 session.
 * @param {any|null} ai - Workers AI binding, or null.
 * @param {any|null} vectorize - Vectorize binding, or null.
 * @param {string} entityTag - Entity type to search.
 * @param {string} q - Search query string.
 * @param {string} effectiveMode - 'keyword' or 'semantic'.
 * @param {number} limit - Result limit.
 * @param {number} skip - Pagination offset (keyword only).
 * @returns {Promise<{id: number, name: string, entity_type: string, score: number}[]>}
 */
async function runEntitySearch(db, ai, vectorize, entityTag, q, effectiveMode, limit, skip) {
    if (effectiveMode === 'semantic') {
        const idList = await resolveSemanticIds(entityTag, 'name', q, limit);
        if (!idList) return [];
        return hydrateSemanticIds(db, entityTag, idList, limit);
    }
    // Keyword: decode the Uint8Array from handleKeyword back to an object array.
    const buf = await handleKeyword(db, entityTag, q, limit, skip);
    if (!buf) return [];
    const parsed = JSON.parse(new TextDecoder().decode(buf));
    return parsed.data || [];
}

/**
 * Handles a search request with SWR caching.
 *
 * Dispatches to single-entity or multi-entity path depending on whether
 * `entity` (singular) or `entities` (plural CSV) was provided.
 *
 * Single-entity response shape:
 *   {data: [{id, name, entity_type, score}], meta: {count, mode}}
 *
 * Multi-entity response shape:
 *   {data: {net: [...], ix: [...]}, meta: {mode, counts: {net: N, ix: N, ...}}}
 *
 * Flow:
 *   1. Parse and validate query parameters (tokenizeString, §1, §2).
 *   2. Resolve effective mode (auto → semantic if enabled, else keyword).
 *   3. Build SHA-256 cache key (sorted entity list for canonicality).
 *   4. withSearchSWR → L1 → coalesce → L2 → queryFn (§9: D1 inside closure).
 *   5. Return serialised response with cache tier headers.
 *
 * @param {Request} request - Inbound HTTP request.
 * @param {string} queryString - Raw query string from parseURL().
 * @param {D1Database} db - D1 session (withSession already applied).
 * @param {any|null} ai - Workers AI binding, or null if absent.
 * @param {any|null} vectorize - Vectorize binding, or null if absent.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @returns {Promise<Response>} Search results or error response.
 */
export async function handleSearch(request, queryString, db, ai, vectorize, ctx, authenticated) {
    const { q, entityList, isMulti, mode, limit, skip, error } = parseSearchParams(queryString);
    if (error) return jsonError(400, error);

    // Resolve effective mode.
    const semanticAvailable = isSemanticEnabled();
    let effectiveMode = mode;
    if (mode === 'auto') effectiveMode = semanticAvailable ? 'semantic' : 'keyword';
    if (mode === 'semantic' && !semanticAvailable) {
        return jsonError(503, 'Semantic search is not available on this deployment.');
    }

    // Cache key: buildSearchKey sorts entityList internally for canonical ordering.
    const cacheKey = await buildSearchKey(q, entityList, effectiveMode, limit, skip, authenticated);

    const { buf, tier, hits } = await withSearchSWR(cacheKey, ctx, async () => {
        // §9: all D1 and AI calls inside this queryFn closure.

        if (isMulti) {
            // Fan out one search per entity type in parallel. §3: for-of to build promise array.
            const promises = [];
            for (const tag of entityList) {
                promises.push(runEntitySearch(db, ai, vectorize, tag, q, effectiveMode, limit, skip));
            }
            const rowSets = await Promise.all(promises);

            // Assemble grouped result. §3: for loop with index.
            /** @type {Record<string, {id: number, name: string, entity_type: string, score: number}[]>} */
            const data = {};
            /** @type {Record<string, number>} */
            const counts = {};
            let totalCount = 0;
            for (let i = 0; i < entityList.length; i++) {
                data[entityList[i]] = rowSets[i];
                counts[entityList[i]] = rowSets[i].length;
                totalCount += rowSets[i].length;
            }

            // Return null (→ negative cache) if every entity returned empty.
            if (totalCount === 0) return null;

            // §4: single serialisation at exit.
            return encoder.encode(JSON.stringify({ data, meta: { mode: effectiveMode, counts } }));
        }

        // Single-entity path.
        const [entityTag] = entityList;
        if (effectiveMode === 'semantic') {
            const idList = await resolveSemanticIds(entityTag, 'name', q, limit);
            if (!idList) return null;
            return hydrateSemanticIds(db, entityTag, idList, limit).then(rows =>
                rows.length === 0 ? null : encoder.encode(JSON.stringify({
                    data: rows,
                    meta: { count: rows.length, mode: 'semantic' },
                }))
            );
        }
        return handleKeyword(db, entityTag, q, limit, skip);
    });

    if (!buf) {
        return serveSearch(isMulti ? SEARCH_MULTI_EMPTY_SENTINEL : SEARCH_EMPTY_SENTINEL, 'MISS', 0);
    }

    return serveSearch(buf, tier, hits);
}
