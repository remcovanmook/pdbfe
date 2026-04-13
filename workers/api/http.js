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
 */
export const H_API = Object.freeze({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60, stale-while-revalidate=30",
    "Allow": "GET, HEAD, OPTIONS",
    "X-App-Version": VERSIONS.api_schema,
    ...H_CORS
});

/**
 * Pre-cooked API header sets with X-Auth-Status baked in.
 * Handlers select the right one based on caller authentication,
 * avoiding per-request Response cloning.
 */
export const H_API_AUTH = Object.freeze({ ...H_API, "X-Auth-Status": "authenticated" });
export const H_API_ANON = Object.freeze({ ...H_API, "X-Auth-Status": "unauthenticated" });

/**
 * Pre-cooked no-cache header sets with X-Auth-Status baked in.
 */
export const H_NOCACHE_AUTH = Object.freeze({ ...H_NOCACHE, "X-Auth-Status": "authenticated" });
export const H_NOCACHE_ANON = Object.freeze({ ...H_NOCACHE, "X-Auth-Status": "unauthenticated" });

/**
 * Serves a Uint8Array of pre-encoded JSON bytes as an HTTP Response.
 * Handles ETag generation and 304 Not Modified checks. On a cache hit,
 * the buf is forwarded directly — no JSON.parse or JSON.stringify.
 *
 * @param {Request} request - The inbound HTTP request (for conditional headers).
 * @param {Uint8Array} buf - Pre-encoded JSON payload bytes.
 * @param {{tier: import('./pipeline.js').CacheTier, hits: number}} [meta] - Cache metadata for X-Cache headers.
 * @param {Record<string, string>} [baseHeaders] - Base header set. Defaults to H_API;
 *        pass H_API_AUTH or H_API_ANON to bake in X-Auth-Status without cloning.
 * @returns {Response} The HTTP response ready for the client.
 */
export function serveJSON(request, buf, meta = { tier: 'MISS', hits: 0 }, baseHeaders = H_API) {
    const etag = generateETag(buf);

    if (isNotModified(request.headers, etag)) {
        return new Response(null, {
            status: 304,
            headers: {
                ...baseHeaders,
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
