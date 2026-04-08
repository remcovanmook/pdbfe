/**
 * @fileoverview HTTP response helpers for JSON API responses.
 * Handles ETag generation, 304 Not Modified, CORS preflight,
 * and raw Uint8Array forwarding for zero-serialisation cache hits.
 */

/**
 * Shared TextEncoder instance. Exported so modules that need to
 * encode strings to Uint8Array don't each create their own copy.
 * TextEncoder is stateless and reentrant.
 */
export const encoder = new TextEncoder();

/**
 * Precompiled CORS headers applied to every API response.
 * Frozen to prevent accidental mutation.
 *
 * Uses wildcard origin (`*`) deliberately:
 *   - Browser requests go through the Cloudflare Pages proxy (same-origin),
 *     so CORS is never triggered for the primary frontend.
 *   - Cross-origin API consumers use `Authorization: Api-Key` headers,
 *     not cookies, so `Access-Control-Allow-Credentials` is not needed.
 *   - Session cookies (pdbfe_sid) are handled by the auth worker, which
 *     sets its own CORS headers with the specific frontend origin.
 */
export const H_CORS = Object.freeze({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "X-Cache, X-Cache-Hits, X-Timer, X-Served-By, X-Isolate-ID, ETag"
});

/**
 * Standard cache headers for API responses.
 * Responses are public-cacheable for 60s with stale-while-revalidate.
 */
export const H_API = Object.freeze({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60, stale-while-revalidate=30",
    ...H_CORS
});

/**
 * Headers for responses that should not be cached.
 */
export const H_NOCACHE = Object.freeze({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...H_CORS
});

/**
 * Precompiled CORS preflight response. Returned for all OPTIONS requests
 * to /api/* paths without hitting any handler logic.
 */
const PREFLIGHT_RESPONSE_INIT = Object.freeze({
    status: 204,
    headers: H_CORS
});

/**
 * Returns a precompiled CORS preflight response (204 No Content).
 * No body, no handler logic — just the frozen headers.
 *
 * @returns {Response} CORS preflight response.
 */
export function handlePreflight() {
    return new Response(null, PREFLIGHT_RESPONSE_INIT);
}

/**
 * Generates a weak ETag from a Uint8Array payload using a fast
 * DJB2-style hash. Not cryptographic — just collision-resistant
 * enough for HTTP conditional caching.
 *
 * @param {Uint8Array} buf - The response payload bytes.
 * @returns {string} Weak ETag string, e.g. 'W/"a1b2c3d4"'.
 */
export function generateETag(buf) {
    let hash = 5381;
    for (let i = 0; i < buf.byteLength; i++) {
        hash = ((hash << 5) + hash + buf[i]) >>> 0;
    }
    return `W/"${hash.toString(16)}"`;
}

/**
 * Checks whether the client's conditional headers (If-None-Match)
 * indicate the response has not changed. Used before sending a
 * full payload to potentially return a 304 instead.
 *
 * @param {Headers} requestHeaders - Inbound HTTP request headers.
 * @param {string} etag - The current ETag for the response.
 * @returns {boolean} True if the client cache is still valid.
 */
export function isNotModified(requestHeaders, etag) {
    const reqEtag = requestHeaders.get("if-none-match");
    if (!reqEtag) return false;
    const cleanReq = reqEtag.replace(/^W\//, "").replace(/"/g, "");
    const cleanObj = etag.replace(/^W\//, "").replace(/"/g, "");
    return reqEtag === "*" || cleanReq === cleanObj;
}

/**
 * Encodes a JavaScript value to a Uint8Array of JSON bytes.
 * This is the single serialisation point — the resulting bytes
 * are stored in the LRU cache and forwarded verbatim on cache hits.
 *
 * @param {any} data - The value to JSON-encode.
 * @returns {Uint8Array} UTF-8 encoded JSON bytes.
 */
export function encodeJSON(data) {
    return encoder.encode(JSON.stringify(data));
}

/**
 * Serves a Uint8Array of pre-encoded JSON bytes as an HTTP Response.
 * Handles ETag generation and 304 Not Modified checks. On a cache hit,
 * the buf is forwarded directly — no JSON.parse or JSON.stringify.
 *
 * @param {Request} request - The inbound HTTP request (for conditional headers).
 * @param {Uint8Array} buf - Pre-encoded JSON payload bytes.
 * @param {{tier: import('../api/pipeline.js').CacheTier, hits: number}} [meta] - Cache metadata for X-Cache headers.
 * @returns {Response} The HTTP response ready for the client.
 */
export function serveJSON(request, buf, meta = { tier: 'MISS', hits: 0 }) {
    const etag = generateETag(buf);

    if (isNotModified(request.headers, etag)) {
        return new Response(null, {
            status: 304,
            headers: {
                ...H_API,
                "ETag": etag,
                "X-Cache": meta.tier,
                "X-Cache-Hits": meta.hits.toString()
            }
        });
    }

    return new Response(/** @type {BodyInit} */(/** @type {unknown} */(buf)), {
        status: 200,
        headers: {
            ...H_API,
            "ETag": etag,
            "Content-Length": buf.byteLength.toString(),
            "X-Cache": meta.tier,
            "X-Cache-Hits": meta.hits.toString()
        }
    });
}

/**
 * Returns a JSON error response with the standard CORS and no-cache headers.
 *
 * @param {number} status - HTTP status code.
 * @param {string} message - Error message for the response body.
 * @returns {Response} The error response.
 */
export function jsonError(status, message) {
    return new Response(
        JSON.stringify({ error: message }) + "\n",
        { status, headers: H_NOCACHE }
    );
}
