/**
 * @fileoverview API-specific HTTP response helpers.
 *
 * Inherits the generic building blocks from core/http.js and layers
 * API-specific header sets on top. The VERSIONS-dependent H_API header
 * (with X-App-Version, Allow, and Cache-Control) lives here so that
 * core/http.js has no dependency on the api/ layer.
 *
 * Consumers within api/ should import from this module instead of
 * core/http.js for API-specific symbols.
 */

import { VERSIONS } from './entities.js';
import { H_CORS, H_NOCACHE, generateETag, isNotModified, lastModifiedHeader } from '../core/http.js';

// Re-export core symbols that api/ modules also need, so they can
// import everything from a single api/http.js entry point.
export { encoder, encodeJSON, jsonError, handlePreflight, generateETag, isNotModified, H_CORS, H_NOCACHE, lastModifiedHeader, isNotModifiedSince } from '../core/http.js';

/**
 * Standard cache headers for API responses.
 * Responses are public-cacheable for 60s with stale-while-revalidate.
 * Includes the API schema version from the entity registry.
 *
 * This set is the *anonymous* default: `public` makes it edge-cacheable
 * (Workers Cache / shared caches). Authenticated responses must NOT be
 * public — see H_API_AUTH. serveJSON() defaults baseHeaders to H_API, so
 * any caller that omits baseHeaders emits an anonymous, public response.
 */
export const H_API = Object.freeze({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60, stale-while-revalidate=30",
    // Vary on Authorization so the edge keys the anonymous (public) variant
    // separately from any authenticated request. Without it, a request
    // carrying Authorization is served the cached anon response on a HIT (the
    // Worker never runs, so the `private` on H_API_AUTH never takes effect).
    // With it, Authorization-bearing requests miss the anon variant and run
    // the Worker, returning their own `private`, un-stored response. No
    // hit-rate cost: authenticated responses are never edge-stored anyway.
    "Vary": "Authorization",
    "Allow": "GET, HEAD, OPTIONS",
    "X-App-Version": VERSIONS.api_schema,
    ...H_CORS
});

/**
 * Pre-cooked API header sets with X-Auth-Status baked in.
 * Handlers select the right one based on caller authentication,
 * avoiding per-request Response cloning.
 *
 * H_API_AUTH overrides Cache-Control to `private`: authenticated responses
 * (API-key OR session) must never be stored in a shared/edge cache. `private`
 * triggers edge BYPASS and removes the RFC 9111 §3.5 store-on-`public` path,
 * while the browser keeps the same max-age/SWR/ETag behaviour. X-Auth-Id in a
 * per-user private cache carries no replay risk.
 *
 * H_API_ANON stays `public` (inherited from H_API) — anonymous responses are
 * edge-cacheable.
 */
export const H_API_AUTH = Object.freeze({
    ...H_API,
    "Cache-Control": "private, max-age=60, stale-while-revalidate=30",
    "X-Auth-Status": "authenticated",
});
export const H_API_ANON = Object.freeze({ ...H_API, "X-Auth-Status": "unauthenticated" });

/**
 * Pre-cooked no-cache header sets with X-Auth-Status baked in.
 */
export const H_NOCACHE_AUTH = Object.freeze({ ...H_NOCACHE, "X-Auth-Status": "authenticated" });
export const H_NOCACHE_ANON = Object.freeze({ ...H_NOCACHE, "X-Auth-Status": "unauthenticated" });

/** Default cache metadata for responses that bypassed all cache tiers. */
const DEFAULT_META = Object.freeze({ tier: /** @type {import('./cache.js').CacheTier} */ ('MISS'), hits: 0 });

/**
 * Serves a Uint8Array of pre-encoded JSON bytes as an HTTP Response.
 * Handles ETag generation and 304 Not Modified checks. On a cache hit,
 * the buf is forwarded directly — no JSON.parse or JSON.stringify.
 *
 * Optional `lastModifiedMs` and `authId` params bake Last-Modified and
 * X-Auth-Id directly into the initial header dict, avoiding a subsequent
 * Response repack (new Headers + new Response) on the hot path.
 *
 * @param {Request} request - The inbound HTTP request (for conditional headers).
 * @param {Uint8Array} buf - Pre-encoded JSON payload bytes.
 * @param {{tier: import('./cache.js').CacheTier, hits: number}} [meta] - Cache metadata for X-Cache headers.
 * @param {Record<string, string>} [baseHeaders] - Base header set. Defaults to H_API;
 *        pass H_API_AUTH or H_API_ANON to bake in X-Auth-Status without cloning.
 * @param {number} [lastModifiedMs] - Entity last-modified epoch ms. When >0, sets Last-Modified.
 * @param {number|null} [authId] - Authenticated user ID. When non-null, sets X-Auth-Id.
 * @returns {Response} The HTTP response ready for the client.
 */
export function serveJSON(request, buf, meta = DEFAULT_META, baseHeaders = H_API, lastModifiedMs = 0, authId = null) {
    const etag = generateETag(buf);

    /** @type {Record<string, string>} */
    const extra = {};
    if (lastModifiedMs > 0) extra['Last-Modified'] = lastModifiedHeader(lastModifiedMs);
    if (authId !== null) {
        // X-Auth-Id is per-user and must only ride the `private` H_API_AUTH set.
        // Guard against a future call site pairing authId with a cacheable
        // (public) header set, which would edge-store a per-user identifier.
        if (baseHeaders !== H_API_AUTH) {
            throw new Error('serveJSON: authId requires H_API_AUTH (private) headers');
        }
        extra['X-Auth-Id'] = `u${authId}`;
    }

    if (isNotModified(request.headers, etag)) {
        return new Response(null, {
            status: 304,
            headers: {
                ...baseHeaders,
                ...extra,
                "ETag": etag,
                "X-Cache": meta.tier,
                "X-Cache-Hits": meta.hits.toString()
            }
        });
    }

    return new Response(/** @type {BodyInit} */(/** @type {unknown} */(buf)), {
        status: 200,
        headers: {
            ...baseHeaders,
            ...extra,
            "ETag": etag,
            "Content-Length": buf.byteLength.toString(),
            "X-Cache": meta.tier,
            "X-Cache-Hits": meta.hits.toString()
        }
    });
}

/**
 * Adds a Last-Modified header to an existing response. Constructs a
 * new Response to work around frozen header objects on cached responses.
 * Returns the original response unchanged if epochMs is falsy (0 or undefined).
 *
 * @param {Response} response - The original response.
 * @param {number} epochMs - Last-modified epoch in milliseconds.
 * @returns {Response} New response with Last-Modified header, or the original.
 */
export function withLastModified(response, epochMs) {
    if (!epochMs) return response;
    const h = new Headers(response.headers);
    h.set('Last-Modified', lastModifiedHeader(epochMs));
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: h
    });
}
