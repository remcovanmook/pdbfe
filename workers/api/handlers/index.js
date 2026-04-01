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
 * Cache stampede prevention:
 *   All three handlers (list, detail, as_set) coalesce concurrent cache-miss
 *   requests for the same cache key via cache.pending. The first request
 *   creates the D1 fetch Promise; subsequent requests await the same Promise.
 *   This prevents N identical D1 queries when a popular key expires.
 */

import { ENTITIES } from '../entities.js';
import { buildJsonQuery, buildRowQuery, buildCountQuery, nextPageParams } from '../query.js';
import { expandDepth } from '../depth.js';
import { getEntityCache, LIST_TTL, DETAIL_TTL, COUNT_TTL } from '../cache.js';
import { encodeJSON, serveJSON, jsonError } from '../../core/http.js';
import { normaliseCacheKey } from '../../core/utils.js';

const _encoder = new TextEncoder();

/** @type {Uint8Array} */
const EMPTY_ENVELOPE = _encoder.encode('{"data":[],"meta":{}}');

/**
 * Handles a list request for an entity type (GET /api/{entity}).
 * Checks the per-entity LRU cache first. On miss, coalesces concurrent
 * requests for the same key before dispatching to D1.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {string} entityTag - Entity tag (e.g. "net").
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Pagination and depth.
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

    // Coalesce concurrent misses for the same key
    let fetchPromise = cache.pending.get(cacheKey);

    if (!fetchPromise) {
        fetchPromise = (async () => {
            /** @type {Uint8Array} */
            let buf;
            let rowCount = 0;

            if (opts.depth > 0) {
                // Cold path: row-level query → V8 expansion → JSON.stringify
                const { sql, params } = buildRowQuery(entity, filters, opts);
                const result = await env.PDB.prepare(sql).bind(...params).all();
                const rows = result.results || [];
                rowCount = rows.length;

                for (const row of rows) { parseJsonFields(row); }
                await expandDepth(env.PDB, entity, rows, opts.depth);
                buf = encodeJSON({ data: rows, meta: {} });
            } else {
                // Hot path: D1 returns the full JSON envelope as a single string
                const { sql, params } = buildJsonQuery(entity, filters, opts);
                const result = await env.PDB.prepare(sql).bind(...params).first();

                if (!result || !result.payload) {
                    buf = EMPTY_ENVELOPE;
                } else {
                    buf = _encoder.encode(/** @type {string} */(result.payload));
                    rowCount = countRows(/** @type {string} */(result.payload));
                }
            }

            cache.add(cacheKey, buf, { entityTag }, Date.now());
            return { buf, rowCount };
        })();

        cache.pending.set(cacheKey, fetchPromise);
        fetchPromise.finally(() => cache.pending.delete(cacheKey)).catch(() => {});
    }

    const { buf, rowCount } = await fetchPromise;

    // Pre-fetch next page in background if paginated
    if (rowCount > 0) {
        const nextPage = nextPageParams(filters, opts, rowCount);
        if (nextPage) {
            const nextOpts = { ...opts, limit: nextPage.limit, skip: nextPage.skip };
            const nextCacheKey = normaliseCacheKey(rawPath, buildSortedQS(filters, nextOpts));
            if (!cache.has(nextCacheKey) && !cache.pending.has(nextCacheKey)) {
                const pfPromise = prefetchPage(env, entity, entityTag, filters, nextOpts, nextCacheKey, cache, opts.depth > 0);
                cache.pending.set(nextCacheKey, pfPromise);
                ctx.waitUntil(pfPromise.finally(() => cache.pending.delete(nextCacheKey)));
            }
        }
    }

    return serveJSON(request, buf, { isCached: false, hits: 0 });
}

/**
 * Handles a detail request for a single entity (GET /api/{entity}/{id}).
 * Uses the zero-allocation path for depth=0, row expansion for depth>0.
 * Coalesces concurrent misses for the same key.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {string} entityTag - Entity tag.
 * @param {number} id - Entity ID.
 * @param {ParsedFilter[]} filters - Parsed query filters (only depth is relevant here).
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Depth option.
 * @param {string} rawPath - Original URL path for cache key.
 * @param {string} queryString - Original query string for cache key.
 * @returns {Promise<Response>} JSON response.
 */
export async function handleDetail(request, env, ctx, entityTag, id, filters, opts, rawPath, queryString) {
    const entity = ENTITIES[entityTag];
    if (!entity) return jsonError(404, `Unknown entity: ${entityTag}`);

    const cache = getEntityCache(entityTag);
    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const now = Date.now();

    // L1 cache check
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.addedAt) < DETAIL_TTL) {
        return serveJSON(request, /** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)), { isCached: true, hits: cached.hits });
    }

    // Coalesce concurrent misses
    let fetchPromise = cache.pending.get(cacheKey);

    if (!fetchPromise) {
        fetchPromise = (async () => {
            /** @type {Uint8Array|null} */
            let buf = null;

            if (opts.depth > 0) {
                const { sql, params } = buildRowQuery(entity, filters, opts, id);
                const result = await env.PDB.prepare(sql).bind(...params).all();
                const rows = result.results || [];

                if (rows.length === 0) return { buf: null, rowCount: 0 };

                for (const row of rows) { parseJsonFields(row); }
                await expandDepth(env.PDB, entity, rows, opts.depth);
                buf = encodeJSON({ data: rows, meta: {} });
            } else {
                const { sql, params } = buildJsonQuery(entity, filters, opts, id);
                const result = await env.PDB.prepare(sql).bind(...params).first();

                if (!result || !result.payload || result.payload === '{"data":[],"meta":{}}') {
                    return { buf: null, rowCount: 0 };
                }
                buf = _encoder.encode(/** @type {string} */(result.payload));
            }

            cache.add(cacheKey, buf, { entityTag }, Date.now());
            return { buf, rowCount: 1 };
        })();

        cache.pending.set(cacheKey, fetchPromise);
        fetchPromise.finally(() => cache.pending.delete(cacheKey)).catch(() => {});
    }

    const { buf } = await fetchPromise;

    if (!buf) {
        return jsonError(404, `${entityTag} with id ${id} not found`);
    }

    return serveJSON(request, buf, { isCached: false, hits: 0 });
}

/**
 * Handles the special /api/as_set/{asn} endpoint.
 * Looks up a network by ASN and returns its irr_as_set field.
 * Coalesces concurrent misses for the same ASN.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {number} asn - The ASN to look up.
 * @returns {Promise<Response>} JSON response.
 */
export async function handleAsSet(request, env, asn) {
    const cache = getEntityCache("as_set");
    const cacheKey = `as_set/${asn}`;
    const now = Date.now();

    const cached = cache.get(cacheKey);
    if (cached && (now - cached.addedAt) < DETAIL_TTL) {
        return serveJSON(request, /** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)), { isCached: true, hits: cached.hits });
    }

    // Coalesce concurrent misses
    let fetchPromise = cache.pending.get(cacheKey);

    if (!fetchPromise) {
        fetchPromise = (async () => {
            const result = await env.PDB.prepare(
                `SELECT json_object('data', json_array(json_object('asn', "asn", 'irr_as_set', "irr_as_set", 'name', "name")), 'meta', json_object()) AS payload FROM "peeringdb_network" WHERE "asn" = ?`
            ).bind(asn).first();

            if (!result || !result.payload) {
                return { buf: null };
            }

            const buf = _encoder.encode(/** @type {string} */(result.payload));
            cache.add(cacheKey, buf, { entityTag: "as_set" }, Date.now());
            return { buf };
        })();

        cache.pending.set(cacheKey, fetchPromise);
        fetchPromise.finally(() => cache.pending.delete(cacheKey)).catch(() => {});
    }

    const { buf } = await fetchPromise;

    if (!buf) {
        return jsonError(404, `No network found for ASN ${asn}`);
    }

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

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Handles count requests (limit=0, skip=0).
 * Tries to derive count from a cached unfiltered list response first.
 * Falls back to SELECT COUNT(*) with any applied filters.
 * Caches the count envelope with COUNT_TTL (15 min).
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string} entityTag - Entity tag.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Query options.
 * @param {string} rawPath - Original URL path.
 * @param {string} queryString - Original query string.
 * @returns {Promise<Response>} JSON response with count in meta.
 */
async function handleCount(request, env, entity, entityTag, filters, opts, rawPath, queryString) {
    const cache = getEntityCache(entityTag);
    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const now = Date.now();

    // Check if the count itself is cached
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.addedAt) < COUNT_TTL) {
        return serveJSON(request, /** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)), { isCached: true, hits: cached.hits });
    }

    // Try to derive count from a cached unfiltered list for this entity.
    // Only possible when there are no user-supplied filters and no since param.
    let count = -1;
    if (filters.length === 0 && opts.since === 0) {
        const listKey = normaliseCacheKey(rawPath, '');
        const listCached = cache.get(listKey);
        if (listCached && listCached.buf) {
            // Decode the cached Uint8Array to string and scan for row count
            const payload = new TextDecoder().decode(/** @type {Uint8Array} */(/** @type {unknown} */(listCached.buf)));
            count = countRows(payload);
        }
    }

    // Fall back to COUNT(*) query
    if (count < 0) {
        const { sql, params } = buildCountQuery(entity, filters, opts);
        const result = await env.PDB.prepare(sql).bind(...params).first();
        count = (result && typeof result.cnt === 'number') ? result.cnt : 0;
    }

    const buf = _encoder.encode(`{"data":[],"meta":{"count":${count}}}`);
    cache.add(cacheKey, buf, { entityTag }, Date.now());

    return serveJSON(request, buf, { isCached: false, hits: 0 });
}


/**
 * Parses JSON-stored TEXT columns back to native arrays/objects.
 * Only used in the depth>0 cold path where we need individual row objects
 * for V8-side relationship expansion.
 *
 * @param {Record<string, any>} row - A result row to mutate in-place.
 */
function parseJsonFields(row) {
    if (typeof row.social_media === "string" && row.social_media) {
        try { row.social_media = JSON.parse(row.social_media); } catch { /* keep as string */ }
    }
    if (typeof row.info_types === "string" && row.info_types) {
        try { row.info_types = JSON.parse(row.info_types); } catch { /* keep as string */ }
    }
    if (typeof row.available_voltage_services === "string" && row.available_voltage_services) {
        try { row.available_voltage_services = JSON.parse(row.available_voltage_services); } catch { /* keep as string */ }
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
 * Uses the appropriate query path based on whether depth expansion is needed.
 *
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string} entityTag - Entity tag for cache metadata.
 * @param {ParsedFilter[]} filters - Query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Pagination.
 * @param {string} cacheKey - Cache key for the pre-fetched page.
 * @param {LocalCache} cache - The entity's LRU cache instance.
 * @param {boolean} needsExpansion - Whether depth>0 expansion is required.
 * @returns {Promise<void>}
 */
async function prefetchPage(env, entity, entityTag, filters, opts, cacheKey, cache, needsExpansion) {
    try {
        /** @type {Uint8Array} */
        let buf;

        if (needsExpansion) {
            const { sql, params } = buildRowQuery(entity, filters, opts);
            const result = await env.PDB.prepare(sql).bind(...params).all();
            const rows = result.results || [];

            for (const row of rows) { parseJsonFields(row); }
            if (opts.depth > 0) {
                await expandDepth(env.PDB, entity, rows, opts.depth);
            }
            buf = encodeJSON({ data: rows, meta: {} });
        } else {
            const { sql, params } = buildJsonQuery(entity, filters, opts);
            const result = await env.PDB.prepare(sql).bind(...params).first();

            if (!result || !result.payload) {
                buf = EMPTY_ENVELOPE;
            } else {
                buf = _encoder.encode(/** @type {string} */(result.payload));
            }
        }

        cache.add(cacheKey, buf, { entityTag }, Date.now());
    } catch (err) {
        console.error(`Pre-fetch failed for ${cacheKey}:`, err);
    }
}

/**
 * Reconstructs a sorted query string from filters and pagination options.
 * Used to build the cache key for the pre-fetched next page.
 *
 * @param {ParsedFilter[]} filters - The current query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Pagination.
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
    if (opts.limit > 0) parts.push(`limit=${opts.limit}`);
    if (opts.skip > 0) parts.push(`skip=${opts.skip}`);
    if (opts.since > 0) parts.push(`since=${opts.since}`);
    return parts.sort().join("&");
}
