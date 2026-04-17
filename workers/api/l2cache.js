/**
 * @fileoverview Re-exports L2 cache from core/ for backwards compatibility.
 * The implementation now lives in core/l2cache.js so it can be shared
 * by the GraphQL and REST workers alongside the API worker.
 */
export { initL2, getL2, putL2 } from '../core/l2cache.js';
