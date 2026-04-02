/**
 * @fileoverview Unit tests for the /status endpoint.
 * Validates that the handler reads _sync_meta and returns
 * the expected JSON structure with CORS and cache headers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock D1 ────────────────────────────────────────────────────

/**
 * Builds a mock D1 database that returns the given rows from
 * any SELECT on _sync_meta.
 *
 * @param {Array<{entity: string, last_sync: number, row_count: number, updated_at: string}>} rows
 * @returns {{prepare: Function}}
 */
function mockDB(rows) {
    const db = {
        prepare(_sql) {
            return {
                all() {
                    return Promise.resolve({ results: rows });
                }
            };
        },
        /** Sessions API: returns itself since the mock already has .prepare(). */
        withSession() { return db; }
    };
    return db;
}

// ── Import the worker under test ────────────────────────────────

// The worker default export is { fetch }.
// We import the whole module so we can call .fetch() directly.
// Note: wrapHandler returns { fetch }, so the default export IS the worker.

// Because api/index.js imports from relative paths that need to resolve
// correctly, we import the whole default export.
const workerModule = await import('../../api/index.js');
const worker = workerModule.default;

/**
 * Sends a GET request to the worker and returns the response.
 *
 * @param {string} path - URL path (e.g. "/status").
 * @param {{}} [env] - Environment bindings.
 * @returns {Promise<Response>}
 */
async function get(path, env = {}) {
    const request = new Request(`https://test-host${path}`, { method: 'GET' });
    // Provide a minimal cf object for X-Served-By header
    Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
    const ctx = { waitUntil: () => {} };
    return worker.fetch(request, env, ctx);
}

// ── Tests ───────────────────────────────────────────────────────

describe('/status endpoint', () => {

    it('returns 200 with sync metadata', async () => {
        const env = {
            PDB: mockDB([
                { entity: 'fac', last_sync: 1743520000, row_count: 8500, updated_at: '2026-04-01 14:00:00' },
                { entity: 'net', last_sync: 1743520200, row_count: 42000, updated_at: '2026-04-01 14:30:00' },
            ])
        };

        const res = await get('/status', env);
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.ok(body.sync, 'response should have a sync object');
        assert.equal(body.sync.last_sync_at, '2026-04-01 14:30:00');
        assert.equal(body.sync.entities.net.row_count, 42000);
        assert.equal(body.sync.entities.fac.last_sync, 1743520000);
    });

    it('returns correct Content-Type and CORS headers', async () => {
        const env = {
            PDB: mockDB([
                { entity: 'ix', last_sync: 1743520000, row_count: 1200, updated_at: '2026-04-01 14:00:00' },
            ])
        };

        const res = await get('/status', env);
        assert.match(res.headers.get('Content-Type'), /application\/json/);
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    });

    it('returns empty sync when _sync_meta has no rows', async () => {
        const env = { PDB: mockDB([]) };

        const res = await get('/status', env);
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.equal(body.sync.last_sync_at, '');
        assert.deepEqual(body.sync.entities, {});
    });

    it('picks the most recent updated_at as last_sync_at', async () => {
        const env = {
            PDB: mockDB([
                { entity: 'carrier', last_sync: 1743510000, row_count: 100, updated_at: '2026-04-01 10:00:00' },
                { entity: 'net', last_sync: 1743520200, row_count: 42000, updated_at: '2026-04-01 14:30:00' },
                { entity: 'org', last_sync: 1743518000, row_count: 30000, updated_at: '2026-04-01 13:00:00' },
            ])
        };

        const res = await get('/status', env);
        const body = await res.json();
        assert.equal(body.sync.last_sync_at, '2026-04-01 14:30:00');
    });
});
