/**
 * @fileoverview Unit tests for api/cache.js.
 *
 * Tests normaliseCacheKey (query parameter sorting), getCacheStats
 * (aggregation across entity caches), purgeAllCaches (full flush),
 * and getEntityCache (per-tag resolution).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    normaliseCacheKey,
    getCacheStats,
    purgeAllCaches,
    getEntityCache,
    LIST_TTL,
    DETAIL_TTL,
    COUNT_TTL,
    NEGATIVE_TTL,
} from '../../../api/cache.js';

// ── normaliseCacheKey ────────────────────────────────────────────────────────

describe('normaliseCacheKey', () => {
    it('returns path unchanged when no query string', () => {
        assert.equal(normaliseCacheKey('api/net', ''), 'api/net');
    });

    it('returns path unchanged when query string is falsy', () => {
        assert.equal(normaliseCacheKey('api/net', null), 'api/net');
        assert.equal(normaliseCacheKey('api/net', undefined), 'api/net');
    });

    it('sorts query parameters alphabetically', () => {
        const result = normaliseCacheKey('api/net', 'z=1&a=2&m=3');
        assert.equal(result, 'api/net?a=2&m=3&z=1');
    });

    it('produces the same key for different parameter orderings', () => {
        const a = normaliseCacheKey('api/net', 'limit=10&asn=123');
        const b = normaliseCacheKey('api/net', 'asn=123&limit=10');
        assert.equal(a, b);
    });

    it('handles single parameter', () => {
        const result = normaliseCacheKey('api/net', 'depth=2');
        assert.equal(result, 'api/net?depth=2');
    });
});

// ── getEntityCache ───────────────────────────────────────────────────────────

describe('getEntityCache', () => {
    it('returns a cache instance for a known entity', () => {
        const cache = getEntityCache('net');
        assert.ok(cache);
        assert.ok(typeof cache.get === 'function');
        assert.ok(typeof cache.add === 'function');
        assert.ok(typeof cache.has === 'function');
    });

    it('returns a cache instance for as_set', () => {
        const cache = getEntityCache('as_set');
        assert.ok(cache);
    });

    it('returns undefined for unknown entity', () => {
        const cache = getEntityCache('nonexistent_entity');
        assert.equal(cache, undefined);
    });
});

// ── getCacheStats ────────────────────────────────────────────────────────────

describe('getCacheStats', () => {
    it('returns an object with entities and totals', () => {
        const stats = getCacheStats();
        assert.ok(stats.entities);
        assert.ok(stats.totals);
        assert.equal(typeof stats.totals.items, 'number');
        assert.equal(typeof stats.totals.bytes, 'number');
        assert.equal(typeof stats.totals.limit, 'number');
    });

    it('includes net in entity stats', () => {
        const stats = getCacheStats();
        assert.ok('net' in stats.entities);
    });

    it('total limit is sum of entity limits', () => {
        const stats = getCacheStats();
        let sum = 0;
        for (const tag in stats.entities) {
            sum += stats.entities[tag].limit;
        }
        assert.equal(stats.totals.limit, sum);
    });
});

// ── purgeAllCaches ───────────────────────────────────────────────────────────

describe('purgeAllCaches', () => {
    it('resets all cache entries to zero', () => {
        // Add an entry to a known cache
        const cache = getEntityCache('org');
        const buf = new Uint8Array([1, 2, 3]);
        cache.add('test-key', buf, { entityTag: 'org' }, Date.now());

        // Verify it exists
        assert.ok(cache.has('test-key'));

        // Purge and verify
        purgeAllCaches();
        assert.equal(cache.has('test-key'), false);
    });
});

// ── TTL constants ────────────────────────────────────────────────────────────

describe('TTL constants', () => {
    it('LIST_TTL is 60 minutes in ms', () => {
        assert.equal(LIST_TTL, 60 * 60 * 1000);
    });

    it('DETAIL_TTL is 60 minutes in ms', () => {
        assert.equal(DETAIL_TTL, 60 * 60 * 1000);
    });

    it('COUNT_TTL is 60 minutes in ms', () => {
        assert.equal(COUNT_TTL, 60 * 60 * 1000);
    });

    it('NEGATIVE_TTL is 5 minutes in ms', () => {
        assert.equal(NEGATIVE_TTL, 5 * 60 * 1000);
    });

    it('NEGATIVE_TTL is shorter than LIST_TTL', () => {
        assert.ok(NEGATIVE_TTL < LIST_TTL);
    });
});
