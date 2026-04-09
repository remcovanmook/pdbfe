/**
 * @fileoverview Per-entity LRU cache instances for the PeeringDB API worker.
 * Each entity type gets its own cache with slot counts and max sizes
 * proportional to its query cardinality and response sizes. Stores
 * pre-encoded Uint8Array JSON payloads — cache hits serve bytes directly
 * with zero serialisation cost.
 *
 * Cache tiers are sized based on measured response data (April 2026):
 *
 *   Entity      Avg Response   Outlier           Slots   Max
 *   ──────────  ────────────   ────────────────  ─────   ────
 *   net         1-24 KB        depth=2: 200 KB   1024    16 MB
 *   netixlan    1-7 KB         big ASN: 157 KB   2048    16 MB
 *   netfac      2-5 KB         big net: 37 KB     512     8 MB
 *   fac         1-19 KB        —                  512     4 MB
 *   ix          1-20 KB        —                  512     4 MB
 *   org         0.1-10 KB      depth=2: 314 KB    512     8 MB
 *   poc         0.05-0.5 KB    —                  256     1 MB
 *   light tier  0.2 KB         —                  128     1 MB
 *
 * Slot counts prioritise query cardinality: entities with many filter
 * combinations (asn, ix_id, fac_id, cross-entity filters) get more
 * slots. Byte budgets are sized for the measured outlier responses,
 * not the average — a single netixlan?asn={big ASN} can be 157 KB.
 *
 * Total budget: ~59 MB, leaving ~69 MB of the 128 MB isolate for
 * working memory, V8 heap, and the D1 query pipeline.
 */

import { LRUCache } from '../core/cache.js';
import { ENTITY_TAGS } from './entities.js';

const MB = 1024 * 1024;

/**
 * TTL for list endpoint responses (60 minutes).
 * With background sync invalidation (sync_state.js), data freshness
 * is handled by the 15s poll loop. TTL is an upper bound for entries
 * that survive without invalidation (e.g. if polling is delayed).
 * @type {number}
 */
export const LIST_TTL = 60 * 60 * 1000;

/**
 * TTL for detail (single-row) responses (60 minutes).
 * @type {number}
 */
export const DETAIL_TTL = 60 * 60 * 1000;

/**
 * TTL for count responses (60 minutes).
 * Counts are derived from the same entity data; invalidation
 * purges them along with list/detail entries.
 * @type {number}
 */
export const COUNT_TTL = 60 * 60 * 1000;

/**
 * TTL for negative (404) responses (5 minutes).
 * Shorter than detail TTL since entities can be created at any time.
 * Prevents repeated D1 queries for the same non-existent ID.
 * @type {number}
 */
export const NEGATIVE_TTL = 5 * 60 * 1000;


/**
 * Cache tier configuration per entity. Sized by two factors:
 *
 *   slots:   query cardinality — how many unique filter combinations
 *            are expected. Entities queryable by ASN, net_id, ix_id,
 *            fac_id, and cross-entity filters get more slots.
 *
 *   maxSize: byte budget — based on measured response outliers.
 *            A single netixlan?asn=13335 (Cloudflare) is 157 KB.
 *            A single net?asn=13335&depth=2 is 200 KB.
 *            A single org?id=X&depth=2 can reach 314 KB.
 *
 * Entities not listed here use the light tier (128 slots, 1 MB).
 *
 * @type {Record<string, {slots: number, maxSize: number}>}
 */
const TIERS = {
    // High cardinality: ASN lookups, IX participant lists, cross-entity filters.
    // depth=2 produces 200KB responses; filtered lists average 1-24KB.
    net:      { slots: 1024, maxSize: 16 * MB },

    // Highest cardinality: queried by asn, net_id, ix_id, ixlan_id.
    // Big-ASN responses reach 157KB (Cloudflare: 411 IX connections).
    netixlan: { slots: 2048, maxSize: 16 * MB },

    // High cardinality: queried by net_id, fac_id. Big-carrier
    // responses reach 37KB (167 facilities for a single network).
    netfac:   { slots: 512,  maxSize: 8 * MB },

    // Mid cardinality: cross-entity filter target (fac__state, fac__country).
    // Filtered lists average 1-19KB; detail pages ~4KB with depth.
    fac:      { slots: 512,  maxSize: 4 * MB },

    // Mid cardinality: regional queries (region_continent), cross-entity
    // filter target (ix__name). Filtered lists average 1-20KB.
    ix:       { slots: 512,  maxSize: 4 * MB },

    // Lower cardinality but depth=2 outlier: a single large org
    // expands to 314KB with all nets/facs/IXs. Most responses <10KB.
    org:      { slots: 512,  maxSize: 8 * MB },

    // Low cardinality: queried by net_id + role. Responses are tiny
    // (0.05-0.5KB). 1MB is enough for 2000+ entries.
    poc:      { slots: 256,  maxSize: 1 * MB },
};

/** Light tier for low-traffic entities: ixlan, ixpfx, ixfac, carrier, carrierfac, campus. */
const DEFAULT_TIER = { slots: 128, maxSize: 1 * MB };

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
 * Normalises a cache key from a URL path and query string.
 * Sorts query parameters alphabetically to ensure that identical
 * queries with different parameter orderings hit the same cache slot.
 *
 * @param {string} path - The URL path (e.g. "api/net").
 * @param {string} queryString - Raw query string without leading '?'.
 * @returns {string} Normalised cache key.
 */
export function normaliseCacheKey(path, queryString) {
    if (!queryString) return path;
    const sorted = queryString.split("&").sort().join("&"); // ap-ok: bounded by URL length
    return `${path}?${sorted}`;
}
