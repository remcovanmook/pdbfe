/**
 * @fileoverview Request handlers for the PeeringDB API worker.
 * Implements list, detail, AS set lookup, and 501 Not Implemented
 * for write endpoints. Uses the per-entity LRU caches with raw
 * Uint8Array JSON forwarding on cache hits.
 */

import { ENTITIES } from '../entities.js';
import { buildQuery, nextPageParams } from '../query.js';
import { expandDepth } from '../depth.js';
import { getEntityCache, LIST_TTL, DETAIL_TTL } from '../cache.js';
import { encodeJSON, serveJSON, jsonError } from '../../core/http.js';
import { normaliseCacheKey } from '../../core/utils.js';

const _encoder = new TextEncoder();

/**
 * Handles a list request for an entity type (GET /api/{entity}).
 * Checks the per-entity LRU cache first. On miss, queries D1,
 * JSON-encodes the result once into Uint8Array, stores it in cache,
 * and serves the bytes. On paginated results, fires a background
 * pre-fetch for the next page.
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

    const cache = getEntityCache(entityTag);
    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const now = Date.now();
    const ttl = LIST_TTL;

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.addedAt) < ttl) {
        return serveJSON(request, /** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)), { isCached: true, hits: cached.hits });
    }

    // Cache miss — query D1
    const { sql, params } = buildQuery(entity, filters, opts);
    const result = await env.PDB.prepare(sql).bind(...params).all();
    const rows = result.results || [];

    // Parse social_media JSON strings back to arrays where applicable
    for (const row of rows) {
        parseSocialMedia(row);
    }

    // Depth expansion
    if (opts.depth > 0) {
        await expandDepth(env.PDB, entity, rows, opts.depth);
    }

    // Build PeeringDB-compatible response envelope
    const responseBody = { data: rows, meta: {} };
    const buf = encodeJSON(responseBody);

    // Store in cache
    cache.add(cacheKey, buf, { entityTag }, now);

    // Pre-fetch next page in background if paginated
    const nextPage = nextPageParams(filters, opts, rows.length);
    if (nextPage) {
        const nextOpts = { ...opts, limit: nextPage.limit, skip: nextPage.skip };
        const nextCacheKey = normaliseCacheKey(rawPath, buildSortedQS(filters, nextOpts));
        if (!cache.has(nextCacheKey) && !cache.pending.has(nextCacheKey)) {
            const prefetchPromise = prefetchPage(env, entity, filters, nextOpts, nextCacheKey, cache, entityTag);
            cache.pending.set(nextCacheKey, prefetchPromise);
            ctx.waitUntil(prefetchPromise.finally(() => cache.pending.delete(nextCacheKey)));
        }
    }

    return serveJSON(request, buf, { isCached: false, hits: 0 });
}

/**
 * Handles a detail request for a single entity (GET /api/{entity}/{id}).
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

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.addedAt) < DETAIL_TTL) {
        return serveJSON(request, /** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)), { isCached: true, hits: cached.hits });
    }

    // Query D1 for single row
    const { sql, params } = buildQuery(entity, filters, opts, id);
    const result = await env.PDB.prepare(sql).bind(...params).all();
    const rows = result.results || [];

    if (rows.length === 0) {
        return jsonError(404, `${entityTag} with id ${id} not found`);
    }

    for (const row of rows) {
        parseSocialMedia(row);
    }

    if (opts.depth > 0) {
        await expandDepth(env.PDB, entity, rows, opts.depth);
    }

    const responseBody = { data: rows, meta: {} };
    const buf = encodeJSON(responseBody);

    cache.add(cacheKey, buf, { entityTag }, now);
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
    const now = Date.now();

    const cached = cache.get(cacheKey);
    if (cached && (now - cached.addedAt) < DETAIL_TTL) {
        return serveJSON(request, /** @type {Uint8Array} */(/** @type {unknown} */(cached.buf)), { isCached: true, hits: cached.hits });
    }

    const result = await env.PDB.prepare(
        'SELECT "asn", "irr_as_set", "name" FROM "peeringdb_network" WHERE "asn" = ?'
    ).bind(asn).first();

    if (!result) {
        return jsonError(404, `No network found for ASN ${asn}`);
    }

    const responseBody = { data: [result], meta: {} };
    const buf = encodeJSON(responseBody);
    cache.add(cacheKey, buf, { entityTag: "as_set" }, now);

    return serveJSON(request, buf, { isCached: false, hits: 0 });
}

/**
 * Returns a 501 Not Implemented response for write endpoints.
 * The response body indicates that this is a read-only mirror
 * and the write endpoint exists in the spec but is not available.
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
 * Parses the social_media column from a TEXT string back to a JSON array.
 * The column is stored as TEXT in D1 but the API returns it as an array.
 * Also handles info_types which is stored as TEXT but returned as an array.
 *
 * @param {Record<string, any>} row - A result row to mutate in-place.
 */
function parseSocialMedia(row) {
    if (typeof row.social_media === "string" && row.social_media) {
        try { row.social_media = JSON.parse(row.social_media); } catch { /* keep as string */ }
    }
    if (typeof row.info_types === "string" && row.info_types) {
        try { row.info_types = JSON.parse(row.info_types); } catch { /* keep as string */ }
    }
}

/**
 * Background pre-fetch for the next page of paginated results.
 * Queries D1, encodes the result, and stores it in the entity cache.
 *
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Pagination.
 * @param {string} cacheKey - Cache key for the pre-fetched page.
 * @param {LocalCache} cache - The entity's LRU cache instance.
 * @param {string} entityTag - Entity tag for metadata.
 * @returns {Promise<void>}
 */
async function prefetchPage(env, entity, filters, opts, cacheKey, cache, entityTag) {
    try {
        const { sql, params } = buildQuery(entity, filters, opts);
        const result = await env.PDB.prepare(sql).bind(...params).all();
        const rows = result.results || [];

        for (const row of rows) {
            parseSocialMedia(row);
        }

        if (opts.depth > 0) {
            await expandDepth(env.PDB, entity, rows, opts.depth);
        }

        const responseBody = { data: rows, meta: {} };
        const buf = encodeJSON(responseBody);
        cache.add(cacheKey, buf, { entityTag }, Date.now());
    } catch (err) {
        // Pre-fetch failures are non-fatal — just log and move on.
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
