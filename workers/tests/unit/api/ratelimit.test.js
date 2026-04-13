/**
 * @fileoverview Unit tests for the isolate-level rate limiter.
 * Verifies per-IP counting, window expiry, authenticated vs anonymous
 * limits, independent IP tracking, and stats/purge operations.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, normaliseIP, getRateLimitStats, purgeRateLimit } from '../../../api/ratelimit.js';

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
        for (let i = 0; i < 60; i++) {
            assert.equal(isRateLimited('10.0.0.1', false, now), false,
                `request ${i + 1} should be allowed`);
        }
    });

    it('should block the 61st anonymous request within window', () => {
        const now = Date.now();
        for (let i = 0; i < 60; i++) {
            isRateLimited('10.0.0.1', false, now);
        }
        assert.equal(isRateLimited('10.0.0.1', false, now), true);
    });

    it('should allow requests under the authenticated limit', () => {
        const now = Date.now();
        for (let i = 0; i < 600; i++) {
            assert.equal(isRateLimited('key:pdbfe.abc123', true, now), false,
                `request ${i + 1} should be allowed`);
        }
    });

    it('should block the 601st authenticated request within window', () => {
        const now = Date.now();
        for (let i = 0; i < 600; i++) {
            isRateLimited('key:pdbfe.abc123', true, now);
        }
        assert.equal(isRateLimited('key:pdbfe.abc123', true, now), true);
    });

    it('should track keys independently', () => {
        const now = Date.now();
        // Exhaust quota for IP A
        for (let i = 0; i < 61; i++) {
            isRateLimited('10.0.0.1', false, now);
        }
        // IP B should still be allowed
        assert.equal(isRateLimited('10.0.0.2', false, now), false);
    });

    it('should reset counter after the 60-second window expires', () => {
        const t0 = 1_000_000;

        // Exhaust the anonymous quota
        for (let i = 0; i < 61; i++) {
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
        for (let i = 0; i < 61; i++) {
            isRateLimited('10.0.0.1', false, t0);
        }

        // Reset by expired window
        const t1 = t0 + 60_001;
        isRateLimited('10.0.0.1', false, t1);

        // Should tolerate another 59 requests in the new window
        for (let i = 1; i < 60; i++) {
            assert.equal(isRateLimited('10.0.0.1', false, t1), false,
                `post-reset request ${i + 1} should be allowed`);
        }
        // 61st should block again
        assert.equal(isRateLimited('10.0.0.1', false, t1), true);
    });

    it('should use anonymous limit when authenticated is false', () => {
        const now = Date.now();
        for (let i = 0; i < 60; i++) {
            isRateLimited('10.0.0.1', false, now);
        }
        assert.equal(isRateLimited('10.0.0.1', false, now), true,
            'anonymous should be blocked at 61');
    });

    it('should give independent buckets to different API keys on same IP', () => {
        const now = Date.now();
        // Key A exhausts its quota
        for (let i = 0; i < 601; i++) {
            isRateLimited('pdbfe.aaa', true, now);
        }
        assert.equal(isRateLimited('pdbfe.aaa', true, now), true,
            'key A should be blocked');
        // Key B should still be allowed (identity-only keying)
        assert.equal(isRateLimited('pdbfe.bbb', true, now), false,
            'key B should be allowed');
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

    it('should allow previously blocked keys after purge', () => {
        const now = Date.now();
        for (let i = 0; i < 61; i++) {
            isRateLimited('10.0.0.1', false, now);
        }
        assert.equal(isRateLimited('10.0.0.1', false, now), true);

        purgeRateLimit();
        assert.equal(isRateLimited('10.0.0.1', false, now), false,
            'should be allowed after purge');
    });
});

describe('normaliseIP', () => {
    it('should pass through IPv4 addresses unchanged', () => {
        assert.equal(normaliseIP('192.168.1.1'), '192.168.1.1');
        assert.equal(normaliseIP('10.0.0.1'), '10.0.0.1');
    });

    it('should truncate full IPv6 to /64 prefix', () => {
        assert.equal(
            normaliseIP('2001:0db8:85a3:0000:0000:8a2e:0370:7334'),
            '2001:0db8:85a3:0000'
        );
    });

    it('should group addresses in the same /64 together', () => {
        const a = normaliseIP('2001:db8:85a3:0:1::1');
        const b = normaliseIP('2001:db8:85a3:0:ffff::9999');
        assert.equal(a, b, 'same /64 should produce same key');
    });

    it('should handle :: compressed notation', () => {
        // 2001:db8::1 expands to 2001:db8:0:0:0:0:0:1
        assert.equal(normaliseIP('2001:db8::1'), '2001:db8:0:0');
    });

    it('should handle leading :: (loopback)', () => {
        // ::1 expands to 0:0:0:0:0:0:0:1
        assert.equal(normaliseIP('::1'), '0:0:0:0');
    });

    it('should handle trailing ::', () => {
        // 2001:db8:: expands to 2001:db8:0:0:0:0:0:0
        assert.equal(normaliseIP('2001:db8::'), '2001:db8:0:0');
    });

    it('should handle :: in the middle with groups on both sides', () => {
        // fe80::1:2 expands to fe80:0:0:0:0:0:1:2
        assert.equal(normaliseIP('fe80::1:2'), 'fe80:0:0:0');
    });

    it('should pass through unknown as-is', () => {
        assert.equal(normaliseIP('unknown'), 'unknown');
    });
});
