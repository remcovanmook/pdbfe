/**
 * @fileoverview Unit tests for the withEdgeSWR wrapper (api/swr.js).
 *
 * Tests the full L1 → SWR → cachedQuery flow with mocked cache instances.
 * L2 cache (caches.default) is not available in Node.js, so all miss-path
 * queries go straight to D1 (via queryFn).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { withEdgeSWR, getEntityCache, NEGATIVE_TTL } from '../../../api/cache.js';
import { EMPTY_ENVELOPE } from '../../../core/pipeline.js';
import { LRUCache } from '../../../core/cache.js';

/**
 * Creates a minimal mock ExecutionContext that captures waitUntil calls.
 *
 * @returns {{ctx: ExecutionContext, waitUntilCalls: Promise<any>[]}}
 */
function mockCtx() {
    /** @type {Promise<any>[]} */
    const waitUntilCalls = [];
    const ctx = /** @type {ExecutionContext} */ ({
        waitUntil: (/** @type {Promise<any>} */ p) => { waitUntilCalls.push(p); },
        passThroughOnException: () => {}
    });
    return { ctx, waitUntilCalls };
}

// ── Fresh L1 hit ─────────────────────────────────────────────────────────────

describe('withEdgeSWR', () => {
    it('should return L1 hit without calling queryFn when entry is fresh', async () => {
        const { ctx } = mockCtx();
        const cache = getEntityCache('net');
        const payload = new TextEncoder().encode('{"data":[{"id":1}],"meta":{}}');

        // Pre-populate L1
        cache.add('test/fresh', payload, { entityTag: 'net' }, Date.now());

        let queryCalled = false;
        const result = await withEdgeSWR('net', 'test/fresh', ctx, 300000,
            async () => { queryCalled = true; return payload; }
        );

        assert.equal(queryCalled, false, 'queryFn should not be called on fresh L1 hit');
        assert.equal(result.tier, 'L1');
        assert.notStrictEqual(result.buf, null);
        assert.ok(result.hits >= 1);

        // Clean up
        cache.purge('test/fresh');
    });

    // ── Stale L1 hit (SWR) ───────────────────────────────────────────────────

    it('should return stale data and fire background refresh when entry is in SWR window', async () => {
        const { ctx, waitUntilCalls } = mockCtx();
        const cache = getEntityCache('net');
        const stalePayload = new TextEncoder().encode('{"data":[{"id":2}],"meta":{}}');

        // Add entry that is past staleMs (80% of 300s = 240s) but within ttlMs (300s).
        // Simulate an entry added 250 seconds ago.
        const ttlMs = 300000;
        const addedAt = Date.now() - 250000;
        cache.add('test/stale', stalePayload, { entityTag: 'net' }, addedAt);

        let queryCalled = false;
        const freshPayload = new TextEncoder().encode('{"data":[{"id":2,"updated":true}],"meta":{}}');
        const result = await withEdgeSWR('net', 'test/stale', ctx, ttlMs,
            async () => { queryCalled = true; return freshPayload; }
        );

        // Should serve the stale data
        assert.equal(result.tier, 'L1');
        assert.notStrictEqual(result.buf, null);

        // Should have fired a background refresh via ctx.waitUntil
        assert.ok(waitUntilCalls.length >= 1, 'should fire background refresh (+ L2 write-back)');

        // Wait for background refresh to complete
        await waitUntilCalls[0];
        assert.equal(queryCalled, true, 'queryFn should be called in background');

        // Clean up
        cache.purge('test/stale');
    });

    // ── Expired L1 entry ─────────────────────────────────────────────────────

    it('should block on queryFn when L1 entry has expired past ttlMs', async () => {
        const { ctx, waitUntilCalls } = mockCtx();
        const cache = getEntityCache('net');
        const oldPayload = new TextEncoder().encode('{"data":[{"id":3}],"meta":{}}');

        // Add entry well past ttlMs
        const ttlMs = 300000;
        const addedAt = Date.now() - 400000;
        cache.add('test/expired', oldPayload, { entityTag: 'net' }, addedAt);

        let queryCalled = false;
        const freshPayload = new TextEncoder().encode('{"data":[{"id":3,"fresh":true}],"meta":{}}');
        const result = await withEdgeSWR('net', 'test/expired', ctx, ttlMs,
            async () => { queryCalled = true; return freshPayload; }
        );

        assert.equal(queryCalled, true, 'queryFn should be called (blocking)');
        assert.notEqual(result.tier, 'L1', 'should not report as L1 hit');
        assert.notStrictEqual(result.buf, null);
        assert.equal(result.hits, 0);
        // L2 write-back fires via ctx.waitUntil (even though the Cache API
        // is unavailable in Node.js, the putL2 promise is still registered).
        // No SWR background refresh is issued — just the L2 write.
        assert.ok(waitUntilCalls.length <= 1, 'only L2 write-back, no SWR refresh');

        // Clean up
        cache.purge('test/expired');
    });

    // ── Full cache miss ──────────────────────────────────────────────────────

    it('should block on queryFn when there is no L1 entry', async () => {
        const { ctx } = mockCtx();
        const freshPayload = new TextEncoder().encode('{"data":[{"id":4}],"meta":{}}');

        let queryCalled = false;
        const result = await withEdgeSWR('net', 'test/miss-' + Date.now(), ctx, 300000,
            async () => { queryCalled = true; return freshPayload; }
        );

        assert.equal(queryCalled, true);
        assert.notStrictEqual(result.buf, null);
        assert.equal(result.hits, 0);
    });

    // ── Negative cache entry ─────────────────────────────────────────────────

    it('should return null buf for negative cache entries and use NEGATIVE_TTL', async () => {
        const { ctx, waitUntilCalls } = mockCtx();
        const cache = getEntityCache('net');

        // Store a negative entry (EMPTY_ENVELOPE) that is recent
        cache.add('test/negative', EMPTY_ENVELOPE, { entityTag: 'net' }, Date.now());

        let queryCalled = false;
        const result = await withEdgeSWR('net', 'test/negative', ctx, 900000,
            async () => { queryCalled = true; return null; }
        );

        assert.equal(queryCalled, false, 'queryFn should not be called for fresh negative');
        assert.equal(result.buf, null, 'negative entries return null buf');
        assert.equal(result.tier, 'L1');
        // No SWR for negative entries
        assert.equal(waitUntilCalls.length, 0);

        // Clean up
        cache.purge('test/negative');
    });

    it('should treat negative entry as miss when past NEGATIVE_TTL', async () => {
        const { ctx } = mockCtx();
        const cache = getEntityCache('net');

        // Store a negative entry well past NEGATIVE_TTL
        cache.add('test/neg-expired', EMPTY_ENVELOPE, { entityTag: 'net' },
            Date.now() - NEGATIVE_TTL - 10000);

        let queryCalled = false;
        const result = await withEdgeSWR('net', 'test/neg-expired', ctx, 900000,
            async () => { queryCalled = true; return null; }
        );

        assert.equal(queryCalled, true, 'queryFn should be called for expired negative');

        // Clean up
        cache.purge('test/neg-expired');
    });

    // ── Synchronous field extraction safety ──────────────────────────────────

    it('should not corrupt data when multiple entries are accessed', async () => {
        const { ctx } = mockCtx();
        const cache = getEntityCache('ix');
        const payloadA = new TextEncoder().encode('{"data":[{"id":"A"}],"meta":{}}');
        const payloadB = new TextEncoder().encode('{"data":[{"id":"B"}],"meta":{}}');

        cache.add('test/safe-a', payloadA, { entityTag: 'ix' }, Date.now());
        cache.add('test/safe-b', payloadB, { entityTag: 'ix' }, Date.now());

        // Read both entries — the _ret mutation trap would corrupt the first
        // entry if fields weren't extracted synchronously.
        const resultA = await withEdgeSWR('ix', 'test/safe-a', ctx, 300000,
            async () => payloadA);
        const resultB = await withEdgeSWR('ix', 'test/safe-b', ctx, 300000,
            async () => payloadB);

        // Verify both have distinct data
        const textA = new TextDecoder().decode(/** @type {Uint8Array} */ (resultA.buf));
        const textB = new TextDecoder().decode(/** @type {Uint8Array} */ (resultB.buf));

        assert.ok(textA.includes('"A"'), `Expected A data, got: ${textA}`);
        assert.ok(textB.includes('"B"'), `Expected B data, got: ${textB}`);

        // Clean up
        cache.purge('test/safe-a');
        cache.purge('test/safe-b');
    });

    // ── Custom staleMs ───────────────────────────────────────────────────────

    it('should honour custom staleMs parameter', async () => {
        const { ctx, waitUntilCalls } = mockCtx();
        const cache = getEntityCache('fac');
        const payload = new TextEncoder().encode('{"data":[{"id":5}],"meta":{}}');

        // Add entry 10 seconds old with staleMs=5000, ttlMs=60000
        cache.add('test/custom-stale', payload, { entityTag: 'fac' },
            Date.now() - 10000);

        const result = await withEdgeSWR('fac', 'test/custom-stale', ctx, 60000,
            async () => payload,
            5000  // staleMs = 5 seconds
        );

        assert.equal(result.tier, 'L1');
        assert.ok(waitUntilCalls.length >= 1, 'should fire SWR with custom staleMs');

        await waitUntilCalls[0];

        // Clean up
        cache.purge('test/custom-stale');
    });

    // ── Error propagation ────────────────────────────────────────────────────

    it('should propagate queryFn errors on cache miss', async () => {
        const { ctx } = mockCtx();

        await assert.rejects(
            withEdgeSWR('net', 'test/throw-' + Date.now(), ctx, 300000,
                async () => { throw new Error('D1 exploded'); }
            ),
            { message: 'D1 exploded' }
        );
    });

    it('should swallow background refresh errors without crashing', async () => {
        const { ctx, waitUntilCalls } = mockCtx();
        const cache = getEntityCache('net');
        const payload = new TextEncoder().encode('{"data":[{"id":6}],"meta":{}}');

        // Add stale entry
        cache.add('test/bg-error', payload, { entityTag: 'net' },
            Date.now() - 280000);

        const result = await withEdgeSWR('net', 'test/bg-error', ctx, 300000,
            async () => { throw new Error('background boom'); }
        );

        // Stale data should still be returned
        assert.equal(result.tier, 'L1');
        assert.notStrictEqual(result.buf, null);

        // Background refresh should not throw — error is caught internally
        assert.equal(waitUntilCalls.length, 1);
        await assert.doesNotReject(waitUntilCalls[0]);

        // Clean up
        cache.purge('test/bg-error');
    });
});
