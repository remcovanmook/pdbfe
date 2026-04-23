/**
 * @fileoverview Search query handler with SWR caching.
 *
 * Dispatches incoming search requests to the keyword or semantic backend,
 * wrapping the result in the L1 → SWR → L2 cache pipeline.
 *
 * Query parameters are parsed from the raw query string using tokenizeString()
 * (§1: no new URL(); §2: no regex on hot path). The deterministic cache key
 * is derived via buildSearchKey() which SHA-256 hashes normalised parameters
 * and scopes by auth tier.
 *
 * For semantic mode: resolveSemanticIds() returns a ranked ID list which is
 * hydrated from D1 inside the queryFn closure (§9: no raw D1 outside pipeline).
 * The CASE-based relevance sort preserves vector-distance ranking through SQL.
 *
 * For keyword mode: handleKeyword() executes a LIKE query across primary
 * display fields (§3: for loops, no .map()).
 */

import { tokenizeString } from '../../core/utils.js';
import { encoder, jsonError, serveSearch } from '../http.js';
import { buildSearchKey, withSearchSWR, SEARCH_EMPTY_SENTINEL } from '../cache.js';
import { SEARCH_ENTITY_TAGS, getPrimaryField } from '../entities.js';
import { isSemanticEnabled, resolveSemanticIds } from './semantic.js';
import { handleKeyword } from './keyword.js';

/** Default and maximum result limits. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Parses and validates search query parameters from a raw query string.
 *
 * Uses tokenizeString with delimiter='&' (unlimited splits) for the outer
 * key-value pairs, then tokenizeString with delimiter='=' and maxParts=2
 * for each individual pair. §1: no new URL(). §2: no regex.
 *
 * @param {string} queryString - Raw query string (without leading '?').
 * @returns {{
 *   q: string,
 *   entity: string,
 *   mode: string,
 *   limit: number,
 *   skip: number,
 *   error: string|null
 * }} Parsed parameters or error message.
 */
function parseSearchParams(queryString) {
    let q = '';
    let entity = '';
    let mode = 'auto';
    let limit = DEFAULT_LIMIT;
    let skip = 0;

    // Outer split on '&' — unlimited parts. Iterate values with for-of.
    const pairs = tokenizeString(queryString, '&', -1);
    for (const pair of Object.values(pairs)) {
        // Inner split on '=' — at most 2 parts so values containing '=' are preserved.
        const kv = tokenizeString(pair, '=', 2);
        const k = kv.p0;
        const v = kv.p1 !== undefined ? decodeURIComponent(kv.p1.replace(/\+/g, ' ')) : '';
        if (k === 'q')      q = v;
        else if (k === 'entity') entity = v;
        else if (k === 'mode')   mode = v;
        else if (k === 'limit')  { const n = parseInt(v, 10); if (!isNaN(n)) limit = n; }
        else if (k === 'skip')   { const n = parseInt(v, 10); if (!isNaN(n)) skip = n; }
    }

    if (!q)                                return { q, entity, mode, limit, skip, error: 'Missing required parameter: q' };
    if (!entity)                           return { q, entity, mode, limit, skip, error: 'Missing required parameter: entity' };
    if (!SEARCH_ENTITY_TAGS.has(entity))   return { q, entity, mode, limit, skip, error: `Unknown entity type: ${entity}` };
    if (mode !== 'keyword' && mode !== 'semantic' && mode !== 'auto')
                                           return { q, entity, mode, limit, skip, error: `Invalid mode: ${mode}` };
    if (limit < 1 || limit > MAX_LIMIT)    limit = DEFAULT_LIMIT;
    if (skip < 0)                          skip = 0;

    return { q, entity, mode, limit, skip, error: null };
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
 * @returns {Promise<Uint8Array|null>} Serialised search envelope, or null if empty.
 */
async function hydrateSemanticIds(db, entityTag, idList, limit) {
    const table = `peeringdb_${entityTag}`;
    const primaryField = getPrimaryField(entityTag);

    // Build CASE expression for relevance sort. §3: for loop over id array.
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
    if (!result.success || result.results.length === 0) return null;

    const rows = result.results;
    /** @type {{id: number, name: string, entity_type: string, score: number}[]} */
    const data = [];
    for (let i = 0; i < rows.length; i++) {
        // Score is inverse-ordinal: first result = 1.0, last = approaching 0.
        const score = 1 - i / rows.length;
        data.push({
            id: /** @type {number} */ (rows[i].id),
            name: /** @type {string} */ (rows[i].name) || '',
            entity_type: entityTag,
            score: Math.round(score * 100) / 100,
        });
    }

    // §4: single serialisation at exit.
    return encoder.encode(JSON.stringify({
        data,
        meta: { count: data.length, mode: 'semantic' },
    }));
}

/**
 * Handles a search request with SWR caching.
 *
 * Flow:
 *   1. Parse and validate query parameters (tokenizeString, §1, §2).
 *   2. Resolve effective mode (auto → semantic if enabled, else keyword).
 *   3. Build SHA-256 cache key scoped by auth tier.
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
    const { q, entity, mode, limit, skip, error } = parseSearchParams(queryString);
    if (error) return jsonError(400, error);

    // Resolve effective mode.
    const semanticAvailable = isSemanticEnabled();
    let effectiveMode = mode;
    if (mode === 'auto') effectiveMode = semanticAvailable ? 'semantic' : 'keyword';
    if (mode === 'semantic' && !semanticAvailable) {
        return jsonError(503, 'Semantic search is not available on this deployment.');
    }

    const cacheKey = await buildSearchKey(q, entity, effectiveMode, limit, skip, authenticated);

    const { buf, tier, hits } = await withSearchSWR(cacheKey, ctx, async () => {
        // §9: all D1 and AI calls inside this queryFn closure.
        if (effectiveMode === 'semantic') {
            const idList = await resolveSemanticIds(entity, 'name', q, limit);
            if (!idList) return null;
            return hydrateSemanticIds(db, entity, idList, limit);
        }
        return handleKeyword(db, entity, q, limit, skip);
    });

    if (!buf) {
        return serveSearch(SEARCH_EMPTY_SENTINEL, 'MISS', 0);
    }

    return serveSearch(buf, tier, hits);
}
