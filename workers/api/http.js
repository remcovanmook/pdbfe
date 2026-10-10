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
import { H_CORS, H_NOCACHE, SHARED_MARKER, generateETag, isNotModified, lastModifiedHeader } from '../core/http.js';

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
 * H_API_SHARED: responses that cannot differ by auth state (see
 * api/auth_scope.js) — everything except restricted-entity content. One
 * copy serves every caller, so it is `public` with NO `Vary: Authorization`:
 * authenticated requests hit the same edge object as anonymous ones.
 *
 * It must never carry per-caller data: no X-Auth-Id (serveJSON enforces
 * that authId only rides H_API_AUTH) and no X-Auth-Status, since an edge hit
 * replays whatever the filling caller got. SHARED_MARKER tells wrapHandler
 * not to add its default X-Auth-Status; wrapHandler strips the marker.
 */
const { Vary: _vary, ...H_API_NO_VARY } = H_API;
export const H_API_SHARED = Object.freeze({ ...H_API_NO_VARY, [SHARED_MARKER]: "1" });

/**
 * Pre-cooked no-cache header sets with X-Auth-Status baked in.
 */
export const H_NOCACHE_AUTH = Object.freeze({ ...H_NOCACHE, "X-Auth-Status": "authenticated" });
export const H_NOCACHE_ANON = Object.freeze({ ...H_NOCACHE, "X-Auth-Status": "unauthenticated" });

/**
 * Builds a Server-Timing value for a served response: auth resolution, the
 * per-PoP L2 lookup and the D1 query (the latter two only on L1 misses).
 * Note: the edge cache stores this header with the response, so on an edge
 * HIT it describes the request that filled the cache (as X-Timer does).
 *
 * `d1` (core/d1stats.js) adds what D1 itself reported for this request's
 * calls: `d1;dur` = SQL execution time inside D1, desc = round trips and rows
 * read. `db` minus `d1` is network/round-trip overhead plus JS work.
 *
 * @param {number|undefined} authMs - Auth resolution time.
 * @param {{tier: string, l2Ms?: number, dbMs?: number}} r - Pipeline result.
 * @param {import('../core/d1stats.js').D1Stats} [d1] - Per-request D1 counters.
 * @returns {string}
 */
export function serverTiming(authMs, r, d1) {
    let v = `cache;desc="${r.tier}"`;
    if (authMs !== undefined) v += `, auth;dur=${authMs}`;
    if (r.l2Ms !== undefined) v += `, l2;dur=${r.l2Ms}`;
    if (r.dbMs !== undefined) v += `, db;dur=${r.dbMs}`;
    if (d1 && d1.calls > 0) v += `, d1;dur=${Math.round(d1.sqlMs * 10) / 10};desc="${d1.calls} rt, ${d1.rowsRead} rows"`;
    return v;
}

/**
 * Sync cadence the edge TTL is aligned to: the sync worker's cron
 * (wrangler-sync.toml: "*\/15 * * * *") runs on every quarter hour, and a
 * run takes well under a minute. A test pins these to the cron.
 */
export const SYNC_INTERVAL_S = 900;
export const SYNC_GRACE_S = 60;
/** stale-while-revalidate window on the aligned edge TTL. */
export const SWR_S = 30;

/**
 * Seconds until the next point at which newly synced data can be visible:
 * the next quarter-hour boundary plus SYNC_GRACE_S for the sync run itself.
 * A response produced inside the grace window of a run that is still
 * writing expires at the end of that window rather than a full interval
 * later. Never less than 1.
 *
 * @param {number} nowSec - Current time, epoch seconds.
 * @returns {number}
 */
export function secondsUntilFreshData(nowSec) {
    const prevBoundary = nowSec - (nowSec % SYNC_INTERVAL_S);
    let expiry = prevBoundary + SYNC_GRACE_S;
    if (expiry <= nowSec) expiry += SYNC_INTERVAL_S;
    return Math.max(1, expiry - nowSec);
}

/**
 * Cache-Control for public (edge-cacheable) API responses: an absolute
 * expiry aligned to the sync schedule instead of a fixed relative max-age.
 * The data only changes when the sync runs, so a copy stays fresh until just
 * after the next run. stale-while-revalidate lets the edge answer at that
 * moment while it refetches; with a 15-minute mutation cadence the extra
 * staleness (≤ SWR_S) is immaterial.
 *
 * @param {number} [nowMs] - Current time in ms (injectable for tests).
 * @returns {string}
 */
export function syncAlignedCacheControl(nowMs = Date.now()) {
    return `public, max-age=${secondsUntilFreshData(Math.floor(nowMs / 1000))}, stale-while-revalidate=${SWR_S}`;
}

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
 * @param {{tier: import('./cache.js').CacheTier, hits: number, timing?: string}} [meta] - Cache metadata for X-Cache headers (+ optional Server-Timing value).
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
    if (meta.timing) extra['Server-Timing'] = meta.timing;
    // Public responses expire just after the next sync, not after a fixed 60s.
    if (baseHeaders['Cache-Control'].startsWith('public')) extra['Cache-Control'] = syncAlignedCacheControl();
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
