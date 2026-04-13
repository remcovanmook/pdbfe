/**
 * @fileoverview Generic HTTP response helpers shared across all workers.
 *
 * Provides low-level building blocks: encoder, CORS headers, ETag,
 * conditional request checks, JSON encoding, and error responses.
 *
 * API-specific header sets (H_API, H_API_AUTH/ANON, serveJSON) live
 * in api/http.js which layers on top of this module.
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
    "Access-Control-Expose-Headers": "X-Cache, X-Cache-Hits, X-Timer, X-Served-By, X-Isolate-ID, ETag, Allow, X-Auth-Status, X-App-Version, Last-Modified"
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
    if (reqEtag === "*") return true;
    return stripEtagDecoration(reqEtag) === stripEtagDecoration(etag);
}

/**
 * Strips the W/ weak indicator and surrounding quotes from an ETag value.
 * Uses string operations (no regex) — safe for the hot path.
 *
 * @param {string} raw - Raw ETag string (e.g. 'W/"abc123"' or '"abc123"').
 * @returns {string} The bare hash value (e.g. 'abc123').
 */
function stripEtagDecoration(raw) {
    let s = raw;
    if (s.startsWith('W/')) s = s.slice(2);
    if (s.startsWith('"')) s = s.slice(1);
    if (s.endsWith('"')) s = s.slice(0, -1);
    return s;
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

/** @type {Map<string, Uint8Array>} Pre-compiled error body cache. */
const _errorBufs = new Map();

/**
 * Returns a JSON error response with the standard CORS and no-cache headers.
 *
 * Error body bytes are cached by message string so repeated calls
 * (e.g. 404 scanner sweeps, 429 rate-limit storms) skip JSON.stringify
 * and TextEncoder on the hot path.
 *
 * @param {number} status - HTTP status code.
 * @param {string} message - Error message for the response body.
 * @param {Record<string, string>} [headers] - Header set. Defaults to H_NOCACHE;
 *        pass H_NOCACHE_AUTH or H_NOCACHE_ANON to bake in X-Auth-Status.
 * @returns {Response} The error response.
 */
export function jsonError(status, message, headers = H_NOCACHE) {
    let buf = _errorBufs.get(message);
    if (!buf) {
        buf = encoder.encode(JSON.stringify({ error: message }) + "\n");
        _errorBufs.set(message, buf);
    }
    return new Response(/** @type {BodyInit} */(/** @type {unknown} */(buf)), { status, headers });
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
