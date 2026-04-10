/**
 * @fileoverview Safe abstraction for Edge L1 caching with Stale-While-Revalidate.
 *
 * Encapsulates the full L1 read → SWR background refresh → cachedQuery miss
 * flow into a single function call. Handlers call withEdgeSWR() instead of
 * manually orchestrating cache.get(), TTL checks, and cachedQuery().
 *
 * Why this exists:
 *   - Defuses the V8 singleton mutation trap (ANTI_PATTERNS.md §11) by
 *     guaranteeing synchronous destructuring of the shared _ret object.
 *   - Eliminates duplicated L1 check + cachedQuery boilerplate across
 *     every handler (handleList, handleDetail, handleCount, handleAsSet).
 *   - Adds stale-while-revalidate: entries between staleMs and ttlMs
 *     are served immediately while a background refresh runs via
 *     ctx.waitUntil().
 *
 * cachedQuery() (pipeline.js) remains the internal miss-resolution engine
 * and is not deprecated — withEdgeSWR delegates to it for coalescing,
 * L2 cache, and negative caching.
 */

import { getEntityCache, NEGATIVE_TTL } from '../api/cache.js';
import { cachedQuery, isNegative } from '../api/pipeline.js';

/**
 * Performs the full L1 read → SWR → cachedQuery miss flow for a cache key.
 *
 * The caller provides the entity tag, cache key, execution context, TTL,
 * and D1 query closure. Everything else — cache resolution, synchronous
 * field extraction, SWR background refresh, promise coalescing, L2,
 * and negative caching — is handled internally.
 *
 * Flow:
 *   1. Resolve cache from entityTag (via getEntityCache)
 *   2. Synchronous L1 read + immediate destructure (defuses _ret trap)
 *   3. If age < staleMs → return immediately (fresh hit)
 *   4. If staleMs ≤ age < effectiveTtl → return stale, fire background
 *      cachedQuery via ctx.waitUntil (SWR)
 *   5. If age ≥ effectiveTtl or miss → await cachedQuery (blocking)
 *
 * Negative cache entries (EMPTY_ENVELOPE) automatically use NEGATIVE_TTL
 * instead of the caller's ttlMs, so callers don't need to handle this.
 *
 * @param {string} entityTag - Entity tag (e.g. "net"). Used to resolve the
 *        per-entity LRU cache instance internally.
 * @param {string} cacheKey - Normalised cache key (e.g. "api/net?depth=0").
 * @param {ExecutionContext} ctx - Cloudflare worker execution context. Used
 *        for ctx.waitUntil() on SWR background refreshes.
 * @param {number} ttlMs - Hard expiry in milliseconds. Entries older than
 *        this are treated as a miss and block on D1.
 * @param {() => Promise<Uint8Array|null>} queryFn - D1 query closure to
 *        execute on cache miss. Same contract as cachedQuery's queryFn:
 *        return Uint8Array for positive results, null for 404/empty.
 * @param {number} [staleMs] - Age in milliseconds before a background
 *        refresh is triggered. Entries between staleMs and ttlMs are served
 *        stale while refreshing. Defaults to 80% of ttlMs.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1' | 'L2' | 'MISS', hits: number}>}}
 *          The response payload, cache tier that served it, and hit count.
 *          buf is null when the result is a negative cache entry (caller
 *          should return 404).
 */
export async function withEdgeSWR(entityTag, cacheKey, ctx, ttlMs, queryFn, staleMs) {
    const cache = getEntityCache(entityTag);
    const effectiveStaleMs = staleMs !== undefined ? staleMs : Math.floor(ttlMs * 0.8);

    // ── SYNCHRONOUS DESTRUCTURE ──────────────────────────────────────
    // cache.get() returns a shared mutable object (_ret) that is
    // overwritten on every call. Extract needed fields immediately
    // before any async work or subsequent get() calls.
    const entry = cache.get(cacheKey);

    if (entry) {
        const buf = /** @type {Uint8Array|null} */ (/** @type {unknown} */ (entry.buf));
        const hits = entry.hits;
        const addedAt = entry.addedAt;
        // Fields extracted — safe from _ret mutation beyond this point.

        const age = Date.now() - addedAt;
        const neg = buf ? isNegative(buf) : false;
        const effectiveTtl = neg ? NEGATIVE_TTL : ttlMs;

        if (age < effectiveTtl) {
            // Entry is within hard TTL — check if we should SWR
            if (age >= effectiveStaleMs && !neg) {
                // Stale window: serve current data, refresh in background.
                // Negative entries are not refreshed in SWR — they expire
                // and get re-queried on the next request past NEGATIVE_TTL.
                ctx.waitUntil(
                    cachedQuery({ cacheKey, cache, entityTag, ttlMs, queryFn, ctx })
                        .catch(err => {
                            console.error(`[SWR] Background refresh failed for ${cacheKey}:`, err);
                        })
                );
            }

            // Return cached data (fresh or stale-but-valid)
            if (neg) {
                return { buf: null, tier: /** @type {'L1'} */ ('L1'), hits };
            }
            return { buf, tier: /** @type {'L1'} */ ('L1'), hits };
        }
        // Entry is past hard TTL — fall through to miss path
    }

    // ── CACHE MISS (blocking) ────────────────────────────────────────
    const result = await cachedQuery({ cacheKey, cache, entityTag, ttlMs, queryFn, ctx });
    return { buf: result.buf, tier: result.tier, hits: 0 };
}
