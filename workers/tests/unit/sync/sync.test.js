/**
 * @fileoverview Unit tests for the sync worker.
 *
 * Covers:
 *   - coerceValue: value coercion for D1 parameters
 *   - buildUpsert: parameterised INSERT OR REPLACE generation
 *   - syncEntity: epoch guard, pagination, HTTP errors, data flow (upserts,
 *     deletes, column coercion, notNullStrings derivation)
 *   - ensureColumns: existing column skip, new column ALTER TABLE, invalid name rejection
 *   - syncLogos: no-binding early return, unknown URL, R2 hit, S3 404/403, full path
 *   - isValidSyncSecret: tested indirectly via the fetch handler
 *   - fetch handler: /sync/status GET, /sync/trigger POST (valid/invalid secret), 404
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { syncEntity, buildUpsert, ensureColumns, syncLogos } from '../../../sync/index.js';

// ── Runtime polyfills ─────────────────────────────────────────────────────────
// Node.js crypto.subtle does not implement timingSafeEqual (a Cloudflare
// Workers extension). Polyfill it with a constant-time XOR so sync handler
// tests can exercise isValidSyncSecret.
if (!crypto.subtle.timingSafeEqual) {
    /** @param {ArrayBufferView} a @param {ArrayBufferView} b @returns {boolean} */
    crypto.subtle.timingSafeEqual = function timingSafeEqual(a, b) {
        const va = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const vb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        if (va.length !== vb.length) return false;
        let diff = 0;
        for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
        return diff === 0;
    };
}

// ── Shared mock helpers ───────────────────────────────────────────────────────

/**
 * Creates a configurable mock D1 database for sync tests.
 *
 * @param {object} [opts]
 * @param {number|null} [opts.lastSync] - last_sync value; null = no row.
 * @param {string[]} [opts.existingColumns] - PRAGMA table_info column names.
 * @param {string[]} [opts.capturedAlters] - Array that receives ALTER TABLE SQL.
 * @param {string[]} [opts.capturedBatch] - Array that receives batch statement SQL.
 * @returns {{db: D1Database, preparedSql: string[]}}
 */
function mockD1({ lastSync = null, existingColumns = [], capturedAlters = [], capturedBatch = [] } = {}) {
    /** @type {string[]} */
    const preparedSql = [];

    const db = /** @type {any} */ ({
        prepare(/** @type {string} */ sql) {
            preparedSql.push(sql);
            const stmt = {
                _sql: sql,
                _params: /** @type {any[]} */ ([]),
                bind(/** @type {...any} */ ...params) { this._params = params; return this; },
                first() {
                    if (sql.includes('_sync_meta') && sql.includes('SELECT')) {
                        return lastSync === null
                            ? Promise.resolve(null)
                            : Promise.resolve({ last_sync: lastSync });
                    }
                    if (sql.includes('COUNT(*)')) {
                        return Promise.resolve({ cnt: 0 });
                    }
                    return Promise.resolve(null);
                },
                run() { return Promise.resolve({ success: true, meta: {}, results: [] }); },
                all() {
                    if (sql.includes('PRAGMA table_info')) {
                        return Promise.resolve({
                            success: true,
                            results: existingColumns.map(name => ({ name })),
                            meta: {},
                        });
                    }
                    return Promise.resolve({ success: true, results: [], meta: {} });
                },
            };
            return stmt;
        },
        batch(/** @type {any[]} */ stmts) {
            for (const s of stmts) capturedBatch.push(s._sql || '');
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
        { name: 'info_type', type: 'string', nullable: false },
        { name: 'notes', type: 'string', nullable: true },
        { name: 'created', type: 'datetime' },
    ],
};

// ── buildUpsert ───────────────────────────────────────────────────────────────

describe('buildUpsert', () => {
    it('generates INSERT OR REPLACE with correct column count', () => {
        const { sql, params } = buildUpsert(
            'peeringdb_network',
            ['id', 'name'],
            { id: 1, name: 'Test Net' },
            new Set()
        );
        assert.ok(sql.startsWith('INSERT OR REPLACE INTO "peeringdb_network"'));
        assert.ok(sql.includes('"id","name"'));
        assert.equal(params.length, 2);
        assert.equal(params[0], 1);
        assert.equal(params[1], 'Test Net');
    });

    it('coerces boolean true to 1', () => {
        const { params } = buildUpsert('t', ['active'], { active: true }, new Set());
        assert.equal(params[0], 1);
    });

    it('coerces boolean false to 0', () => {
        const { params } = buildUpsert('t', ['active'], { active: false }, new Set());
        assert.equal(params[0], 0);
    });

    it('JSON-stringifies arrays', () => {
        const { params } = buildUpsert('t', ['tags'], { tags: ['a', 'b'] }, new Set());
        assert.equal(params[0], '["a","b"]');
    });

    it('JSON-stringifies objects', () => {
        const { params } = buildUpsert('t', ['meta'], { meta: { k: 1 } }, new Set());
        assert.equal(params[0], '{"k":1}');
    });

    it('coerces null to null for nullable columns', () => {
        const { params } = buildUpsert('t', ['notes'], { notes: null }, new Set());
        assert.equal(params[0], null);
    });

    it('coerces null to "" for NOT NULL string columns', () => {
        const { params } = buildUpsert('t', ['name'], { name: null }, new Set(['name']));
        assert.equal(params[0], '');
    });

    it('coerces undefined to "" for NOT NULL string columns', () => {
        const { params } = buildUpsert('t', ['name'], {}, new Set(['name']));
        assert.equal(params[0], '');
    });

    it('passes numbers through unchanged', () => {
        const { params } = buildUpsert('t', ['asn'], { asn: 3356 }, new Set());
        assert.equal(params[0], 3356);
    });

    it('converts other types to string via String()', () => {
        const { params } = buildUpsert('t', ['val'], { val: 42n }, new Set());
        assert.equal(params[0], '42');
    });
});

// ── ensureColumns ─────────────────────────────────────────────────────────────

describe('ensureColumns', () => {
    it('does not ALTER when all columns already exist', async () => {
        const { db, preparedSql } = mockD1({ existingColumns: ['id', 'name'] });
        await ensureColumns(db, 'peeringdb_network', ['id', 'name']);
        const alters = preparedSql.filter(s => s.includes('ALTER'));
        assert.equal(alters.length, 0);
    });

    it('issues ALTER TABLE ADD COLUMN for missing columns', async () => {
        const alters = /** @type {string[]} */ ([]);
        const { db } = mockD1({ existingColumns: ['id'] });
        const origPrepare = db.prepare.bind(db);
        db.prepare = (/** @type {string} */ sql) => {
            if (sql.includes('ALTER')) alters.push(sql);
            return origPrepare(sql);
        };
        await ensureColumns(db, 'peeringdb_network', ['id', 'new_col']);
        assert.equal(alters.length, 1);
        assert.ok(alters[0].includes('"new_col"'));
    });

    it('rejects column names with invalid characters', async () => {
        const alters = /** @type {string[]} */ ([]);
        const { db } = mockD1({ existingColumns: [] });
        const origPrepare = db.prepare.bind(db);
        db.prepare = (/** @type {string} */ sql) => {
            if (sql.includes('ALTER')) alters.push(sql);
            return origPrepare(sql);
        };
        await ensureColumns(db, 'peeringdb_network', ['valid_col', 'bad-col!', '1invalid']);
        const alteredCols = alters.map(s => (/"(\w+)"\s+TEXT/.exec(s) || [])[1]);
        assert.ok(alteredCols.includes('valid_col'), 'valid_col should be added');
        assert.ok(!alteredCols.some(c => c === undefined || c?.includes('bad')), 'invalid names must not be added');
    });
});

// ── syncEntity — epoch guard ──────────────────────────────────────────────────

describe('syncEntity epoch guard', () => {
    it('returns an error when last_sync is 0 (no sync_meta row)', async () => {
        const { db } = mockD1({ lastSync: null });
        const result = await syncEntity(db, 'net', TEST_META, '');
        assert.equal(result.tag, 'net');
        assert.equal(result.updated, 0);
        assert.equal(result.deleted, 0);
        assert.ok(result.error.includes('last_sync is 0'));
    });

    it('returns an error when last_sync is explicitly 0', async () => {
        const { db } = mockD1({ lastSync: 0 });
        const result = await syncEntity(db, 'netixlan', TEST_META, '');
        assert.ok(result.error.includes('last_sync is 0'));
    });

    it('does not reject when last_sync is a valid timestamp', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(
            JSON.stringify({ data: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
        try {
            const { db } = mockD1({ lastSync: 1712000000 });
            const result = await syncEntity(db, 'net', TEST_META, '');
            assert.ok(!result.error.includes('last_sync is 0'));
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

// ── syncEntity — pagination ───────────────────────────────────────────────────

describe('syncEntity pagination', () => {
    it('appends limit=0 and depth=0 to the PeeringDB API URL', async () => {
        let capturedUrl = '';
        const origFetch = globalThis.fetch;
        globalThis.fetch = async (/** @type {string | URL | Request} */ url) => {
            capturedUrl = url instanceof Request ? url.url : String(url);
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
        };
        try {
            const { db } = mockD1({ lastSync: 1712000000 });
            await syncEntity(db, 'net', TEST_META, '');
            assert.ok(capturedUrl.includes('limit=0'));
            assert.ok(capturedUrl.includes('depth=0'));
            assert.ok(capturedUrl.includes('since=1712000000'));
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('includes Authorization header when API key is provided', async () => {
        let capturedAuth = '';
        const origFetch = globalThis.fetch;
        globalThis.fetch = async (_url, init) => {
            capturedAuth = new Headers(/** @type {HeadersInit} */(init?.headers)).get('authorization') || '';
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
        };
        try {
            const { db } = mockD1({ lastSync: 1712000000 });
            await syncEntity(db, 'net', TEST_META, 'my-api-key');
            assert.equal(capturedAuth, 'Api-Key my-api-key');
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

// ── syncEntity — HTTP errors ──────────────────────────────────────────────────

describe('syncEntity HTTP error handling', () => {
    it('returns error string for non-200 API response', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response('Not Found', { status: 404 });
        try {
            const { db } = mockD1({ lastSync: 1712000000 });
            const result = await syncEntity(db, 'net', TEST_META, '');
            assert.ok(result.error.includes('404'));
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('returns error string when fetch throws', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error('network failure'); };
        try {
            const { db } = mockD1({ lastSync: 1712000000 });
            const result = await syncEntity(db, 'net', TEST_META, '');
            assert.ok(result.error.includes('network failure'));
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

// ── syncEntity — data flow ────────────────────────────────────────────────────

describe('syncEntity data flow', () => {
    it('counts active and deleted rows correctly', async () => {
        const origFetch = globalThis.fetch;
        const rows = [
            { id: 1, name: 'Alpha', info_type: 'NSP', notes: null, created: '2024-01-01', status: 'ok' },
            { id: 2, name: 'Beta',  info_type: 'ISP', notes: null, created: '2024-01-02', status: 'deleted' },
        ];
        globalThis.fetch = async () => new Response(JSON.stringify({ data: rows }), { status: 200 });
        try {
            const { db } = mockD1({ lastSync: 1712000000, existingColumns: Object.keys(rows[0]) });
            const result = await syncEntity(db, 'net', TEST_META, '');
            assert.equal(result.updated, 1);
            assert.equal(result.deleted, 1);
            assert.equal(result.error, '');
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('handles null values for NOT NULL string columns without error', async () => {
        const origFetch = globalThis.fetch;
        const rows = [{ id: 1, name: null, info_type: null, notes: null, created: null, status: 'ok' }];
        globalThis.fetch = async () => new Response(JSON.stringify({ data: rows }), { status: 200 });
        try {
            const { db } = mockD1({ lastSync: 1712000000, existingColumns: Object.keys(rows[0]) });
            const result = await syncEntity(db, 'net', TEST_META, '');
            assert.equal(result.error, '');
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('handles empty data array without upserting', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
        try {
            const { db } = mockD1({ lastSync: 1712000000 });
            const result = await syncEntity(db, 'net', TEST_META, '');
            assert.equal(result.updated, 0);
            assert.equal(result.deleted, 0);
            assert.equal(result.error, '');
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

// ── syncLogos ─────────────────────────────────────────────────────────────────

const S3_PREFIX = 'https://peeringdb-media-prod.s3.amazonaws.com/media/';

/**
 * Minimal mock R2 bucket for syncLogos tests.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.existsInR2] - Whether head() returns an object.
 * @param {string[]} [opts.capturedPuts] - Receives R2 keys that were put.
 * @returns {R2Bucket}
 */
function mockR2({ existsInR2 = false, capturedPuts = [] } = {}) {
    return /** @type {any} */ ({
        head(/** @type {string} */ _key) { return Promise.resolve(existsInR2 ? { key: _key } : null); },
        put(/** @type {string} */ key) { capturedPuts.push(key); return Promise.resolve({ key }); },
    });
}

/**
 * Creates a D1 mock that returns a single logo row from the unmigrated query.
 *
 * @param {string} logo - Logo URL to return.
 * @returns {D1Database}
 */
function mockD1WithLogo(logo) {
    let allCalled = false;
    return /** @type {any} */ ({
        prepare(/** @type {string} */ sql) {
            return {
                bind() { return this; },
                all() {
                    if (!allCalled && sql.includes('__logo_migrated')) {
                        allCalled = true;
                        return Promise.resolve({ success: true, results: [{ id: 1, logo }], meta: {} });
                    }
                    return Promise.resolve({ success: true, results: [], meta: {} });
                },
                run() { return Promise.resolve({ success: true, meta: {}, results: [] }); },
                first() { return Promise.resolve(null); },
            };
        },
        batch() { return Promise.resolve([]); },
    });
}

describe('syncLogos', () => {
    it('returns immediately when logos binding is undefined', async () => {
        const { db } = mockD1();
        const result = await syncLogos(db, undefined, 'org', 'peeringdb_organization');
        assert.deepEqual(result, { fetched: 0, errors: 0 });
    });

    it('returns 0/0 when no unmigrated logos exist', async () => {
        const { db } = mockD1();
        const result = await syncLogos(db, mockR2(), 'org', 'peeringdb_organization');
        assert.deepEqual(result, { fetched: 0, errors: 0 });
    });

    it('marks unknown URL format as migrated without incrementing fetched', async () => {
        const db = mockD1WithLogo('https://unknown.example.com/img.png');
        const result = await syncLogos(db, mockR2(), 'org', 'peeringdb_organization');
        assert.equal(result.fetched, 0);
        assert.equal(result.errors, 0);
    });

    it('counts already-in-R2 logos as fetched without re-uploading', async () => {
        const db = mockD1WithLogo(`${S3_PREFIX}logos/net/1.png`);
        const puts = /** @type {string[]} */ ([]);
        const result = await syncLogos(db, mockR2({ existsInR2: true, capturedPuts: puts }), 'org', 'peeringdb_organization');
        assert.equal(result.fetched, 1);
        assert.equal(result.errors, 0);
        assert.equal(puts.length, 0, 'Should not re-upload logos already in R2');
    });

    it('records errors for non-404/403 S3 responses', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response('', { status: 500 });
        try {
            const db = mockD1WithLogo(`${S3_PREFIX}logos/net/1.png`);
            const result = await syncLogos(db, mockR2(), 'org', 'peeringdb_organization');
            assert.equal(result.errors, 1);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('marks S3 404 as migrated (logo deleted upstream)', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response('', { status: 404 });
        try {
            const db = mockD1WithLogo(`${S3_PREFIX}logos/net/1.png`);
            const result = await syncLogos(db, mockR2(), 'org', 'peeringdb_organization');
            assert.equal(result.fetched, 1);
            assert.equal(result.errors, 0);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('marks S3 403 as migrated', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response('', { status: 403 });
        try {
            const db = mockD1WithLogo(`${S3_PREFIX}logos/net/1.png`);
            const result = await syncLogos(db, mockR2(), 'org', 'peeringdb_organization');
            assert.equal(result.fetched, 1);
            assert.equal(result.errors, 0);
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

// ── HTTP fetch handler (also covers isValidSyncSecret) ───────────────────────

describe('sync worker HTTP fetch handler', () => {
    const ENV = /** @type {any} */ ({
        PDB: mockD1().db,
        ADMIN_SECRET: 'correct-secret',
    });
    const CTX = /** @type {ExecutionContext} */ ({
        waitUntil(/** @type {Promise<any>} */ p) { p.catch(() => {}); },
        passThroughOnException() {},
    });

    it('GET /sync/status returns 200 with data array', async () => {
        const res = await worker.fetch(
            new Request('https://sync.example.com/sync/status'),
            ENV, CTX
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(Array.isArray(body.data));
    });

    it('POST /sync/trigger.<correct-secret> returns 200 immediately', async () => {
        const res = await worker.fetch(
            new Request('https://sync.example.com/sync/trigger.correct-secret', { method: 'POST' }),
            ENV, CTX
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, 'sync triggered');
    });

    it('POST /sync/trigger.<wrong-secret> returns 403', async () => {
        const res = await worker.fetch(
            new Request('https://sync.example.com/sync/trigger.wrong-secret', { method: 'POST' }),
            ENV, CTX
        );
        assert.equal(res.status, 403);
        const body = await res.json();
        assert.ok(body.error.includes('Forbidden'));
    });

    it('returns 404 for unrecognised paths', async () => {
        const res = await worker.fetch(
            new Request('https://sync.example.com/something-else'),
            ENV, CTX
        );
        assert.equal(res.status, 404);
    });

    it('returns 403 when ADMIN_SECRET is not configured', async () => {
        const env = /** @type {any} */ ({ PDB: mockD1().db });
        const res = await worker.fetch(
            new Request('https://sync.example.com/sync/trigger.any-secret', { method: 'POST' }),
            env, CTX
        );
        assert.equal(res.status, 403);
    });
});
