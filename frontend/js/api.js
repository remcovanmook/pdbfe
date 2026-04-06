/**
 * @fileoverview API client for the PeeringDB mirror.
 * Fetches data from the pdbfe-api worker with client-side response caching
 * to prevent redundant requests during back/forward navigation.
 * Attaches OAuth session tokens when the user is authenticated.
 */

import { getSessionId } from './auth.js';
import { API_ORIGIN } from './config.js';

/** Base URL for the API — configured in config.js. */
const API_BASE = API_ORIGIN;

/**
 * In-memory response cache. Maps cache key → { data, timestamp }.
 * Entries are served stale during the SWR window and refreshed
 * in the background.
 * @type {Map<string, {data: any, ts: number}>}
 */
const _cache = new Map();

/**
 * Set of cache keys currently being revalidated in the background.
 * Prevents duplicate concurrent fetches for the same stale entry.
 * @type {Set<string>}
 */
const _pending = new Set();

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
 * Cache keys include auth state so authenticated and anonymous
 * responses are stored separately.
 *
 * @param {string} path - API path (e.g. "/api/net/694").
 * @param {Record<string, string|number>} [params] - Query parameters.
 * @returns {Promise<any>} Parsed JSON response body.
 * @throws {Error} On non-2xx status or network failure.
 */
async function cachedFetch(path, params) {
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

    // Expired or first request: blocking fetch
    return freshFetch(cacheKey, url, sid);
}

/**
 * Fetches fresh data from the API and updates the cache.
 * Used for both blocking fetches and background revalidation.
 *
 * @param {string} cacheKey - Cache key for storage.
 * @param {string} url - Full API URL to fetch.
 * @param {string|null} sid - Session ID for auth header, or null.
 * @returns {Promise<any>} Parsed JSON response body.
 * @throws {Error} On non-2xx status or network failure.
 */
async function freshFetch(cacheKey, url, sid) {
    /** @type {RequestInit} */
    const init = {};
    if (sid) {
        init.headers = { 'Authorization': `Bearer ${sid}` };
    }

    const res = await fetch(url, init);
    if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    _cache.set(cacheKey, { data, ts: Date.now() });
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
 * @returns {Promise<any[]>} Array of result objects.
 */
export async function fetchList(type, filters = {}) {
    const result = await cachedFetch(`/api/${type}`, filters);
    return result?.data || [];
}

/**
 * Searches across all navigable entity types in parallel.
 * Returns results grouped by type.
 *
 * @param {string} query - Search term (matched via name__contains).
 * @returns {Promise<{net: any[], ix: any[], fac: any[], org: any[], carrier: any[], campus: any[]}>}
 */
export async function searchAll(query) {
    const types = ['net', 'ix', 'fac', 'org', 'carrier', 'campus'];
    const params = { name__contains: query, limit: 20 };

    const results = await Promise.all(
        types.map(type => fetchList(type, params).catch(() => []))
    );

    return {
        net:     results[0],
        ix:      results[1],
        fac:     results[2],
        org:     results[3],
        carrier: results[4],
        campus:  results[5]
    };
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
 * @returns {Promise<{last_sync_at: string, entities: Record<string, {last_sync: number, row_count: number, updated_at: string}>}>}
 *     The sync metadata, or null on failure.
 */
export async function fetchSyncStatus() {
    const result = await cachedFetch('/status');
    return result?.sync || null;
}

/**
 * Clears the client-side response cache. Useful after navigation
 * to a page that may have stale data.
 */
export function clearCache() {
    _cache.clear();
}
