/**
 * @fileoverview L2 per-PoP cache using Cloudflare's Cache API (caches.default).
 *
 * Sits between the per-isolate L1 LRU cache and D1. Multiple isolates
 * at the same PoP share this cache, so a cold isolate can skip D1
 * if another isolate at the same PoP already fetched the same key.
 *
 * The Cache API stores full Response objects keyed by URL. We construct
 * a synthetic URL from the normalised cache key, using the worker's own
 * origin (derived from the first incoming request) as the namespace.
 * TTL is controlled by the Cache-Control header on the stored Response.
 *
 * Flow: L1 (per-isolate) → L2 (per-PoP) → D1 (global)
 */

/**
 * Base URL prefix for synthetic cache keys. Derived from the first
 * incoming request's origin so the worker doesn't hardcode its own
 * domain. The /__l2/ path segment namespaces cache entries away from
 * real request paths.
 * @type {string}
 */
let _cachePrefix = '';

/**
 * Initialises the L2 cache origin from an incoming request URL.
 * Called once per isolate from the main fetch handler. Subsequent
 * calls are no-ops.
 *
 * @param {string} requestUrl - Any incoming request URL (e.g. "https://api.pdbfe.dev/api/net").
 */
export function initL2(requestUrl) {
    if (_cachePrefix) return;
    // Extract origin without constructing a URL object.
    // requestUrl is always "https://host/path..." — the origin is
    // everything before the first slash after "://".
    const schemeEnd = requestUrl.indexOf('://');
    const slashAfterHost = requestUrl.indexOf('/', schemeEnd + 3);
    const origin = slashAfterHost === -1 ? requestUrl : requestUrl.slice(0, slashAfterHost);
    _cachePrefix = origin + '/__l2/';
}

/**
 * Attempts to retrieve a cached payload from the per-PoP L2 cache.
 * Returns the raw bytes if found and not expired, or null on miss.
 *
 * @param {string} cacheKey - Normalised cache key (e.g. "api/net/694" or "api/net?country=NL&limit=50").
 * @returns {Promise<Uint8Array|null>} Cached payload bytes, or null on miss.
 */
export async function getL2(cacheKey) {
    if (!_cachePrefix) return null;
    try {
        const cfCache = /** @type {any} */(caches).default;
        const url = _cachePrefix + cacheKey;
        const response = await cfCache.match(url);
        if (!response) return null;

        const buf = new Uint8Array(await response.arrayBuffer());
        return buf;
    } catch {
        // Cache API unavailable (e.g. local dev) — degrade to miss
        return null;
    }
}

/**
 * Writes a payload to the per-PoP L2 cache with a specified TTL.
 * Non-blocking — errors are silently swallowed since L2 is optional.
 *
 * @param {string} cacheKey - Normalised cache key.
 * @param {Uint8Array} buf - JSON payload bytes to cache.
 * @param {number} ttlSeconds - Cache-Control max-age in seconds.
 * @returns {Promise<void>}
 */
export async function putL2(cacheKey, buf, ttlSeconds) {
    if (!_cachePrefix) return;
    try {
        const cfCache = /** @type {any} */(caches).default;
        const url = _cachePrefix + cacheKey;
        const response = new Response(/** @type {BodyInit} */(/** @type {unknown} */(buf)), {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': `public, max-age=${ttlSeconds}`,
                'Content-Length': buf.byteLength.toString(),
            }
        });
        await cfCache.put(url, response);
    } catch {
        // Cache API unavailable — skip silently
    }
}
