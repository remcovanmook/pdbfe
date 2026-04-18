/**
 * @fileoverview GraphQL worker cache layer.
 *
 * Consolidates all cache-related concerns for the GraphQL worker:
 *   - LRU cache instance and TTL constants
 *   - Cache key generation (SHA-256 hashing of query + variables)
 *   - SWR wrapper (thin adapter over core/swr.js)
 *   - Cache stats and admin flush
 *
 * The Cloudflare Cache API only supports GET requests. Since GraphQL
 * operations are POST-based, we hash the operation body to produce a
 * deterministic cache key (format: gql/{sha256-hex}), then rely on
 * core/pipeline.js for L2 get/put via caches.default.
 */

import { LRUCache } from '../core/cache.js';
import { withSWR } from '../core/swr.js';
import { encoder } from '../core/http.js';

/**
 * Cache TTL for GraphQL query results (30 minutes).
 * Shorter than the API worker's DETAIL_TTL because GraphQL queries
 * can span multiple entity types and staleness is harder to detect
 * without per-entity version tracking.
 * @type {number}
 */
export const GQL_TTL = 30 * 60 * 1000;

/**
 * Negative cache TTL for 404 / empty results (30 seconds).
 * @type {number}
 */
export const GQL_NEGATIVE_TTL = 30_000;

/**
 * Sentinel value representing a cached empty/error GraphQL result.
 * Different from the API worker's EMPTY_ENVELOPE because GraphQL
 * responses use {data, errors} shape rather than {data, meta}.
 * @type {Uint8Array}
 */
export const GQL_EMPTY_SENTINEL = encoder.encode('{"data":null,"errors":[]}');

/**
 * Single LRU cache instance for all GraphQL operations.
 * 1024 slots, 32 MB byte budget. GraphQL responses tend to be larger
 * than individual API entity responses because a single query can span
 * multiple entity types with FK resolution.
 * @type {LocalCache}
 */
const gqlCache = LRUCache(1024, 32 * 1024 * 1024, GQL_TTL);

/**
 * Returns the GraphQL cache instance.
 *
 * @returns {LocalCache} The cache instance.
 */
export function getGqlCache() {
    return gqlCache;
}

/**
 * Returns cache statistics for the admin/health endpoint.
 *
 * @returns {{items: number, bytes: number, limit: number}} Cache stats.
 */
export function getGqlCacheStats() {
    return gqlCache.getStats();
}

/**
 * Purges all entries from the GraphQL cache.
 */
export function purgeGqlCache() {
    gqlCache.purge();
}

// ── Cache key generation ─────────────────────────────────────────────────────

/**
 * Generates a deterministic L2 cache key from a GraphQL operation.
 *
 * The POST body properties (query string and variables object) are
 * serialised and hashed with SHA-256 to produce a URL-safe key that
 * can be stored in the GET-only Cache API.
 *
 * @param {string} query - The GraphQL query string.
 * @param {Record<string, any>|undefined} variables - Operation variables.
 * @returns {Promise<string>} Cache key in the form "gql/{hex}".
 */
export async function graphqlCacheKey(query, variables) {
    const payload = JSON.stringify({ query, variables: variables || {} });
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        encoder.encode(payload)
    );
    const arr = new Uint8Array(digest);
    let hex = '';
    for (const byte of arr) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return `gql/${hex}`;
}

// ── SWR wrapper ──────────────────────────────────────────────────────────────

/**
 * Performs the full L1 → SWR → coalesce → L2 → queryFn flow for a
 * GraphQL operation.
 *
 * Delegates entirely to the generic withSWR() in core/swr.js, injecting
 * the GraphQL cache, sentinel, and TTL values. The caller only needs to
 * provide the cache key, execution context, and yoga query closure.
 *
 * Unlike the API worker, GraphQL has no entity version tracking (queries
 * span multiple entity types), so getVersion is not provided.
 *
 * @param {string} cacheKey - Deterministic cache key from graphqlCacheKey().
 * @param {ExecutionContext} ctx - Worker execution context for waitUntil().
 * @param {() => Promise<Uint8Array|null>} queryFn - Closure that executes
 *        yoga.fetch() and returns the response as a Uint8Array, or null
 *        on error.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1'|'L2'|'MISS', hits: number}>}
 */
export async function withGqlSWR(cacheKey, ctx, queryFn) {
    return withSWR({
        cache: gqlCache,
        cacheKey,
        ctx,
        ttlMs: GQL_TTL,
        negativeTtlMs: GQL_NEGATIVE_TTL,
        queryFn,
        tag: 'graphql',
        emptySentinel: GQL_EMPTY_SENTINEL,
    });
}
