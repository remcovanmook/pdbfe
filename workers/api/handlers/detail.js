/**
 * @fileoverview Detail handler for GET /api/{entity}/{id}.
 *
 * Uses the zero-allocation hot path (json_group_array) for depth=0 and
 * falls back to row-level expansion for depth>0.
 */

import { ENTITIES } from '../entities.js';
import { buildJsonQuery, buildRowQuery } from '../query.js';
import { expandDepth } from '../depth.js';
import { normaliseCacheKey, DETAIL_TTL } from '../cache.js';
import { encoder, encodeJSON, serveJSON, jsonError, H_API_AUTH, H_API_ANON } from '../http.js';
import { withEdgeSWR } from '../swr.js';
import { parseJsonFields } from './shared.js';

/**
 * Handles a detail request for a single entity (GET /api/{entity}/{id}).
 * Uses the zero-allocation path for depth=0, row expansion for depth>0.
 *
 * @param {HandlerContext} hc - Common handler context.
 * @param {number} id - Entity ID.
 * @returns {Promise<Response>} JSON response.
 */
export async function handleDetail(hc, id) {
    const { request, db, ctx, entityTag, filters, opts, rawPath, queryString, authenticated } = hc;
    const entity = ENTITIES[entityTag];
    if (!entity) return jsonError(404, `Unknown entity: ${entityTag}`);

    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const { buf, tier, hits } = await withEdgeSWR(
        entityTag, cacheKey, ctx, DETAIL_TTL,
        () => executeDetailQuery(db, entity, filters, opts, id, authenticated)
    );

    if (!buf) return jsonError(404, `${entityTag} with id ${id} not found`);

    return serveJSON(request, buf, { tier, hits }, authenticated ? H_API_AUTH : H_API_ANON);
}

/**
 * Executes a detail (single entity) query against D1.
 * Returns null if the entity doesn't exist (triggering negative caching).
 *
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {QueryOpts} opts - Query options.
 * @param {number} id - Entity ID.
 * @param {boolean} authenticated - Whether the caller is authenticated (for POC visibility).
 * @returns {Promise<Uint8Array|null>} Payload bytes, or null for 404.
 */
async function executeDetailQuery(db, entity, filters, opts, id, authenticated) {
    if (opts.depth > 0) {
        const { sql, params } = buildRowQuery(entity, filters, opts, id);
        const result = await db.prepare(sql).bind(...params).all();
        const rows = result.results || [];

        if (rows.length === 0) return null;

        for (const row of rows) { parseJsonFields(entity, row); }
        await expandDepth(db, entity, rows, opts.depth, authenticated, opts.pdbfe);
        return encodeJSON({ data: rows, meta: {} });
    }

    const { sql, params } = buildJsonQuery(entity, filters, opts, id);
    const result = await db.prepare(sql).bind(...params).first();

    if (!result || !result.payload || result.payload === '{"data":[],"meta":{}}') {
        return null;
    }
    return encoder.encode(/** @type {string} */(result.payload));
}
