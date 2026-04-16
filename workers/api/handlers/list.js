/**
 * @fileoverview List handler for GET /api/{entity}.
 *
 * Handles the list endpoint with pagination, pre-fetch, and count mode.
 * Uses the zero-allocation hot path (json_group_array) for depth=0 and
 * falls back to row-level expansion for depth>0.
 */

import { ENTITIES } from '../entities.js';
import { buildJsonQuery, buildRowQuery, buildCountQuery, nextPageParams } from '../query.js';
import { expandDepth } from '../depth.js';
import { getEntityCache, LIST_TTL, COUNT_TTL, normaliseCacheKey } from '../cache.js';
import { cachedQuery, EMPTY_ENVELOPE } from '../pipeline.js';
import { encoder, encodeJSON, serveJSON, jsonError, H_API_AUTH, H_API_ANON } from '../http.js';
import { withEdgeSWR } from '../swr.js';
import { parseJsonFields, countRows } from './shared.js';

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

    // Count mode: limit=0 with no skip returns {data:[], meta:{count:N}}
    if (opts.limit === 0 && opts.skip === 0) {
        return handleCount(hc, entity);
    }

    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const { buf, tier, hits } = await withEdgeSWR(
        entityTag, cacheKey, ctx, LIST_TTL,
        () => executeListQuery(db, entity, filters, opts, authenticated)
    );
    const effectiveBuf = buf || EMPTY_ENVELOPE;

    // Pre-fetch next page in background if paginated
    const cache = getEntityCache(entityTag);
    const rowCount = countRows(new TextDecoder().decode(effectiveBuf));
    if (rowCount > 0) {
        const nextPage = nextPageParams(filters, opts, rowCount);
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

    return serveJSON(request, effectiveBuf, { tier, hits }, authenticated ? H_API_AUTH : H_API_ANON);
}

// ── D1 query functions ───────────────────────────────────────────────────────

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
        const { sql, params } = buildRowQuery(entity, filters, opts);
        const result = await db.prepare(sql).bind(...params).all();
        const rows = result.results || [];
        for (const row of rows) { parseJsonFields(entity, row); }
        await expandDepth(db, entity, rows, opts.depth, authenticated, opts.pdbfe);
        return encodeJSON({ data: rows, meta: {} });
    }

    // Hot path: D1 returns the full JSON envelope as a single string
    const { sql, params } = buildJsonQuery(entity, filters, opts);
    const result = await db.prepare(sql).bind(...params).first();

    if (!result || !result.payload) {
        return EMPTY_ENVELOPE;
    }
    return encoder.encode(/** @type {string} */(result.payload));
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Handles count requests (limit=0, skip=0).
 * Tries to derive count from a cached unfiltered list response first.
 * Falls back to withEdgeSWR() pipeline with SELECT COUNT(*).
 * Caches the count envelope with COUNT_TTL (15 min).
 *
 * @param {HandlerContext} hc - Common handler context.
 * @param {EntityMeta} entity - Resolved entity metadata.
 * @returns {Promise<Response>} JSON response with count in meta.
 */
async function handleCount(hc, entity) {
    const { request, db, ctx, entityTag, filters, opts, rawPath, queryString, authenticated } = hc;
    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const hApi = authenticated ? H_API_AUTH : H_API_ANON;

    // Try to derive count from a cached unfiltered list for this entity.
    // Only possible when there are no user-supplied filters and no since param.
    // This avoids a D1 query entirely when we already have the data.
    // Note: this reads cache.get() directly — it's a cross-key optimisation
    // (reading a *different* cache key) that doesn't fit the withEdgeSWR
    // single-key model. The synchronous destructure is safe because we
    // extract buf immediately.
    if (filters.length === 0 && opts.since === 0) {
        const cache = getEntityCache(entityTag);
        const listKey = normaliseCacheKey(rawPath, '');
        const listCached = cache.get(listKey); // ap-ok: cross-key optimization, synchronous destructure follows
        const listBuf = listCached ? listCached.buf : null;
        if (listBuf) {
            const payload = new TextDecoder().decode(/** @type {Uint8Array} */(/** @type {unknown} */(listBuf)));
            const count = countRows(payload);
            if (count > 0) {
                const buf = encoder.encode(`{"data":[],"meta":{"count":${count}}}`);
                cache.add(cacheKey, buf, { entityTag }, Date.now());
                return serveJSON(request, buf, { tier: 'L1', hits: 0 }, hApi);
            }
        }
    }

    // Fall back to withEdgeSWR pipeline with COUNT(*) query
    const { buf, tier, hits } = await withEdgeSWR(
        entityTag, cacheKey, ctx, COUNT_TTL,
        async () => {
            const { sql, params } = buildCountQuery(entity, filters, opts);
            const result = await db.prepare(sql).bind(...params).first();
            const count = (result && typeof result.cnt === 'number') ? result.cnt : 0;
            return encoder.encode(`{"data":[],"meta":{"count":${count}}}`);
        }
    );

    return serveJSON(request, buf || EMPTY_ENVELOPE, { tier, hits }, hApi);
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
