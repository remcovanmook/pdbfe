/**
 * @fileoverview Unit tests for the pdbfe-async Queue consumer worker.
 *
 * Covers:
 *   - handleEmbed:  D1 pre-check (already embedded → skip), no neighbors → ack
 *                   without embed, entity gone → skip, success path
 *   - handleDelete: D1 pre-check (entity still exists → skip), success path
 *   - handleLogo:   D1 pre-check (already migrated → skip), entity gone → skip,
 *                   R2 hit, S3 404/403, success path
 *   - queue handler: unknown action → ack+warn, error → retry
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../async/index.js';

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Creates a minimal mock D1 database.
 *
 * @param {object} [opts]
 * @param {Record<string, any> | null} [opts.firstRow] - Row returned by first().
 * @param {any[]} [opts.allResults] - Rows returned by all().
 * @returns {D1Database}
 */
function mockD1({ firstRow = null, allResults = [] } = {}) {
    return /** @type {any} */ ({
        prepare() {
            return {
                bind() { return this; },
                first() { return Promise.resolve(firstRow); },
                all()  { return Promise.resolve({ results: allResults, success: true, meta: {} }); },
                run()  { return Promise.resolve({ success: true, meta: {}, results: [] }); },
            };
        },
        batch() { return Promise.resolve([]); },
    });
}

/**
 * Creates a mock D1 that returns different results per SQL pattern.
 *
 * @param {Array<{ match: string, first?: any, all?: any[] }>} routes
 * @returns {D1Database}
 */
function mockD1Routed(routes) {
    return /** @type {any} */ ({
        prepare(/** @type {string} */ sql) {
            const route = routes.find(r => sql.includes(r.match)) || {};
            return {
                bind() { return this; },
                first() { return Promise.resolve(route.first ?? null); },
                all()   { return Promise.resolve({ results: route.all ?? [], success: true, meta: {} }); },
                run()   { return Promise.resolve({ success: true, meta: {}, results: [] }); },
            };
        },
    });
}

/**
 * Creates a mock Vectorize index.
 *
 * @param {object} [opts]
 * @param {VectorizeVector[]} [opts.stored] - Vectors returned by getByIds().
 * @param {string[]} [opts.capturedUpserts] - Captures IDs passed to upsert().
 * @param {string[]} [opts.capturedDeletes] - Captures IDs passed to deleteByIds().
 * @returns {VectorizeIndex}
 */
function mockVectorize({ stored = [], capturedUpserts = [], capturedDeletes = [] } = {}) {
    return /** @type {any} */ ({
        getByIds()              { return Promise.resolve(stored); },
        upsert(vecs)            { capturedUpserts.push(...vecs.map(v => v.id)); return Promise.resolve({ count: vecs.length }); },
        deleteByIds(ids)        { capturedDeletes.push(...ids); return Promise.resolve({ count: ids.length }); },
        query()                 { return Promise.resolve({ matches: [] }); },
    });
}

/**
 * Creates a mock R2 bucket.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.existsInR2]
 * @param {string[]} [opts.capturedPuts]
 * @returns {R2Bucket}
 */
function mockR2({ existsInR2 = false, capturedPuts = [] } = {}) {
    return /** @type {any} */ ({
        head(_key)     { return Promise.resolve(existsInR2 ? { key: _key } : null); },
        put(key)       { capturedPuts.push(key); return Promise.resolve({ key }); },
        get()          { return Promise.resolve(null); },
        delete()       { return Promise.resolve(); },
        list()         { return Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }); },
    });
}

/** Builds a mock Queue message. */
function mockMessage(body) {
    const msg = {
        id: 'test-id',
        timestamp: new Date(),
        body,
        acked: false,
        retried: false,
        ack()   { this.acked   = true; },
        retry() { this.retried = true; },
    };
    return msg;
}

/** Builds a MessageBatch from an array of message bodies. */
function mockBatch(bodies) {
    return /** @type {any} */ ({
        queue:    'pdbfe-tasks',
        messages: bodies.map(mockMessage),
    });
}

const S3_PREFIX = 'https://peeringdb-media-prod.s3.amazonaws.com/media/';

// ── embed ─────────────────────────────────────────────────────────────────────

describe('async worker — embed action', () => {
    it('acks and skips when entity does not exist in D1', async () => {
        const db        = mockD1({ firstRow: null });
        const vectorize = mockVectorize();
        const batch     = mockBatch([{ action: 'embed', tag: 'net', id: 1 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: vectorize, LOGOS: mockR2() }, {});
        assert.equal(batch.messages[0].acked, true);
        assert.equal(batch.messages[0].retried, false);
    });

    it('acks and skips when __vector_embedded is already 1', async () => {
        const upserts = [];
        const db      = mockD1({ firstRow: { id: 1, embedded: 1 } });
        const vec     = mockVectorize({ capturedUpserts: upserts });
        const batch   = mockBatch([{ action: 'embed', tag: 'net', id: 1 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: vec, LOGOS: mockR2() }, {});
        assert.equal(upserts.length, 0);
        assert.equal(batch.messages[0].acked, true);
    });

    it('acks without embedding when no neighbor vectors exist', async () => {
        const upserts = [];
        const db      = mockD1Routed([
            { match: '__vector_embedded', first: { id: 1, embedded: 0 } },
        ]);
        const vec     = mockVectorize({ stored: [], capturedUpserts: upserts });
        const batch   = mockBatch([{ action: 'embed', tag: 'net', id: 1 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: vec, LOGOS: mockR2() }, {});
        assert.equal(upserts.length, 0);
        assert.equal(batch.messages[0].acked, true);
    });

    it('upserts averaged vector and acks on success', async () => {
        const upserts = [];
        const db      = mockD1Routed([
            { match: '__vector_embedded', first: { id: 1, embedded: 0 } },
            { match: 'network_ixlan',     all:   [{ ix_id: 10 }] },
            { match: 'network_facility',  all:   [] },
            { match: 'peeringdb_network', first: { org_id: 5 } },
        ]);
        const stored = [
            { id: 'ix:10', values: [0.0, 1.0, 0.5] },
        ];
        const vec   = mockVectorize({ stored, capturedUpserts: upserts });
        const batch = mockBatch([{ action: 'embed', tag: 'net', id: 1 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: vec, LOGOS: mockR2() }, {});
        assert.equal(upserts.length, 1);
        assert.equal(upserts[0], 'net:1');
        assert.equal(batch.messages[0].acked, true);
    });

    it('retries on unexpected error', async () => {
        const db    = { prepare() { throw new Error('D1 boom'); } };
        const batch = mockBatch([{ action: 'embed', tag: 'net', id: 1 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: mockVectorize(), LOGOS: mockR2() }, {});
        assert.equal(batch.messages[0].retried, true);
    });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe('async worker — delete action', () => {
    it('acks and skips when entity still exists in D1', async () => {
        const deletes = [];
        const db      = mockD1({ firstRow: { id: 2 } });
        const vec     = mockVectorize({ capturedDeletes: deletes });
        const batch   = mockBatch([{ action: 'delete', tag: 'ix', id: 2 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: vec, LOGOS: mockR2() }, {});
        assert.equal(deletes.length, 0);
        assert.equal(batch.messages[0].acked, true);
    });

    it('deletes vector and acks when entity is gone from D1', async () => {
        const deletes = [];
        const db      = mockD1({ firstRow: null });
        const vec     = mockVectorize({ capturedDeletes: deletes });
        const batch   = mockBatch([{ action: 'delete', tag: 'fac', id: 7 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: vec, LOGOS: mockR2() }, {});
        assert.equal(deletes.length, 1);
        assert.equal(deletes[0], 'fac:7');
        assert.equal(batch.messages[0].acked, true);
    });
});

// ── logo ──────────────────────────────────────────────────────────────────────

describe('async worker — logo action', () => {
    it('acks and skips when entity has no logo row', async () => {
        const puts  = [];
        const db    = mockD1({ firstRow: null });
        const r2    = mockR2({ capturedPuts: puts });
        const batch = mockBatch([{ action: 'logo', tag: 'org', id: 1 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: mockVectorize(), LOGOS: r2 }, {});
        assert.equal(puts.length, 0);
        assert.equal(batch.messages[0].acked, true);
    });

    it('acks and skips when __logo_migrated is already 1', async () => {
        const puts  = [];
        const db    = mockD1({ firstRow: { id: 1, logo: `${S3_PREFIX}img.png`, migrated: 1 } });
        const r2    = mockR2({ capturedPuts: puts });
        const batch = mockBatch([{ action: 'logo', tag: 'org', id: 1 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: mockVectorize(), LOGOS: r2 }, {});
        assert.equal(puts.length, 0);
        assert.equal(batch.messages[0].acked, true);
    });

    it('marks unknown URL format as migrated without uploading', async () => {
        const puts  = [];
        const db    = mockD1({ firstRow: { id: 1, logo: 'https://other.example.com/img.png', migrated: 0 } });
        const r2    = mockR2({ capturedPuts: puts });
        const batch = mockBatch([{ action: 'logo', tag: 'org', id: 1 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: mockVectorize(), LOGOS: r2 }, {});
        assert.equal(puts.length, 0);
        assert.equal(batch.messages[0].acked, true);
    });

    it('acks when logo already exists in R2 without re-uploading', async () => {
        const puts  = [];
        const db    = mockD1({ firstRow: { id: 1, logo: `${S3_PREFIX}logos/net/1.png`, migrated: 0 } });
        const r2    = mockR2({ existsInR2: true, capturedPuts: puts });
        const batch = mockBatch([{ action: 'logo', tag: 'org', id: 1 }]);
        await worker.queue(batch, { PDB: db, VECTORIZE: mockVectorize(), LOGOS: r2 }, {});
        assert.equal(puts.length, 0);
        assert.equal(batch.messages[0].acked, true);
    });

    it('marks S3 404 as migrated (logo deleted upstream)', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response('', { status: 404 });
        try {
            const db    = mockD1({ firstRow: { id: 1, logo: `${S3_PREFIX}logos/net/1.png`, migrated: 0 } });
            const batch = mockBatch([{ action: 'logo', tag: 'org', id: 1 }]);
            await worker.queue(batch, { PDB: db, VECTORIZE: mockVectorize(), LOGOS: mockR2() }, {});
            assert.equal(batch.messages[0].acked, true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('retries on S3 5xx errors', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response('', { status: 500 });
        try {
            const db    = mockD1({ firstRow: { id: 1, logo: `${S3_PREFIX}logos/net/1.png`, migrated: 0 } });
            const batch = mockBatch([{ action: 'logo', tag: 'org', id: 1 }]);
            await worker.queue(batch, { PDB: db, VECTORIZE: mockVectorize(), LOGOS: mockR2() }, {});
            assert.equal(batch.messages[0].retried, true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('puts logo in R2 and acks on success', async () => {
        const origFetch = globalThis.fetch;
        const body      = new Uint8Array([1, 2, 3]);
        globalThis.fetch = async () => new Response(body, {
            status: 200,
            headers: { 'content-type': 'image/png' },
        });
        try {
            const puts  = [];
            const db    = mockD1({ firstRow: { id: 1, logo: `${S3_PREFIX}logos/net/1.png`, migrated: 0 } });
            const r2    = mockR2({ capturedPuts: puts });
            const batch = mockBatch([{ action: 'logo', tag: 'org', id: 1 }]);
            await worker.queue(batch, { PDB: db, VECTORIZE: mockVectorize(), LOGOS: r2 }, {});
            assert.equal(puts.length, 1);
            assert.equal(puts[0], 'logos/net/1.png');
            assert.equal(batch.messages[0].acked, true);
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

// ── queue handler edge cases ──────────────────────────────────────────────────

describe('async worker — queue handler', () => {
    it('acks unknown action types without throwing', async () => {
        const batch = mockBatch([{ action: 'unknown', tag: 'net', id: 1 }]);
        await worker.queue(batch, { PDB: mockD1(), VECTORIZE: mockVectorize(), LOGOS: mockR2() }, {});
        assert.equal(batch.messages[0].acked, true);
    });

    it('processes multiple messages independently', async () => {
        const deletes = [];
        const db      = mockD1({ firstRow: null });
        const vec     = mockVectorize({ capturedDeletes: deletes });
        const batch   = mockBatch([
            { action: 'delete', tag: 'net', id: 1 },
            { action: 'delete', tag: 'ix',  id: 2 },
        ]);
        await worker.queue(batch, { PDB: db, VECTORIZE: vec, LOGOS: mockR2() }, {});
        assert.equal(deletes.length, 2);
        assert.deepEqual(deletes.sort(), ['ix:2', 'net:1']);
        assert.equal(batch.messages[0].acked, true);
        assert.equal(batch.messages[1].acked, true);
    });

    it('health fetch handler returns 200', async () => {
        const res = await worker.fetch(new Request('https://async.internal/health'), {}, {});
        assert.equal(res.status, 200);
    });
});
