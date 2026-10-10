/**
 * @fileoverview List handler for GET /api/{entity}.
 *
 * Handles the list endpoint with pagination and pre-fetch. `limit=0` means
 * no limit, as upstream (PeeringDB returns every row; it has no count mode).
 * Uses the zero-allocation hot path (json_group_array) for depth=0 and
 * falls back to row-level expansion for depth>0.
 */

import { ENTITIES } from '../entities.js';
import { buildRowQuery, nextPageParams } from '../query.js';
import { selectWithDepth } from '../depth.js';
import { queryJsonList } from '../json_list.js';
import { buildPagedEnvelope, parsePageNumber, parsePerPage } from './paged.js';
import { getEntityCache, LIST_TTL, cachedQuery, withEdgeSWR } from '../cache.js';
import { normaliseCacheKey } from '../../core/cache.js';
import { EMPTY_ENVELOPE } from '../../core/pipeline/index.js';
import { encodeJSON, serveJSON, serverTiming, jsonError } from '../http.js';
import { countRowsBytes } from './shared.js';

/**
 * Handles a list request for an entity type (GET /api/{entity}).
 * Checks the per-entity LRU cache first. On miss, delegates to
 * cachedQuery() which handles coalescing, L2, and D1.
 *
 * @param {HandlerContext} hc - Common handler context.
 * @returns {Promise<Response>} JSON response.
 */
export async function handleList(hc) {
    const { request, db, ctx, entityTag, filters, opts, rawPath, queryString, authenticated } = hc;
    const entity = ENTITIES[entityTag];
    if (!entity) return jsonError(404, `Unknown entity: ${entityTag}`);

    // Page-number pagination (?page=N), as upstream: ?page=1&limit=0
    // paginates the full set.
    if (hc.paging) {
        return handlePaged(hc, entity, hc.paging);
    }

    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const result = await withEdgeSWR(
        entityTag, cacheKey, ctx, LIST_TTL,
        () => executeListQuery(db, entity, filters, opts, authenticated),
        undefined, opts.since === 0 // ?since= keys carry a fresh timestamp: skip L2
    );
    const { buf, tier, hits } = result;
    hc.pipeline = result;
    const effectiveBuf = buf || EMPTY_ENVELOPE;

    // Pre-fetch next page in background if paginated. Count rows directly from
    // the payload bytes — decoding the whole (potentially multi-MB) buffer to a
    // string just to count would be pure waste on every cache hit.
    const cache = getEntityCache(entityTag);
    const rowCount = countRowsBytes(effectiveBuf);
    if (rowCount > 0) {
        const nextPage = nextPageParams(entity, filters, opts, rowCount);
        if (nextPage) {
            const nextOpts = { ...opts, limit: nextPage.limit, skip: nextPage.skip };
            const nextCacheKey = normaliseCacheKey(rawPath, buildSortedQS(filters, nextOpts));
            if (!cache.has(nextCacheKey) && !cache.pending.has(nextCacheKey)) {
                ctx.waitUntil(
                    prefetchPage(db, entity, entityTag, filters, nextOpts, nextCacheKey, cache, authenticated, ctx)
                );
            }
        }
    }

    return serveJSON(request, effectiveBuf, { tier, hits, timing: serverTiming(hc.authMs, result) }, hc.hApi, hc.entityVersionMs, hc.userId);
}

// ── D1 query functions ───────────────────────────────────────────────────────

/**
 * From this OFFSET on, a depth>0 list page fetches its rows first and then
 * expands them by id (two round trips) rather than in one batch: there every
 * expansion statement re-runs the main query, re-scanning the skipped rows
 * (measured: skip=30000 at depth=1 went from 161 to 237 ms of D1 time). A
 * judgment call — one scan past ~2000 rows starts to cost a few ms.
 */
export const DEEP_SKIP = 2000;

/**
 * Executes a list query against D1. Uses the hot path (json_group_array)
 * for depth=0, or the cold path (row-level + expandDepth) for depth>0.
 *
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {QueryOpts} opts - Query options.
 * @param {boolean} authenticated - Whether the caller is authenticated (for POC visibility).
 * @returns {Promise<Uint8Array|null>} Payload bytes, or null for empty result.
 *          Note: empty lists return EMPTY_ENVELOPE (not null) since an empty
 *          list is valid data, not a 404.
 */
async function executeListQuery(db, entity, filters, opts, authenticated) {
    if (opts.depth > 0) {
        // Main query (all columns) + every expansion in one D1 batch
        // (api/depth.js); ?fields= is applied after expansion. Deep pages
        // fetch first and expand by id instead: each batched statement re-runs
        // the main query, and OFFSET re-scans every skipped row each time.
        const main = buildRowQuery(entity, filters, { ...opts, fields: [] });
        const inline = (opts.skip || 0) < DEEP_SKIP;
        const rows = await selectWithDepth(db, entity, main, opts.depth, authenticated, opts.pdbfe, false, opts.fields, inline);
        return encodeJSON({ data: rows, meta: {} });
    }

    // Hot path: D1 returns the full JSON envelope as a single string
    // (chunked fallback when it exceeds SQLite's max value size).
    return (await queryJsonList(db, entity, filters, opts)) ?? EMPTY_ENVELOPE;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Serves ?page=N&per_page=M with meta.pagination (see handlers/paged.js).
 * The whole paged envelope is cached under the request's own key.
 *
 * @param {HandlerContext} hc - Common handler context.
 * @param {EntityMeta} entity - Resolved entity metadata.
 * @param {{page: string, perPage: string|null}} paging - Raw page / per_page values.
 * @returns {Promise<Response>}
 */
async function handlePaged(hc, entity, paging) {
    const { request, db, ctx, entityTag, filters, opts, rawPath, queryString, authenticated, hApi } = hc;
    const page = parsePageNumber(paging.page);
    if (page === null) return jsonError(404, 'Invalid page.');
    const perPage = parsePerPage(paging.perPage);

    const qIdx = request.url.indexOf('?');
    const base = qIdx === -1 ? request.url : request.url.slice(0, qIdx);

    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const result = await withEdgeSWR(
        entityTag, cacheKey, ctx, LIST_TTL,
        () => buildPagedEnvelope(db, entity, filters, opts, { page, perPage, base, queryString },
            (pageOpts) => executeListQuery(db, entity, filters, pageOpts, authenticated))
    );
    const { buf, tier, hits } = result;
    hc.pipeline = result;
    if (!buf) return jsonError(404, 'Invalid page.');
    return serveJSON(request, buf, { tier, hits, timing: serverTiming(hc.authMs, result) }, hApi, hc.entityVersionMs, hc.userId);
}

/**
 * Background pre-fetch for the next page of paginated results.
 * Delegates to cachedQuery() which handles coalescing, L2, and D1.
 *
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string} entityTag - Entity tag for cache metadata.
 * @param {ParsedFilter[]} filters - Query filters.
 * @param {QueryOpts} opts - Pagination.
 * @param {string} cacheKey - Cache key for the pre-fetched page.
 * @param {LocalCache} cache - The entity's LRU cache instance.
 * @param {boolean} authenticated - Whether the caller is authenticated (for POC visibility).
 * @param {ExecutionContext} ctx - Worker execution context for L2 write-back.
 * @returns {Promise<void>}
 */
async function prefetchPage(db, entity, entityTag, filters, opts, cacheKey, cache, authenticated, ctx) {
    try {
        await cachedQuery({ // ap-ok: background prefetch in waitUntil, not handler flow
            cacheKey, cache, entityTag, ttlMs: LIST_TTL, ctx,
            queryFn: () => executeListQuery(db, entity, filters, opts, authenticated)
        });
    } catch (err) {
        console.error(`Pre-fetch failed for ${cacheKey}:`, err);
    }
}

/**
 * Reconstructs a sorted query string from filters and pagination options.
 * Used to build the cache key for the pre-fetched next page.
 *
 * @param {ParsedFilter[]} filters - The current query filters.
 * @param {QueryOpts} opts - Pagination.
 * @returns {string} Sorted query string.
 */
function buildSortedQS(filters, opts) {
    /** @type {string[]} */
    const parts = [];
    for (const f of filters) {
        const key = f.op === "eq" ? f.field : `${f.field}__${f.op}`;
        parts.push(`${key}=${encodeURIComponent(f.value)}`);
    }
    if (opts.depth > 0) parts.push(`depth=${opts.depth}`);
    if (opts.fields && opts.fields.length > 0) parts.push(`fields=${opts.fields.join(',')}`);
    if (opts.limit > 0) parts.push(`limit=${opts.limit}`);
    if (opts.skip > 0) parts.push(`skip=${opts.skip}`);
    if (opts.since > 0) parts.push(`since=${opts.since}`);
    if (opts.sort) parts.push(`sort=${encodeURIComponent(opts.sort)}`);
    return parts.toSorted((a, b) => a.localeCompare(b)).join("&");
}
