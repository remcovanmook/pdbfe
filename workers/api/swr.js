/**
 * @fileoverview API-worker SWR wrapper.
 *
 * Thin adapter over core/swr.js that pre-fills API-specific defaults:
 * the per-entity LRU cache, EMPTY_ENVELOPE sentinel, NEGATIVE_TTL,
 * and entity version tracking.
 *
 * Preserves the existing withEdgeSWR() signature so all API and REST
 * handler call sites remain unchanged.
 */

import { withSWR } from '../core/swr.js';
import { getEntityCache, NEGATIVE_TTL } from './cache.js';
import { EMPTY_ENVELOPE } from './pipeline.js';
import { getEntityVersion } from './sync_state.js';

/**
 * Performs the full L1 read → SWR → cachedQuery miss flow for an API entity.
 *
 * Delegates entirely to the generic withSWR() in core/swr.js, injecting
 * the API worker's entity cache, version tracker, sentinel, and negative
 * TTL. The caller only needs to provide the entity tag, cache key,
 * execution context, TTL, and query closure.
 *
 * @param {string} entityTag - Entity tag (e.g. "net"). Used to resolve the
 *        per-entity LRU cache instance and entity version for L2 keys.
 * @param {string} cacheKey - Normalised cache key (e.g. "api/net?depth=0").
 * @param {ExecutionContext} ctx - Cloudflare worker execution context. Used
 *        for ctx.waitUntil() on SWR background refreshes.
 * @param {number} ttlMs - Hard expiry in milliseconds. Entries older than
 *        this are treated as a miss and block on D1.
 * @param {() => Promise<Uint8Array|null>} queryFn - D1 query closure to
 *        execute on cache miss. Return Uint8Array for positive results,
 *        null for 404/empty.
 * @param {number} [staleMs] - Age in milliseconds before a background
 *        refresh is triggered. Defaults to 80% of ttlMs.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1' | 'L2' | 'MISS', hits: number}>}
 *          The response payload, cache tier that served it, and hit count.
 *          buf is null when the result is a negative cache entry (caller
 *          should return 404).
 */
export async function withEdgeSWR(entityTag, cacheKey, ctx, ttlMs, queryFn, staleMs) {
    return withSWR({
        cache: getEntityCache(entityTag),
        cacheKey,
        ctx,
        ttlMs,
        negativeTtlMs: NEGATIVE_TTL,
        queryFn,
        tag: entityTag,
        emptySentinel: EMPTY_ENVELOPE,
        getVersion: getEntityVersion,
        staleMs,
    });
}
