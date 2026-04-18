/**
 * @fileoverview REST API worker entry point.
 *
 * Serves a versioned REST API at /v1/{entity}, /v1/{entity}/{id},
 * and /v1/{entity}/{id}/{relation} for sub-resource traversal,
 * plus an OpenAPI 3.1 spec at /openapi.json and a Scalar API docs
 * UI at the root path.
 *
 * Architecture:
 *   - handlers/static.js  — Scalar UI, OpenAPI spec, font assets
 *   - handlers/detail.js  — Single entity by ID
 *   - handlers/list.js    — Entity list with filters
 *   - cache.js            — LRU cache, SWR wrapper
 *   - Query building via the shared api/query.js module
 *   - Auth via core/auth.js (API keys + session cookies)
 *   - Rate limiting via core/ratelimit.js factory
 *   - L2 cache via core/l2cache.js with /v1/ path keys
 *
 * Route: rest.pdbfe.dev/*
 */

import { ENTITIES, ENTITY_TAGS, validateQuery, validateFields, resolveImplicitFilters } from '../api/entities.js';
import { parseQueryFilters } from '../api/utils.js';
import { resolveAuth } from '../core/auth.js';
import { wrapHandler, validateRequest, routeAdminPath } from '../core/admin.js';
import { handlePreflight, jsonError } from '../core/http.js';
import { H_API_AUTH, H_API_ANON } from '../api/http.js';
import { parseURL, tokenizeString } from '../core/utils.js';
import { initL2 } from '../core/l2cache.js';
import { createRateLimiter } from '../core/ratelimit.js';
import { getRestCacheStats, purgeRestCache } from './cache.js';
import { serveStaticAsset } from './handlers/static.js';
import { handleDetail } from './handlers/detail.js';
import { handleListRequest } from './handlers/list.js';
import { handleSubResource } from './subresource.js';

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

    // Restricted entities (poc) are gated for anonymous callers.
    // Bare /v1/poc → empty; /v1/poc?visible=Public → returns public contacts.
    if (!authenticated && entity._restricted) {
        const af = entity._anonFilter;
        const visFilter = af && filters.find(f => f.field === af.field && !f.entity);
        if (!visFilter) {
            if (idStr !== undefined) {
                return jsonError(404, `${entityTag} not found`);
            }
            return new Response('{"data":[],"meta":{}}\n', { status: 200, headers: hResponse });
        }
        visFilter.value = af.value;
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

export default wrapHandler(handleRequest, 'pdbfe-rest');
