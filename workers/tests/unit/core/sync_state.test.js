/**
 * @fileoverview Unit tests for core/sync_state.js handleStatus: the
 * bounded cold-isolate wait and the injected Cache-Control builder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncState } from '../../../core/sync_state.js';

const ROWS = [{ entity: 'net', last_sync: 1, row_count: 2, updated_at: 'x', last_modified_at: 3 }];
const HEADERS = Object.freeze({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });

/**
 * Mock D1 whose _sync_meta query resolves after `delayMs`.
 *
 * @param {number} delayMs
 * @returns {any}
 */
function mockDB(delayMs = 0) {
    return {
        prepare() {
            return { all: () => new Promise((r) => setTimeout(() => r({ results: ROWS }), delayMs)) };
        },
    };
}

/** @returns {{ctx: any, pending: Promise<any>[]}} */
function mockCtx() {
    /** @type {Promise<any>[]} */
    const pending = [];
    return { ctx: { waitUntil: (/** @type {Promise<any>} */ p) => pending.push(p) }, pending };
}

const req = new Request('https://example.com/status');

describe('createSyncState handleStatus', () => {
    it('answers 503 when the cold poll exceeds the timeout, then serves once it lands', async () => {
        const s = createSyncState({ entityTags: ['net'], onEntityChange() {}, statusHeaders: HEADERS, statusColdTimeoutMs: 10 });
        const { ctx, pending } = mockCtx();

        const first = await s.handleStatus(req, mockDB(50), ctx);
        assert.equal(first.status, 503);
        assert.equal(first.headers.get('Cache-Control'), 'no-store');
        assert.equal(pending.length, 1, 'the poll continues in the background');

        await Promise.all(pending);
        const second = await s.handleStatus(req, mockDB(), ctx);
        assert.equal(second.status, 200);
        assert.equal((await second.json()).sync.entities.net.row_count, 2);
    });

    it('waits for a cold poll that lands within the timeout', async () => {
        const s = createSyncState({ entityTags: ['net'], onEntityChange() {}, statusHeaders: HEADERS, statusColdTimeoutMs: 200 });
        const res = await s.handleStatus(req, mockDB(5), mockCtx().ctx);
        assert.equal(res.status, 200);
    });

    it('uses statusHeaders as-is without a Cache-Control builder', async () => {
        const s = createSyncState({ entityTags: ['net'], onEntityChange() {}, statusHeaders: HEADERS });
        const res = await s.handleStatus(req, mockDB(), mockCtx().ctx);
        assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
    });

    it('applies the injected Cache-Control builder with the payload size', async () => {
        /** @type {number[]} */
        const sizes = [];
        const s = createSyncState({
            entityTags: ['net'], onEntityChange() {}, statusHeaders: HEADERS,
            statusCacheControl: (n) => { sizes.push(n); return 'public, max-age=5'; },
        });
        const res = await s.handleStatus(req, mockDB(), mockCtx().ctx);
        assert.equal(res.headers.get('Cache-Control'), 'public, max-age=5');
        assert.equal(res.headers.get('Content-Type'), 'application/json');
        assert.equal(sizes[0], (await res.arrayBuffer()).byteLength);
    });
});
