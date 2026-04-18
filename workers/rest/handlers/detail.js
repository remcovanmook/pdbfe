/**
 * @fileoverview Detail handler for GET /v1/{entity}/{id} on the REST worker.
 *
 * Uses the zero-allocation hot path (json_group_array) for depth=0 and
 * falls back to row-level expansion for depth>0. Cached via withRestSWR.
 */

import { buildJsonQuery, buildRowQuery } from '../../api/query.js';
import { expandDepth } from '../../api/depth.js';
import { encodeJSON, encoder } from '../../core/http.js';
import { normaliseCacheKey } from '../../core/cache.js';
import { serveJSON, jsonError } from '../../api/http.js';
import { withRestSWR } from '../cache.js';

/**
 * Handles a detail request for a single entity by ID.
 *
 * @param {Request} request - Inbound request.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {number} id - Entity primary key.
 * @param {QueryOpts} opts - Parsed query options.
 * @param {{db: D1Session, ctx: ExecutionContext, entityTag: string, authenticated: boolean, hResponse: Record<string, string>, queryString: string}} qc - Query context.
 * @returns {Promise<Response>}
 */
export async function handleDetail(request, entity, id, opts, qc) {
    const { db, ctx, entityTag, authenticated, hResponse, queryString } = qc;
    const cacheKey = normaliseCacheKey(`v1/${entityTag}/${id}`, queryString);

    const { buf, tier, hits } = await withRestSWR(
        entityTag, cacheKey, ctx,
        async () => {
            if (opts.depth > 0) {
                const { sql, params } = buildRowQuery(entity, [], opts, id);
                const result = await db.prepare(sql).bind(...params).all();
                const rows = result.results || [];
                if (rows.length === 0) return null;
                const expanded = await expandDepth(db, entity, rows, opts.depth, authenticated);
                return encodeJSON({ data: expanded, meta: {} });
            }
            const { sql, params } = buildJsonQuery(entity, [], opts, id);
            const row = await db.prepare(sql).bind(...params).first();
            if (!row?.payload) return null;
            return encoder.encode(/** @type {string} */(row.payload));
        }
    );

    if (!buf) {
        return jsonError(404, `${entityTag} with id ${id} not found`);
    }

    return serveJSON(request, buf, { tier, hits }, hResponse);
}
