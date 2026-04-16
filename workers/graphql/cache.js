/**
 * @fileoverview GraphQL-specific LRU cache tier configuration.
 *
 * Provides a single cache tier for GraphQL query results, keyed by
 * operation hash. Fewer slots but a larger byte budget than the API
 * worker, since GraphQL queries tend to return deeper result sets.
 */

import { LRUCache } from '../core/cache.js';

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
 * Single LRU cache instance for all GraphQL operations.
 * 512 slots, 8 MB byte budget.
 * @type {LocalCache}
 */
const gqlCache = LRUCache(512, 8 * 1024 * 1024, GQL_TTL);

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
