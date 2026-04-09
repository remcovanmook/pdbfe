/**
 * @fileoverview Isolate-level rate limiter using the in-memory LRU cache.
 *
 * Exploits the fact that abusive traffic (scrapers, runaway scripts) tends
 * to hit a small number of Cloudflare PoPs, so the V8 isolate handling
 * those connections sees the full request volume. By tracking per-IP
 * request counts in isolate RAM, we can drop floods in sub-millisecond
 * time without any KV reads, external API calls, or billing.
 *
 * This will not stop a highly distributed botnet across thousands of IPs
 * and PoPs — that requires an enterprise WAF. It does neutralise the
 * common case: a single client looping requests against the API.
 *
 * Implementation notes:
 * - Uses a dedicated LRUCache instance (4000 slots, 1 MB, 60s TTL).
 * - Stores an empty buffer per IP; the count lives on the meta object.
 * - The LRU does not actively evict on TTL, so we check addedAt manually
 *   and reset the counter when the 60-second window expires.
 * - The shared _ret object from get() is consumed synchronously — no
 *   second get() call intervenes, so this is safe per cache.js contract.
 */

import { LRUCache } from '../core/cache.js';

/**
 * Rate limit window duration in milliseconds (60 seconds).
 * @type {number}
 */
const WINDOW_MS = 60_000;

/**
 * Max requests per window for authenticated callers (per isolate).
 * @type {number}
 */
const LIMIT_AUTHENTICATED = 5000;

/**
 * Max requests per window for anonymous callers (per isolate).
 * @type {number}
 */
const LIMIT_ANONYMOUS = 300;

/**
 * Shared empty buffer used for all rate limit entries.
 * Avoids allocating a new Uint8Array(0) on every counter reset.
 * @type {Uint8Array}
 */
const EMPTY_BUF = new Uint8Array(0);

/**
 * Dedicated LRU for rate limiting: 4000 IP slots, 1 MB ceiling, 60s TTL.
 * The byte ceiling is effectively unused since every entry stores EMPTY_BUF
 * (0 bytes), but the LRU constructor requires it.
 *
 * @type {LocalCache}
 */
const rlCache = LRUCache(4000, 1024 * 1024, WINDOW_MS);

/**
 * Checks whether an IP has exceeded its per-isolate request quota for the
 * current 60-second window.
 *
 * On first request from an IP, a counter entry is created in the LRU.
 * Subsequent requests increment the counter in-place on the meta object
 * (zero allocation). If the window has expired (addedAt > 60s ago), the
 * counter resets.
 *
 * @param {string} ip - Client IP address (typically from cf-connecting-ip).
 * @param {boolean} authenticated - Whether the caller has a valid session or API key.
 * @param {number} [now] - Current timestamp in ms. Defaults to Date.now().
 *     Exposed for testing — production callers should omit this.
 * @returns {boolean} True if the request should be rejected (rate limited).
 */
export function isRateLimited(ip, authenticated, now = Date.now()) {
    const limit = authenticated ? LIMIT_AUTHENTICATED : LIMIT_ANONYMOUS;

    const entry = rlCache.get(ip);
    if (entry) {
        // Window expired — reset counter for a fresh window.
        if (now - entry.addedAt > WINDOW_MS) {
            rlCache.add(ip, EMPTY_BUF, { count: 1 }, now);
            return false;
        }

        entry.meta.count++;
        return entry.meta.count > limit;
    }

    // First request from this IP in this isolate.
    rlCache.add(ip, EMPTY_BUF, { count: 1 }, now);
    return false;
}

/**
 * Returns current rate limiter cache statistics.
 * Useful for the admin /_cache_status endpoint.
 *
 * @returns {{items: number, bytes: number, limit: number}} Cache stats.
 */
export function getRateLimitStats() {
    return rlCache.getStats();
}

/**
 * Flushes all rate limit entries. Useful for admin cache flush
 * and for test isolation.
 */
export function purgeRateLimit() {
    rlCache.purge();
}
