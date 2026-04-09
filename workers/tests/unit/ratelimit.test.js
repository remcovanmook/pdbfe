/**
 * @fileoverview Unit tests for the isolate-level rate limiter.
 * Verifies per-IP counting, window expiry, authenticated vs anonymous
 * limits, independent IP tracking, and stats/purge operations.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, getRateLimitStats, purgeRateLimit } from '../../api/ratelimit.js';

/**
 * Reset rate limiter state between tests to prevent cross-contamination.
 */
beforeEach(() => {
    purgeRateLimit();
});

describe('isRateLimited', () => {
    it('should allow the first request from a new IP', () => {
        assert.equal(isRateLimited('10.0.0.1', false), false);
    });

    it('should allow requests under the anonymous limit', () => {
        const now = Date.now();
        for (let i = 0; i < 300; i++) {
            assert.equal(isRateLimited('10.0.0.1', false, now), false,
                `request ${i + 1} should be allowed`);
        }
    });

    it('should block the 301st anonymous request within window', () => {
        const now = Date.now();
        for (let i = 0; i < 300; i++) {
            isRateLimited('10.0.0.1', false, now);
        }
        assert.equal(isRateLimited('10.0.0.1', false, now), true);
    });

    it('should allow requests under the authenticated limit', () => {
        const now = Date.now();
        for (let i = 0; i < 5000; i++) {
            assert.equal(isRateLimited('10.0.0.1', true, now), false,
                `request ${i + 1} should be allowed`);
        }
    });

    it('should block the 5001st authenticated request within window', () => {
        const now = Date.now();
        for (let i = 0; i < 5000; i++) {
            isRateLimited('10.0.0.1', true, now);
        }
        assert.equal(isRateLimited('10.0.0.1', true, now), true);
    });

    it('should track IPs independently', () => {
        const now = Date.now();
        // Exhaust quota for IP A
        for (let i = 0; i < 301; i++) {
            isRateLimited('10.0.0.1', false, now);
        }
        // IP B should still be allowed
        assert.equal(isRateLimited('10.0.0.2', false, now), false);
    });

    it('should reset counter after the 60-second window expires', () => {
        const t0 = 1_000_000;

        // Exhaust the anonymous quota
        for (let i = 0; i < 301; i++) {
            isRateLimited('10.0.0.1', false, t0);
        }
        assert.equal(isRateLimited('10.0.0.1', false, t0), true,
            'should be blocked within window');

        // Jump forward past the window boundary (60001ms later)
        const t1 = t0 + 60_001;
        assert.equal(isRateLimited('10.0.0.1', false, t1), false,
            'should be allowed after window reset');
    });

    it('should start a fresh counter after window reset', () => {
        const t0 = 1_000_000;
        // Exhaust and block
        for (let i = 0; i < 301; i++) {
            isRateLimited('10.0.0.1', false, t0);
        }

        // Reset by expired window
        const t1 = t0 + 60_001;
        isRateLimited('10.0.0.1', false, t1);

        // Should tolerate another 299 requests in the new window
        for (let i = 1; i < 300; i++) {
            assert.equal(isRateLimited('10.0.0.1', false, t1), false,
                `post-reset request ${i + 1} should be allowed`);
        }
        // 301st should block again
        assert.equal(isRateLimited('10.0.0.1', false, t1), true);
    });

    it('should use anonymous limit when authenticated is false', () => {
        const now = Date.now();
        for (let i = 0; i < 300; i++) {
            isRateLimited('10.0.0.1', false, now);
        }
        assert.equal(isRateLimited('10.0.0.1', false, now), true,
            'anonymous should be blocked at 301');
    });
});

describe('getRateLimitStats', () => {
    it('should report zero items when empty', () => {
        const stats = getRateLimitStats();
        assert.equal(stats.items, 0);
        assert.equal(stats.bytes, 0);
    });

    it('should count tracked IPs', () => {
        const now = Date.now();
        isRateLimited('10.0.0.1', false, now);
        isRateLimited('10.0.0.2', false, now);
        isRateLimited('10.0.0.3', false, now);

        const stats = getRateLimitStats();
        assert.equal(stats.items, 3);
        // Empty buffers so bytes should be 0
        assert.equal(stats.bytes, 0);
    });
});

describe('purgeRateLimit', () => {
    it('should clear all tracked IPs', () => {
        const now = Date.now();
        isRateLimited('10.0.0.1', false, now);
        isRateLimited('10.0.0.2', false, now);
        purgeRateLimit();

        const stats = getRateLimitStats();
        assert.equal(stats.items, 0);
    });

    it('should allow previously blocked IPs after purge', () => {
        const now = Date.now();
        for (let i = 0; i < 301; i++) {
            isRateLimited('10.0.0.1', false, now);
        }
        assert.equal(isRateLimited('10.0.0.1', false, now), true);

        purgeRateLimit();
        assert.equal(isRateLimited('10.0.0.1', false, now), false,
            'should be allowed after purge');
    });
});
