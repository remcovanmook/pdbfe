/**
 * @fileoverview Main router for the PeeringDB API worker.
 * Validates requests, dispatches to admin endpoints, entity list/detail
 * handlers, AS-set lookups, and returns 501 for write methods.
 */

import { parseURL, parseQueryFilters } from '../core/utils.js';
import { validateRequest, routeAdminPath, wrapHandler } from '../core/admin.js';
import { handlePreflight, jsonError, H_API, H_NOCACHE, encoder } from '../core/http.js';
import { handleList, handleDetail, handleAsSet, handleNotImplemented } from './handlers/index.js';
import { ENTITY_TAGS, ENTITIES, validateFields, validateQuery } from './entities.js';
import { getCacheStats, purgeAllCaches, getEntityCache, normaliseCacheKey, ERROR_TTL } from './cache.js';
import { putL2 } from './l2cache.js';

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];

/** Cache metadata tag for 400 error entries, distinguishing them from data. */
const ERROR_META_TAG = '_error';

/**
 * Checks the entity cache for a cached 400 error response. If found and
 * within TTL, returns the Response directly. If not cached, runs
 * validation; on failure, caches the error body in L1 + L2 and returns
 * the Response. Returns null if validation passes.
 *
 * This prevents repeated schema validation for the same invalid query
 * string (bot traffic, retries, scrapers with broken filters).
 *
 * @param {string} entityTag - Entity tag for cache lookup.
 * @param {string} rawPath - URL path for cache key.
 * @param {string} queryString - Query string for cache key.
 * @param {EntityMeta} entity - Entity schema for validation.
 * @param {ParsedFilter[]} filters - Parsed filters to validate.
 * @param {string} sort - Sort parameter to validate.
 * @returns {Response|null} Cached or fresh 400 Response, or null if valid.
 */
function checkCachedError(entityTag, rawPath, queryString, entity, filters, sort) {
    const cache = getEntityCache(entityTag);
    const cacheKey = normaliseCacheKey(rawPath, queryString);
    const now = Date.now();

    // L1 check: if we've already cached a 400 for this exact query, return it
    const cached = cache.get(cacheKey);
    if (cached && cached.meta?.entityTag === ERROR_META_TAG && (now - cached.addedAt) < ERROR_TTL) {
        return new Response(
            /** @type {BodyInit} */(/** @type {unknown} */(cached.buf)),
            { status: 400, headers: H_NOCACHE }
        );
    }

    // Run validation
    const queryError = validateQuery(entity, filters, sort);
    if (!queryError) return null;

    // Cache the error body in L1 + L2
    const errorBody = encoder.encode(JSON.stringify({ error: queryError }) + '\n');
    cache.add(cacheKey, errorBody, { entityTag: ERROR_META_TAG }, now);
    putL2(cacheKey, errorBody, ERROR_TTL / 1000);

    return new Response(
        JSON.stringify({ error: queryError }) + '\n',
        { status: 400, headers: H_NOCACHE }
    );
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
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 * @returns {Promise<Response>} JSON response with sync metadata.
 */
async function handleSyncStatus(env) {
    const rows = await env.PDB.prepare(
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
            db: env.PDB,
            serviceName: "pdbfe-api",
            getStats: getCacheStats,
            flush: purgeAllCaches,
        });
        if (adminResponse) return adminResponse;

        // /status — public sync metadata (outside /api/ namespace)
        if (rawPath === "status") {
            return handleSyncStatus(env);
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
        const entity = ENTITIES[entityTag];
        const fields = rawFields.length > 0 ? validateFields(entity, rawFields) : [];

        const errorResponse = checkCachedError(entityTag, rawPath, queryString, entity, filters, sort);
        if (errorResponse) return errorResponse;

        return handleList(request, env, ctx, entityTag, filters, { depth, limit, skip, since, sort, fields }, rawPath, queryString);
    }

    const entityTag = apiPath.slice(0, entitySlash);
    const rest = apiPath.slice(entitySlash + 1);

    // Special case: as_set/{asn}
    if (entityTag === "as_set") {
        const asn = parseInt(rest, 10);
        if (isNaN(asn) || asn <= 0) {
            return jsonError(400, "Invalid ASN");
        }
        return handleAsSet(request, env, asn);
    }

    // api/{entity}/{id} — detail endpoint
    if (!ENTITY_TAGS.has(entityTag)) {
        return jsonError(404, `Unknown entity: ${entityTag}`);
    }

    // Trailing slash is common in PeeringDB URLs — strip it
    const idStr = rest.endsWith("/") ? rest.slice(0, -1) : rest;
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id <= 0) {
        return jsonError(400, `Invalid ID: ${idStr}`);
    }

    const { filters, depth, limit, skip, since, sort, fields: rawFields } = parseQueryFilters(queryString);
    const entity = ENTITIES[entityTag];
    const fields = rawFields.length > 0 ? validateFields(entity, rawFields) : [];

    const errorResponse = checkCachedError(entityTag, rawPath, queryString, entity, filters, sort);
    if (errorResponse) return errorResponse;

    return handleDetail(request, env, ctx, entityTag, id, filters, { depth, limit, skip, since, sort, fields }, rawPath, queryString);
}

export default wrapHandler(handleRequest, "pdbfe-api");
