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
 *   - L1 cache + coalescing via core/pipeline/ with /v1/ path keys
 *
 * Route: rest.pdbfe.dev/*
 */

import { ENTITIES, ENTITY_TAGS, validateQuery, validateFields, resolveImplicitFilters, dropUnknownFilters } from '../api/entities.js';
import { parseQueryFilters } from '../api/utils.js';
import { identifyCaller, rateLimited, startVerification, settle } from '../core/gate.js';
import { wrapHandler, validateRequest, routeAdminPath } from '../core/admin.js';
import { handlePreflight, jsonError, deployedAtMs, isNotModifiedSince, parseIfModifiedSince } from '../core/http.js';
import { H_API_AUTH, H_API_ANON, H_API_SHARED, syncAlignedFor } from '../api/http.js';
import { isAuthSensitive, isRelationAuthSensitive } from '../api/auth_scope.js';
import { parseURL, tokenizeString } from '../core/utils.js';
import { getRestCacheStats, purgeRestCache, claimSyncPoll, runSyncPoll, getEntityVersion, refreshSyncState } from './cache.js';
import { withD1Stats } from '../core/d1stats.js';
import { serveStaticAsset } from './handlers/static.js';
import { handleDetail } from './handlers/detail.js';
import { handleListRequest } from './handlers/list.js';
import { handleSubResource, SUBRESOURCE_MAP } from './subresource.js';

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
        getStats: () => ({ rest: getRestCacheStats() }),
        flush: () => purgeRestCache(),
    });
    if (adminResponse) return adminResponse;

    // Static assets (Scalar UI, OpenAPI spec) — no auth needed
    const staticResponse = serveStaticAsset(rawPath);
    if (staticResponse) return staticResponse;

    // Unknown paths answer before auth and rate limiting: a scanner should get
    // a 404, not a 429 that invites it to retry. The message stays constant
    // here: jsonError caches by message, and nothing limits these requests.
    if (!rawPath.startsWith('v1/') || !ENTITY_TAGS.has(tokenizeString(rawPath.slice(3), '/', 2).p0)) {
        return jsonError(404, 'Not found');
    }

    // Rate limit, then serve as authenticated when the caller has a key or a
    // valid session; a key is verified alongside, a bad one gets a 401
    // (core/gate.js).
    const caller = await identifyCaller(request, env);
    if (caller.rejection) return jsonError(403, caller.rejection);
    if (await rateLimited(env, request, caller)) {
        return jsonError(429, 'Rate limit exceeded. Try again later.');
    }
    const authenticated = caller.identity !== null;
    const verification = startVerification(env, caller);
    const now = Date.now();

    // The wrapper lets the _sync_meta poll ride along with the request's
    // first D1 call (core/d1stats.js carry), as in the API worker: no extra
    // round trip, and the entity version is known when the response is built.
    const { db: rdb } = withD1Stats(db);
    const response = await routeApiRequest(request, { db: rdb, ctx, rawPath, queryString, authenticated, dumps: env.DUMPS, deployedAt: deployedAtMs(env), now });
    return settle(response, caller, verification, jsonError);
}

/**
 * Routes /v1/* API requests to the list or detail handler.
 * Extracted from handleRequest to reduce cognitive complexity.
 *
 * @param {Request} request - Inbound request.
 * @param {{db: any, ctx: ExecutionContext, rawPath: string, queryString: string, authenticated: boolean, dumps?: R2Bucket, deployedAt: number, now: number}} rc - Request context; `db` is the withD1Stats session.
 * @returns {Promise<Response>}
 */
async function routeApiRequest(request, rc) {
    const { db, ctx, rawPath, queryString, authenticated, dumps, deployedAt, now } = rc;

    const apiPath = rawPath.slice(3); // strip "v1/"
    const { p0: entityTag, p1: idStr, p2: relation } = tokenizeString(apiPath, '/', 3);

    const entity = ENTITIES[entityTag];
    const { filters, depth, limit, skip, since, sort, fields: rawFields, pdbfe, page, perPage } = parseQueryFilters(queryString);

    // Page-number pagination is an upstream-compatibility feature of /api;
    // the REST API pages with limit/skip. Reject rather than silently ignore.
    if (page !== null || perPage !== null) {
        return jsonError(400, 'page/per_page are not supported on the REST API; use limit and skip (or the /api endpoint)');
    }

    if (limit < -1 || skip < 0) {
        return jsonError(400, 'limit and skip must be non-negative integers');
    }

    const fields = rawFields.length > 0 ? validateFields(entity, rawFields) : [];

    // Restricted entities (poc): no gate here. The WHERE builder
    // (api/query.js) pins anonymous callers to visible=Public on every
    // query path.

    resolveImplicitFilters(entity, filters);
    // Unknown parameters are ignored, as upstream does (see dropUnknownFilters).
    dropUnknownFilters(entity, filters);

    // Auth-independent responses are shared (one cache partition, public,
    // edge-cacheable, no X-Auth-Status) — see api/auth_scope.js. A
    // sub-resource is sensitive if either end is a restricted entity.
    const def = relation === undefined ? undefined : SUBRESOURCE_MAP.get(entityTag)?.get(relation);
    const shared = relation === undefined
        ? !isAuthSensitive(entityTag, depth, filters)
        : !isRelationAuthSensitive(entityTag, def?.targetTag) && !isAuthSensitive(def?.targetTag ?? '', 0, filters);
    let hResponse = authenticated ? H_API_AUTH : H_API_ANON;
    let cachePrefix = authenticated ? 'auth' : 'anon';
    if (shared) {
        hResponse = H_API_SHARED;
        cachePrefix = 'pub';
    }

    const queryError = validateQuery(entity, filters);
    if (queryError) return jsonError(400, queryError);

    // If-Modified-Since: a list or depth=0 detail is made of the entity's
    // rows alone, so the entity version answers (Last-Modified on those
    // responses is that version). A cold isolate knows no versions yet; the
    // edge revalidates after every sync and most leave the table unchanged,
    // so a conditional request reads _sync_meta first (13 rows) for a 304
    // instead of the full response. Copies from before this worker version
    // was deployed get a full response (as api/index.js).
    const versioned = relation === undefined && depth === 0;
    const imsMs = versioned ? parseIfModifiedSince(request.headers) : -1;
    if (imsMs >= 0 && imsMs >= deployedAt) {
        if (getEntityVersion(entityTag) === 0) await refreshSyncState(db);
        const versionMs = getEntityVersion(entityTag) * 1000;
        if (versionMs > 0 && isNotModifiedSince(request.headers, versionMs)) {
            return new Response(null, { status: 304, headers: { ...hResponse, 'Cache-Control': syncAlignedFor(hResponse) } });
        }
    }

    const opts = { depth, limit, skip, since, sort, fields, pdbfe, authenticated };
    /** @type {{db: D1Session, ctx: ExecutionContext, entityTag: string, authenticated: boolean, hResponse: Record<string, string>, cachePrefix: string, queryString: string, dumps?: R2Bucket}} */
    const qc = { db, ctx, entityTag, authenticated, hResponse, cachePrefix, queryString, dumps };

    const poll = claimSyncPoll(now);
    if (poll) db.carry(poll);
    const response = await dispatch(rc, entity, idStr, relation, filters, opts, qc);
    const unsent = db.takeRider();
    if (unsent) ctx.waitUntil(runSyncPoll(db, unsent));
    return response;
}

/**
 * Dispatches a validated /v1/* request to the detail, sub-resource or list
 * handler.
 *
 * @param {any} rc - Request context (see routeApiRequest).
 * @param {EntityMeta} entity
 * @param {string|undefined} idStr
 * @param {string|undefined} relation
 * @param {ParsedFilter[]} filters
 * @param {QueryOpts} opts
 * @param {any} qc - Query context (see handlers/list.js).
 * @returns {Promise<Response>}
 */
async function dispatch(rc, entity, idStr, relation, filters, opts, qc) {
    const { entityTag, hResponse } = qc;
    if (idStr !== undefined) {
        const id = Number.parseInt(idStr, 10);
        if (Number.isNaN(id) || id <= 0) {
            return jsonError(400, `Invalid ID: ${idStr}`);
        }

        // Sub-resource: /v1/{entity}/{id}/{relation}
        if (relation !== undefined) {
            return handleSubResource(rc, entityTag, id, relation, rc.queryString, rc.authenticated, hResponse);
        }

        return handleDetail(entity, id, opts, qc);
    }

    return handleListRequest(entity, filters, opts, rc.rawPath, qc);
}

export default wrapHandler(handleRequest, 'pdbfe-rest');
