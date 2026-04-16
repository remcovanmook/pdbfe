/**
 * @fileoverview Isolate-level rate limiter factory using the in-memory LRU cache.
 *
 * Provides a `createRateLimiter()` factory that returns an independent rate
 * limiter instance. Each worker (API, GraphQL, REST) creates its own instance
 * with worker-specific thresholds.
 *
 * Exploits the fact that abusive traffic (scrapers, runaway scripts) tends
 * to hit a small number of Cloudflare PoPs, so the V8 isolate handling
 * those connections sees the full request volume. By tracking per-caller
 * request counts in isolate RAM, we can drop floods in sub-millisecond
 * time without any KV reads, external API calls, or billing.
 *
 * IPv6 addresses are truncated to /64 prefixes before rate limiting.
 * A typical subscriber receives a /48 to /64 allocation, so individual
 * addresses within the block should share one rate limit bucket.
 */

import { LRUCache } from './cache.js';

/**
 * Normalises a client IP address for rate limiting.
 * IPv6 addresses are truncated to their /64 prefix (first 4 groups)
 * because a single subscriber typically receives a /48 to /64 block
 * and can rotate freely within it. Grouping by /64 ensures address
 * rotation within an allocation shares one rate limit bucket.
 *
 * IPv4 addresses are returned unchanged.
 *
 * @param {string} ip - Raw IP address from cf-connecting-ip.
 * @returns {string} Normalised rate limit key (IPv4 as-is, IPv6 /64 prefix).
 */
export function normaliseIP(ip) {
    if (!ip.includes(':')) return ip;

    // Split on :: to handle compressed notation.
    const halves = ip.split('::'); // ap-ok: simple two-part split on known delimiter

    if (halves.length === 1) {
        // Full notation — split and take first 4 groups.
        return ip.split(':').slice(0, 4).join(':'); // ap-ok: simple group extraction
    }

    // Expand :: by inserting zero groups to fill 8 total.
    const head = halves[0] ? halves[0].split(':') : []; // ap-ok: group extraction from head
    const tail = halves[1] ? halves[1].split(':') : []; // ap-ok: group extraction from tail
    const zeros = new Array(8 - head.length - tail.length).fill('0'); // ap-ok: zero-fill for :: expansion
    const full = [...head, ...zeros, ...tail]; // ap-ok: reassemble expanded groups
    return full.slice(0, 4).join(':');
}

/**
 * Shared empty buffer used for all rate limit entries.
 * Avoids allocating a new Uint8Array(0) on every counter reset.
 * @type {Uint8Array}
 */
const EMPTY_BUF = new Uint8Array(0);

/**
 * @typedef {Object} RateLimiterOpts
 * @property {number} slots - LRU slot count for tracking callers.
 * @property {number} maxBytes - LRU byte ceiling (effectively unused, but required by constructor).
 * @property {number} windowMs - Sliding window duration in milliseconds.
 * @property {number} limitAnon - Max requests per window for anonymous callers.
 * @property {number} limitAuth - Max requests per window for authenticated callers.
 */

/**
 * @typedef {Object} RateLimiter
 * @property {(key: string, authenticated: boolean, now?: number) => boolean} isRateLimited
 *   Returns true if the caller should be rejected.
 * @property {() => {items: number, bytes: number, limit: number}} getStats
 *   Returns current cache statistics.
 * @property {() => void} purge - Flushes all rate limit entries.
 */

/**
 * Creates an independent rate limiter instance with the given thresholds.
 *
 * Each worker creates its own instance so rate limits are scoped to that
 * worker's isolate. The returned object exposes `isRateLimited`, `getStats`,
 * and `purge` methods.
 *
 * @param {RateLimiterOpts} opts - Rate limiter configuration.
 * @returns {RateLimiter} A rate limiter instance.
 */
export function createRateLimiter({ slots, maxBytes, windowMs, limitAnon, limitAuth }) {
    const rlCache = LRUCache(slots, maxBytes, windowMs);

    return {
        /**
         * Checks whether a caller has exceeded its per-isolate request quota
         * for the current window.
         *
         * For anonymous callers, pass the raw client IP as the key — it is
         * normalised internally (IPv6 truncated to /64). For authenticated
         * callers, pass the API key or session ID directly.
         *
         * @param {string} key - Rate limit bucket key.
         * @param {boolean} authenticated - Whether the caller has a valid session or API key.
         * @param {number} [now] - Current timestamp in ms. Defaults to Date.now().
         * @returns {boolean} True if the request should be rejected.
         */
        isRateLimited(key, authenticated, now = Date.now()) {
            const limit = authenticated ? limitAuth : limitAnon;
            const k = authenticated ? key : normaliseIP(key);

            const entry = rlCache.get(k);
            if (entry) {
                if (now - entry.addedAt > windowMs) {
                    rlCache.add(k, EMPTY_BUF, { count: 1 }, now);
                    return false;
                }
                entry.meta.count++;
                return entry.meta.count > limit;
            }

            rlCache.add(k, EMPTY_BUF, { count: 1 }, now);
            return false;
        },

        /**
         * Returns current rate limiter cache statistics.
         *
         * @returns {{items: number, bytes: number, limit: number}} Cache stats.
         */
        getStats() {
            return rlCache.getStats();
        },

        /**
         * Flushes all rate limit entries.
         */
        purge() {
            rlCache.purge();
        },
    };
}
