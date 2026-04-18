/**
 * @fileoverview REST worker cache layer.
 *
 * Consolidates all cache-related concerns for the REST worker:
 *   - LRU cache instance and TTL constants
 *   - SWR wrapper (thin adapter over core/swr.js)
 *   - Cache stats and admin flush
 *
 * Dependencies are limited to core/ — no cross-worker imports.
 */

import { LRUCache } from '../core/cache.js';
import { withSWR } from '../core/swr.js';
import { EMPTY_ENVELOPE } from '../core/pipeline.js';

/**
 * Cache TTL for REST responses (60 minutes).
 * Matches the API worker's DETAIL_TTL.
 * @type {number}
 */
export const REST_TTL = 60 * 60 * 1000;

/**
 * Negative cache TTL for 404 / empty results (30 seconds).
 * @type {number}
 */
export const REST_NEGATIVE_TTL = 30_000;

/**
 * Single LRU cache instance for all REST operations.
 * 1024 slots, 32 MB byte budget. REST responses mirror the API
 * worker's output format so size characteristics are similar.
 * @type {LocalCache}
 */
const restCache = LRUCache(1024, 32 * 1024 * 1024, REST_TTL);

/**
 * Returns the REST cache instance.
 *
 * @returns {LocalCache} The cache instance.
 */
export function getRestCache() {
    return restCache;
}

/**
 * Returns cache statistics for the admin/health endpoint.
 *
 * @returns {{items: number, bytes: number, limit: number}} Cache stats.
 */
export function getRestCacheStats() {
    return restCache.getStats();
}

/**
 * Purges all entries from the REST cache.
 */
export function purgeRestCache() {
    restCache.purge();
}

// ── SWR wrapper ──────────────────────────────────────────────────────────────

/**
 * Performs the full L1 read → SWR → cachedQuery miss flow for a REST
 * API endpoint.
 *
 * Delegates entirely to the generic withSWR() in core/swr.js, injecting
 * the REST cache, EMPTY_ENVELOPE sentinel, and TTL values.
 *
 * @param {string} entityTag - Entity tag (e.g. "net"). Used as the
 *        metadata tag for cache.add and for L2 key construction.
 * @param {string} cacheKey - Normalised cache key (e.g. "v1/net/123").
 * @param {ExecutionContext} ctx - Cloudflare worker execution context.
 * @param {() => Promise<Uint8Array|null>} queryFn - D1 query closure.
 *        Return Uint8Array for positive results, null for 404/empty.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1' | 'L2' | 'MISS', hits: number}>}
 */
export async function withRestSWR(entityTag, cacheKey, ctx, queryFn) {
    return withSWR({
        cache: restCache,
        cacheKey,
        ctx,
        ttlMs: REST_TTL,
        negativeTtlMs: REST_NEGATIVE_TTL,
        queryFn,
        tag: entityTag,
        emptySentinel: EMPTY_ENVELOPE,
    });
}
