/**
 * @fileoverview Shared query pipeline for all workers.
 *
 * Encapsulates the cache-miss resolution flow:
 *
 *   coalesce → queryFn → L1 write
 *
 * By centralising this in one function:
 *   - Promise coalescing (cache stampede prevention) is guaranteed for every query
 *   - Negative-cache sentinel detection logic cannot be omitted
 *
 * Callers provide a queryFn closure that contains only the backend-specific
 * logic (D1 for the API worker, yoga.fetch for the GraphQL worker). Everything
 * else — coalescing, cache writes, negative caching — is handled here.
 *
 * There is no per-PoP L2 tier any more: in front of the worker the edge cache
 * serves repeats, and behind it a Cache API lookup (13–59 ms measured) cost as
 * much as or more than the D1 round trip it was meant to save (~20 ms).
 */

import { encoder } from '../http.js';

/**
 * Default sentinel value representing a cached 404 / empty result.
 * Stored in L1 to prevent repeated queries for non-existent entity IDs.
 * Workers may supply their own sentinel via the emptySentinel parameter.
 * @type {Uint8Array}
 */
export const EMPTY_ENVELOPE = encoder.encode('{"data":[],"meta":{}}');

/**
 * Checks whether a Uint8Array matches a negative-cache sentinel: by
 * reference first (the L1 stores the sentinel object itself), then
 * byte-for-byte.
 *
 * @internal Exported for unit testing. Production callers use cachedQuery().
 * @param {Uint8Array|ArrayBuffer} buf - Buffer to check.
 * @param {Uint8Array} [sentinel] - Sentinel to compare against.
 *        Defaults to EMPTY_ENVELOPE for backward compatibility.
 * @returns {boolean} True if buf matches the sentinel byte-for-byte.
 */
export function isNegative(buf, sentinel = EMPTY_ENVELOPE) {
    if (buf === sentinel) return true;
    if (!(buf instanceof Uint8Array)) return false;
    if (buf.byteLength !== sentinel.byteLength) return false;
    for (let i = 0; i < buf.byteLength; i++) {
        if (buf[i] !== sentinel[i]) return false;
    }
    return true;
}

/**
 * @typedef {'L1' | 'MISS'} CacheTier
 * Indicates which cache tier served a request:
 *   - L1: per-isolate LRU (set by handler, not by cachedQuery)
 *   - MISS: backend query (D1, yoga, etc.)
 */

/**
 * @typedef {{buf: Uint8Array|null, tier: CacheTier, dbMs?: number}} CachedResult
 */

/**
 * Executes a query through the cache-miss resolution pipeline.
 *
 * Flow:
 *   1. Coalesce: if another request is already fetching this key, await
 *      that in-flight promise instead of issuing a duplicate query.
 *   2. Execute the caller's queryFn.
 *   3. Write the result to L1 (per-isolate LRU).
 *
 * Promise coalescing:
 *   Uses cache.pending to ensure N concurrent requests for the same expired
 *   key result in exactly 1 backend query. The first caller creates the fetch
 *   promise; subsequent callers await it. The pending entry is cleaned up
 *   in a .finally() handler.
 *
 * Negative caching:
 *   If queryFn returns null, emptySentinel is stored in L1 (the caller's
 *   negativeTtlMs governs its lifetime there) and buf is null.
 *
 * @param {Object} opts - Pipeline configuration.
 * @param {string} opts.cacheKey - Normalised cache key (e.g. "api/net/694?depth=2").
 * @param {LocalCache} opts.cache - Per-entity LRU cache instance from getEntityCache().
 * @param {string} opts.entityTag - Tag for cache metadata (e.g. "net", "graphql").
 * @param {number} [opts.ttlMs] - TTL for positive results (read by the L1 caller).
 * @param {number} [opts.negativeTtlMs] - TTL for negative results (read by the L1 caller).
 * @param {() => Promise<Uint8Array|null>} opts.queryFn - Backend query function to execute on
 *        cache miss. Must return a Uint8Array payload for positive results, or null for
 *        404/empty.
 * @param {Uint8Array} [opts.emptySentinel] - Sentinel buffer used for negative cache
 *        entries. Defaults to EMPTY_ENVELOPE. Workers with different empty-result
 *        shapes (e.g. GraphQL's {"data":null,"errors":[]}) inject their own.
 * @returns {Promise<CachedResult>} Fresh payload; buf is null for negative results
 *          (sentinel was stored, caller should 404).
 */
export async function cachedQuery({ cacheKey, cache, entityTag, queryFn, emptySentinel = EMPTY_ENVELOPE }) {
    // ── Promise coalescing ───────────────────────────────────────
    let inflight = cache.pending.get(cacheKey);

    if (!inflight) {
        inflight = _resolve(cacheKey, cache, entityTag, queryFn, emptySentinel);
        cache.pending.set(cacheKey, inflight);
        inflight.finally(() => cache.pending.delete(cacheKey)).catch(() => {});
    }

    return inflight;
}

/**
 * Internal fetch — separated from cachedQuery so the coalescing wrapper can
 * store and share the single promise reference.
 *
 * @param {string} cacheKey
 * @param {LocalCache} cache
 * @param {string} entityTag
 * @param {() => Promise<Uint8Array|null>} queryFn
 * @param {Uint8Array} emptySentinel
 * @returns {Promise<CachedResult>}
 */
async function _resolve(cacheKey, cache, entityTag, queryFn, emptySentinel) {
    // Phase timing for Server-Timing. Workers clocks advance across I/O,
    // which is exactly what this await is.
    const tDb = Date.now();
    const buf = await queryFn();
    const dbMs = Date.now() - tDb;

    if (buf === null) {
        // Negative result: store sentinel (the caller's negativeTtlMs applies)
        cache.add(cacheKey, emptySentinel, { entityTag }, Date.now());
        return { buf: null, tier: 'MISS', dbMs };
    }

    cache.add(cacheKey, buf, { entityTag }, Date.now());
    return { buf, tier: 'MISS', dbMs };
}
