/**
 * @fileoverview List handler for GET /v1/{entity} on the REST worker.
 *
 * Uses the zero-allocation hot path (json_group_array) for depth=0 and
 * falls back to row-level expansion for depth>0. Cached via withRestSWR.
 */

import { buildJsonQuery, buildRowQuery } from '../../api/query.js';
import { expandDepth } from '../../api/depth.js';
import { encodeJSON, encoder } from '../../core/http.js';
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
 * @param {{db: D1Session, ctx: ExecutionContext, entityTag: string, authenticated: boolean, hResponse: Record<string, string>, queryString: string}} qc - Query context.
 * @returns {Promise<Response>}
 */
export async function handleListRequest(request, entity, filters, opts, rawPath, qc) {
    const { db, ctx, entityTag, authenticated, hResponse, queryString } = qc;
    const cacheKey = normaliseCacheKey(rawPath, queryString);

    const { buf, tier, hits } = await withRestSWR(
        entityTag, cacheKey, ctx,
        async () => {
            if (opts.depth > 0) {
                const { sql, params } = buildRowQuery(entity, filters, opts);
                const result = await db.prepare(sql).bind(...params).all();
                const rows = result.results || [];
                const expanded = await expandDepth(db, entity, rows, opts.depth, authenticated);
                return encodeJSON({ data: expanded, meta: {} });
            }
            const { sql, params } = buildJsonQuery(entity, filters, opts);
            const row = await db.prepare(sql).bind(...params).first();
            if (!row?.payload) return null;
            return encoder.encode(/** @type {string} */(row.payload));
        }
    );

    const effectiveBuf = buf || EMPTY_ENVELOPE;
    return serveJSON(request, effectiveBuf, { tier, hits }, hResponse);
}
