/**
 * @fileoverview L2 per-PoP cache using Cloudflare's Cache API (caches.default).
 *
 * Sits between the per-isolate L1 LRU cache and D1. Multiple isolates
 * at the same PoP share this cache, so a cold isolate can skip D1
 * if another isolate at the same PoP already fetched the same key.
 *
 * The Cache API stores full Response objects keyed by URL. We construct
 * a synthetic URL from the normalised cache key. TTL is controlled by
 * the Cache-Control header on the stored Response.
 *
 * Flow: L1 (per-isolate) → L2 (per-PoP) → D1 (global)
 */

/**
 * Base URL used to construct synthetic cache keys for the Cache API.
 * Never hits the network — only used as a namespace for cache lookups.
 * @type {string}
 */
const CACHE_ORIGIN = 'https://api.pdbfe.dev/__l2/';

/**
 * Attempts to retrieve a cached payload from the per-PoP L2 cache.
 * Returns the raw bytes if found and not expired, or null on miss.
 *
 * @param {string} cacheKey - Normalised cache key (e.g. "api/net/694" or "api/net?country=NL&limit=50").
 * @returns {Promise<Uint8Array|null>} Cached payload bytes, or null on miss.
 */
export async function getL2(cacheKey) {
    try {
        const cfCache = /** @type {any} */(caches).default;
        const url = CACHE_ORIGIN + cacheKey;
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
    try {
        const cfCache = /** @type {any} */(caches).default;
        const url = CACHE_ORIGIN + cacheKey;
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
