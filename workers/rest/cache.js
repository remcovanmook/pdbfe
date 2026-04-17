/**
 * @fileoverview REST-specific LRU cache tier configuration.
 *
 * Provides a single cache tier for REST API responses, keyed by
 * normalised /v1/ URL paths. Separate instance from the API worker
 * to avoid cross-contamination of cache namespaces.
 */

import { LRUCache } from '../core/cache.js';

/**
 * Cache TTL for REST responses (60 minutes).
 * Matches the API worker's DETAIL_TTL.
 * @type {number}
 */
export const REST_TTL = 60 * 60 * 1000;

/**
 * Negative cache TTL for 404 / empty results (30 seconds).
 * @type {number}
 */
export const REST_NEGATIVE_TTL = 30_000;

/**
 * Single LRU cache instance for all REST operations.
 * 1024 slots, 32 MB byte budget. REST responses mirror the API
 * worker's output format so size characteristics are similar.
 * @type {LocalCache}
 */
const restCache = LRUCache(1024, 32 * 1024 * 1024, REST_TTL);

/**
 * Returns the REST cache instance.
 *
 * @returns {LocalCache} The cache instance.
 */
export function getRestCache() {
    return restCache;
}

/**
 * Returns cache statistics for the admin/health endpoint.
 *
 * @returns {{items: number, bytes: number, limit: number}} Cache stats.
 */
export function getRestCacheStats() {
    return restCache.getStats();
}

/**
 * Purges all entries from the REST cache.
 */
export function purgeRestCache() {
    restCache.purge();
}
