/**
 * @fileoverview GraphQL query handler with SWR caching.
 *
 * Handles POST requests by wrapping yoga.fetch() in the L1→SWR→L2
 * cache pipeline. The query body is parsed, normalised, and SHA-256
 * hashed to produce a deterministic cache key. Auth tier is appended
 * to the key so authenticated and anonymous results are cached
 * separately.
 *
 * On a negative cache hit (previous error/empty), falls through to
 * yoga for a fresh attempt so the client gets the actual GraphQL
 * error message.
 */

import { createSchema, createYoga } from 'graphql-yoga';
import { typeDefs } from '../../../extracted/graphql-typedefs.js';
import { resolvers } from '../../../extracted/graphql-resolvers.js';
import { encoder } from '../../core/http.js';
import { graphqlCacheKey, withGqlSWR } from '../cache.js';

/**
 * Lazily initialised graphql-yoga instance.
 * Created on first request to avoid cold-start overhead when the
 * isolate is recycled. Module-scoped singleton pattern.
 * @type {ReturnType<typeof createYoga>|null}
 */
let _yoga = null;

/**
 * Returns the graphql-yoga instance, creating it on first call.
 * The schema is compiled once and reused for the isolate lifetime.
 * GraphiQL is disabled — we serve our own branded page instead.
 *
 * @returns {ReturnType<typeof createYoga>} The yoga instance.
 */
function getYoga() {
    if (!_yoga) {
        _yoga = createYoga({
            schema: createSchema({ typeDefs, resolvers }),
            graphiql: false,
            landingPage: false,
            graphqlEndpoint: '*',
        });
    }
    return _yoga;
}

/**
 * Handles a GraphQL POST request with SWR caching.
 *
 * Flow:
 *   1. Clone and parse the POST body to extract query + variables
 *   2. SHA-256 hash → deterministic cache key (with auth tier suffix)
 *   3. withGqlSWR → L1 check → coalesce → L2 → yoga.fetch
 *   4. On cache hit: return pre-encoded response with cache headers
 *   5. On negative hit: fall through to yoga for fresh error response
 *
 * @param {Request} request - The inbound POST request.
 * @param {D1Session} db - D1 database binding for resolvers.
 * @param {ExecutionContext} ctx - Worker execution context.
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @returns {Promise<Response|null>} Cached response, or null to signal
 *          fallback to uncached yoga.fetch (negative cache hit or non-POST).
 */
export async function handleQuery(request, db, ctx, authenticated) {
    if (request.method !== 'POST') return null;

    const bodyText = await request.clone().text();

    // Parse the body to separate query and variables. This allows
    // graphqlCacheKey to normalise the hash input — two clients
    // sending the same query with different JSON whitespace or key
    // order will produce the same cache key.
    let query = bodyText;
    /** @type {Record<string, any>|undefined} */
    let variables;
    try {
        const parsed = JSON.parse(bodyText);
        query = parsed.query || bodyText;
        variables = parsed.variables;
    } catch {
        // Malformed JSON — hash the raw body. yoga will return an
        // error anyway, which gets negative-cached.
    }

    // Build a deterministic cache key from query + variables + auth state.
    const baseKey = await graphqlCacheKey(query, variables);
    const cacheKey = authenticated ? baseKey + ':auth' : baseKey + ':anon';

    const { buf, tier, hits } = await withGqlSWR(
        cacheKey, ctx,
        async () => {
            const yoga = getYoga();
            const response = await yoga.fetch(request, { db, authenticated });
            if (!response.ok) return null;
            const text = await response.text();
            return encoder.encode(text);
        }
    );

    if (buf) {
        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'X-Cache': tier,
                'X-Cache-Hits': hits.toString()
            }
        });
    }

    // Negative cache hit — fall through to yoga for fresh error response
    return null;
}

/**
 * Executes a raw yoga.fetch without caching.
 * Used as fallback for non-POST requests, HEAD, and negative cache
 * bypass (where we want the actual GraphQL error response).
 *
 * @param {Request} request - The inbound request.
 * @param {D1Session} db - D1 database binding.
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @returns {Promise<Response>} Direct yoga response.
 */
export async function handleUncached(request, db, authenticated) {
    const yoga = getYoga();
    return yoga.fetch(request, { db, authenticated });
}
