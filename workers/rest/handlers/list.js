/**
 * @fileoverview List handler for GET /v1/{entity} on the REST worker.
 *
 * Uses the zero-allocation hot path (json_group_array) for depth=0 and
 * falls back to row-level expansion for depth>0. Cached via withRestSWR.
 */

import { buildRowQuery } from '../../api/query.js';
import { queryJsonList } from '../../api/json_list.js';
import { expandDepth } from '../../api/depth.js';
import { parseJsonFields } from '../../api/handlers/shared.js';
import { encodeJSON } from '../../core/http.js';
import { normaliseCacheKey } from '../../core/cache.js';
import { serveJSON } from '../../api/http.js';
import { EMPTY_ENVELOPE } from '../../core/pipeline/index.js';
import { withRestSWR } from '../cache.js';

/**
 * Handles a list request for entities matching the given filters.
 *
 * @param {Request} request - Inbound request.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Query filters.
 * @param {QueryOpts} opts - Parsed query options.
 * @param {string} rawPath - Raw URL path (for cache key).
 * @param {{db: D1Session, ctx: ExecutionContext, entityTag: string, authenticated: boolean, hResponse: Record<string, string>, cachePrefix: string, queryString: string}} qc - Query context.
 * @returns {Promise<Response>}
 */
export async function handleListRequest(request, entity, filters, opts, rawPath, qc) {
    const { db, ctx, entityTag, authenticated, hResponse, queryString } = qc;
    // Partitioned by auth state where it matters (poc lists, depth>0
    // poc_set): authenticated responses include non-public contacts and must
    // never reach an anonymous caller from L1/L2. Shared responses use one
    // 'pub' partition. The router picks qc.cachePrefix (api/auth_scope.js).
    const cacheKey = normaliseCacheKey(`${qc.cachePrefix}:${rawPath}`, queryString);

    const { buf, tier, hits } = await withRestSWR(
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
    return serveJSON(request, effectiveBuf, { tier, hits }, hResponse);
}
