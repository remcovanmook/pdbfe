/**
 * @fileoverview API client for the PeeringDB mirror.
 * Fetches data from the pdbfe-api worker with client-side response caching
 * to prevent redundant requests during back/forward navigation.
 */

/** Base URL for the API worker. */
const API_BASE = 'https://pdbfe-api.remco-vanmook.workers.dev';

/**
 * In-memory response cache. Maps URL → { data, timestamp }.
 * Entries expire after CACHE_TTL_MS milliseconds.
 * @type {Map<string, {data: any, ts: number}>}
 */
const _cache = new Map();

/** Cache entry lifetime in milliseconds. */
const CACHE_TTL_MS = 60_000;

/**
 * Performs a cached fetch against the API. Returns cached data if the
 * entry exists and hasn't expired, otherwise fetches fresh data.
 *
 * @param {string} path - API path (e.g. "/api/net/694").
 * @param {Record<string, string|number>} [params] - Query parameters.
 * @returns {Promise<any>} Parsed JSON response body.
 * @throws {Error} On non-2xx status or network failure.
 */
async function cachedFetch(path, params) {
    const url = buildURL(path, params);
    const now = Date.now();

    const cached = _cache.get(url);
    if (cached && (now - cached.ts) < CACHE_TTL_MS) {
        return cached.data;
    }

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    _cache.set(url, { data, ts: now });
    return data;
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
