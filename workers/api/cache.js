/**
 * @fileoverview Per-entity LRU cache instances for the PeeringDB API worker.
 * Each entity type gets its own cache with slot counts and max sizes
 * proportional to its data volume. Stores pre-encoded Uint8Array JSON
 * payloads — cache hits serve bytes directly with zero serialisation cost.
 *
 * Cache tiers:
 *   Heavy  (net, org, netixlan):  1024 slots, 16 MB
 *   Medium (netfac, poc, fac):     256 slots,  4 MB
 *   Light  (everything else):      128 slots,  2 MB
 *
 * Total budget: 76 MB, leaving ~52 MB for working memory and future
 * pre-cooked answer caches.
 */

import { LRUCache } from '../core/cache.js';
import { ENTITY_TAGS } from './entities.js';

const MB = 1024 * 1024;

/**
 * TTL for list endpoint responses (5 minutes).
 * @type {number}
 */
export const LIST_TTL = 5 * 60 * 1000;

/**
 * TTL for detail (single-row) responses (15 minutes).
 * @type {number}
 */
export const DETAIL_TTL = 15 * 60 * 1000;

/**
 * TTL for count responses (15 minutes).
 * Counts are eventually consistent — they change slowly enough
 * that a longer TTL is acceptable.
 * @type {number}
 */
export const COUNT_TTL = 15 * 60 * 1000;

/**
 * Cache tier configuration. Entities not listed here default to the
 * light tier (128 slots, 2 MB).
 *
 * @type {Record<string, {slots: number, maxSize: number}>}
 */
const TIERS = {
    net:      { slots: 1024, maxSize: 16 * MB },
    org:      { slots: 1024, maxSize: 16 * MB },
    netixlan: { slots: 1024, maxSize: 16 * MB },
    netfac:   { slots: 256,  maxSize: 4 * MB },
    poc:      { slots: 256,  maxSize: 4 * MB },
    fac:      { slots: 256,  maxSize: 4 * MB },
};

const DEFAULT_TIER = { slots: 128, maxSize: 2 * MB };

/**
 * Per-entity cache instances. Keyed by entity tag.
 * @type {Record<string, LocalCache>}
 */
const caches = {};

// Initialise one LRU cache per entity tag
for (const tag of ENTITY_TAGS) {
    const tier = TIERS[tag] || DEFAULT_TIER;
    caches[tag] = LRUCache(tier.slots, tier.maxSize, LIST_TTL);
}

// Special cache for as_set lookups
caches["as_set"] = LRUCache(DEFAULT_TIER.slots, DEFAULT_TIER.maxSize, DETAIL_TTL);

/**
 * Returns the LRU cache instance for the given entity tag.
 *
 * @param {string} tag - Entity tag (e.g. "net", "org").
 * @returns {LocalCache} The entity's cache instance.
 */
export function getEntityCache(tag) {
    return caches[tag];
}

/**
 * Aggregates cache statistics across all entity caches.
 * Used by the admin /health and /_cache_status endpoints.
 *
 * @returns {{entities: Record<string, {items: number, bytes: number, limit: number}>, totals: {items: number, bytes: number, limit: number}}} Stats per entity and totals.
 */
export function getCacheStats() {
    /** @type {Record<string, {items: number, bytes: number, limit: number}>} */
    const entities = {};
    let totalItems = 0;
    let totalBytes = 0;
    let totalLimit = 0;

    for (const tag in caches) {
        const stats = caches[tag].getStats();
        entities[tag] = stats;
        totalItems += stats.items;
        totalBytes += stats.bytes;
        totalLimit += stats.limit;
    }

    return {
        entities,
        totals: { items: totalItems, bytes: totalBytes, limit: totalLimit }
    };
}

/**
 * Flushes all entity caches. Used by the admin /_cache_flush endpoint.
 */
export function purgeAllCaches() {
    for (const tag in caches) {
        caches[tag].purge();
    }
}

/**
 * Flushes a single entity's cache. Useful after sync updates.
 *
 * @param {string} tag - Entity tag to flush.
 */
export function purgeEntityCache(tag) {
    if (caches[tag]) {
        caches[tag].purge();
    }
}
