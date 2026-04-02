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
 * D1 query pipeline:
 *   All D1 queries flow through cachedQuery() (pipeline.js) which owns
 *   promise coalescing, the L2→semaphore→D1→cache-write lifecycle, and
 *   negative caching. Handlers provide only a queryFn closure containing
 *   the D1-specific logic.
 */

import { ENTITIES, getJsonColumns } from '../entities.js';
import { buildJsonQuery, buildRowQuery, buildCountQuery, nextPageParams } from '../query.js';
import { expandDepth } from '../depth.js';
import { getEntityCache, LIST_TTL, DETAIL_TTL, COUNT_TTL, NEGATIVE_TTL, normaliseCacheKey } from '../cache.js';
import { cachedQuery, EMPTY_ENVELOPE, isNegative } from '../pipeline.js';
import { encoder, encodeJSON, serveJSON, jsonError } from '../../core/http.js';

/**
 * Handles a list request for an entity type (GET /api/{entity}).
 * Checks the per-entity LRU cache first. On miss, delegates to
 * cachedQuery() which handles coalescing, L2, semaphore, and D1.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {string} entityTag - Entity tag (e.g. "net").
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Pagination and depth.
 * @param {string} rawPath - Original URL path for cache key.
 * @param {string} queryString - Original query string for cache key.
 * @returns {Promise<Response>} JSON response.
 */
export async function handleList(request, env, ctx, entityTag, filters, opts, rawPath, queryString) {
    const entity = ENTITIES[entityTag];
    if (!entity) return jsonError(404, `Unknown entity: ${entityTag}`);

    // Count mode: limit=0 with no skip returns {data:[], meta:{count:N}}
    if (opts.limit === 0 && opts.skip === 0) {
        return handleCount(request, env, entity, entityTag, filters, opts, rawPath, queryString);
    }

    const cache = getEntityCache(entityTag);
    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const now = Date.now();

    // L1 cache check
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.addedAt) < LIST_TTL) {
        return serveJSON(request, /** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)), { isCached: true, hits: cached.hits });
    }

    const buf = await cachedQuery({
        cacheKey, cache, entityTag, ttlMs: LIST_TTL,
        queryFn: () => executeListQuery(env, entity, filters, opts)
    });
    const effectiveBuf = buf || EMPTY_ENVELOPE;

    // Pre-fetch next page in background if paginated
    const rowCount = countRows(new TextDecoder().decode(effectiveBuf));
    if (rowCount > 0) {
        const nextPage = nextPageParams(filters, opts, rowCount);
        if (nextPage) {
            const nextOpts = { ...opts, limit: nextPage.limit, skip: nextPage.skip };
            const nextCacheKey = normaliseCacheKey(rawPath, buildSortedQS(filters, nextOpts));
            if (!cache.has(nextCacheKey) && !cache.pending.has(nextCacheKey)) {
                ctx.waitUntil(
                    prefetchPage(env, entity, entityTag, filters, nextOpts, nextCacheKey, cache)
                );
            }
        }
    }

    return serveJSON(request, effectiveBuf, { isCached: false, hits: 0 });
}

/**
 * Handles a detail request for a single entity (GET /api/{entity}/{id}).
 * Uses the zero-allocation path for depth=0, row expansion for depth>0.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {string} entityTag - Entity tag.
 * @param {number} id - Entity ID.
 * @param {ParsedFilter[]} filters - Parsed query filters (only depth is relevant here).
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Depth option.
 * @param {string} rawPath - Original URL path for cache key.
 * @param {string} queryString - Original query string for cache key.
 * @returns {Promise<Response>} JSON response.
 */
export async function handleDetail(request, env, ctx, entityTag, id, filters, opts, rawPath, queryString) {
    const entity = ENTITIES[entityTag];
    if (!entity) return jsonError(404, `Unknown entity: ${entityTag}`);

    const cache = getEntityCache(entityTag);
    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const notFoundMsg = `${entityTag} with id ${id} not found`;

    const l1Hit = serveCachedDetail(request, cache, cacheKey, notFoundMsg);
    if (l1Hit) return l1Hit;

    const buf = await cachedQuery({
        cacheKey, cache, entityTag, ttlMs: DETAIL_TTL,
        queryFn: () => executeDetailQuery(env, entity, filters, opts, id)
    });

    if (!buf) return jsonError(404, notFoundMsg);

    return serveJSON(request, buf, { isCached: false, hits: 0 });
}

/**
 * Handles the special /api/as_set/{asn} endpoint.
 * Looks up a network by ASN and returns its irr_as_set field.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {number} asn - The ASN to look up.
 * @returns {Promise<Response>} JSON response.
 */
export async function handleAsSet(request, env, asn) {
    const cache = getEntityCache("as_set");
    const cacheKey = `as_set/${asn}`;
    const notFoundMsg = `No network found for ASN ${asn}`;

    const l1Hit = serveCachedDetail(request, cache, cacheKey, notFoundMsg);
    if (l1Hit) return l1Hit;

    const buf = await cachedQuery({
        cacheKey, cache, entityTag: "as_set", ttlMs: DETAIL_TTL,
        queryFn: async () => {
            const result = await env.PDB.prepare(
                `SELECT json_object('data', json_array(json_object('asn', "asn", 'irr_as_set', "irr_as_set", 'name', "name")), 'meta', json_object()) AS payload FROM "peeringdb_network" WHERE "asn" = ?`
            ).bind(asn).first();

            if (!result || !result.payload) return null;
            return encoder.encode(/** @type {string} */(result.payload));
        }
    });

    if (!buf) return jsonError(404, notFoundMsg);

    return serveJSON(request, buf, { isCached: false, hits: 0 });
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
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Query options.
 * @returns {Promise<Uint8Array|null>} Payload bytes, or null for empty result.
 *          Note: empty lists return EMPTY_ENVELOPE (not null) since an empty
 *          list is valid data, not a 404.
 */
async function executeListQuery(env, entity, filters, opts) {
    if (opts.depth > 0) {
        const { sql, params } = buildRowQuery(entity, filters, opts);
        const result = await env.PDB.prepare(sql).bind(...params).all();
        const rows = result.results || [];
        for (const row of rows) { parseJsonFields(entity, row); }
        await expandDepth(env.PDB, entity, rows, opts.depth);
        return encodeJSON({ data: rows, meta: {} });
    }

    // Hot path: D1 returns the full JSON envelope as a single string
    const { sql, params } = buildJsonQuery(entity, filters, opts);
    const result = await env.PDB.prepare(sql).bind(...params).first();

    if (!result || !result.payload) {
        return EMPTY_ENVELOPE;
    }
    return encoder.encode(/** @type {string} */(result.payload));
}

/**
 * Executes a detail (single entity) query against D1.
 * Returns null if the entity doesn't exist (triggering negative caching).
 *
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Query options.
 * @param {number} id - Entity ID.
 * @returns {Promise<Uint8Array|null>} Payload bytes, or null for 404.
 */
async function executeDetailQuery(env, entity, filters, opts, id) {
    if (opts.depth > 0) {
        const { sql, params } = buildRowQuery(entity, filters, opts, id);
        const result = await env.PDB.prepare(sql).bind(...params).all();
        const rows = result.results || [];

        if (rows.length === 0) return null;

        for (const row of rows) { parseJsonFields(entity, row); }
        await expandDepth(env.PDB, entity, rows, opts.depth);
        return encodeJSON({ data: rows, meta: {} });
    }

    const { sql, params } = buildJsonQuery(entity, filters, opts, id);
    const result = await env.PDB.prepare(sql).bind(...params).first();

    if (!result || !result.payload || result.payload === '{"data":[],"meta":{}}') {
        return null;
    }
    return encoder.encode(/** @type {string} */(result.payload));
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Checks the L1 cache for a detail-type entry (with negative TTL awareness).
 * Returns a Response on hit (including 404 for negative entries), or null
 * on miss. Caches the isNegative check result to avoid duplicate byte
 * comparisons.
 *
 * Used by handleDetail and handleAsSet to de-duplicate the L1 check pattern.
 *
 * @param {Request} request - The inbound HTTP request (for ETag headers).
 * @param {LocalCache} cache - Per-entity LRU cache instance.
 * @param {string} cacheKey - Normalised cache key.
 * @param {string} notFoundMsg - 404 message if the entry is a negative cache hit.
 * @returns {Response|null} Cached response, or null on miss/expired.
 */
function serveCachedDetail(request, cache, cacheKey, notFoundMsg) {
    const cached = cache.get(cacheKey);
    if (!cached) return null;

    const neg = isNegative(/** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)));
    const ttl = neg ? NEGATIVE_TTL : DETAIL_TTL;
    if ((Date.now() - cached.addedAt) >= ttl) return null;

    if (neg) return jsonError(404, notFoundMsg);
    return serveJSON(request, /** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)), { isCached: true, hits: cached.hits });
}

/**
 * Handles count requests (limit=0, skip=0).
 * Tries to derive count from a cached unfiltered list response first.
 * Falls back to a cachedQuery() pipeline with SELECT COUNT(*).
 * Caches the count envelope with COUNT_TTL (15 min).
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string} entityTag - Entity tag.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Query options.
 * @param {string} rawPath - Original URL path.
 * @param {string} queryString - Original query string.
 * @returns {Promise<Response>} JSON response with count in meta.
 */
async function handleCount(request, env, entity, entityTag, filters, opts, rawPath, queryString) {
    const cache = getEntityCache(entityTag);
    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const now = Date.now();

    // Check if the count itself is cached (L1)
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.addedAt) < COUNT_TTL) {
        return serveJSON(request, /** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)), { isCached: true, hits: cached.hits });
    }

    // Try to derive count from a cached unfiltered list for this entity.
    // Only possible when there are no user-supplied filters and no since param.
    // This avoids a D1 query entirely when we already have the data.
    if (filters.length === 0 && opts.since === 0) {
        const listKey = normaliseCacheKey(rawPath, '');
        const listCached = cache.get(listKey);
        if (listCached && listCached.buf) {
            const payload = new TextDecoder().decode(/** @type {Uint8Array} */(/** @type {unknown} */(listCached.buf)));
            const count = countRows(payload);
            if (count > 0) {
                const buf = encoder.encode(`{"data":[],"meta":{"count":${count}}}`);
                cache.add(cacheKey, buf, { entityTag }, Date.now());
                return serveJSON(request, buf, { isCached: false, hits: 0 });
            }
        }
    }

    // Fall back to cachedQuery pipeline with COUNT(*) query
    const buf = await cachedQuery({
        cacheKey, cache, entityTag, ttlMs: COUNT_TTL,
        queryFn: async () => {
            const { sql, params } = buildCountQuery(entity, filters, opts);
            const result = await env.PDB.prepare(sql).bind(...params).first();
            const count = (result && typeof result.cnt === 'number') ? result.cnt : 0;
            return encoder.encode(`{"data":[],"meta":{"count":${count}}}`);
        }
    });

    return serveJSON(request, buf || EMPTY_ENVELOPE, { isCached: false, hits: 0 });
}


/**
 * Parses JSON-stored TEXT columns back to native arrays/objects.
 * Only used in the depth>0 cold path where we need individual row objects
 * for V8-side relationship expansion. Column names are derived from the
 * entity's field definitions (json: true).
 *
 * @param {EntityMeta} entity - Entity metadata for JSON column lookup.
 * @param {Record<string, any>} row - A result row to mutate in-place.
 */
function parseJsonFields(entity, row) {
    for (const col of getJsonColumns(entity)) {
        if (typeof row[col] === "string" && row[col]) {
            try { row[col] = JSON.parse(row[col]); } catch { /* keep as string */ }
        }
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
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string} entityTag - Entity tag for cache metadata.
 * @param {ParsedFilter[]} filters - Query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Pagination.
 * @param {string} cacheKey - Cache key for the pre-fetched page.
 * @param {LocalCache} cache - The entity's LRU cache instance.
 * @returns {Promise<void>}
 */
async function prefetchPage(env, entity, entityTag, filters, opts, cacheKey, cache) {
    try {
        await cachedQuery({
            cacheKey, cache, entityTag, ttlMs: LIST_TTL,
            queryFn: () => executeListQuery(env, entity, filters, opts)
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
