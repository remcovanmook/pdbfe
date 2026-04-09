/**
 * @fileoverview Main router for the PeeringDB API worker.
 * Validates requests, dispatches to admin endpoints, entity list/detail
 * handlers, AS-set lookups, and returns 501 for write methods.
 */

import { parseURL, parseQueryFilters } from '../core/utils.js';
import { validateRequest, routeAdminPath, wrapHandler } from '../core/admin.js';
import { handlePreflight, jsonError, H_API, H_NOCACHE } from '../core/http.js';
import { handleList, handleDetail, handleAsSet, handleNotImplemented } from './handlers/index.js';
import { ENTITY_TAGS, ENTITIES, validateFields, validateQuery, resolveImplicitFilters } from './entities.js';
import { getCacheStats, purgeAllCaches } from './cache.js';
import { isRateLimited, getRateLimitStats, purgeRateLimit } from './ratelimit.js';
import { extractApiKey, verifyApiKey, extractSessionId, resolveSession } from '../core/auth.js';

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
 * @param {string} _entityTag - Entity tag (unused, kept for call-site compat).
 * @param {string} _rawPath - URL path (unused, kept for call-site compat).
 * @param {string} _queryString - Query string (unused, kept for call-site compat).
 * @param {EntityMeta} entity - Entity schema for validation.
 * @param {ParsedFilter[]} filters - Parsed filters to validate.
 * @param {string} sort - Sort parameter to validate.
 * @returns {Response|null} 400 Response on validation failure, or null if valid.
 */
function checkCachedError(_entityTag, _rawPath, _queryString, entity, filters, sort) {
    const queryError = validateQuery(entity, filters, sort);
    if (!queryError) return null;

    const errorJson = JSON.stringify({ error: queryError }) + '\n';
    return new Response(errorJson, { status: 400, headers: H_NOCACHE });
}

/**
 * Returns database sync status from the _sync_meta table.
 * Reports the most recent sync timestamp across all entities,
 * plus a per-entity breakdown of last_sync epoch, row_count,
 * and updated_at datetime.
 *
 * This endpoint lives outside /api/ so it does not interfere
 * with the PeeringDB-compatible API schema.
 *
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @returns {Promise<Response>} JSON response with sync metadata.
 */
async function handleSyncStatus(db) {
    const rows = await db.prepare(
        'SELECT entity, last_sync, row_count, updated_at FROM "_sync_meta" ORDER BY entity'
    ).all();

    const entities = /** @type {Record<string, {last_sync: number, row_count: number, updated_at: string}>} */ ({});
    let latestUpdatedAt = '';

    for (const row of (rows.results || [])) {
        const entity = /** @type {string} */ (row.entity);
        entities[entity] = {
            last_sync: /** @type {number} */ (row.last_sync),
            row_count: /** @type {number} */ (row.row_count),
            updated_at: /** @type {string} */ (row.updated_at),
        };
        if (/** @type {string} */ (row.updated_at) > latestUpdatedAt) {
            latestUpdatedAt = /** @type {string} */ (row.updated_at);
        }
    }

    const body = {
        sync: {
            last_sync_at: latestUpdatedAt,
            entities,
        },
    };

    return new Response(JSON.stringify(body, null, 2) + "\n", {
        status: 200,
        headers: H_API,
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

    // In-memory rate limiting — drop abusive callers before touching D1.
    // Authenticated users are keyed by their identity (API key or session ID)
    // so multiple keys behind the same NAT each get independent quotas.
    // Anonymous callers share a single bucket per source IP.
    const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
    const rlKey = authIdentity
        ? `${clientIP}:${authIdentity}`
        : clientIP;
    if (isRateLimited(rlKey, authenticated)) {
        return authenticated
            ? jsonError(429, 'Too Many Requests')
            : jsonError(429,
                'Too Many Requests. Sign in or use an API key ' +
                'for higher rate limits — see /account');
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

        // /status — public sync metadata (outside /api/ namespace)
        if (rawPath === "status") {
            return handleSyncStatus(db);
        }

        return jsonError(404, "Not found");
    }

    // All API paths start with "api/"
    if (!rawPath.startsWith("api/")) {
        return jsonError(404, "Not found");
    }

    const apiPath = rawPath.slice(4); // strip "api/"

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
            return jsonError(404, `Unknown entity: ${entityTag}`);
        }

        const { filters, depth, limit, skip, since, sort, fields: rawFields } = parseQueryFilters(queryString);

        // Reject nonsensical negative values. limit=-1 is the internal
        // sentinel for "not specified"; any lower value is invalid user input.
        if (limit < -1 || skip < 0) {
            return jsonError(400, 'limit and skip must be non-negative integers');
        }

        const entity = ENTITIES[entityTag];
        const fields = rawFields.length > 0 ? validateFields(entity, rawFields) : [];

        // Restricted entities (poc) are not accessible to anonymous callers.
        // Upstream PeeringDB returns {"data": []} for unauthenticated /api/poc
        // requests. The anonFilter (visible=Public) is only applied during
        // depth expansion (poc_set), not on the direct endpoint.
        if (!authenticated && entity._restricted) {
            return new Response('{"data":[],"meta":{}}\n', { status: 200, headers: H_API });
        }

        resolveImplicitFilters(entity, filters);

        // Partition cache keys by authentication state to prevent cache
        // poisoning. Anonymous users see restricted poc_set filtered to
        // visible=Public; authenticated users see all visibility levels.
        // Without partitioning, whichever request populates the cache
        // first determines what the other group sees until TTL expires.
        const cachePath = (authenticated ? 'auth:' : 'anon:') + rawPath;

        const errorResponse = checkCachedError(entityTag, cachePath, queryString, entity, filters, sort);
        if (errorResponse) return errorResponse;

        return handleList(request, db, ctx, entityTag, filters, { depth, limit, skip, since, sort, fields }, cachePath, queryString, authenticated);
    }

    const entityTag = apiPath.slice(0, entitySlash);
    const rest = apiPath.slice(entitySlash + 1);

    // Special case: as_set/{asn}
    // Upstream rejects comma-separated ASNs with 400 — match that behaviour.
    if (entityTag === "as_set") {
        if (rest.includes(',')) {
            return jsonError(400, "Invalid ASN");
        }
        const asn = parseInt(rest, 10);
        if (isNaN(asn)) {
            return jsonError(400, "Invalid ASN");
        }
        return handleAsSet(request, db, ctx, asn);
    }

    // api/{entity}/{id} — detail endpoint
    if (!ENTITY_TAGS.has(entityTag)) {
        return jsonError(404, `Unknown entity: ${entityTag}`);
    }

    // Trailing slash is common in PeeringDB URLs — strip it.
    // Note: parseInt tolerates trailing non-numeric characters, so
    // ".json" extensions (e.g. /api/net/1.json) work accidentally:
    // parseInt('1.json', 10) → 1. This provides compatibility with
    // clients that append .json to API paths.
    const idStr = rest.endsWith("/") ? rest.slice(0, -1) : rest;
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id <= 0) {
        return jsonError(400, `Invalid ID: ${idStr}`);
    }

    const { filters, depth, limit, skip, since, sort, fields: rawFields } = parseQueryFilters(queryString);

    if (limit < -1 || skip < 0) {
        return jsonError(400, 'limit and skip must be non-negative integers');
    }

    const entity = ENTITIES[entityTag];
    const fields = rawFields.length > 0 ? validateFields(entity, rawFields) : [];

    // Restricted entities (poc) are not accessible to anonymous callers.
    if (!authenticated && entity._restricted) {
        return jsonError(404, `${entityTag} with id ${id} not found`);
    }

    resolveImplicitFilters(entity, filters);

    const cachePath = (authenticated ? 'auth:' : 'anon:') + rawPath;

    const errorResponse = checkCachedError(entityTag, cachePath, queryString, entity, filters, sort);
    if (errorResponse) return errorResponse;

    return handleDetail(request, db, ctx, entityTag, id, filters, { depth, limit, skip, since, sort, fields }, cachePath, queryString, authenticated);
}

export default wrapHandler(handleRequest, "pdbfe-api");
