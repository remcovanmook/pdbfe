/**
 * @fileoverview Request handlers for the PeeringDB API worker.
 *
 * Two code paths depending on depth:
 *   depth=0 (hot path): D1 returns the full JSON envelope as a single string
 *           via json_group_array/json_object. The worker encodes it to
 *           Uint8Array and serves — zero V8 object allocations per row.
 *   depth>0 (cold path): D1 returns individual rows, expanded with
 *           relationship sets in V8, then JSON.stringify'd and cached.
 *
 * Cache lifecycle:
 *   All handlers use withEdgeSWR() (core/swr.js) which encapsulates the
 *   full L1 read → stale-while-revalidate → cachedQuery miss flow.
 *   Handlers provide only the D1 query closure. Cache resolution,
 *   synchronous field extraction, SWR background refresh, promise
 *   coalescing, L2, and negative caching are all handled internally.
 */

import { ENTITIES, getJsonColumns, getBoolColumns } from '../entities.js';
import { buildJsonQuery, buildRowQuery, buildCountQuery, nextPageParams } from '../query.js';
import { expandDepth } from '../depth.js';
import { getEntityCache, LIST_TTL, DETAIL_TTL, COUNT_TTL, normaliseCacheKey } from '../cache.js';
import { cachedQuery, EMPTY_ENVELOPE } from '../pipeline.js';
import { encoder, encodeJSON, serveJSON, jsonError } from '../../core/http.js';
import { withEdgeSWR } from '../../core/swr.js';

/**
 * Handles a list request for an entity type (GET /api/{entity}).
 * Checks the per-entity LRU cache first. On miss, delegates to
 * cachedQuery() which handles coalescing, L2, and D1.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {string} entityTag - Entity tag (e.g. "net").
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Pagination and depth.
 * @param {string} rawPath - Original URL path for cache key.
 * @param {string} queryString - Original query string for cache key.
 * @param {boolean} authenticated - Whether the caller is authenticated (for POC visibility).
 * @returns {Promise<Response>} JSON response.
 */
export async function handleList(request, db, ctx, entityTag, filters, opts, rawPath, queryString, authenticated) {
    const entity = ENTITIES[entityTag];
    if (!entity) return jsonError(404, `Unknown entity: ${entityTag}`);

    // Count mode: limit=0 with no skip returns {data:[], meta:{count:N}}
    if (opts.limit === 0 && opts.skip === 0) {
        return handleCount(request, db, ctx, entity, entityTag, filters, opts, rawPath, queryString);
    }

    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const { buf, tier, hits } = await withEdgeSWR(
        entityTag, cacheKey, ctx, LIST_TTL,
        () => executeListQuery(db, entity, filters, opts, authenticated)
    );
    const effectiveBuf = buf || EMPTY_ENVELOPE;

    // Pre-fetch next page in background if paginated
    const cache = getEntityCache(entityTag);
    const rowCount = countRows(new TextDecoder().decode(effectiveBuf));
    if (rowCount > 0) {
        const nextPage = nextPageParams(filters, opts, rowCount);
        if (nextPage) {
            const nextOpts = { ...opts, limit: nextPage.limit, skip: nextPage.skip };
            const nextCacheKey = normaliseCacheKey(rawPath, buildSortedQS(filters, nextOpts));
            if (!cache.has(nextCacheKey) && !cache.pending.has(nextCacheKey)) {
                ctx.waitUntil(
                    prefetchPage(db, entity, entityTag, filters, nextOpts, nextCacheKey, cache)
                );
            }
        }
    }

    return serveJSON(request, effectiveBuf, { tier, hits });
}

/**
 * Handles a detail request for a single entity (GET /api/{entity}/{id}).
 * Uses the zero-allocation path for depth=0, row expansion for depth>0.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {string} entityTag - Entity tag.
 * @param {number} id - Entity ID.
 * @param {ParsedFilter[]} filters - Parsed query filters (only depth is relevant here).
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Depth option.
 * @param {string} rawPath - Original URL path for cache key.
 * @param {string} queryString - Original query string for cache key.
 * @param {boolean} authenticated - Whether the caller is authenticated (for POC visibility).
 * @returns {Promise<Response>} JSON response.
 */
export async function handleDetail(request, db, ctx, entityTag, id, filters, opts, rawPath, queryString, authenticated) {
    const entity = ENTITIES[entityTag];
    if (!entity) return jsonError(404, `Unknown entity: ${entityTag}`);

    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const { buf, tier, hits } = await withEdgeSWR(
        entityTag, cacheKey, ctx, DETAIL_TTL,
        () => executeDetailQuery(db, entity, filters, opts, id, authenticated)
    );

    if (!buf) return jsonError(404, `${entityTag} with id ${id} not found`);

    return serveJSON(request, buf, { tier, hits });
}

/**
 * Handles the special /api/as_set/{asn} endpoint.
 * Looks up a network by ASN and returns its irr_as_set field.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {ExecutionContext} ctx - Worker execution context for SWR background tasks.
 * @param {number} asn - The ASN to look up.
 * @returns {Promise<Response>} JSON response.
 */
export async function handleAsSet(request, db, ctx, asn) {
    const cacheKey = `as_set/${asn}`;
    const { buf, tier, hits } = await withEdgeSWR(
        "as_set", cacheKey, ctx, DETAIL_TTL,
        async () => {
            const result = await db.prepare(
                `SELECT json_object('data', json_array(json_object('asn', "asn", 'irr_as_set', "irr_as_set", 'name', "name")), 'meta', json_object()) AS payload FROM "peeringdb_network" WHERE "asn" = ?`
            ).bind(asn).first();

            if (!result || !result.payload) return null;
            return encoder.encode(/** @type {string} */(result.payload));
        }
    );

    if (!buf) return jsonError(404, `No network found for ASN ${asn}`);

    return serveJSON(request, buf, { tier, hits });
}

/**
 * Returns a 501 Not Implemented response for write endpoints.
 *
 * @param {string} method - The HTTP method (POST, PUT, DELETE).
 * @param {string} path - The URL path.
 * @returns {Response} 501 JSON response.
 */
export function handleNotImplemented(method, path) {
    return jsonError(501, `${method} ${path} is not available on this read-only mirror. See peeringdb.com for write access.`);
}

// ── D1 query functions ───────────────────────────────────────────────────────
// These are the queryFn closures passed to cachedQuery(). They contain only
// the D1-specific logic; everything else is handled by the pipeline.

/**
 * Executes a list query against D1. Uses the hot path (json_group_array)
 * for depth=0, or the cold path (row-level + expandDepth) for depth>0.
 *
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Query options.
 * @param {boolean} authenticated - Whether the caller is authenticated (for POC visibility).
 * @returns {Promise<Uint8Array|null>} Payload bytes, or null for empty result.
 *          Note: empty lists return EMPTY_ENVELOPE (not null) since an empty
 *          list is valid data, not a 404.
 */
async function executeListQuery(db, entity, filters, opts, authenticated) {
    if (opts.depth > 0) {
        const { sql, params } = buildRowQuery(entity, filters, opts);
        const result = await db.prepare(sql).bind(...params).all();
        const rows = result.results || [];
        for (const row of rows) { parseJsonFields(entity, row); }
        await expandDepth(db, entity, rows, opts.depth, authenticated);
        return encodeJSON({ data: rows, meta: {} });
    }

    // Hot path: D1 returns the full JSON envelope as a single string
    const { sql, params } = buildJsonQuery(entity, filters, opts);
    const result = await db.prepare(sql).bind(...params).first();

    if (!result || !result.payload) {
        return EMPTY_ENVELOPE;
    }
    return encoder.encode(/** @type {string} */(result.payload));
}

/**
 * Executes a detail (single entity) query against D1.
 * Returns null if the entity doesn't exist (triggering negative caching).
 *
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Query options.
 * @param {number} id - Entity ID.
 * @param {boolean} authenticated - Whether the caller is authenticated (for POC visibility).
 * @returns {Promise<Uint8Array|null>} Payload bytes, or null for 404.
 */
async function executeDetailQuery(db, entity, filters, opts, id, authenticated) {
    if (opts.depth > 0) {
        const { sql, params } = buildRowQuery(entity, filters, opts, id);
        const result = await db.prepare(sql).bind(...params).all();
        const rows = result.results || [];

        if (rows.length === 0) return null;

        for (const row of rows) { parseJsonFields(entity, row); }
        await expandDepth(db, entity, rows, opts.depth, authenticated);
        return encodeJSON({ data: rows, meta: {} });
    }

    const { sql, params } = buildJsonQuery(entity, filters, opts, id);
    const result = await db.prepare(sql).bind(...params).first();

    if (!result || !result.payload || result.payload === '{"data":[],"meta":{}}') {
        return null;
    }
    return encoder.encode(/** @type {string} */(result.payload));
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Handles count requests (limit=0, skip=0).
 * Tries to derive count from a cached unfiltered list response first.
 * Falls back to withEdgeSWR() pipeline with SELECT COUNT(*).
 * Caches the count envelope with COUNT_TTL (15 min).
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {ExecutionContext} ctx - Worker execution context for SWR background tasks.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string} entityTag - Entity tag.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Query options.
 * @param {string} rawPath - Original URL path.
 * @param {string} queryString - Original query string.
 * @returns {Promise<Response>} JSON response with count in meta.
 */
async function handleCount(request, db, ctx, entity, entityTag, filters, opts, rawPath, queryString) {
    const cacheKey = normaliseCacheKey(rawPath, queryString);

    // Try to derive count from a cached unfiltered list for this entity.
    // Only possible when there are no user-supplied filters and no since param.
    // This avoids a D1 query entirely when we already have the data.
    // Note: this reads cache.get() directly — it's a cross-key optimisation
    // (reading a *different* cache key) that doesn't fit the withEdgeSWR
    // single-key model. The synchronous destructure is safe because we
    // extract buf immediately.
    if (filters.length === 0 && opts.since === 0) {
        const cache = getEntityCache(entityTag);
        const listKey = normaliseCacheKey(rawPath, '');
        const listCached = cache.get(listKey);
        const listBuf = listCached ? listCached.buf : null;
        if (listBuf) {
            const payload = new TextDecoder().decode(/** @type {Uint8Array} */(/** @type {unknown} */(listBuf)));
            const count = countRows(payload);
            if (count > 0) {
                const buf = encoder.encode(`{"data":[],"meta":{"count":${count}}}`);
                cache.add(cacheKey, buf, { entityTag }, Date.now());
                return serveJSON(request, buf, { tier: 'L1', hits: 0 });
            }
        }
    }

    // Fall back to withEdgeSWR pipeline with COUNT(*) query
    const { buf, tier, hits } = await withEdgeSWR(
        entityTag, cacheKey, ctx, COUNT_TTL,
        async () => {
            const { sql, params } = buildCountQuery(entity, filters, opts);
            const result = await db.prepare(sql).bind(...params).first();
            const count = (result && typeof result.cnt === 'number') ? result.cnt : 0;
            return encoder.encode(`{"data":[],"meta":{"count":${count}}}`);
        }
    );

    return serveJSON(request, buf || EMPTY_ENVELOPE, { tier, hits });
}


/**
 * Parses JSON-stored TEXT columns back to native arrays/objects and
 * coerces boolean fields from SQLite's 0/1 integers to JS booleans.
 * Only used in the depth>0 cold path where we need individual row objects
 * for V8-side relationship expansion. Column names are derived from the
 * entity's field definitions.
 *
 * @param {EntityMeta} entity - Entity metadata for column lookup.
 * @param {Record<string, any>} row - A result row to mutate in-place.
 */
function parseJsonFields(entity, row) {
    for (const col of getJsonColumns(entity)) {
        if (typeof row[col] === "string" && row[col]) {
            try { row[col] = JSON.parse(row[col]); } catch { /* keep as string */ }
        }
    }
    for (const col of getBoolColumns(entity)) {
        if (col in row) row[col] = !!row[col];
    }
}

/**
 * Estimates the number of rows in a JSON array payload without parsing it.
 * Counts occurrences of '},{' which separate objects in json_group_array
 * output. Returns 0 for empty arrays, 1 for single-object payloads.
 *
 * @param {string} payload - The raw JSON string from D1.
 * @returns {number} Estimated row count.
 */
function countRows(payload) {
    const start = payload.indexOf('[');
    const end = payload.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start + 1) return 0;

    let count = 1;
    let i = start + 1;
    while (i < end) {
        i = payload.indexOf('},{', i);
        if (i === -1 || i >= end) break;
        count++;
        i += 3;
    }
    return count;
}

/**
 * Background pre-fetch for the next page of paginated results.
 * Delegates to cachedQuery() which handles coalescing, L2, and D1.
 *
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string} entityTag - Entity tag for cache metadata.
 * @param {ParsedFilter[]} filters - Query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Pagination.
 * @param {string} cacheKey - Cache key for the pre-fetched page.
 * @param {LocalCache} cache - The entity's LRU cache instance.
 * @returns {Promise<void>}
 */
async function prefetchPage(db, entity, entityTag, filters, opts, cacheKey, cache) {
    try {
        await cachedQuery({
            cacheKey, cache, entityTag, ttlMs: LIST_TTL,
            queryFn: () => executeListQuery(db, entity, filters, opts, false)
        });
    } catch (err) {
        console.error(`Pre-fetch failed for ${cacheKey}:`, err);
    }
}

/**
 * Reconstructs a sorted query string from filters and pagination options.
 * Used to build the cache key for the pre-fetched next page.
 *
 * @param {ParsedFilter[]} filters - The current query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Pagination.
 * @returns {string} Sorted query string.
 */
function buildSortedQS(filters, opts) {
    /** @type {string[]} */
    const parts = [];
    for (const f of filters) {
        const key = f.op === "eq" ? f.field : `${f.field}__${f.op}`;
        parts.push(`${key}=${encodeURIComponent(f.value)}`);
    }
    if (opts.depth > 0) parts.push(`depth=${opts.depth}`);
    if (opts.fields && opts.fields.length > 0) parts.push(`fields=${opts.fields.join(',')}`);
    if (opts.limit > 0) parts.push(`limit=${opts.limit}`);
    if (opts.skip > 0) parts.push(`skip=${opts.skip}`);
    if (opts.since > 0) parts.push(`since=${opts.since}`);
    if (opts.sort) parts.push(`sort=${encodeURIComponent(opts.sort)}`);
    return parts.sort().join("&");
}
