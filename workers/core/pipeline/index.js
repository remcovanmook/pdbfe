/**
 * @fileoverview Barrel for the cache resolution pipeline.
 *
 * Groups query coalescing, negative caching and stale-while-revalidate
 * into a single importable module.
 */

export { EMPTY_ENVELOPE, isNegative, cachedQuery } from './query.js';
export { withSWR } from './swr.js';
