/**
 * @fileoverview Main router for the PeeringDB API worker.
 * Validates requests, dispatches to admin endpoints, entity list/detail
 * handlers, AS-set lookups, and returns 501 for write methods.
 */

import { parseURL, tokenizeString } from '../core/utils.js';
import { parseQueryFilters } from './utils.js';
import { validateRequest, routeAdminPath, wrapHandler } from '../core/admin.js';
import { handlePreflight, jsonError, H_API_AUTH, H_API_ANON, H_NOCACHE_AUTH, H_NOCACHE_ANON, isNotModifiedSince, lastModifiedHeader, withLastModified } from './http.js';
import { handleList, handleDetail, handleAsSet, handleNotImplemented } from './handlers/index.js';
import { ensureSyncFreshness, getEntityVersion, handleStatus } from './sync_state.js';
import { ENTITY_TAGS, ENTITIES, validateFields, validateQuery, resolveImplicitFilters } from './entities.js';
import { getCacheStats, purgeAllCaches } from './cache.js';
import { isRateLimited, getRateLimitStats, purgeRateLimit } from './ratelimit.js';
import { resolveAuth } from '../core/auth.js';
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
function validateQueryOrError(entity, filters, sort, hNocache) {
    const queryError = validateQuery(entity, filters, sort);
    if (!queryError) return null;
    return jsonError(400, queryError, hNocache);
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

    const { authenticated, identity: authIdentity, rejection } = await resolveAuth(request, env);
    if (rejection) return jsonError(403, rejection);

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

    // Allow all methods through validation so we can return proper 501s
    const invalid = validateRequest(request, rawPath, ALL_METHODS);
    if (invalid) return invalid;

    // CORS preflight — return before D1 session allocation
    if (request.method === "OPTIONS") {
        return handlePreflight();
    }

    // Create a D1 session for read replication. "first-unconstrained" allows
    // queries to hit any replica (including the primary). This is optimal for
    // read-only workloads where eventual consistency is acceptable.
    // Placed after OPTIONS/method checks to avoid the allocation on preflight.
    const db = env.PDB.withSession("first-unconstrained");

    const { p0: topLevel, p1: apiCall } = tokenizeString(rawPath, '/', 2);

    // Root-level paths (no slash): admin endpoints
    if (apiCall === undefined) {
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
            return handleStatus(request, db, ctx);
        }

        return jsonError(404, "Not found");
    }

    // All API paths start with "api/"
    if (topLevel !== "api") {
        return jsonError(404, "Not found");
    }

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
    const { p0: entityTag, p1: rest } = tokenizeString(apiCall, '/', 2);

    // Special case: as_set/{asn} — early return before shared entity flow.
    // Upstream rejects comma-separated ASNs with 400 — match that behaviour.
    if (entityTag === "as_set" && rest !== undefined) {
        if (rest.includes(',')) {
            return jsonError(400, "Invalid ASN", hNocache);
        }
        const asn = parseInt(rest, 10);
        if (isNaN(asn)) {
            return jsonError(400, "Invalid ASN", hNocache);
        }
        return handleAsSet(request, db, ctx, asn, authenticated);
    }

    // ── Shared entity request pipeline ───────────────────────────────
    // List and detail endpoints share the same validation, caching, and
    // response pipeline. The only fork is which handler to call at the end.

    if (!ENTITY_TAGS.has(entityTag)) {
        return jsonError(404, `Unknown entity: ${entityTag}`, hNocache);
    }

    // Parse optional detail ID from the rest segment.
    let id = 0;
    if (rest !== undefined) {
        // parseInt stops at the first non-numeric character, so trailing
        // slashes ("/") and ".json" suffixes are handled natively:
        // parseInt('1/', 10) → 1, parseInt('1.json', 10) → 1.
        id = parseInt(rest, 10);
        if (isNaN(id) || id <= 0) {
            return jsonError(400, `Invalid ID: ${rest}`, hNocache);
        }
    }

    const { filters, depth, limit, skip, since, sort, fields: rawFields } = parseQueryFilters(queryString);

    if (limit < -1 || skip < 0) {
        return jsonError(400, 'limit and skip must be non-negative integers', hNocache);
    }

    const entity = ENTITIES[entityTag];
    const fields = rawFields.length > 0 ? validateFields(entity, rawFields) : [];

    // Restricted entities (poc) are not accessible to anonymous callers.
    // List returns 200 with empty data (upstream behaviour); detail returns 404.
    if (!authenticated && entity._restricted) {
        if (id > 0) {
            return jsonError(404, `${entityTag} with id ${id} not found`, hNocache);
        }
        // 200 empty result — not an error — matches upstream's treatment
        // of unauthenticated /api/poc as a valid but empty result set.
        return new Response('{"data":[],"meta":{}}\n', { status: 200, headers: hApi });
    }

    // If-Modified-Since shortcut: return 304 without touching cache or D1
    // if the entity data hasn't changed since the client's cached copy.
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
    const cachePath = `${authenticated ? 'auth' : 'anon'}:${rawPath}`;

    const errorResponse = validateQueryOrError(entity, filters, sort, hNocache);
    if (errorResponse) return errorResponse;

    const opts = { depth, limit, skip, since, sort, fields };

    // ── Handler dispatch ─────────────────────────────────────────────
    const response = id > 0
        ? await handleDetail(request, db, ctx, entityTag, id, filters, opts, cachePath, queryString, authenticated)
        : await handleList(request, db, ctx, entityTag, filters, opts, cachePath, queryString, authenticated);
    return withLastModified(response, entityVersionMs);
}

export default wrapHandler(handleRequest, "pdbfe-api");
