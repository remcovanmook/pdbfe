/**
 * @fileoverview List handler for GET /v1/{entity} on the REST worker.
 *
 * Uses the zero-allocation hot path (JSON built by D1, api/json_list.js)
 * for depth=0 and falls back to row-level expansion for depth>0. Cached via
 * withRestSWR, except an unfiltered list of a table larger than a page,
 * which streams page by page (ANTI_PATTERNS.md §9).
 */

import { buildRowQuery } from '../../api/query.js';
import { queryJsonList, isStreamedList, streamJsonList } from '../../api/json_list.js';
import { expandDepth } from '../../api/depth.js';
import { parseJsonFields } from '../../api/handlers/shared.js';
import { encodeJSON } from '../../core/http.js';
import { normaliseCacheKey } from '../../core/cache.js';
import { serveJSON } from '../../api/http.js';
import { EMPTY_ENVELOPE } from '../../core/pipeline/index.js';
import { withRestSWR, getEntityVersion, getDumpKey, refreshSyncState } from '../cache.js';
import { isDumpRequest, currentDump } from '../../api/dumps.js';

/**
 * Handles a list request for entities matching the given filters.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Query filters.
 * @param {QueryOpts} opts - Parsed query options.
 * @param {string} rawPath - Raw URL path (for cache key).
 * @param {{db: D1Session, ctx: ExecutionContext, entityTag: string, authenticated: boolean, hResponse: Record<string, string>, cachePrefix: string, queryString: string}} qc - Query context.
 * @returns {Promise<Response>}
 */
export async function handleListRequest(entity, filters, opts, rawPath, qc) {
    const { db, ctx, entityTag, authenticated, hResponse, queryString } = qc;
    // Default full-table list: the R2 dump when current (api/dumps.js; see
    // the API list handler).
    if (isDumpRequest(entityTag, filters, opts)) {
        if (getEntityVersion(entityTag) === 0) await refreshSyncState(db);
        const version = getEntityVersion(entityTag);
        const dump = await currentDump(qc.dumps, entityTag, getDumpKey(entityTag), version);
        if (dump) return serveJSON(dump, { tier: 'R2', hits: 0 }, hResponse, version * 1000);
    }
    if (isStreamedList(entity, filters, opts)) {
        const stream = await streamJsonList(db, entity, filters, opts);
        return serveJSON(stream, { tier: 'MISS', hits: 0 }, hResponse, lastModifiedOf(getEntityVersion(entityTag), opts));
    }
    // Partitioned by auth state where it matters (poc lists, depth>0
    // poc_set): authenticated responses include non-public contacts and must
    // never reach an anonymous caller from L1. Shared responses use one
    // 'pub' partition. The router picks qc.cachePrefix (api/auth_scope.js).
    const cacheKey = normaliseCacheKey(`${qc.cachePrefix}:${rawPath}`, queryString);

    const { buf, tier, hits, stamp } = await withRestSWR(
        entityTag, cacheKey, ctx,
        async () => {
            if (opts.depth > 0) {
                const { sql, params } = buildRowQuery(entity, filters, opts);
                const result = await db.prepare(sql).bind(...params).all();
                const rows = result.results || [];
                // expandDepth mutates rows in place and returns nothing.
                for (const row of rows) { parseJsonFields(entity, row); }
                await expandDepth(db, entity, rows, opts.depth, authenticated, opts.pdbfe);
                return encodeJSON({ data: rows, meta: {} });
            }
            return queryJsonList(db, entity, filters, opts);
        }
    );

    const effectiveBuf = buf || EMPTY_ENVELOPE;
    return serveJSON(effectiveBuf, { tier, hits }, hResponse, lastModifiedOf(stamp, opts));
}

/**
 * Last-Modified for a response: the entity version its data was read at
 * (epoch ms) for depth=0, which shows the entity's rows alone (the router
 * answers If-Modified-Since from the version); 0, no header, at depth>0 or
 * when the version is unknown. Read after the query: on a cold isolate the
 * _sync_meta poll rode along with it.
 *
 * @param {number} version - Entity version (epoch s).
 * @param {QueryOpts} opts
 * @returns {number}
 */
export function lastModifiedOf(version, opts) {
    return opts.depth === 0 ? version * 1000 : 0;
}
