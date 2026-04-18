/**
 * @fileoverview Shared query pipeline for all workers.
 *
 * Encapsulates the full cache-miss resolution flow:
 *
 *   coalesce → L2 check → queryFn → L1 + L2 write
 *
 * By centralising this in one function:
 *   - Promise coalescing (cache stampede prevention) is guaranteed for every query
 *   - Negative-cache sentinel detection logic cannot be omitted
 *
 * Callers provide a queryFn closure that contains only the backend-specific
 * logic (D1 for the API worker, yoga.fetch for the GraphQL worker). Everything
 * else — coalescing, L2 lookups, cache writes, negative caching — is
 * handled here.
 *
 * Dependencies that vary per worker (entity version tracking, negative TTL,
 * sentinel value) are injected as parameters rather than imported, so each
 * worker can provide its own configuration.
 */

import { getL2, putL2 } from './l2cache.js';
import { encoder } from './http.js';

/**
 * Default sentinel value representing a cached 404 / empty result.
 * Stored in L1 and L2 to prevent repeated queries for non-existent
 * entity IDs. Workers may supply their own sentinel via the
 * emptySentinel parameter.
 * @type {Uint8Array}
 */
export const EMPTY_ENVELOPE = encoder.encode('{"data":[],"meta":{}}');

/**
 * Checks whether a Uint8Array matches a negative-cache sentinel.
 * Compares by reference first (fast path for L1 hits where the same
 * object is stored), then byte-for-byte (needed for L2, which returns
 * a copy).
 *
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
 * @typedef {'L1' | 'L2' | 'MISS'} CacheTier
 * Indicates which cache tier served a request:
 *   - L1: per-isolate LRU (set by handler, not by cachedQuery)
 *   - L2: per-PoP caches.default
 *   - MISS: backend query (D1, yoga, etc.)
 */

/**
 * @typedef {{buf: Uint8Array|null, tier: CacheTier}} CachedResult
 */

/**
 * Executes a query through the full cache-miss resolution pipeline.
 *
 * Flow:
 *   1. Coalesce: if another request is already fetching this key, await
 *      that in-flight promise instead of issuing a duplicate query.
 *   2. Check L2 per-PoP cache (caches.default)
 *   3. On L2 miss: execute the caller's queryFn
 *   4. Write result to L1 (per-isolate LRU) and L2 (per-PoP, fire-and-forget)
 *
 * Promise coalescing:
 *   Uses cache.pending to ensure N concurrent requests for the same expired
 *   key result in exactly 1 backend query. The first caller creates the fetch
 *   promise; subsequent callers await it. The pending entry is cleaned up
 *   in a .finally() handler.
 *
 * Negative caching:
 *   - If queryFn returns null, emptySentinel is stored with negativeTtlMs
 *   - If L2 returns a sentinel match, it's treated as a negative hit
 *
 * @param {Object} opts - Pipeline configuration.
 * @param {string} opts.cacheKey - Normalised cache key (e.g. "api/net/694?depth=2").
 * @param {LocalCache} opts.cache - Per-entity LRU cache instance from getEntityCache().
 * @param {string} opts.entityTag - Tag for cache metadata (e.g. "net", "graphql").
 * @param {number} opts.ttlMs - TTL in milliseconds for positive results (L1 addedAt, L2 max-age).
 * @param {number} opts.negativeTtlMs - TTL for negative (404) results in milliseconds.
 * @param {() => Promise<Uint8Array|null>} opts.queryFn - Backend query function to execute on
 *        cache miss. Must return a Uint8Array payload for positive results, or null for
 *        404/empty.
 * @param {(tag: string) => number} [opts.getVersion] - Optional function returning the
 *        entity's version number for L2 key tagging. When provided, L2 keys include the
 *        version so stale entries are automatically orphaned on data changes.
 * @param {ExecutionContext} [opts.ctx] - Worker execution context. When provided, L2 cache
 *        writes are wrapped in ctx.waitUntil() to ensure the async cache.put() completes
 *        before isolate recycling.
 * @param {Uint8Array} [opts.emptySentinel] - Sentinel buffer used for negative cache
 *        entries. Defaults to EMPTY_ENVELOPE. Workers with different empty-result
 *        shapes (e.g. GraphQL's {"data":null,"errors":[]}) inject their own.
 * @returns {Promise<CachedResult>} Cached or fresh payload with the tier that served it.
 *          buf is null for negative results (sentinel was stored, caller should 404).
 */
export async function cachedQuery({ cacheKey, cache, entityTag, ttlMs, negativeTtlMs, queryFn, getVersion, ctx, emptySentinel = EMPTY_ENVELOPE }) {
    // ── Promise coalescing ───────────────────────────────────────
    let inflight = cache.pending.get(cacheKey);

    if (!inflight) {
        inflight = _resolve(cacheKey, cache, entityTag, ttlMs, negativeTtlMs, queryFn, getVersion, ctx, emptySentinel);
        cache.pending.set(cacheKey, inflight);
        inflight.finally(() => cache.pending.delete(cacheKey)).catch(() => {});
    }

    return inflight;
}

/**
 * Internal fetch pipeline — separated from cachedQuery so the coalescing
 * wrapper can store and share the single promise reference.
 *
 * @param {string} cacheKey - Normalised cache key.
 * @param {LocalCache} cache - Per-entity LRU cache instance.
 * @param {string} entityTag - Tag for cache metadata.
 * @param {number} ttlMs - TTL in milliseconds for positive results.
 * @param {number} negativeTtlMs - TTL in milliseconds for negative results.
 * @param {() => Promise<Uint8Array|null>} queryFn - Backend query closure.
 * @param {((tag: string) => number)|undefined} getVersion - Optional version getter.
 * @param {ExecutionContext} [ctx] - Worker execution context for L2 write-back.
 * @param {Uint8Array} [emptySentinel] - Sentinel buffer for negative entries.
 * @returns {Promise<CachedResult>}
 */
async function _resolve(cacheKey, cache, entityTag, ttlMs, negativeTtlMs, queryFn, getVersion, ctx, emptySentinel = EMPTY_ENVELOPE) {
    // ── L2 per-PoP cache check ───────────────────────────────────
    // L2 keys are version-tagged with the entity's last_modified_at.
    // When data changes, the version advances and old L2 entries are
    // orphaned — they expire via Cache-Control TTL without requiring
    // enumeration or explicit deletion.
    const version = getVersion ? getVersion(entityTag) : 0;
    const l2Key = version ? `v/${version}/${cacheKey}` : cacheKey;

    const l2Buf = await getL2(l2Key);
    if (l2Buf) {
        if (isNegative(l2Buf, emptySentinel)) {
            cache.add(cacheKey, emptySentinel, { entityTag }, Date.now());
            return { buf: null, tier: 'L2' };
        }
        cache.add(cacheKey, l2Buf, { entityTag }, Date.now());
        return { buf: l2Buf, tier: 'L2' };
    }

    // ── Backend query ────────────────────────────────────────────
    const buf = await queryFn();

    // ── Cache write-back ─────────────────────────────────────────
    if (buf === null) {
        // Negative result: store sentinel with shorter TTL
        cache.add(cacheKey, emptySentinel, { entityTag }, Date.now());
        const negWrite = putL2(l2Key, emptySentinel, negativeTtlMs / 1000);
        if (ctx) ctx.waitUntil(negWrite);
        return { buf: null, tier: 'MISS' };
    }

    cache.add(cacheKey, buf, { entityTag }, Date.now());
    const posWrite = putL2(l2Key, buf, ttlMs / 1000);
    if (ctx) ctx.waitUntil(posWrite);
    return { buf, tier: 'MISS' };
}
