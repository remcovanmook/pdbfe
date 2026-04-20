/**
 * @fileoverview Generic Stale-While-Revalidate wrapper for all workers.
 *
 * Encapsulates the full L1 read → SWR background refresh → cachedQuery
 * miss flow. Workers call withSWR() with their specific cache instance,
 * sentinel, and TTL configuration.
 *
 * Why this exists:
 *   - Defuses the V8 singleton mutation trap (ANTI_PATTERNS.md §11) by
 *     guaranteeing synchronous destructuring of the shared _ret object.
 *   - Eliminates duplicated L1 check + coalescing boilerplate across
 *     workers (API, REST, GraphQL).
 *   - Adds stale-while-revalidate: entries between staleMs and ttlMs
 *     are served immediately while a background refresh runs via
 *     ctx.waitUntil().
 *
 * cachedQuery() (query.js) remains the internal miss-resolution engine
 * — withSWR delegates to it for coalescing, L2 cache, and negative caching.
 *
 * Worker-specific modules (api/swr.js, graphql/swr.js) are thin wrappers
 * that call withSWR with pre-filled configuration.
 */

import { cachedQuery, isNegative, EMPTY_ENVELOPE } from './query.js';

/**
 * Performs the full L1 read → SWR → cachedQuery miss flow for a cache key.
 *
 * The caller provides a pre-resolved cache instance, TTL configuration,
 * and a query closure. Everything else — L1 resolution, synchronous field
 * extraction, SWR background refresh, promise coalescing, L2, and negative
 * caching — is handled internally.
 *
 * Flow:
 *   1. Synchronous L1 read + immediate destructure (defuses _ret trap)
 *   2. If age < staleMs → return immediately (fresh hit)
 *   3. If staleMs ≤ age < effectiveTtl → return stale, fire background
 *      cachedQuery via ctx.waitUntil (SWR)
 *   4. If age ≥ effectiveTtl or miss → await cachedQuery (blocking)
 *
 * Negative cache entries automatically use negativeTtlMs instead of
 * the caller's ttlMs, so callers don't need to handle this.
 *
 * @param {Object} opts - SWR configuration.
 * @param {LocalCache} opts.cache - Pre-resolved LRU cache instance.
 * @param {string} opts.cacheKey - Normalised cache key.
 * @param {ExecutionContext} opts.ctx - Cloudflare execution context for
 *        ctx.waitUntil() on SWR background refreshes.
 * @param {number} opts.ttlMs - Hard expiry in milliseconds. Entries older
 *        than this are treated as a miss and block on the backend.
 * @param {number} opts.negativeTtlMs - TTL for negative (404/empty) results.
 * @param {() => Promise<Uint8Array|null>} opts.queryFn - Backend query
 *        closure. Return Uint8Array for positive results, null for 404/empty.
 * @param {string} opts.tag - Metadata tag for cache.add (e.g. "net", "graphql").
 * @param {Uint8Array} [opts.emptySentinel] - Sentinel buffer for negative
 *        cache entries. Defaults to EMPTY_ENVELOPE.
 * @param {(tag: string) => number} [opts.getVersion] - Optional function
 *        returning the entity's version number for L2 key tagging.
 * @param {number} [opts.staleMs] - Age in milliseconds before a background
 *        refresh is triggered. Defaults to 80% of ttlMs.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1' | 'L2' | 'MISS', hits: number}>}
 *          The response payload, cache tier that served it, and hit count.
 *          buf is null when the result is a negative cache entry (caller
 *          should return 404).
 */
export async function withSWR({
    cache, cacheKey, ctx, ttlMs, negativeTtlMs,
    queryFn, tag, emptySentinel = EMPTY_ENVELOPE,
    getVersion, staleMs,
}) {
    const effectiveStaleMs = staleMs !== undefined ? staleMs : Math.floor(ttlMs * 0.8);

    /** @type {Parameters<typeof cachedQuery>[0]} */
    const pipelineOpts = {
        cacheKey, cache, entityTag: tag, ttlMs,
        negativeTtlMs, queryFn, getVersion, ctx,
        emptySentinel,
    };

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
        const neg = buf ? isNegative(buf, emptySentinel) : false;
        const effectiveTtl = neg ? negativeTtlMs : ttlMs;

        if (age < effectiveTtl) {
            // Entry is within hard TTL — check if we should SWR
            if (age >= effectiveStaleMs && !neg) {
                // Stale window: serve current data, refresh in background.
                // Negative entries are not refreshed in SWR — they expire
                // and get re-queried on the next request past negativeTtlMs.
                ctx.waitUntil(
                    cachedQuery(pipelineOpts).catch(err => {
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
    const result = await cachedQuery(pipelineOpts);
    return { buf: result.buf, tier: result.tier, hits: 0 };
}
