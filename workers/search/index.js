/**
 * @fileoverview pdbfe-search worker entry point.
 *
 * Serves a search API over the PeeringDB dataset at api.pdbfe.dev/search.
 * Supports keyword (D1 LIKE) and graph-structural (Vectorize) modes.
 *
 * Architecture:
 *   - handlers/query.js  — dispatch, parameter parsing, SWR caching
 *   - handlers/keyword.js — D1 LIKE search across primary display fields
 *   - handlers/graph.js  — Vectorize + graph-search resolver
 *   - cache.js           — LRU cache, SHA-256 key generation, withSearchSWR()
 *   - entities.js        — field map for keyword search per entity type
 *   - Auth via core/auth.js (API keys + session cookies)
 *   - Rate limiting via core/ratelimit.js factory
 *
 * Route: api.pdbfe.dev/search*
 *
 * @see search.md for full architecture documentation.
 */

import { identifyCaller, rateLimited, startVerification, settle } from '../core/gate.js';
import { wrapHandler, validateRequest, routeAdminPath } from '../core/admin.js';
import { handlePreflight, jsonError } from './http.js';
import { parseURL } from '../core/utils.js';
import { getSearchCacheStats, purgeSearchCache } from './cache.js';
import { initGraphSearch } from './handlers/graph.js';
import { handleSearch } from './handlers/query.js';

/**
 * Handles incoming requests to the search worker.
 *
 * Flow:
 *   1. Semantic binding probe (once per isolate lifetime)
 *   2. URL parsing (§1: no new URL())
 *   3. Method and path validation
 *   4. CORS preflight
 *   5. Admin endpoints (health, robots.txt, cache stats)
 *   6. Auth resolution
 *   7. Rate limiting
 *   8. Dispatch to handleSearch
 *
 * @param {Request} request - Inbound HTTP request.
 * @param {PdbSearchEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @returns {Promise<Response>} HTTP response.
 */
async function handleRequest(request, env, ctx) {
    // Probe VECTORIZE binding once per isolate. Subsequent calls are no-ops.
    initGraphSearch(/** @type {any} */ (env));

    const { rawPath, queryString } = parseURL(request); // §1: no new URL()

    const validationError = validateRequest(
        request, rawPath,
        ['GET', 'HEAD', 'OPTIONS', 'POST'],
    );
    if (validationError) return validationError;

    if (request.method === 'OPTIONS') return handlePreflight(request);

    const db = env.PDB.withSession('first-unconstrained');

    const adminResponse = await routeAdminPath(rawPath, env, {
        db,
        serviceName: 'pdbfe-search',
        getStats: () => ({ search: getSearchCacheStats() }),
        flush: () => purgeSearchCache(),
    });
    if (adminResponse) return adminResponse;

    // Rate limit by key, session or IP; results do not depend on who asks,
    // but an invalid API key still gets a 401 (core/gate.js).
    const caller = await identifyCaller(request, env);
    if (caller.rejection) return jsonError(403, caller.rejection);
    if (await rateLimited(env, request, caller)) {
        return jsonError(429, 'Rate limit exceeded. Try again later.');
    }
    const verification = startVerification(env, caller);
    const response = await handleSearch(request, queryString, db, env.VECTORIZE ?? null, ctx);
    return settle(response, caller, verification, jsonError);
}

export default wrapHandler(handleRequest, 'pdbfe-search');
