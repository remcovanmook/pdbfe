/**
 * @fileoverview Search worker cache layer.
 *
 * Consolidates all cache-related concerns for the search worker:
 *   - LRU cache instance and TTL constants
 *   - Cache key generation (SHA-256 hash of query + entity + mode, auth-scoped)
 *   - SWR wrapper (thin adapter over core/pipeline/withSWR)
 *   - Cache stats and admin flush
 *
 * Mirrors the structure of graphql/cache.js. The Cloudflare Cache API only
 * supports GET requests; since keyword vs graph-search dispatch is determined
 * by query parameters that cannot be safely keyed by URL alone, we hash the
 * normalised parameter set to produce a deterministic key (format:
 * search/{sha256-hex}:{anon|auth}).
 */

import { LRUCache } from '../core/cache.js';
import { withSWR } from '../core/pipeline/index.js';
import { encoder } from './http.js';

/**
 * Cache TTL for search results (30 minutes).
 *
 * Graph-structural queries require a Vectorize round-trip for similarity
 * searches but no AI embed call. Results change only when the underlying
 * entity data changes (every 15 min sync). 30 minutes matches the GraphQL
 * worker's TTL, which faces the same multi-entity staleness challenge.
 *
 * @type {number}
 */
export const SEARCH_TTL = 30 * 60 * 1000;

/**
 * Negative cache TTL for failed or empty results (60 seconds).
 *
 * Longer than GraphQL's 30 s because a failing Vectorize query is more likely
 * to be a transient infrastructure issue than a bad query, and 60 s reduces
 * the window of retrying an unavailable backend.
 *
 * @type {number}
 */
export const SEARCH_NEGATIVE_TTL = 60_000;

/**
 * Sentinel value representing a cached empty search result.
 *
 * Different from the API worker's EMPTY_ENVELOPE because search responses
 * use {data, meta} shape with a mode field.
 *
 * @type {Uint8Array}
 */
export const SEARCH_EMPTY_SENTINEL = encoder.encode('{"data":[],"meta":{"count":0,"mode":"none"}}');

/**
 * Sentinel value for a cached empty multi-entity search result.
 *
 * Uses the grouped response shape — {data: {}, meta: {mode, counts: {}}} —
 * so clients can always parse the response with the same shape check
 * regardless of whether results were found.
 *
 * @type {Uint8Array}
 */
export const SEARCH_MULTI_EMPTY_SENTINEL = encoder.encode('{"data":{},"meta":{"mode":"none","counts":{}}}');

/**
 * Single LRU cache instance for all search operations.
 *
 * 1024 slots, 32 MB byte budget. Search responses are variable in size
 * (graph results include multiple fields per entity), similar to GraphQL.
 *
 * @type {LocalCache}
 */
const searchCache = LRUCache(1024, 32 * 1024 * 1024, SEARCH_TTL);

/**
 * Returns the search cache instance.
 *
 * @returns {LocalCache} The cache instance.
 */
export function getSearchCache() {
    return searchCache;
}

/**
 * Returns cache statistics for the admin/health endpoint.
 *
 * @returns {{items: number, bytes: number, limit: number}} Cache stats.
 */
export function getSearchCacheStats() {
    return searchCache.getStats();
}

/**
 * Purges all entries from the search cache.
 */
export function purgeSearchCache() {
    searchCache.purge();
}

// ── Cache key generation ──────────────────────────────────────────────────────

/**
 * Bounded map from serialised parameter set → resolved base cache key.
 *
 * Skips SHA-256 on repeat queries with identical parameters.
 * Uses insertion-order iteration for LRU eviction: the oldest entry
 * (first key in iteration order) is deleted when the map reaches
 * PARAM_KEY_CACHE_LIMIT. Same "cache for the cache key" pattern as
 * graphql/handlers/query.js#bodyKeyCache.
 *
 * @type {Map<string, string>}
 */
const paramKeyCache = new Map();

/** Maximum entries in paramKeyCache before eviction. */
const PARAM_KEY_CACHE_LIMIT = 500;

/**
 * Generates a deterministic, auth-scoped cache key for a search request.
 *
 * Parameters are serialised in a canonical order and hashed with SHA-256
 * to produce a URL-safe key. The key is scoped by authentication tier
 * (anon: vs auth:) so authenticated results never pollute the anonymous
 * cache (relevant if authenticated users gain access to restricted entities
 * in future).
 *
 * Fast path: if the same normalised parameter string has been seen before,
 * returns the previously computed hash without repeating the SHA-256 call.
 *
 * @param {string} q - The search query string.
 * @param {string[]} entityList - Entity type tags (e.g. ["net"] or ["net","ix","fac"]).
 *   Sorted internally so [net,ix] and [ix,net] produce the same key.
 * @param {string} mode - Resolved mode ("keyword" or "graph").
 * @param {number} limit - Result limit.
 * @param {number} skip - Pagination offset.
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @returns {Promise<string>} Cache key in the form "anon:search/{hex}" or "auth:search/{hex}".
 */
export async function buildSearchKey(q, entityList, mode, limit, skip, authenticated) {
    // Sort the entity list so [net,ix] and [ix,net] map to the same cache entry.
    // Canonical serialisation: fixed key order, no extra whitespace.
    const entityKey = entityList.slice().sort((a, b) => a.localeCompare(b)).join(',');
    const paramStr = `${entityKey}\x00${mode}\x00${limit}\x00${skip}\x00${q}`;
    const authPrefix = authenticated ? 'auth:' : 'anon:';

    const cached = paramKeyCache.get(paramStr);
    if (cached) return authPrefix + cached;

    const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(paramStr));
    const arr = new Uint8Array(digest);
    const hex = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    const baseKey = `search/${hex}`;

    if (paramKeyCache.size >= PARAM_KEY_CACHE_LIMIT) {
        paramKeyCache.delete(paramKeyCache.keys().next().value);
    }
    paramKeyCache.set(paramStr, baseKey);

    return authPrefix + baseKey;
}

// ── SWR wrapper ───────────────────────────────────────────────────────────────

/**
 * Performs the full L1 → SWR → coalesce → L2 → queryFn flow for a
 * search operation.
 *
 * Delegates entirely to the generic withSWR() in core/pipeline/, injecting
 * the search cache, sentinel, and TTL values. The caller only needs to
 * provide the cache key, execution context, and search query closure.
 *
 * Unlike the API worker, the search worker does not use per-entity version
 * tracking for L2 invalidation — the 30-minute TTL provides sufficient
 * freshness given the 15-minute sync cadence.
 *
 * @param {string} cacheKey - Deterministic key from buildSearchKey().
 * @param {ExecutionContext} ctx - Worker execution context for waitUntil().
 * @param {() => Promise<Uint8Array|null>} queryFn - Closure that executes
 *        the keyword or graph-structural search and returns a serialised Uint8Array,
 *        or null on error.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1'|'L2'|'MISS', hits: number}>}
 */
export async function withSearchSWR(cacheKey, ctx, queryFn) {
    return withSWR({
        cache: searchCache,
        cacheKey,
        ctx,
        ttlMs: SEARCH_TTL,
        negativeTtlMs: SEARCH_NEGATIVE_TTL,
        queryFn,
        tag: 'search',
        emptySentinel: SEARCH_EMPTY_SENTINEL,
    });
}
