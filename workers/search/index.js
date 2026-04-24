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

import { resolveAuth } from '../core/auth.js';
import { wrapHandler, validateRequest, routeAdminPath } from '../core/admin.js';
import { handlePreflight, jsonError } from './http.js';
import { parseURL } from '../core/utils.js';
import { initL2 } from '../core/pipeline/index.js';
import { createRateLimiter } from '../core/ratelimit.js';
import { getSearchCacheStats, purgeSearchCache } from './cache.js';
import { initGraphSearch } from './handlers/graph.js';
import { handleSearch } from './handlers/query.js';

/**
 * Rate limiter for search requests.
 *
 * Graph-structural queries require a Vectorize round-trip for similarity
 * searches, but no Workers AI embedding call — significantly cheaper than
 * the previous BGE-based approach.
 *
 * Anonymous: 10 req/min, Authenticated: 100 req/min.
 */
const { isRateLimited, getStats: getRateLimitStats, purge: purgeRateLimit } = createRateLimiter({
    slots: 1000,
    maxBytes: 1024 * 1024,
    windowMs: 60_000,
    limitAnon: 10,
    limitAuth: 100,
});

/**
 * Handles incoming requests to the search worker.
 *
 * Flow:
 *   1. L2 cache initialisation
 *   2. Semantic binding probe (once per isolate lifetime)
 *   3. URL parsing (§1: no new URL())
 *   4. Method and path validation
 *   5. CORS preflight
 *   6. Admin endpoints (health, robots.txt, cache stats)
 *   7. Auth resolution
 *   8. Rate limiting
 *   9. Dispatch to handleSearch
 *
 * @param {Request} request - Inbound HTTP request.
 * @param {PdbSearchEnv} env - Cloudflare environment bindings.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @returns {Promise<Response>} HTTP response.
 */
async function handleRequest(request, env, ctx) {
    initL2(request.url);
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
        getStats: () => ({
            search: getSearchCacheStats(),
            rateLimit: getRateLimitStats(),
        }),
        flush: () => { purgeSearchCache(); purgeRateLimit(); },
    });
    if (adminResponse) return adminResponse;

    const { authenticated, identity, rejection } = await resolveAuth(request, env);
    if (rejection) return jsonError(403, rejection);

    const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
    const callerKey = identity || clientIP;
    if (isRateLimited(callerKey, authenticated, Date.now())) {
        return jsonError(429, 'Rate limit exceeded. Try again later.');
    }

    return handleSearch(request, queryString, db, env.VECTORIZE ?? null, ctx, authenticated);
}

export default wrapHandler(handleRequest, 'pdbfe-search');
