/**
 * @fileoverview Isolate-level rate limiter using the in-memory LRU cache.
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
 *
 * This will not stop a highly distributed botnet across thousands of IPs
 * and PoPs — that requires an enterprise WAF. It does neutralise the
 * common case: a single client looping requests against the API.
 *
 * Implementation notes:
 * - Uses a dedicated LRUCache instance (4000 slots, 1 MB, 60s TTL).
 * - Stores an empty buffer per entry; the count lives on the meta object.
 * - The LRU does not actively evict on TTL, so we check addedAt manually
 *   and reset the counter when the 60-second window expires.
 * - The shared _ret object from get() is consumed synchronously — no
 *   second get() call intervenes, so this is safe per cache.js contract.
 */

import { LRUCache } from '../core/cache.js';

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
 * Rate limit window duration in milliseconds (60 seconds).
 * @type {number}
 */
const WINDOW_MS = 60_000;

/**
 * Max requests per window for authenticated callers (per isolate).
 * With ~50-60 req/s isolate throughput, 600/min is roughly 10 req/s
 * sustained — generous for legitimate use, tight enough to protect D1.
 * @type {number}
 */
const LIMIT_AUTHENTICATED = 600;

/**
 * Max requests per window for anonymous callers (per isolate).
 * One request per second sustained. Enough for casual browsing and
 * light scripting; anything heavier should use an API key.
 * @type {number}
 */
const LIMIT_ANONYMOUS = 60;

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
 * Checks whether a caller has exceeded its per-isolate request quota for
 * the current 60-second window.
 *
 * For anonymous callers, pass the raw client IP as the key — it is
 * normalised internally (IPv6 truncated to /64). For authenticated
 * callers, pass the API key or session ID directly.
 *
 * On first request, a counter entry is created in the LRU. Subsequent
 * requests increment the counter in-place on the meta object (zero
 * allocation). If the window has expired (addedAt > 60s ago), the
 * counter resets.
 *
 * @param {string} key - Rate limit bucket key (raw IP for anonymous, identity for authenticated).
 * @param {boolean} authenticated - Whether the caller has a valid session or API key.
 * @param {number} [now] - Current timestamp in ms. Defaults to Date.now().
 *     Exposed for testing — production callers should omit this.
 * @returns {boolean} True if the request should be rejected (rate limited).
 */
export function isRateLimited(key, authenticated, now = Date.now()) {
    const limit = authenticated ? LIMIT_AUTHENTICATED : LIMIT_ANONYMOUS;
    // Anonymous keys are raw IPs — normalise IPv6 to /64 so address
    // rotation within a subscriber's allocation shares one bucket.
    const k = authenticated ? key : normaliseIP(key);

    const entry = rlCache.get(k);
    if (entry) {
        // Window expired — reset counter for a fresh window.
        if (now - entry.addedAt > WINDOW_MS) {
            rlCache.add(k, EMPTY_BUF, { count: 1 }, now);
            return false;
        }

        entry.meta.count++;
        return entry.meta.count > limit;
    }

    // First request from this caller in this isolate.
    rlCache.add(k, EMPTY_BUF, { count: 1 }, now);
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
