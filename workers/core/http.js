/**
 * @fileoverview Generic HTTP response helpers shared across all workers.
 *
 * Provides low-level building blocks: encoder, CORS headers, Last-Modified
 * helpers, JSON encoding, and error responses.
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
    "Access-Control-Expose-Headers": "X-Cache, X-Cache-Hits, X-Timer, X-Served-By, X-Isolate-ID, Allow, X-Auth-Status, X-Auth-Id, X-App-Version, Last-Modified, Server-Timing"
});

/**
 * Headers for responses that should not be cached.
 */
/**
 * Internal response header marking an auth-independent (shared) response.
 * wrapHandler skips its default X-Auth-Status for these and removes the
 * marker before the response leaves the Worker.
 */
export const SHARED_MARKER = "X-PDBFE-Shared";

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

/** Parsed CF_VERSION_METADATA.timestamp, cached by its string. */
let _versionTs = /** @type {string|undefined} */ (undefined);
let _versionMs = 0;

/**
 * When this worker version was deployed (epoch ms; 0 when unknown — tests,
 * local dev): If-Modified-Since shortcuts only answer for copies at least
 * this new, since a release may change the output format without any data
 * changing.
 *
 * @param {{ CF_VERSION_METADATA?: { timestamp?: string } }} env
 * @returns {number}
 */
export function deployedAtMs(env) {
    const ts = env.CF_VERSION_METADATA?.timestamp;
    if (ts !== _versionTs) {
        _versionTs = ts;
        const ms = Date.parse(ts ?? '');
        _versionMs = Number.isNaN(ms) ? 0 : ms;
    }
    return _versionMs;
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
    const imsTime = parseIfModifiedSince(requestHeaders);
    if (imsTime < 0) return false;
    // HTTP dates have 1-second resolution. The data is unchanged if
    // the IMS timestamp is >= the last-modified epoch (truncated to seconds).
    return imsTime >= Math.floor(epochMs / 1000) * 1000;
}

/**
 * The request's If-Modified-Since as epoch milliseconds, or -1 when absent
 * or unparseable.
 *
 * @param {Headers} requestHeaders - Inbound HTTP request headers.
 * @returns {number}
 */
export function parseIfModifiedSince(requestHeaders) {
    const ims = requestHeaders.get('if-modified-since');
    if (!ims) return -1;
    const imsTime = Date.parse(ims);
    return Number.isNaN(imsTime) ? -1 : imsTime;
}
