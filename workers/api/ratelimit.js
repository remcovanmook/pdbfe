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
 * Handles :: compressed notation without allocating intermediate arrays —
 * uses indexOf/substring/charCodeAt loops to walk the string directly.
 *
 * @param {string} ip - Raw IP address from cf-connecting-ip.
 * @returns {string} Normalised rate limit key (IPv4 as-is, IPv6 /64 prefix).
 */
export function normaliseIP(ip) {
    // No colon → IPv4 or fallback like 'unknown'. Return as-is.
    if (!ip.includes(':')) return ip;

    const dc = ip.indexOf('::');

    if (dc === -1) {
        // Full notation — return everything before the 4th colon.
        // e.g. 2001:0db8:85a3:0000:... → 2001:0db8:85a3:0000
        let pos = 0;
        for (let i = 0; i < 3; i++) {
            const c = ip.indexOf(':', pos);
            if (c === -1) return ip;
            pos = c + 1;
        }
        const end = ip.indexOf(':', pos);
        return end === -1 ? ip : ip.substring(0, end);
    }

    // Compressed notation (::). Count head groups before :: by
    // counting colon characters in ip[0..dc-1].
    let headGroups = 0;
    if (dc > 0) {
        headGroups = 1;
        for (let i = 0; i < dc; i++) {
            if (ip.charCodeAt(i) === 58) headGroups++; // ':'
        }
    }

    // If 4+ groups exist before ::, extract only those.
    if (headGroups >= 4) {
        let pos = 0;
        for (let i = 0; i < 3; i++) {
            pos = ip.indexOf(':', pos) + 1;
        }
        const end = ip.indexOf(':', pos);
        return end === -1 ? ip.substring(0, dc) : ip.substring(0, end);
    }

    // Fewer than 4 head groups — pad with zeros from the :: expansion.
    // Count tail groups to determine the zero-fill count.
    let tailGroups = 0;
    const tailStart = dc + 2;
    if (tailStart < ip.length) {
        tailGroups = 1;
        for (let i = tailStart; i < ip.length; i++) {
            if (ip.charCodeAt(i) === 58) tailGroups++;
        }
    }
    const zeroCount = 8 - headGroups - tailGroups;

    // Build result: head groups from ip[0..dc-1].
    let result = headGroups > 0 ? ip.substring(0, dc) : '';
    let filled = headGroups;

    // Append zero-fill groups from ::.
    const zerosToAdd = Math.min(4 - filled, zeroCount);
    for (let i = 0; i < zerosToAdd; i++) {
        result += filled > 0 ? ':0' : '0';
        filled++;
    }

    // If still under 4 groups, take from the tail (rare: >4 tail groups).
    if (filled < 4 && tailGroups > 0) {
        let pos = tailStart;
        while (filled < 4 && pos < ip.length) {
            const c = ip.indexOf(':', pos);
            result += filled > 0 ? ':' : '';
            result += c === -1 ? ip.substring(pos) : ip.substring(pos, c);
            filled++;
            if (c === -1) break;
            pos = c + 1;
        }
    }

    return result;
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
