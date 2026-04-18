/**
 * @fileoverview Self-contained SWR cache layer for the GraphQL worker.
 *
 * Mirrors the pattern from core/pipeline.js + api/swr.js but uses the
 * GraphQL worker's own LRU cache (graphql/cache.js) and L2 adapter
 * (graphql/l2.js). This avoids cross-dependencies between the two
 * worker packages.
 *
 * Flow:
 *   1. Check L1 (gql LRU) — synchronous destructure of shared _ret
 *   2. If fresh → return immediately
 *   3. If stale (age > 80% TTL) → return stale, fire background refresh
 *   4. If expired or miss → coalesce concurrent requests, then:
 *      a. Check L2 (per-PoP Cache API via graphql/l2.js)
 *      b. If L2 miss → execute queryFn (yoga.fetch), write to L1 + L2
 *
 * Promise coalescing:
 *   Uses cache.pending (same Map as core/pipeline.js) to ensure N
 *   concurrent requests for the same cache key result in exactly 1
 *   yoga execution. The first caller creates the fetch promise;
 *   subsequent callers await it. Cleanup is in .finally().
 */

import { getGqlCache, GQL_TTL, GQL_NEGATIVE_TTL } from './cache.js';
import { getGqlL2, putGqlL2 } from './l2.js';
import { encoder } from '../core/http.js';

/**
 * SWR threshold: entries older than this but within GQL_TTL get a
 * background refresh. Computed once at module load.
 * @type {number}
 */
const GQL_STALE_MS = Math.floor(GQL_TTL * 0.8);

/**
 * Sentinel value representing a cached empty/error result.
 * Stored in L1 and L2 to prevent repeated yoga executions for
 * queries that consistently return errors or empty results.
 * @type {Uint8Array}
 */
const EMPTY_SENTINEL = encoder.encode('{"data":null,"errors":[]}');

/**
 * Checks whether a Uint8Array is the EMPTY_SENTINEL value.
 * Compares by reference first (L1 hit), then byte-for-byte (L2 copy).
 *
 * @param {Uint8Array} buf - Buffer to check.
 * @returns {boolean} True if buf matches EMPTY_SENTINEL.
 */
function isNegative(buf) {
    if (buf === EMPTY_SENTINEL) return true;
    if (buf.byteLength !== EMPTY_SENTINEL.byteLength) return false;
    for (let i = 0; i < buf.byteLength; i++) {
        if (buf[i] !== EMPTY_SENTINEL[i]) return false;
    }
    return true;
}

/**
 * Performs the full L1 → SWR → coalesce → L2 → queryFn cache resolution
 * for a GraphQL operation.
 *
 * Cache keys are SHA-256 hashes of the normalised query + variables,
 * computed by the caller via graphqlCacheKey() and suffixed with the
 * auth state. This function handles the rest: L1 lookup, SWR background
 * refresh, promise coalescing, L2 fallback, and write-back on miss.
 *
 * @param {string} cacheKey - Deterministic cache key from graphqlCacheKey().
 * @param {ExecutionContext} ctx - Worker execution context for waitUntil().
 * @param {() => Promise<Uint8Array|null>} queryFn - Closure that executes
 *        yoga.fetch() and returns the response as a Uint8Array, or null
 *        on error.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1'|'L2'|'MISS', hits: number}>}
 */
export async function withGqlSWR(cacheKey, ctx, queryFn) {
    const cache = getGqlCache();

    // ── SYNCHRONOUS DESTRUCTURE ──────────────────────────────────
    // cache.get() returns a shared mutable _ret object. Extract all
    // needed fields before any async work or subsequent get() calls.
    const entry = cache.get(cacheKey);

    if (entry) {
        const buf = /** @type {Uint8Array|null} */ (/** @type {unknown} */ (entry.buf));
        const hits = entry.hits;
        const addedAt = entry.addedAt;

        const age = Date.now() - addedAt;
        const neg = buf ? isNegative(buf) : false;
        const effectiveTtl = neg ? GQL_NEGATIVE_TTL : GQL_TTL;

        if (age < effectiveTtl) {
            // Within hard TTL — check SWR window
            if (age >= GQL_STALE_MS && !neg) {
                ctx.waitUntil(
                    _coalesce(cacheKey, cache, queryFn, ctx)
                        .catch(err => {
                            console.error(`[GQL-SWR] Background refresh failed for ${cacheKey}:`, err);
                        })
                );
            }

            if (neg) {
                return { buf: null, tier: /** @type {'L1'} */ ('L1'), hits };
            }
            return { buf, tier: /** @type {'L1'} */ ('L1'), hits };
        }
        // Past hard TTL — fall through to miss path
    }

    // ── CACHE MISS (blocking) ────────────────────────────────────
    return _coalesce(cacheKey, cache, queryFn, ctx);
}

/**
 * Promise coalescing wrapper. Ensures N concurrent requests for the
 * same cache key result in exactly 1 yoga execution.
 *
 * Uses cache.pending — the same Map that core/pipeline.js uses for
 * D1 query coalescing. The first caller creates the fetch promise;
 * subsequent callers await it. The pending entry is cleaned up in
 * a .finally() handler.
 *
 * @param {string} cacheKey - Cache key.
 * @param {LocalCache} cache - The gql LRU cache instance.
 * @param {() => Promise<Uint8Array|null>} queryFn - Query closure.
 * @param {ExecutionContext} ctx - Execution context for L2 write.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1'|'L2'|'MISS', hits: number}>}
 */
function _coalesce(cacheKey, cache, queryFn, ctx) {
    let inflight = cache.pending.get(cacheKey);

    if (!inflight) {
        inflight = _resolve(cacheKey, cache, queryFn, ctx);
        cache.pending.set(cacheKey, inflight);
        inflight.finally(() => cache.pending.delete(cacheKey)).catch(() => {});
    }

    return inflight;
}

/**
 * Internal miss-resolution pipeline: L2 check → queryFn → L1 + L2 write.
 * Separated from _coalesce so the coalescing wrapper can store and share
 * the single promise reference.
 *
 * @param {string} cacheKey - Cache key.
 * @param {LocalCache} cache - The gql LRU cache instance.
 * @param {() => Promise<Uint8Array|null>} queryFn - Query closure.
 * @param {ExecutionContext} ctx - Execution context for L2 write.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1'|'L2'|'MISS', hits: number}>}
 */
async function _resolve(cacheKey, cache, queryFn, ctx) {
    // ── L2 per-PoP cache check ───────────────────────────────────
    const l2Buf = await getGqlL2(cacheKey);
    if (l2Buf) {
        const now = Date.now();
        if (isNegative(l2Buf)) {
            cache.add(cacheKey, EMPTY_SENTINEL, { tag: 'graphql' }, now);
            return { buf: null, tier: /** @type {'L2'} */ ('L2'), hits: 0 };
        }
        cache.add(cacheKey, l2Buf, { tag: 'graphql' }, now);
        return { buf: l2Buf, tier: /** @type {'L2'} */ ('L2'), hits: 0 };
    }

    // ── Execute queryFn (yoga.fetch) ─────────────────────────────
    const buf = await queryFn();
    const now = Date.now();

    if (buf === null) {
        cache.add(cacheKey, EMPTY_SENTINEL, { tag: 'graphql' }, now);
        ctx.waitUntil(putGqlL2(cacheKey, EMPTY_SENTINEL, GQL_NEGATIVE_TTL / 1000));
        return { buf: null, tier: /** @type {'MISS'} */ ('MISS'), hits: 0 };
    }

    cache.add(cacheKey, buf, { tag: 'graphql' }, now);
    ctx.waitUntil(putGqlL2(cacheKey, buf, GQL_TTL / 1000));
    return { buf, tier: /** @type {'MISS'} */ ('MISS'), hits: 0 };
}
