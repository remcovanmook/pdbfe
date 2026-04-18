/**
 * @fileoverview REST-worker SWR wrapper.
 *
 * Thin adapter over core/swr.js that pre-fills REST-specific defaults:
 * the REST LRU cache, EMPTY_ENVELOPE sentinel, and REST_NEGATIVE_TTL.
 *
 * Unlike the API worker, the REST worker has no entity version tracking
 * — cache invalidation relies on TTL expiry. This keeps the REST worker
 * decoupled from api/sync_state.js.
 *
 * Dependencies are limited to core/ and rest/cache.js — no cross-worker
 * imports from api/.
 */

import { withSWR } from '../core/swr.js';
import { EMPTY_ENVELOPE } from '../core/pipeline.js';
import { getRestCache, REST_TTL, REST_NEGATIVE_TTL } from './cache.js';

/**
 * Performs the full L1 read → SWR → cachedQuery miss flow for a REST
 * API endpoint.
 *
 * Delegates entirely to the generic withSWR() in core/swr.js, injecting
 * the REST cache, EMPTY_ENVELOPE sentinel, and TTL values.
 *
 * @param {string} entityTag - Entity tag (e.g. "net"). Used as the
 *        metadata tag for cache.add and for L2 key construction.
 * @param {string} cacheKey - Normalised cache key (e.g. "v1/net/123").
 * @param {ExecutionContext} ctx - Cloudflare worker execution context.
 * @param {() => Promise<Uint8Array|null>} queryFn - D1 query closure.
 *        Return Uint8Array for positive results, null for 404/empty.
 * @returns {Promise<{buf: Uint8Array|null, tier: 'L1' | 'L2' | 'MISS', hits: number}>}
 */
export async function withRestSWR(entityTag, cacheKey, ctx, queryFn) {
    return withSWR({
        cache: getRestCache(),
        cacheKey,
        ctx,
        ttlMs: REST_TTL,
        negativeTtlMs: REST_NEGATIVE_TTL,
        queryFn,
        tag: entityTag,
        emptySentinel: EMPTY_ENVELOPE,
    });
}
