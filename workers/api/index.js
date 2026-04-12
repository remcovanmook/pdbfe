/**
 * @fileoverview Main router for the PeeringDB API worker.
 * Validates requests, dispatches to admin endpoints, entity list/detail
 * handlers, AS-set lookups, and returns 501 for write methods.
 */

import { parseURL, parseQueryFilters } from '../core/utils.js';
import { validateRequest, routeAdminPath, wrapHandler } from '../core/admin.js';
import { handlePreflight, jsonError, H_API_AUTH, H_API_ANON, H_NOCACHE_AUTH, H_NOCACHE_ANON, isNotModifiedSince, lastModifiedHeader } from '../core/http.js';
import { handleList, handleDetail, handleAsSet, handleNotImplemented } from './handlers/index.js';
import { ensureSyncFreshness, getEntityVersion, handleSyncStatusCached } from './sync_state.js';
import { ENTITY_TAGS, ENTITIES, validateFields, validateQuery, resolveImplicitFilters } from './entities.js';
import { getCacheStats, purgeAllCaches } from './cache.js';
import { isRateLimited, getRateLimitStats, purgeRateLimit } from './ratelimit.js';
import { extractApiKey, verifyApiKey, extractSessionId, resolveSession } from '../core/auth.js';
import { initL2 } from './l2cache.js';

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Validates query filters and sort parameter against the entity schema.
 * Returns a 400 Response if validation fails, or null if valid.
 *
 * Validation errors are deliberately NOT cached in the entity LRU.
 * The CPU cost of re-validating is negligible (a Set.has() per filter
 * field), and caching errors would allow attackers to evict legitimate
 * data entries by flooding with randomised invalid query parameters.
 *
 * @param {EntityMeta} entity - Entity schema for validation.
 * @param {ParsedFilter[]} filters - Parsed filters to validate.
 * @param {string} sort - Sort parameter to validate.
 * @param {Record<string, string>} hNocache - Pre-cooked no-cache header set.
 * @returns {Response|null} 400 Response on validation failure, or null if valid.
 */
function checkCachedError(entity, filters, sort, hNocache) {
    const queryError = validateQuery(entity, filters, sort);
    if (!queryError) return null;

    const errorJson = JSON.stringify({ error: queryError }) + '\n';
    return new Response(errorJson, { status: 400, headers: hNocache });
}

/**
 * Adds Last-Modified header to an entity response using the per-entity
 * version timestamp from _sync_meta. Clones into a new Response to
 * work around frozen header objects.
 *
 * @param {Response} response - The original response.
 * @param {number} epochMs - Last-modified epoch in milliseconds.
 * @returns {Response} New response with Last-Modified header.
 */
function withLastModified(response, epochMs) {
    if (!epochMs) return response;
    const h = new Headers(response.headers);
    h.set('Last-Modified', lastModifiedHeader(epochMs));
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: h
    });
}

/**
 * Validates and routes incoming API requests.
 * Routes to admin endpoints, CORS preflight, entity list/detail handlers,
 * AS-set lookups, or returns appropriate error responses.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context for waitUntil.
 * @returns {Promise<Response>} The HTTP response.
 */
async function handleRequest(request, env, ctx) {
    initL2(request.url);
    const { rawPath, queryString } = parseURL(request);

    // Determine authentication status. Two paths:
    //   1. API-Key header (pdbfe.* keys) → USERS KV lookup
    //   2. Session ID (from Bearer token or cookie) → SESSIONS KV lookup
    const apiKey = extractApiKey(request);

    // Reject upstream PeeringDB keys early with a helpful error.
    // Only pdbfe-issued keys (pdbfe.<hex>) are valid on this mirror.
    if (apiKey !== null && !apiKey.startsWith('pdbfe.')) {
        return jsonError(403,
            'PeeringDB API keys are not valid on this mirror. ' +
            'Create a key at /account after signing in.');
    }

    let authenticated = apiKey !== null && await verifyApiKey(env.USERS, apiKey);
    let authIdentity = authenticated ? apiKey : null;

    if (!authenticated) {
        const sid = extractSessionId(request);
        if (sid) {
            const session = await resolveSession(env.SESSIONS, sid);
            if (session !== null) {
                authenticated = true;
                authIdentity = sid;
            }
        }
    }

    // Pre-select header sets based on auth state. These frozen objects
    // are used for all Response construction — no per-request cloning.
    const hApi = authenticated ? H_API_AUTH : H_API_ANON;
    const hNocache = authenticated ? H_NOCACHE_AUTH : H_NOCACHE_ANON;

    // In-memory rate limiting — drop abusive callers before touching D1.
    // Authenticated users are keyed by their identity (API key or session ID)
    // so multiple keys behind the same NAT each get independent quotas.
    // Anonymous callers share a single bucket per source IP.
    const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
    const rlKey = authIdentity || clientIP;
    if (isRateLimited(rlKey, authenticated)) {
        return authenticated
            ? jsonError(429, 'Too Many Requests', hNocache)
            : jsonError(429,
                'Too Many Requests. Sign in or use an API key ' +
                'for higher rate limits \u2014 see /account', hNocache);
    }

    // Create a D1 session for read replication. "first-unconstrained" allows
    // queries to hit any replica (including the primary). This is optimal for
    // read-only workloads where eventual consistency is acceptable.
    const db = env.PDB.withSession("first-unconstrained");

    // Allow all methods through validation so we can return proper 501s
    const invalid = validateRequest(request, rawPath, ALL_METHODS);
    if (invalid) return invalid;

    // CORS preflight
    if (request.method === "OPTIONS") {
        return handlePreflight();
    }

    const slash = rawPath.indexOf("/");

    // Root-level paths (no slash): admin endpoints
    if (slash === -1) {
        const adminResponse = routeAdminPath(rawPath, env, {
            db,
            serviceName: "pdbfe-api",
            getStats: () => ({
                ...getCacheStats(),
                rateLimit: getRateLimitStats(),
            }),
            flush: () => { purgeAllCaches(); purgeRateLimit(); },
        });
        if (adminResponse) return adminResponse;

        if (rawPath === "status") {
            return handleSyncStatusCached(request, db, ctx);
        }

        return jsonError(404, "Not found");
    }

    // All API paths start with "api/"
    if (!rawPath.startsWith("api/")) {
        return jsonError(404, "Not found");
    }

    const apiPath = rawPath.slice(4); // strip "api/"

    // O(1) hot-path hook: trigger background D1 poll if 15s have passed.
    // Scoped to entity routes only — admin/health/status don't need it.
    const now = Date.now();
    ensureSyncFreshness(db, ctx, now);

    // Write methods on API paths → 501 Not Implemented
    if (WRITE_METHODS.has(request.method)) {
        return handleNotImplemented(request.method, `/${rawPath}`);
    }

    // Parse the entity tag and optional ID from the path
    // Patterns:
    //   api/{entity}       → list
    //   api/{entity}/{id}  → detail
    //   api/as_set/{asn}   → AS set lookup
    const entitySlash = apiPath.indexOf("/");

    if (entitySlash === -1) {
        // api/{entity} — list endpoint
        const entityTag = apiPath;
        if (!ENTITY_TAGS.has(entityTag)) {
            return jsonError(404, `Unknown entity: ${entityTag}`, hNocache);
        }

        const { filters, depth, limit, skip, since, sort, fields: rawFields } = parseQueryFilters(queryString);

        // Reject nonsensical negative values. limit=-1 is the internal
        // sentinel for "not specified"; any lower value is invalid user input.
        if (limit < -1 || skip < 0) {
            return jsonError(400, 'limit and skip must be non-negative integers', hNocache);
        }

        const entity = ENTITIES[entityTag];
        const fields = rawFields.length > 0 ? validateFields(entity, rawFields) : [];

        // Restricted entities (poc) are not accessible to anonymous callers.
        // Upstream PeeringDB returns {"data": []} for unauthenticated /api/poc
        // requests. The anonFilter (visible=Public) is only applied during
        // depth expansion (poc_set), not on the direct endpoint.
        if (!authenticated && entity._restricted) {
            return new Response('{"data":[],"meta":{}}\n', { status: 200, headers: hApi });
        }

        // If-Modified-Since shortcut: if the entity data hasn't changed
        // since the client's cached copy, return 304 without touching
        // any cache or D1. Uses the per-entity last_modified_at from _sync_meta.
        const entityVersionMs = getEntityVersion(entityTag) * 1000;
        if (entityVersionMs > 0 && isNotModifiedSince(request.headers, entityVersionMs)) {
            return new Response(null, {
                status: 304,
                headers: {
                    ...hApi,
                    'Last-Modified': lastModifiedHeader(entityVersionMs),
                }
            });
        }

        resolveImplicitFilters(entity, filters);

        // Partition cache keys by authentication state to prevent cache
        // poisoning. Anonymous users see restricted poc_set filtered to
        // visible=Public; authenticated users see all visibility levels.
        // Without partitioning, whichever request populates the cache
        // first determines what the other group sees until TTL expires.
        const cachePath = (authenticated ? 'auth:' : 'anon:') + rawPath;

        const errorResponse = checkCachedError(entity, filters, sort, hNocache);
        if (errorResponse) return errorResponse;

        const response = await handleList(request, db, ctx, entityTag, filters, { depth, limit, skip, since, sort, fields }, cachePath, queryString, authenticated);
        return withLastModified(response, entityVersionMs);
    }

    const entityTag = apiPath.slice(0, entitySlash);
    const rest = apiPath.slice(entitySlash + 1);

    // Special case: as_set/{asn}
    // Upstream rejects comma-separated ASNs with 400 — match that behaviour.
    if (entityTag === "as_set") {
        if (rest.includes(',')) {
            return jsonError(400, "Invalid ASN", hNocache);
        }
        const asn = parseInt(rest, 10);
        if (isNaN(asn)) {
            return jsonError(400, "Invalid ASN", hNocache);
        }
        return handleAsSet(request, db, ctx, asn, authenticated);
    }

    // api/{entity}/{id} — detail endpoint
    if (!ENTITY_TAGS.has(entityTag)) {
        return jsonError(404, `Unknown entity: ${entityTag}`, hNocache);
    }

    // Trailing slash is common in PeeringDB URLs — strip it.
    // Note: parseInt tolerates trailing non-numeric characters, so
    // ".json" extensions (e.g. /api/net/1.json) work accidentally:
    // parseInt('1.json', 10) → 1. This provides compatibility with
    // clients that append .json to API paths.
    const idStr = rest.endsWith("/") ? rest.slice(0, -1) : rest;
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id <= 0) {
        return jsonError(400, `Invalid ID: ${idStr}`, hNocache);
    }

    const { filters, depth, limit, skip, since, sort, fields: rawFields } = parseQueryFilters(queryString);

    if (limit < -1 || skip < 0) {
        return jsonError(400, 'limit and skip must be non-negative integers', hNocache);
    }

    const entity = ENTITIES[entityTag];
    const fields = rawFields.length > 0 ? validateFields(entity, rawFields) : [];

    // Restricted entities (poc) are not accessible to anonymous callers.
    if (!authenticated && entity._restricted) {
        return jsonError(404, `${entityTag} with id ${id} not found`, hNocache);
    }

    // If-Modified-Since shortcut for detail endpoints.
    const entityVersionMs = getEntityVersion(entityTag) * 1000;
    if (entityVersionMs > 0 && isNotModifiedSince(request.headers, entityVersionMs)) {
        return new Response(null, {
            status: 304,
            headers: {
                ...hApi,
                'Last-Modified': lastModifiedHeader(entityVersionMs),
            }
        });
    }

    resolveImplicitFilters(entity, filters);

    const cachePath = (authenticated ? 'auth:' : 'anon:') + rawPath;

    const errorResponse = checkCachedError(entity, filters, sort, hNocache);
    if (errorResponse) return errorResponse;

    const response = await handleDetail(request, db, ctx, entityTag, id, filters, { depth, limit, skip, since, sort, fields }, cachePath, queryString, authenticated);
    return withLastModified(response, entityVersionMs);
}

export default wrapHandler(handleRequest, "pdbfe-api");
