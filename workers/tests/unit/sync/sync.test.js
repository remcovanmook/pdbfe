/**
 * @fileoverview Unit tests for the sync worker's syncEntity function.
 *
 * Tests the two hardening fixes:
 *   1. Epoch OOM guard: syncEntity refuses to run when last_sync is 0.
 *   2. Pagination fix: fetch URL includes &limit=0 to disable the
 *      PeeringDB 250-item default cap.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { syncEntity } from '../../../sync/index.js';

// ── Mock D1 Database ─────────────────────────────────────────────────────────

/**
 * Creates a minimal mock D1 database for syncEntity tests.
 * Supports configurable _sync_meta rows and captures prepared SQL.
 *
 * @param {object} options
 * @param {number|null} options.lastSync - Value for last_sync (null = no row).
 * @returns {{db: D1Database, preparedSql: string[]}}
 */
function mockD1({ lastSync = null } = {}) {
    /** @type {string[]} */
    const preparedSql = [];

    const db = /** @type {any} */ ({
        prepare(sql) {
            preparedSql.push(sql);
            return {
                bind() { return this; },
                first() {
                    // Respond to the _sync_meta SELECT
                    if (sql.includes('_sync_meta')) {
                        return lastSync !== null
                            ? Promise.resolve({ last_sync: lastSync })
                            : Promise.resolve(null);
                    }
                    return Promise.resolve(null);
                },
                run() { return Promise.resolve({ success: true, meta: {}, results: [] }); },
                all() { return Promise.resolve({ success: true, meta: {}, results: [] }); },
            };
        },
        batch(stmts) {
            return Promise.resolve(stmts.map(() => ({ success: true, meta: {}, results: [] })));
        },
    });

    return { db, preparedSql };
}

/** Minimal entity metadata for test purposes. */
const TEST_META = {
    table: 'peeringdb_network',
    fields: [
        { name: 'id', type: 'number' },
        { name: 'name', type: 'string' },
    ],
};

// ── Epoch OOM Guard ──────────────────────────────────────────────────────────

describe('syncEntity epoch guard', () => {
    it('returns an error when last_sync is 0 (no sync_meta row)', async () => {
        const { db } = mockD1({ lastSync: null });

        const result = await syncEntity(db, 'net', TEST_META, '');

        assert.equal(result.tag, 'net');
        assert.equal(result.updated, 0);
        assert.equal(result.deleted, 0);
        assert.ok(
            result.error.includes('last_sync is 0'),
            `Expected error about last_sync=0, got: "${result.error}"`
        );
    });

    it('returns an error when last_sync is explicitly 0', async () => {
        const { db } = mockD1({ lastSync: 0 });

        const result = await syncEntity(db, 'netixlan', TEST_META, '');

        assert.ok(
            result.error.includes('last_sync is 0'),
            `Expected error about last_sync=0, got: "${result.error}"`
        );
    });

    it('does not reject when last_sync is a valid timestamp', async () => {
        // Stub globalThis.fetch to return an empty response so syncEntity
        // proceeds past the epoch guard without making real network calls.
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(
            JSON.stringify({ data: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

        try {
            const { db } = mockD1({ lastSync: 1712000000 });
            const result = await syncEntity(db, 'net', TEST_META, '');

            // Should not have the epoch error
            assert.ok(
                !result.error.includes('last_sync is 0'),
                `Should not reject valid timestamp, got: "${result.error}"`
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

// ── Pagination Fix ───────────────────────────────────────────────────────────

describe('syncEntity pagination', () => {
    it('appends limit=0 to the PeeringDB API URL', async () => {
        /** @type {string|null} */
        let capturedUrl = null;

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            capturedUrl = typeof url === 'string' ? url : url.toString();
            return new Response(
                JSON.stringify({ data: [] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        };

        try {
            const { db } = mockD1({ lastSync: 1712000000 });
            await syncEntity(db, 'net', TEST_META, '');

            assert.notStrictEqual(capturedUrl, null, 'Expected fetch to be called');
            assert.ok(
                capturedUrl.includes('limit=0'),
                `Expected URL to contain limit=0, got: "${capturedUrl}"`
            );
            assert.ok(
                capturedUrl.includes('depth=0'),
                `Expected URL to contain depth=0, got: "${capturedUrl}"`
            );
            assert.ok(
                capturedUrl.includes('since=1712000000'),
                `Expected URL to contain since=1712000000, got: "${capturedUrl}"`
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('includes Authorization header when API key is provided', async () => {
        /** @type {Record<string, string>} */
        let capturedHeaders = {};

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (_url, init) => {
            capturedHeaders = Object.fromEntries(
                new Headers(/** @type {HeadersInit} */ (init?.headers)).entries()
            );
            return new Response(
                JSON.stringify({ data: [] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        };

        try {
            const { db } = mockD1({ lastSync: 1712000000 });
            await syncEntity(db, 'net', TEST_META, 'test-api-key-123');

            assert.equal(
                capturedHeaders['authorization'],
                'Api-Key test-api-key-123'
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
