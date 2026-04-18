/**
 * @fileoverview GraphQL-worker SWR wrapper.
 *
 * Thin adapter over core/swr.js that pre-fills GraphQL-specific defaults:
 * the gql LRU cache, GQL_EMPTY_SENTINEL, and fixed TTL values.
 *
 * Unlike the API worker, GraphQL has no entity version tracking (queries
 * span multiple entity types), so getVersion is not provided.
 */

import { withSWR } from '../core/swr.js';
import { getGqlCache, GQL_TTL, GQL_NEGATIVE_TTL } from './cache.js';
import { encoder } from '../core/http.js';

/**
 * Sentinel value representing a cached empty/error GraphQL result.
 * Different from the API worker's EMPTY_ENVELOPE because GraphQL
 * responses use {data, errors} shape rather than {data, meta}.
 * @type {Uint8Array}
 */
export const GQL_EMPTY_SENTINEL = encoder.encode('{"data":null,"errors":[]}');

/**
 * Performs the full L1 → SWR → coalesce → L2 → queryFn flow for a
 * GraphQL operation.
 *
 * Delegates entirely to the generic withSWR() in core/swr.js, injecting
 * the GraphQL cache, sentinel, and TTL values. The caller only needs to
 * provide the cache key, execution context, and yoga query closure.
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
        cache: getGqlCache(),
        cacheKey,
        ctx,
        ttlMs: GQL_TTL,
        negativeTtlMs: GQL_NEGATIVE_TTL,
        queryFn,
        tag: 'graphql',
        emptySentinel: GQL_EMPTY_SENTINEL,
    });
}
