/**
 * @fileoverview Barrel for the cache resolution pipeline.
 *
 * Groups L2 per-PoP cache, query coalescing, negative caching,
 * and stale-while-revalidate into a single importable module.
 *
 * Internal helpers (getL2, putL2, isNegative) are not re-exported
 * here — test files import them directly from their source modules.
 */

export { initL2 } from './l2cache.js';
export { EMPTY_ENVELOPE, isNegative, cachedQuery } from './query.js';
export { withSWR } from './swr.js';
