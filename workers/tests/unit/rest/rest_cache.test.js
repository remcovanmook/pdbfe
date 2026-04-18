/**
 * @fileoverview Unit tests for the REST cache layer.
 *
 * Tests cache stats, purge functions, and the withRestSWR wrapper.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    getRestCacheStats,
    purgeRestCache,
    getRestCache,
    withRestSWR,
} from '../../../rest/cache.js';

// ── Mock ExecutionContext ────────────────────────────────────────────────────

/**
 * Creates a minimal mock ExecutionContext.
 *
 * @returns {{ctx: ExecutionContext, waitUntilCalls: Promise<any>[]}}
 */
function mockCtx() {
    /** @type {Promise<any>[]} */
    const waitUntilCalls = [];
    return {
        ctx: /** @type {ExecutionContext} */ ({
            waitUntil: (/** @type {Promise<any>} */ p) => { waitUntilCalls.push(p); },
            passThroughOnException: () => {}
        }),
        waitUntilCalls,
    };
}

// ── Cache stats and purge ────────────────────────────────────────────────────

describe('getRestCacheStats', () => {
    beforeEach(() => {
        purgeRestCache();
    });

    it('returns stats object with required fields', () => {
        const stats = getRestCacheStats();
        assert.ok('items' in stats);
        assert.ok('bytes' in stats);
        assert.ok('limit' in stats);
    });

    it('reports zero items on a fresh cache', () => {
        const stats = getRestCacheStats();
        assert.equal(stats.items, 0);
        assert.equal(stats.bytes, 0);
    });

    it('reports items after cache population', () => {
        const cache = getRestCache();
        const payload = new TextEncoder().encode('{"data":[{"id":1}],"meta":{}}');
        cache.add('test/rest-stats', payload, { entityTag: 'net' }, Date.now());

        const stats = getRestCacheStats();
        assert.ok(stats.items > 0);
        assert.ok(stats.bytes > 0);

        purgeRestCache();
    });
});

describe('purgeRestCache', () => {
    it('empties the cache', () => {
        const cache = getRestCache();
        cache.add('test/purge', new Uint8Array(10), { entityTag: 'net' }, Date.now());
        assert.ok(getRestCacheStats().items > 0);

        purgeRestCache();
        assert.equal(getRestCacheStats().items, 0);
    });
});

// ── withRestSWR ──────────────────────────────────────────────────────────────

describe('withRestSWR', () => {
    beforeEach(() => {
        purgeRestCache();
    });

    it('calls queryFn on cache miss', async () => {
        const { ctx } = mockCtx();
        const payload = new TextEncoder().encode('{"data":[{"id":1}],"meta":{}}');

        let called = false;
        const result = await withRestSWR('net', 'test/miss-' + Date.now(), ctx, async () => {
            called = true;
            return payload;
        });

        assert.equal(called, true);
        assert.notStrictEqual(result.buf, null);
        assert.equal(result.hits, 0);
    });

    it('returns L1 hit on second access', async () => {
        const { ctx } = mockCtx();
        const key = 'test/l1hit-' + Date.now();
        const payload = new TextEncoder().encode('{"data":[],"meta":{}}');

        // First call → miss
        await withRestSWR('net', key, ctx, async () => payload);

        // Second call → L1 hit
        let called = false;
        const result = await withRestSWR('net', key, ctx, async () => {
            called = true;
            return payload;
        });

        assert.equal(called, false, 'Should not call queryFn on L1 hit');
        assert.equal(result.tier, 'L1');
        assert.ok(result.hits >= 1);
    });

    it('returns null buf for negative cache entries', async () => {
        const { ctx } = mockCtx();
        const key = 'test/negative-' + Date.now();

        const result = await withRestSWR('net', key, ctx, async () => null);
        assert.equal(result.buf, null);
    });
});
