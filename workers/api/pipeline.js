/**
 * @fileoverview API-worker-specific pipeline wrapper.
 *
 * Re-exports the generic `cachedQuery` from core/pipeline.js with
 * API-specific defaults injected: `getEntityVersion` from sync_state.js
 * and `NEGATIVE_TTL` from api/cache.js.
 *
 * Existing api/ modules import from this file without changes to their
 * call sites. The only difference is that `getVersion` and `negativeTtlMs`
 * are now pre-filled if not explicitly provided.
 */

import { cachedQuery as _cachedQuery, EMPTY_ENVELOPE, isNegative } from '../core/pipeline.js';
import { getEntityVersion } from './sync_state.js';
import { NEGATIVE_TTL } from './cache.js';

// Re-export CacheTier typedef and sentinels
export { EMPTY_ENVELOPE, isNegative };

/** @typedef {import('../core/pipeline.js').CacheTier} CacheTier */
/** @typedef {import('../core/pipeline.js').CachedResult} CachedResult */

/**
 * API-worker cachedQuery wrapper. Pre-fills `getVersion` with the
 * API worker's entity version tracker and `negativeTtlMs` with the
 * API worker's NEGATIVE_TTL constant.
 *
 * Call sites in api/handlers/*.js and api/swr.js continue to work
 * unchanged — they never passed these parameters before because
 * the old pipeline.js imported them directly.
 *
 * @param {Object} opts - Pipeline configuration.
 * @param {string} opts.cacheKey - Normalised cache key.
 * @param {LocalCache} opts.cache - Per-entity LRU cache instance.
 * @param {string} opts.entityTag - Entity tag for cache metadata.
 * @param {number} opts.ttlMs - TTL for positive results in milliseconds.
 * @param {() => Promise<Uint8Array|null>} opts.queryFn - D1 query closure.
 * @param {ExecutionContext} [opts.ctx] - Worker execution context.
 * @returns {Promise<import('../core/pipeline.js').CachedResult>}
 */
export async function cachedQuery(opts) {
    return _cachedQuery({
        negativeTtlMs: NEGATIVE_TTL,
        getVersion: getEntityVersion,
        ...opts,
    });
}
