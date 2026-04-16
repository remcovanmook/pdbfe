/**
 * @fileoverview REST API worker entry point.
 *
 * Serves a versioned REST API at /v1/{entity}, /v1/{entity}/{id},
 * and /v1/{entity}/{id}/{relation} for sub-resource traversal,
 * plus an OpenAPI 3.1 spec at /openapi.json and a Scalar API docs
 * UI at the root path.
 *
 * Architecture:
 *   - Query building via the shared api/query.js module
 *   - Response format matches the upstream PeeringDB JSON envelope
 *   - Auth via core/auth.js (API keys + session cookies)
 *   - Rate limiting via core/ratelimit.js factory
 *   - L2 cache via core/l2cache.js with /v1/ path keys
 *
 * Route: rest.pdbfe.dev/*
 */

import { ENTITIES, ENTITY_TAGS, validateQuery, validateFields, resolveImplicitFilters } from '../api/entities.js';
import { buildJsonQuery, buildRowQuery } from '../api/query.js';
import { parseQueryFilters } from '../api/utils.js';
import { expandDepth } from '../api/depth.js';
import { resolveAuth } from '../core/auth.js';
import { wrapHandler, validateRequest, routeAdminPath } from '../core/admin.js';
import { handlePreflight, jsonError, encodeJSON, encoder } from '../core/http.js';
import { serveJSON, H_API_AUTH, H_API_ANON } from '../api/http.js';
import { parseURL, tokenizeString } from '../core/utils.js';
import { normaliseCacheKey } from '../core/cache.js';
import { initL2 } from '../core/l2cache.js';
import { createRateLimiter } from '../core/ratelimit.js';
import { withEdgeSWR } from '../api/swr.js';
import { EMPTY_ENVELOPE } from '../core/pipeline.js';
import { getRestCacheStats, purgeRestCache, REST_TTL } from './cache.js';
import { serveScalarUI } from './scalar.js';
import { handleSubResource } from './subresource.js';
import openApiSpec from '../../extracted/openapi.json';

/**
 * Pre-encoded OpenAPI spec served at /openapi.json.
 * Encoded once at module load to avoid repeated serialisation.
 * @type {Uint8Array}
 */
const SPEC_BYTES = encoder.encode(JSON.stringify(openApiSpec));

/** Headers for the OpenAPI JSON spec response. */
const H_SPEC = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
});

/**
 * Rate limiter for REST requests.
 * Same thresholds as the API worker — the REST API mirrors the
 * same dataset with the same query patterns.
 */
const { isRateLimited, getStats: getRateLimitStats, purge: purgeRateLimit } = createRateLimiter({
    slots: 4000,
    maxBytes: 4 * 1024 * 1024,
    windowMs: 60_000,
    limitAnon: 60,
    limitAuth: 600,
});

/**
 * Serves static assets: Scalar UI and OpenAPI spec.
 * Returns null if the path doesn't match a static asset.
 *
 * @param {string} rawPath - URL path without leading slash.
 * @returns {Response|null} Static response or null.
 */
function serveStaticAsset(rawPath) {
    if (rawPath === '' || rawPath === 'index.html') {
        return serveScalarUI();
    }
    if (rawPath === 'openapi.json') {
        return new Response(
            /** @type {BodyInit} */(/** @type {unknown} */ (SPEC_BYTES)),
            { status: 200, headers: H_SPEC }
        );
    }
    return null;
}

/**
 * Handles incoming requests to the REST worker.
 *
 * Routing:
 *   GET /                → Scalar API docs UI
 *   GET /openapi.json    → OpenAPI 3.1 spec
 *   GET /v1/{entity}     → List entities
 *   GET /v1/{entity}/{id}→ Get entity by ID
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @returns {Promise<Response>} The HTTP response.
 */
async function handleRequest(request, env, ctx) {
    initL2(request.url);
    const { rawPath, queryString } = parseURL(request);

    const validationError = validateRequest(request, rawPath);
    if (validationError) return validationError;

    if (request.method === 'OPTIONS') {
        return handlePreflight(request);
    }

    const db = env.PDB.withSession('first-unconstrained');

    const adminResponse = await routeAdminPath(rawPath, env, {
        db,
        serviceName: 'pdbfe-rest',
        getStats: () => ({
            rest: getRestCacheStats(),
            rateLimit: getRateLimitStats(),
        }),
        flush: () => { purgeRestCache(); purgeRateLimit(); },
    });
    if (adminResponse) return adminResponse;

    // Static assets (Scalar UI, OpenAPI spec) — no auth needed
    const staticResponse = serveStaticAsset(rawPath);
    if (staticResponse) return staticResponse;

    // Auth resolution
    const { authenticated, identity, rejection } = await resolveAuth(request, env);
    if (rejection) return jsonError(403, rejection);

    const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
    const callerKey = identity || clientIP;
    if (isRateLimited(callerKey, authenticated, Date.now())) {
        return jsonError(429, 'Rate limit exceeded. Try again later.');
    }

    return routeApiRequest(request, { db, ctx, rawPath, queryString, authenticated });
}

/**
 * Routes /v1/* API requests to the list or detail handler.
 * Extracted from handleRequest to reduce cognitive complexity.
 *
 * @param {Request} request - Inbound request.
 * @param {{db: D1Session, ctx: ExecutionContext, rawPath: string, queryString: string, authenticated: boolean}} rc - Request context.
 * @returns {Promise<Response>}
 */
async function routeApiRequest(request, rc) {
    const { db, ctx, rawPath, queryString, authenticated } = rc;
    const hResponse = authenticated ? H_API_AUTH : H_API_ANON;

    if (!rawPath.startsWith('v1/')) {
        return jsonError(404, 'Not found');
    }

    const apiPath = rawPath.slice(3); // strip "v1/"
    const { p0: entityTag, p1: idStr, p2: relation } = tokenizeString(apiPath, '/', 3);

    if (!ENTITY_TAGS.has(entityTag)) {
        return jsonError(404, `Unknown entity: ${entityTag}`);
    }

    const entity = ENTITIES[entityTag];
    const { filters, depth, limit, skip, since, sort, fields: rawFields, pdbfe } = parseQueryFilters(queryString);

    if (limit < -1 || skip < 0) {
        return jsonError(400, 'limit and skip must be non-negative integers');
    }

    const fields = rawFields.length > 0 ? validateFields(entity, rawFields) : [];

    // Restricted entities (poc) → empty for anonymous callers
    if (!authenticated && entity._restricted) {
        if (idStr !== undefined) {
            return jsonError(404, `${entityTag} not found`);
        }
        return new Response('{"data":[],"meta":{}}\n', { status: 200, headers: hResponse });
    }

    resolveImplicitFilters(entity, filters);

    const queryError = validateQuery(entity, filters, sort);
    if (queryError) return jsonError(400, queryError);

    const opts = { depth, limit, skip, since, sort, fields, pdbfe };
    /** @type {{db: D1Session, ctx: ExecutionContext, entityTag: string, authenticated: boolean, hResponse: Record<string, string>, queryString: string}} */
    const qc = { db, ctx, entityTag, authenticated, hResponse, queryString };

    if (idStr !== undefined) {
        const id = Number.parseInt(idStr, 10);
        if (Number.isNaN(id) || id <= 0) {
            return jsonError(400, `Invalid ID: ${idStr}`);
        }

        // Sub-resource: /v1/{entity}/{id}/{relation}
        if (relation !== undefined) {
            return handleSubResource(rc, entityTag, id, relation, queryString, authenticated, hResponse);
        }

        return handleDetail(request, entity, id, opts, qc);
    }

    return handleListRequest(request, entity, filters, opts, rawPath, qc);
}

/**
 * Handles a detail request for a single entity by ID.
 * Uses withEdgeSWR for L1/L2 caching.
 *
 * @param {Request} request - Inbound request.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {number} id - Entity primary key.
 * @param {QueryOpts} opts - Parsed query options.
 * @param {{db: D1Session, ctx: ExecutionContext, entityTag: string, authenticated: boolean, hResponse: Record<string, string>, queryString: string}} qc - Query context.
 * @returns {Promise<Response>}
 */
async function handleDetail(request, entity, id, opts, qc) {
    const { db, ctx, entityTag, authenticated, hResponse, queryString } = qc;
    const cacheKey = normaliseCacheKey(`v1/${entityTag}/${id}`, queryString);

    const { buf, tier, hits } = await withEdgeSWR(
        entityTag, cacheKey, ctx, REST_TTL,
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

/**
 * Handles a list request for entities matching the given filters.
 * Uses withEdgeSWR for L1/L2 caching.
 *
 * @param {Request} request - Inbound request.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Query filters.
 * @param {QueryOpts} opts - Parsed query options.
 * @param {string} rawPath - Raw URL path (for cache key).
 * @param {{db: D1Session, ctx: ExecutionContext, entityTag: string, authenticated: boolean, hResponse: Record<string, string>, queryString: string}} qc - Query context.
 * @returns {Promise<Response>}
 */
async function handleListRequest(request, entity, filters, opts, rawPath, qc) {
    const { db, ctx, entityTag, authenticated, hResponse, queryString } = qc;
    const cacheKey = normaliseCacheKey(rawPath, queryString);

    const { buf, tier, hits } = await withEdgeSWR(
        entityTag, cacheKey, ctx, REST_TTL,
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

export default wrapHandler(handleRequest, 'pdbfe-rest');
