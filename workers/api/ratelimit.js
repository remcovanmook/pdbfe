/**
 * @fileoverview API-worker-specific rate limiter instance.
 *
 * Wraps the generic `createRateLimiter` factory from core/ratelimit.js
 * with API-specific thresholds. Exports the same interface as before
 * so existing imports in api/index.js don't change.
 *
 * Thresholds:
 *   - 4000 IP slots, 1 MB ceiling, 60-second window
 *   - Anonymous: 60 req/min (~1 req/s sustained)
 *   - Authenticated: 600 req/min (~10 req/s sustained)
 */

import { createRateLimiter, normaliseIP } from '../core/ratelimit.js';

const rl = createRateLimiter({
    slots: 4000,
    maxBytes: 1024 * 1024,
    windowMs: 60_000,
    limitAnon: 60,
    limitAuth: 600,
});

export const isRateLimited = rl.isRateLimited;
export const getRateLimitStats = rl.getStats;
export const purgeRateLimit = rl.purge;

// Re-export normaliseIP for the test suite
export { normaliseIP };
