/**
 * @fileoverview Unit tests for the API handler modules.
 *
 * Tests handleList, handleDetail, and handleAsSet through the full
 * public API, exercising the withEdgeSWR → D1 mock pipeline.
 *
 * Uses mock D1 databases that return pre-canned JSON payloads for
 * both the hot path (json_group_array → single string) and cold path
 * (row-level → expandDepth). The L2 cache (caches.default) is
 * unavailable in Node.js so all miss paths go straight to queryFn.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleList } from '../../../api/handlers/list.js';
import { handleDetail } from '../../../api/handlers/detail.js';
import { handleAsSet } from '../../../api/handlers/as_set.js';
import { handleNotImplemented } from '../../../api/handlers/shared.js';
import { purgeAllCaches } from '../../../api/cache.js';

// ── Shared test utilities ────────────────────────────────────────────────────

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

/**
 * Creates a mock D1 database that supports the statement chain pattern
 * used by the handler modules: db.prepare(sql).bind(...params).first()
 * and db.prepare(sql).bind(...params).all().
 *
 * Responses are dispatched based on SQL content matching. This is simpler
 * than a full SQL parser and sufficient for handler-level tests where we
 * control the query patterns.
 *
 * @param {Object} opts - Mock configuration.
 * @param {string} [opts.hotPayload] - JSON string returned by json_group_array (hot path).
 * @param {Array<Record<string, any>>} [opts.rows] - Row-level results (cold path).
 * @param {number} [opts.count] - Count result for SELECT COUNT(*).
 * @param {Record<string, any>|null} [opts.asSetResult] - Result for AS-set lookup.
 * @returns {D1Session}
 */
function mockD1({ hotPayload = null, rows = [], count = 0, asSetResult = null } = {}) {
    return /** @type {any} */ ({
        prepare(/** @type {string} */ sql) {
            return {
                /** @type {any[]} */
                _params: [],
                bind(/** @type {...any} */ ...params) {
                    this._params = params;
                    return this;
                },
                first() {
                    // json_group_array hot path
                    if (sql.includes('json_group_array')) {
                        return Promise.resolve(hotPayload ? { payload: hotPayload } : null);
                    }
                    // COUNT(*) query
                    if (sql.includes('COUNT(*)')) {
                        return Promise.resolve({ cnt: count });
                    }
                    // AS-set lookup
                    if (sql.includes('irr_as_set')) {
                        return Promise.resolve(asSetResult);
                    }
                    return Promise.resolve(null);
                },
                all() {
                    return Promise.resolve({
                        success: true,
                        results: rows,
                        meta: {}
                    });
                },
            };
        },
        batch(/** @type {any[]} */ stmts) {
            return Promise.resolve(stmts.map(() => ({ success: true, meta: {}, results: [] })));
        },
    });
}

/**
 * Builds a minimal HandlerContext for testing.
 *
 * @param {Object} overrides - Fields to override on the default context.
 * @returns {HandlerContext}
 */
function makeHC(overrides = {}) {
    const { ctx } = mockCtx();
    return /** @type {HandlerContext} */ ({
        request: new Request('https://api.pdbfe.dev/api/net'),
        db: mockD1(),
        ctx,
        entityTag: 'net',
        filters: [],
        opts: { depth: 0, limit: -1, skip: 0, since: 0, sort: '', fields: [], pdbfe: false },
        rawPath: 'anon:api/net',
        queryString: '',
        authenticated: false,
        entityVersionMs: 0,
        userId: null,
        ...overrides,
    });
}

// ── handleList ───────────────────────────────────────────────────────────────

describe('handleList', () => {
    beforeEach(() => {
        purgeAllCaches();
    });

    it('returns 404 for unknown entity tag', async () => {
        const hc = makeHC({ entityTag: 'nonexistent' });
        const res = await handleList(hc);
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.ok(body.error.includes('Unknown entity'));
    });

    it('returns JSON payload from hot path (depth=0)', async () => {
        const payload = '{"data":[{"id":1,"name":"Test Net"}],"meta":{}}';
        const db = mockD1({ hotPayload: payload });
        const hc = makeHC({ db });

        const res = await handleList(hc);
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.equal(body.data.length, 1);
        assert.equal(body.data[0].id, 1);
    });

    it('returns empty envelope when hot path returns no payload', async () => {
        const db = mockD1({ hotPayload: null });
        const hc = makeHC({ db });

        const res = await handleList(hc);
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.deepEqual(body.data, []);
    });

    it('returns count when limit=0 and skip=0', async () => {
        const db = mockD1({ count: 42 });
        const hc = makeHC({
            db,
            opts: { depth: 0, limit: 0, skip: 0, since: 0, sort: '', fields: [], pdbfe: false },
        });

        const res = await handleList(hc);
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.deepEqual(body.data, []);
        assert.equal(body.meta.count, 42);
    });

    it('includes X-Auth-Status header for authenticated callers', async () => {
        const payload = '{"data":[],"meta":{}}';
        const db = mockD1({ hotPayload: payload });
        const hc = makeHC({ db, authenticated: true });

        const res = await handleList(hc);
        assert.equal(res.headers.get('X-Auth-Status'), 'authenticated');
    });

    it('includes X-Auth-Status header for anonymous callers', async () => {
        const payload = '{"data":[],"meta":{}}';
        const db = mockD1({ hotPayload: payload });
        const hc = makeHC({ db, authenticated: false });

        const res = await handleList(hc);
        assert.equal(res.headers.get('X-Auth-Status'), 'unauthenticated');
    });

    it('returns rows from cold path when depth > 0', async () => {
        const rows = [
            { id: 1, name: 'Net A', org_id: 10, social_media: '[]', info_unicast: 1 },
            { id: 2, name: 'Net B', org_id: 20, social_media: '[]', info_unicast: 0 },
        ];
        const db = mockD1({ rows });
        const hc = makeHC({
            db,
            opts: { depth: 1, limit: -1, skip: 0, since: 0, sort: '', fields: [], pdbfe: false }
        });

        const res = await handleList(hc);
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.equal(body.data.length, 2);
    });
});

// ── handleDetail ─────────────────────────────────────────────────────────────

describe('handleDetail', () => {
    beforeEach(() => {
        purgeAllCaches();
    });

    it('returns 404 for unknown entity tag', async () => {
        const hc = makeHC({ entityTag: 'nonexistent' });
        const res = await handleDetail(hc, 1);
        assert.equal(res.status, 404);
    });

    it('returns 404 when entity is not found (hot path)', async () => {
        const db = mockD1({ hotPayload: null });
        const hc = makeHC({ db });

        const res = await handleDetail(hc, 999999);
        assert.equal(res.status, 404);
    });

    it('returns 404 when hot path returns empty envelope', async () => {
        const db = mockD1({ hotPayload: '{"data":[],"meta":{}}' });
        const hc = makeHC({ db });

        const res = await handleDetail(hc, 999999);
        assert.equal(res.status, 404);
    });

    it('returns entity data from hot path (depth=0)', async () => {
        const payload = '{"data":[{"id":694,"name":"Cloudflare","asn":13335}],"meta":{}}';
        const db = mockD1({ hotPayload: payload });
        const hc = makeHC({ db });

        const res = await handleDetail(hc, 694);
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.equal(body.data.length, 1);
        assert.equal(body.data[0].id, 694);
    });

    it('returns entity data from cold path (depth > 0)', async () => {
        const rows = [{ id: 694, name: 'Cloudflare', org_id: 10, social_media: '[]', info_unicast: 1 }];
        const db = mockD1({ rows });
        const hc = makeHC({
            db,
            opts: { depth: 1, limit: -1, skip: 0, since: 0, sort: '', fields: [], pdbfe: false }
        });

        const res = await handleDetail(hc, 694);
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.equal(body.data.length, 1);
    });

    it('returns 404 when cold path finds no rows', async () => {
        const db = mockD1({ rows: [] });
        const hc = makeHC({
            db,
            opts: { depth: 1, limit: -1, skip: 0, since: 0, sort: '', fields: [], pdbfe: false }
        });

        const res = await handleDetail(hc, 999999);
        assert.equal(res.status, 404);
    });

    it('includes ETag header on successful response', async () => {
        const payload = '{"data":[{"id":1}],"meta":{}}';
        const db = mockD1({ hotPayload: payload });
        const hc = makeHC({ db });

        const res = await handleDetail(hc, 1);
        assert.ok(res.headers.has('ETag'));
    });

    it('returns 304 when If-None-Match matches ETag', async () => {
        const payload = '{"data":[{"id":1}],"meta":{}}';
        const db = mockD1({ hotPayload: payload });

        // First request to get the ETag
        const hc1 = makeHC({ db });
        const res1 = await handleDetail(hc1, 1);
        const etag = res1.headers.get('ETag');

        // Second request with If-None-Match
        const request = new Request('https://api.pdbfe.dev/api/net/1', {
            headers: { 'If-None-Match': etag }
        });
        const hc2 = makeHC({ db, request });
        const res2 = await handleDetail(hc2, 1);
        assert.equal(res2.status, 304);
    });
});

// ── handleAsSet ──────────────────────────────────────────────────────────────

describe('handleAsSet', () => {
    beforeEach(() => {
        purgeAllCaches();
    });

    it('returns AS-set data for a valid ASN', async () => {
        const asSetPayload = '{"data":[{"asn":13335,"irr_as_set":"AS-CLOUDFLARE","name":"Cloudflare"}],"meta":{}}';
        const db = mockD1({ asSetResult: { payload: asSetPayload } });
        const { ctx } = mockCtx();
        const request = new Request('https://api.pdbfe.dev/api/as_set/13335');

        const res = await handleAsSet(request, db, ctx, 13335, false);
        assert.equal(res.status, 200);

        const body = await res.json();
        assert.equal(body.data[0].asn, 13335);
        assert.equal(body.data[0].irr_as_set, 'AS-CLOUDFLARE');
    });

    it('returns 404 for ASN with no network', async () => {
        const db = mockD1({ asSetResult: null });
        const { ctx } = mockCtx();
        const request = new Request('https://api.pdbfe.dev/api/as_set/999999');

        const res = await handleAsSet(request, db, ctx, 999999, false);
        assert.equal(res.status, 404);
    });

    it('returns 404 when payload is empty', async () => {
        const db = mockD1({ asSetResult: { payload: null } });
        const { ctx } = mockCtx();
        const request = new Request('https://api.pdbfe.dev/api/as_set/999');

        const res = await handleAsSet(request, db, ctx, 999, false);
        assert.equal(res.status, 404);
    });

    it('includes authenticated X-Auth-Status', async () => {
        const asSetPayload = '{"data":[{"asn":1,"irr_as_set":"","name":"Test"}],"meta":{}}';
        const db = mockD1({ asSetResult: { payload: asSetPayload } });
        const { ctx } = mockCtx();
        const request = new Request('https://api.pdbfe.dev/api/as_set/1');

        const res = await handleAsSet(request, db, ctx, 1, true);
        assert.equal(res.headers.get('X-Auth-Status'), 'authenticated');
    });
});

// ── handleNotImplemented ─────────────────────────────────────────────────────

describe('handleNotImplemented', () => {
    it('returns 501 for write methods', () => {
        const res = handleNotImplemented('POST', '/api/net');
        assert.equal(res.status, 501);
    });

    it('includes method and path in error message', async () => {
        const res = handleNotImplemented('DELETE', '/api/net/1');
        const body = await res.json();
        assert.ok(body.error.includes('DELETE'));
        assert.ok(body.error.includes('/api/net/1'));
    });

    it('mentions read-only mirror in error message', async () => {
        const res = handleNotImplemented('PUT', '/api/net/1');
        const body = await res.json();
        assert.ok(body.error.includes('read-only'));
    });
});
