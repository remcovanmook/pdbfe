/**
 * @fileoverview HTTP response helpers for JSON API responses.
 * Handles ETag generation, 304 Not Modified, CORS preflight,
 * Last-Modified / If-Modified-Since, and raw Uint8Array forwarding
 * for zero-serialisation cache hits.
 */

import { VERSIONS } from '../api/entities.js';

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
    "Access-Control-Expose-Headers": "X-Cache, X-Cache-Hits, X-Timer, X-Served-By, X-Isolate-ID, ETag, Allow, X-Auth-Status, X-App-Version, Last-Modified"
});

/**
 * Standard cache headers for API responses.
 * Responses are public-cacheable for 60s with stale-while-revalidate.
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
 * Headers for responses that should not be cached.
 */
export const H_NOCACHE = Object.freeze({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...H_CORS
});

/**
 * Pre-cooked no-cache header sets with X-Auth-Status baked in.
 */
export const H_NOCACHE_AUTH = Object.freeze({ ...H_NOCACHE, "X-Auth-Status": "authenticated" });
export const H_NOCACHE_ANON = Object.freeze({ ...H_NOCACHE, "X-Auth-Status": "unauthenticated" });

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
    const cleanReq = reqEtag.replace(/^W\//, "").replace(/"/g, ""); // ap-ok: fixed pattern on short ETag string
    const cleanObj = etag.replace(/^W\//, "").replace(/"/g, ""); // ap-ok: fixed pattern on short ETag string
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
 * Returns a JSON error response with the standard CORS and no-cache headers.
 *
 * @param {number} status - HTTP status code.
 * @param {string} message - Error message for the response body.
 * @param {Record<string, string>} [headers] - Header set. Defaults to H_NOCACHE;
 *        pass H_NOCACHE_AUTH or H_NOCACHE_ANON to bake in X-Auth-Status.
 * @returns {Response} The error response.
 */
export function jsonError(status, message, headers = H_NOCACHE) {
    return new Response(
        JSON.stringify({ error: message }) + "\n",
        { status, headers }
    );
}

// ── Last-Modified / If-Modified-Since helpers ────────────────────────────────

/**
 * Converts an epoch-millisecond timestamp to an HTTP-date string
 * suitable for the Last-Modified response header.
 *
 * Format: "Thu, 01 Jan 2026 00:00:00 GMT" (RFC 7231 §7.1.1.1).
 *
 * @param {number} epochMs - Timestamp in milliseconds since Unix epoch.
 * @returns {string} HTTP-date string.
 */
export function lastModifiedHeader(epochMs) {
    return new Date(epochMs).toUTCString();
}

/**
 * Checks whether the client's If-Modified-Since header indicates
 * the response has not changed. Compares the request header timestamp
 * against the data's last-modified epoch.
 *
 * Returns true when the client already has a fresh copy and a 304
 * can be returned without touching any cache or D1.
 *
 * @param {Headers} requestHeaders - Inbound HTTP request headers.
 * @param {number} epochMs - The data's last-modified timestamp
 *        in milliseconds since Unix epoch.
 * @returns {boolean} True if the client cache is still valid.
 */
export function isNotModifiedSince(requestHeaders, epochMs) {
    const ims = requestHeaders.get('if-modified-since');
    if (!ims) return false;
    const imsTime = Date.parse(ims);
    if (isNaN(imsTime)) return false;
    // HTTP dates have 1-second resolution. The data is unchanged if
    // the IMS timestamp is >= the last-modified epoch (truncated to seconds).
    return imsTime >= Math.floor(epochMs / 1000) * 1000;
}
