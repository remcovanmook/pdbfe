/**
 * @fileoverview API client for the PeeringDB mirror.
 * Fetches data from the pdbfe-api worker with client-side response caching
 * to prevent redundant requests during back/forward navigation.
 * Attaches OAuth session tokens when the user is authenticated.
 */

import { getSessionId } from './auth.js';
import { API_ORIGIN } from './config.js';
import { ENTITIES, getLabel } from './entities.js';

/**
 * Subtitle formatters for search results.
 * Keyed by entity tag. Returns a one-line string shown below the entity name
 * in search results and typeahead dropdowns.
 * @type {Record<string, (r: any) => string>}
 */
const SUBTITLE_FORMATTERS = {
    net:     /** @param {any} r */ (r) => `AS${r.asn}`,
    ix:      /** @param {any} r */ (r) => r.city || '',
    fac:     /** @param {any} r */ (r) => `${r.city || ''}, ${r.country || ''}`,
    org:     () => '',
    carrier: () => '',
    campus:  /** @param {any} r */ (r) => `${r.city || ''}, ${r.country || ''}`,
};

/**
 * Search entity group definitions — navigable entity types, derived from
 * extracted/entities.json. Used by searchAll(), the search results page,
 * and the typeahead dropdown.
 *
 * Includes only top-level entities with detail pages (excludes join tables
 * like netfac, netixlan, ixfac, etc.).
 *
 * @type {ReadonlyArray<{key: string, label: string, subtitle: (r: any) => string}>}
 */
export const SEARCH_ENTITIES = Object.freeze(
    ['net', 'ix', 'fac', 'org', 'carrier', 'campus']
        .filter(tag => tag in ENTITIES)
        .map(tag => ({
            key: tag,
            label: getLabel(tag),
            subtitle: SUBTITLE_FORMATTERS[tag] || (() => ''),
        }))
);

/** Base URL for the API — configured in config.js. */
const API_BASE = API_ORIGIN;

/**
 * @typedef {Object} CacheTelemetry
 * @property {string} tier  - Edge cache tier from X-Cache (L1, L2, MISS).
 * @property {string} hits  - Hit count from X-Cache-Hits.
 * @property {string} timer - Timing info from X-Timer.
 * @property {string} servedBy - Edge colo + service from X-Served-By.
 * @property {string} isolateId - V8 isolate ID from X-Isolate-ID.
 */

/**
 * In-memory response cache. Maps cache key → { data, timestamp, telemetry }.
 * Entries are served stale during the SWR window and refreshed
 * in the background. Telemetry is captured from edge response headers
 * for the diagnostic overlay.
 * @type {Map<string, {data: any, ts: number, telemetry: CacheTelemetry}>}
 */
const _cache = new Map();

/**
 * Set of cache keys currently being revalidated in the background.
 * Prevents duplicate concurrent fetches for the same stale entry.
 * @type {Set<string>}
 */
const _pending = new Set();

/**
 * Tracks in-flight blocking requests to prevent cold-boot stampedes.
 * When multiple components request the same uncached resource concurrently,
 * only one network request is made; all callers share the same Promise.
 * @type {Map<string, Promise<any>>}
 */
const _inflight = new Map();

/** Fresh window — cached data returned without revalidation. */
const CACHE_TTL_MS = 60_000;

/** Stale-while-revalidate window — stale data returned, background refresh fired. */
const CACHE_SWR_MS = 300_000;

/**
 * Performs a cached fetch with stale-while-revalidate semantics.
 *
 * - **Fresh** (< 60s): returns cached data, no network request.
 * - **Stale** (60s–5min): returns cached data immediately, fires a
 *   background fetch to update the cache for subsequent calls.
 * - **Expired** (> 5min) or **first request**: blocks on fetch.
 *
 * Concurrent cache misses for the same key are coalesced into a single
 * network request via the _inflight Map.
 *
 * Cache keys include auth state so authenticated and anonymous
 * responses are stored separately.
 *
 * @param {string} path - API path (e.g. "/api/net/694").
 * @param {Record<string, string|number>} [params] - Query parameters.
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation.
 * @returns {Promise<any>} Parsed JSON response body.
 * @throws {Error} On non-2xx status or network failure.
 */
async function cachedFetch(path, params, signal) {
    const url = buildURL(path, params);
    const now = Date.now();
    const sid = getSessionId();
    const cacheKey = sid ? `auth:${url}` : url;

    const cached = _cache.get(cacheKey);
    if (cached) {
        const age = now - cached.ts;

        // Fresh: return immediately
        if (age < CACHE_TTL_MS) {
            return cached.data;
        }

        // Stale but within SWR window: return stale, revalidate in background
        if (age < CACHE_SWR_MS) {
            revalidate(cacheKey, url, sid);
            return cached.data;
        }
    }

    // Coalesce concurrent cache misses into a single network request
    if (_inflight.has(cacheKey)) {
        return _inflight.get(cacheKey);
    }

    const promise = freshFetch(cacheKey, url, sid, signal).finally(() => {
        _inflight.delete(cacheKey);
    });
    _inflight.set(cacheKey, promise);
    return promise;
}

/**
 * Fetches fresh data from the API and updates the cache.
 * Used for both blocking fetches and background revalidation.
 *
 * @param {string} cacheKey - Cache key for storage.
 * @param {string} url - Full API URL to fetch.
 * @param {string|null} sid - Session ID for auth header, or null.
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation.
 * @returns {Promise<any>} Parsed JSON response body.
 * @throws {Error} On non-2xx status or network failure.
 */
async function freshFetch(cacheKey, url, sid, signal) {
    /** @type {RequestInit} */
    const init = {};
    if (sid) {
        init.headers = { 'Authorization': `Bearer ${sid}` };
    }
    if (signal) {
        init.signal = signal;
    }

    const res = await fetch(url, init);
    if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    // Capture edge telemetry from response headers for the diagnostic overlay.
    // These headers are only visible if the worker sets Access-Control-Expose-Headers.
    /** @type {CacheTelemetry} */
    const telemetry = {
        tier: res.headers.get('X-Cache') || 'MISS',
        hits: res.headers.get('X-Cache-Hits') || '0',
        timer: res.headers.get('X-Timer') || '',
        servedBy: res.headers.get('X-Served-By') || '',
        isolateId: res.headers.get('X-Isolate-ID') || '',
    };

    _cache.set(cacheKey, { data, ts: Date.now(), telemetry });
    return data;
}

/**
 * Fires a background fetch to refresh a stale cache entry.
 * Deduplicates via _pending — only one in-flight revalidation
 * per cache key at a time. Errors are silently swallowed since
 * the caller already received stale data.
 *
 * @param {string} cacheKey - Cache key to revalidate.
 * @param {string} url - Full API URL to fetch.
 * @param {string|null} sid - Session ID for auth header, or null.
 */
function revalidate(cacheKey, url, sid) {
    if (_pending.has(cacheKey)) return;
    _pending.add(cacheKey);
    freshFetch(cacheKey, url, sid)
        .catch(() => {})
        .finally(() => _pending.delete(cacheKey));
}

/**
 * Constructs a full API URL from a path and optional query parameters.
 *
 * @param {string} path - Relative API path.
 * @param {Record<string, string|number>} [params] - Query parameters (falsy values excluded).
 * @returns {string} Full URL string.
 */
function buildURL(path, params) {
    const base = `${API_BASE}${path}`;
    if (!params) return base;

    const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');

    return qs ? `${base}?${qs}` : base;
}

/**
 * Fetches a single entity by type and ID with optional depth expansion.
 *
 * @param {string} type - Entity type (e.g. "net", "ix", "fac", "org").
 * @param {number|string} id - Entity ID.
 * @param {number} [depth=2] - Depth expansion level.
 * @returns {Promise<any>} The first item in the response data array, or null.
 */
export async function fetchEntity(type, id, depth = 2) {
    const result = await cachedFetch(`/api/${type}/${id}`, { depth });
    return result?.data?.[0] || null;
}

/**
 * Fetches a list of entities with optional filters and pagination.
 *
 * @param {string} type - Entity type.
 * @param {Record<string, string|number>} [filters={}] - Query filters.
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation.
 * @returns {Promise<any[]>} Array of result objects.
 */
export async function fetchList(type, filters = {}, signal = undefined) {
    const result = await cachedFetch(`/api/${type}`, filters, signal);
    return result?.data || [];
}

/**
 * Searches across all navigable entity types in parallel.
 * Returns results grouped by type.
 *
 * @param {string} query - Search term (matched via name__contains).
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation.
 * @returns {Promise<{net: any[], ix: any[], fac: any[], org: any[], carrier: any[], campus: any[]}>}
 */
export async function searchAll(query, signal) {
    const params = { name__contains: query, limit: 20 };

    const results = await Promise.all(
        SEARCH_ENTITIES.map(e => fetchList(e.key, params, signal).catch(/** @returns {any[]} */() => []))
    );

    /** @type {Record<string, any[]>} */
    const grouped = {};
    SEARCH_ENTITIES.forEach((e, i) => { grouped[e.key] = results[i]; });
    return /** @type {{net: any[], ix: any[], fac: any[], org: any[], carrier: any[], campus: any[]}} */ (grouped);
}

/**
 * Fetches the peer table for an exchange. This is a dedicated method
 * because IX peers come from the netixlan entity filtered by ix_id,
 * not from the IX entity's own depth expansion.
 *
 * @param {number|string} ixId - Exchange ID.
 * @returns {Promise<any[]>} Array of netixlan records.
 */
export async function fetchIxPeers(ixId) {
    return fetchList('netixlan', { ix_id: ixId, limit: 5000 });
}

/**
 * Looks up a network by its ASN number. Returns the first matching
 * network object, or null if no network has that ASN.
 *
 * @param {number|string} asn - Autonomous System Number to look up.
 * @returns {Promise<any|null>} The matching network object, or null.
 */
export async function fetchByAsn(asn) {
    const results = await fetchList('net', { asn, limit: 1 });
    return results[0] || null;
}

/**
 * Fetches the total count of entities for a given type.
 * Uses the limit=0 API convention which returns
 * { data: [], meta: { count: N } }.
 *
 * @param {string} type - Entity type (e.g. "net", "ix", "fac", "org").
 * @returns {Promise<number>} Total entity count.
 */
export async function fetchCount(type) {
    const result = await cachedFetch(`/api/${type}`, { limit: 0 });
    return result?.meta?.count ?? 0;
}

/**
 * Fetches the database sync status from the /status endpoint.
 * Returns an object with the most recent sync timestamp and
 * per-entity sync metadata.
 *
 * @returns {Promise<{last_modified_at: number, entities: Record<string, {last_sync: number, row_count: number, updated_at: string, last_modified_at: number}>}|null>}
 *     The sync metadata, or null on failure.
 */
export async function fetchSyncStatus() {
    const result = await cachedFetch('/status');
    return result?.sync || null;
}

/**
 * Pattern matching ASN-shaped queries: bare digits or "AS" prefix + digits.
 * Shared between the search page and typeahead dropdown.
 * @type {RegExp}
 */
const ASN_PATTERN = /^(?:as)?(\d+)$/i;

/**
 * Performs a multi-entity search with ASN-aware injection.
 *
 * If the query looks like an ASN (bare number or "AS"-prefixed),
 * a direct ASN lookup runs in parallel with the name-based search.
 * The exact ASN match is deduplicated and injected at the top of
 * the networks list.
 *
 * @param {string} query - Search term.
 * @param {AbortSignal} [signal] - Optional abort signal for cancellation.
 * @returns {Promise<{net: any[], ix: any[], fac: any[], org: any[], carrier: any[], campus: any[]}>}
 */
export async function searchWithAsn(query, signal) {
    const asnMatch = query.trim().match(ASN_PATTERN);
    const asnNum = asnMatch ? Number.parseInt(asnMatch[1], 10) : Number.NaN;

    const [results, asnNet] = await Promise.all([
        searchAll(query, signal),
        Number.isNaN(asnNum) ? Promise.resolve(null) : fetchByAsn(asnNum)
    ]);

    if (asnNet) {
        const existingIds = new Set(results.net.map(/** @param {any} n */ (n) => n.id));
        if (!existingIds.has(asnNet.id)) {
            results.net.unshift(asnNet);
        } else {
            results.net = [
                asnNet,
                ...results.net.filter(/** @param {any} n */ (n) => n.id !== asnNet.id)
            ];
        }
    }

    return results;
}

/**
 * Returns diagnostic information about each entry in the browser
 * SWR cache for the debug overlay. Excludes auth-prefixed keys
 * to avoid surfacing session state.
 *
 * Each entry includes a `swrState` indicating the browser-side cache
 * state relative to the TTL/SWR thresholds:
 *   - FRESH: within TTL, served without network request
 *   - SWR: stale but within SWR window, background revalidation eligible
 *   - REVALIDATING: stale, background fetch currently in flight
 *   - EXPIRED: past SWR window, next access will block on fetch
 *
 * @returns {Array<{key: string, ageMs: number, swrState: string, telemetry: CacheTelemetry}>}
 */
export function getCacheDiagnostics() {
    /** @type {Array<{key: string, ageMs: number, swrState: string, telemetry: CacheTelemetry}>} */
    const stats = [];
    const now = Date.now();
    for (const [key, entry] of _cache.entries()) {
        if (key.startsWith('auth:')) continue;
        const ageMs = now - entry.ts;
        let swrState = 'EXPIRED';
        if (ageMs < CACHE_TTL_MS) {
            swrState = 'FRESH';
        } else if (ageMs < CACHE_SWR_MS) {
            swrState = _pending.has(key) ? 'REVALIDATING' : 'SWR';
        }
        stats.push({ key, ageMs, swrState, telemetry: entry.telemetry });
    }
    return stats;
}

/**
 * Clears the client-side response cache. Useful after navigation
 * to a page that may have stale data.
 */
export function clearCache() {
    _cache.clear();
}
