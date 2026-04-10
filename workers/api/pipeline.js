/**
 * @fileoverview Shared D1 query pipeline for the PeeringDB API worker.
 *
 * Encapsulates the full cache-miss resolution flow that is common to all
 * handler D1 query sites:
 *
 *   coalesce → L2 check → D1 query → L1 + L2 write
 *
 * By centralising this in one function:
 *   - Promise coalescing (cache stampede prevention) is guaranteed for every query
 *   - The negative-cache (EMPTY_ENVELOPE) detection logic cannot be omitted
 *
 * Callers provide a queryFn closure that contains only the D1-specific
 * logic (which varies per handler). Everything else — coalescing, L2 lookups,
 * cache writes, negative caching — is handled here.
 *
 * Note: D1 handles query serialization internally (single-threaded SQLite
 * with its own request queue). A per-isolate semaphore was previously used
 * here but caused cross-request promise resolution, which the Workers
 * runtime detects and kills as hung code.
 */

import { getL2, putL2 } from './l2cache.js';
import { getEntityVersion } from './sync_state.js';
import { encoder } from '../core/http.js';
import { NEGATIVE_TTL } from './cache.js';

/**
 * Sentinel value representing a cached 404 / empty result.
 * Stored in L1 and L2 to prevent repeated D1 queries for
 * non-existent entity IDs.
 * @type {Uint8Array}
 */
export const EMPTY_ENVELOPE = encoder.encode('{"data":[],"meta":{}}');

/**
 * Checks whether a Uint8Array is the EMPTY_ENVELOPE sentinel.
 * Used to detect negative cache entries retrieved from L2,
 * where we get a fresh copy rather than the same object reference.
 *
 * @param {Uint8Array|ArrayBuffer} buf - Buffer to check.
 * @returns {boolean} True if buf matches EMPTY_ENVELOPE byte-for-byte.
 */
export function isNegative(buf) {
    if (buf === EMPTY_ENVELOPE) return true;
    if (!(buf instanceof Uint8Array)) return false;
    if (buf.byteLength !== EMPTY_ENVELOPE.byteLength) return false;
    for (let i = 0; i < buf.byteLength; i++) {
        if (buf[i] !== EMPTY_ENVELOPE[i]) return false;
    }
    return true;
}

/**
 * @typedef {'L1' | 'L2' | 'MISS'} CacheTier
 * Indicates which cache tier served a request:
 *   - L1: per-isolate LRU (set by handler, not by cachedQuery)
 *   - L2: per-PoP caches.default
 *   - MISS: D1 query
 */

/**
 * @typedef {{buf: Uint8Array|null, tier: CacheTier}} CachedResult
 */

/**
 * Executes a D1 query through the full cache-miss resolution pipeline.
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
 *   key result in exactly 1 D1 query. The first caller creates the fetch
 *   promise; subsequent callers await it. The pending entry is cleaned up
 *   in a .finally() handler.
 *
 * Negative caching:
 *   - If queryFn returns null, EMPTY_ENVELOPE is stored with NEGATIVE_TTL
 *   - If L2 returns an EMPTY_ENVELOPE match, it's treated as a negative hit
 *
 * @param {Object} opts - Pipeline configuration.
 * @param {string} opts.cacheKey - Normalised cache key (e.g. "api/net/694?depth=2").
 * @param {LocalCache} opts.cache - Per-entity LRU cache instance from getEntityCache().
 * @param {string} opts.entityTag - Entity tag for cache metadata (e.g. "net", "as_set").
 * @param {number} opts.ttlMs - TTL in milliseconds for positive results (L1 addedAt, L2 max-age).
 * @param {() => Promise<Uint8Array|null>} opts.queryFn - D1 query function to execute on
 *        cache miss. Must return a Uint8Array payload for positive results, or null for
 *        404/empty.
 * @param {ExecutionContext} [opts.ctx] - Worker execution context. When provided, L2 cache
 *        writes are wrapped in ctx.waitUntil() to ensure the async cache.put() completes
 *        before isolate recycling.
 * @returns {Promise<CachedResult>} Cached or fresh payload with the tier that served it.
 *          buf is null for negative results (EMPTY_ENVELOPE was stored, caller should 404).
 */
export async function cachedQuery({ cacheKey, cache, entityTag, ttlMs, queryFn, ctx }) {
    // ── Promise coalescing ───────────────────────────────────────
    // If another request is already resolving this key, piggyback on
    // that in-flight promise. This prevents N identical D1 queries
    // when a popular key expires and multiple requests arrive before
    // the first one completes.
    let inflight = cache.pending.get(cacheKey);

    if (!inflight) {
        inflight = _resolve(cacheKey, cache, entityTag, ttlMs, queryFn, ctx);
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
 * @param {string} entityTag - Entity tag for cache metadata.
 * @param {number} ttlMs - TTL in milliseconds for positive results.
 * @param {() => Promise<Uint8Array|null>} queryFn - D1 query closure.
 * @param {ExecutionContext} [ctx] - Worker execution context for L2 write-back.
 * @returns {Promise<CachedResult>}
 */
async function _resolve(cacheKey, cache, entityTag, ttlMs, queryFn, ctx) {
    // ── L2 per-PoP cache check ───────────────────────────────────
    // L2 keys are version-tagged with the entity's last_modified_at.
    // When data changes, the version advances and old L2 entries are
    // orphaned — they expire via Cache-Control TTL without requiring
    // enumeration or explicit deletion.
    const version = getEntityVersion(entityTag);
    const l2Key = version ? `v/${version}/${cacheKey}` : cacheKey;

    const l2Buf = await getL2(l2Key);
    if (l2Buf) {
        if (isNegative(l2Buf)) {
            cache.add(cacheKey, EMPTY_ENVELOPE, { entityTag }, Date.now());
            return { buf: null, tier: 'L2' };
        }
        cache.add(cacheKey, l2Buf, { entityTag }, Date.now());
        return { buf: l2Buf, tier: 'L2' };
    }

    // ── D1 query ─────────────────────────────────────────────────
    const buf = await queryFn();

    // ── Cache write-back ─────────────────────────────────────────
    if (buf === null) {
        // Negative result: store sentinel with shorter TTL
        cache.add(cacheKey, EMPTY_ENVELOPE, { entityTag }, Date.now());
        const negWrite = putL2(l2Key, EMPTY_ENVELOPE, NEGATIVE_TTL / 1000);
        if (ctx) ctx.waitUntil(negWrite);
        return { buf: null, tier: 'MISS' };
    }

    cache.add(cacheKey, buf, { entityTag }, Date.now());
    const posWrite = putL2(l2Key, buf, ttlMs / 1000);
    if (ctx) ctx.waitUntil(posWrite);
    return { buf, tier: 'MISS' };
}
