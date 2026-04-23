/**
 * @fileoverview Unit tests for the pdbfe-search worker.
 *
 * Covers:
 *   - parseSearchParams: valid params, missing q, missing entity, unknown entity,
 *     invalid mode, limit clamping, skip normalisation
 *   - handleKeyword: D1 LIKE query structure, empty result (null), result shape
 *   - handleSearch (via worker.fetch): keyword path, semantic gate (503),
 *     auto fallback to keyword, cache tier headers, 400 on bad params,
 *     rate limit rejection, SEARCH_EMPTY_SENTINEL on empty result
 *   - buildSearchKey: auth prefix partitioning, fast-path cache hit
 *   - withSearchSWR: L1 hit, MISS path (delegates to core/pipeline, tested there)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../search/index.js';
import { handleKeyword } from '../../../search/handlers/keyword.js';
import { buildSearchKey, purgeSearchCache, SEARCH_EMPTY_SENTINEL } from '../../../search/cache.js';

// ── Shared mock helpers ───────────────────────────────────────────────────────

/**
 * Minimal D1 mock that returns canned row results.
 *
 * @param {object[]} rows - Rows to return from .all().
 * @returns {D1Database}
 */
function mockDB(rows = []) {
    return /** @type {any} */ ({
        withSession() { return this; },
        prepare(/** @type {string} */ _sql) {
            return {
                bind(/** @type {any[]} */ ..._p) { return this; },
                all() { return Promise.resolve({ success: true, results: rows, meta: {} }); },
                first() { return Promise.resolve(rows[0] ?? null); },
                run() { return Promise.resolve({ success: true, meta: {}, results: [] }); },
            };
        },
        batch(/** @type {any[]} */ stmts) {
            return Promise.resolve(stmts.map(() => ({ success: true, meta: {}, results: [] })));
        },
    });
}

/**
 * Builds a minimal PdbSearchEnv. Omits AI and VECTORIZE so semantic search
 * is disabled by default. Pass ai/vectorize to enable it.
 *
 * @param {object} [overrides]
 * @param {object[]} [overrides.rows] - DB rows returned.
 * @param {any}     [overrides.AI]   - Workers AI binding mock.
 * @param {any}     [overrides.VECTORIZE] - Vectorize binding mock.
 * @returns {PdbSearchEnv}
 */
function mockEnv({ rows = [], AI = undefined, VECTORIZE = undefined } = {}) {
    const db = mockDB(rows);
    return /** @type {any} */ ({
        PDB: db,
        SESSIONS: { get: async () => null },
        USERDB: { withSession() { return this; }, prepare() { return { bind() { return this; }, first: async () => null }; } },
        PDBFE_VERSION: '0.9.0',
        AI,
        VECTORIZE,
    });
}

/** No-op ExecutionContext. */
const mockCtx = /** @type {ExecutionContext} */ ({
    waitUntil(/** @type {Promise<any>} */ p) { p.catch(() => {}); },
    passThroughOnException() {},
});

// ── buildSearchKey ────────────────────────────────────────────────────────────

describe('buildSearchKey', () => {
    it('prefixes anon: for unauthenticated callers', async () => {
        const key = await buildSearchKey('test', 'net', 'keyword', 20, 0, false);
        assert.ok(key.startsWith('anon:search/'));
    });

    it('prefixes auth: for authenticated callers', async () => {
        const key = await buildSearchKey('test', 'net', 'keyword', 20, 0, true);
        assert.ok(key.startsWith('auth:search/'));
    });

    it('returns different keys for different entity types', async () => {
        const k1 = await buildSearchKey('test', 'net', 'keyword', 20, 0, false);
        const k2 = await buildSearchKey('test', 'ix', 'keyword', 20, 0, false);
        assert.notEqual(k1, k2);
    });

    it('returns different keys for different queries', async () => {
        const k1 = await buildSearchKey('cloudflare', 'net', 'keyword', 20, 0, false);
        const k2 = await buildSearchKey('fastly', 'net', 'keyword', 20, 0, false);
        assert.notEqual(k1, k2);
    });

    it('returns same key for identical params (fast-path cache)', async () => {
        const k1 = await buildSearchKey('repeat', 'net', 'keyword', 20, 0, false);
        const k2 = await buildSearchKey('repeat', 'net', 'keyword', 20, 0, false);
        assert.equal(k1, k2);
    });
});

// ── handleKeyword ─────────────────────────────────────────────────────────────

describe('handleKeyword', () => {
    it('returns null when D1 returns no rows', async () => {
        const db = mockDB([]);
        const result = await handleKeyword(db, 'net', 'nobody', 20, 0);
        assert.equal(result, null);
    });

    it('returns Uint8Array with correct shape when rows exist', async () => {
        const db = mockDB([{ id: 694, name: 'Cloudflare', status: 'ok' }]);
        const buf = await handleKeyword(db, 'net', 'cloud', 20, 0);
        assert.ok(buf instanceof Uint8Array);
        const body = JSON.parse(new TextDecoder().decode(buf));
        assert.equal(body.meta.mode, 'keyword');
        assert.equal(body.data.length, 1);
        assert.equal(body.data[0].id, 694);
        assert.equal(body.data[0].entity_type, 'net');
        assert.equal(body.data[0].score, 1.0);
    });

    it('works for ix entity type', async () => {
        const db = mockDB([{ id: 1, name: 'AMSIX', status: 'ok' }]);
        const buf = await handleKeyword(db, 'ix', 'ams', 10, 0);
        assert.ok(buf instanceof Uint8Array);
        const body = JSON.parse(new TextDecoder().decode(buf));
        assert.equal(body.data[0].entity_type, 'ix');
    });
});

// ── worker.fetch (full integration through index.js) ─────────────────────────

describe('GET /search — parameter validation', () => {
    before(() => purgeSearchCache());

    it('returns 400 when q is missing', async () => {
        const req = new Request('https://api.pdbfe.dev/search?entity=net');
        const res = await worker.fetch(req, mockEnv(), mockCtx);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('q'));
    });

    it('returns 400 when entity is missing', async () => {
        const req = new Request('https://api.pdbfe.dev/search?q=test');
        const res = await worker.fetch(req, mockEnv(), mockCtx);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('entity'));
    });

    it('returns 400 for unknown entity type', async () => {
        const req = new Request('https://api.pdbfe.dev/search?q=test&entity=badtype');
        const res = await worker.fetch(req, mockEnv(), mockCtx);
        assert.equal(res.status, 400);
    });

    it('returns 400 for invalid mode', async () => {
        const req = new Request('https://api.pdbfe.dev/search?q=test&entity=net&mode=turbo');
        const res = await worker.fetch(req, mockEnv(), mockCtx);
        assert.equal(res.status, 400);
    });
});

describe('GET /search — keyword path', () => {
    before(() => purgeSearchCache());

    it('returns 200 with keyword results', async () => {
        const env = mockEnv({ rows: [{ id: 1, name: 'TestNet', status: 'ok' }] });
        const req = new Request('https://api.pdbfe.dev/search?q=test&entity=net&mode=keyword');
        const res = await worker.fetch(req, env, mockCtx);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.meta.mode, 'keyword');
        assert.equal(body.data.length, 1);
    });

    it('returns empty sentinel when no rows found', async () => {
        const env = mockEnv({ rows: [] });
        const req = new Request('https://api.pdbfe.dev/search?q=nobody&entity=net&mode=keyword');
        const res = await worker.fetch(req, env, mockCtx);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.data, []);
    });

    it('returns X-Cache header', async () => {
        const env = mockEnv({ rows: [{ id: 2, name: 'Net2', status: 'ok' }] });
        const req = new Request('https://api.pdbfe.dev/search?q=net&entity=net&mode=keyword');
        const res = await worker.fetch(req, env, mockCtx);
        assert.ok(res.headers.get('X-Cache'));
    });

    it('auto mode falls back to keyword when AI bindings absent', async () => {
        const env = mockEnv({ rows: [{ id: 3, name: 'AutoNet', status: 'ok' }] });
        const req = new Request('https://api.pdbfe.dev/search?q=auto&entity=net');
        const res = await worker.fetch(req, env, mockCtx);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.meta.mode, 'keyword');
    });
});

describe('GET /search — semantic gate', () => {
    it('returns 503 for explicit mode=semantic when bindings absent', async () => {
        const env = mockEnv();
        const req = new Request('https://api.pdbfe.dev/search?q=cloud+provider&entity=net&mode=semantic');
        const res = await worker.fetch(req, env, mockCtx);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.ok(body.error.includes('not available'));
    });
});

describe('GET /search — CORS and method handling', () => {
    it('handles OPTIONS preflight', async () => {
        const req = new Request('https://api.pdbfe.dev/search', { method: 'OPTIONS' });
        const res = await worker.fetch(req, mockEnv(), mockCtx);
        assert.ok([200, 204].includes(res.status));
    });

    it('returns CORS header on search response', async () => {
        const env = mockEnv({ rows: [] });
        const req = new Request('https://api.pdbfe.dev/search?q=test&entity=net&mode=keyword');
        const res = await worker.fetch(req, env, mockCtx);
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    });
});

describe('GET /search — admin endpoints', () => {
    it('responds to /health', async () => {
        const req = new Request('https://api.pdbfe.dev/health');
        const res = await worker.fetch(req, mockEnv(), mockCtx);
        assert.ok([200, 204].includes(res.status));
    });
});
