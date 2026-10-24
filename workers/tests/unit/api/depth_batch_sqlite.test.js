/**
 * @fileoverview depth>0 on /api runs the main query and every expansion in
 * ONE D1 batch (api/depth.js selectWithDepth): no other D1 call per request.
 * Also covers ?fields=, where the main query lacks the id/FK columns the
 * expansion statements select through (they use a full-column source).
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');

const TS = '2026-01-01T00:00:00Z';
/** @type {any} */ let env;
const calls = { batch: 0, batchStmts: 0, direct: 0 };

before(() => {
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`INSERT INTO "peeringdb_campus" (id, org_id, name, social_media, status, created, updated) VALUES (5, 1, 'Campus', '[]', 'ok', '${TS}', '${TS}')`);
    const fac = sqlite.prepare(`INSERT INTO "peeringdb_facility" (id, org_id, campus_id, name, social_media, available_voltage_services, status, created, updated) VALUES (?, 1, 5, ?, '[]', '[]', 'ok', '${TS}', '${TS}')`);
    fac.run(10, 'Fac 10'); fac.run(11, 'Fac 11');
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    net.run(100, 'Net 100', 64100); net.run(101, 'Net 101', 64101);
    const nf = sqlite.prepare(`INSERT INTO "peeringdb_network_facility" (id, net_id, fac_id, local_asn, status, created, updated) VALUES (?, ?, ?, 64100, 'ok', '${TS}', '${TS}')`);
    nf.run(700, 100, 10); nf.run(701, 100, 11); nf.run(702, 101, 10);

    // Count D1 calls: batch() vs any direct .all()/.first() (would be extra round trips).
    const counted = {
        ...db,
        withSession() { return this; },
        batch: async (/** @type {any[]} */ stmts) => { calls.batch++; calls.batchStmts += stmts.length; return db.batch(stmts); },
        prepare: (/** @type {string} */ sql) => {
            const wrap = (/** @type {any} */ st) => ({
                ...st,
                bind: (/** @type {any[]} */ ...a) => wrap(st.bind(...a)),
                // _sync_meta: the background freshness poll, not the request path
                all: async () => { if (!sql.includes('_sync_meta')) calls.direct++; return st.all(); },
                first: async () => { if (!sql.includes('_sync_meta')) calls.direct++; return st.first(); },
            });
            return wrap(db.prepare(sql));
        },
    };
    env = envFor(counted);
});
beforeEach(() => { purgeAllCaches(); calls.batch = 0; calls.batchStmts = 0; calls.direct = 0; });

/** @param {string} path */
async function get(path) {
    const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${path}`), env, mockCtx);
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()).data;
}

describe('one D1 round trip per depth>0 request', () => {
    for (const path of ['fac/10?depth=2', 'fac/10?depth=1', 'net?depth=1', 'net?depth=2', 'org/1?depth=2']) {
        it(`${path}: a single batch, no other D1 call`, async () => {
            await get(path);
            assert.equal(calls.batch, 1, 'one batch');
            assert.equal(calls.direct, 0, 'no direct queries');
            assert.ok(calls.batchStmts > 1, 'main query + expansions in the batch');
        });
    }

    it('fac/10?depth=2 nests parents at depth 1 from that one batch', async () => {
        const [fac] = await get('fac/10?depth=2');
        assert.deepEqual(fac.netfac_set.map((/** @type {any} */ c) => c.id), [700, 702]);
        assert.deepEqual(fac.campus.fac_set, [10, 11]);
        assert.equal(fac.campus.org.id, 1);
        assert.deepEqual(fac.org.net_set, [100, 101]);
    });
});

describe('?fields= with depth (main query lacks id/FK columns)', () => {
    it('list: sets and org still expand per row', async () => {
        const rows = await get('net?depth=1&fields=name');
        assert.deepEqual(rows.map((/** @type {any} */ r) => r.name), ['Net 100', 'Net 101']);
        assert.deepEqual(rows.map((/** @type {any} */ r) => r.netfac_set), [[700, 701], [702]]);
        assert.equal(calls.batch, 1);
    });

    it('detail: parents still expand', async () => {
        const [fac] = await get('fac/10?depth=1&fields=name');
        assert.equal(fac.name, 'Fac 10');
        assert.deepEqual(fac.netfac_set, [700, 702]);
    });
});

// limit above the rows left = last page, so no background next-page prefetch adds calls
describe('deep OFFSET pages: rows first, then one batch of expansions by id', async () => {
    const { DEEP_SKIP } = await import('../../../api/handlers/list.js');
    /** @type {any} */ let deepEnv;
    before(() => {
        const { sqlite, db } = createSqliteD1();
        sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
        const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
        sqlite.exec('BEGIN');
        for (let id = 1; id <= DEEP_SKIP + 2; id++) net.run(id, `Net ${id}`, 64000 + id);
        sqlite.exec('COMMIT');
        sqlite.exec(`INSERT INTO "peeringdb_network_facility" (id, net_id, fac_id, local_asn, status, created, updated) VALUES (900, ${DEEP_SKIP + 1}, 10, 1, 'ok', '${TS}', '${TS}')`);
        deepEnv = envFor({
            ...db,
            withSession() { return this; },
            batch: async (/** @type {any[]} */ stmts) => { calls.batch++; calls.batchStmts += stmts.length; return db.batch(stmts); },
            prepare: (/** @type {string} */ sql) => {
                const wrap = (/** @type {any} */ st) => ({
                    ...st,
                    bind: (/** @type {any[]} */ ...a) => wrap(st.bind(...a)),
                    all: async () => { if (!sql.includes('_sync_meta')) calls.direct++; return st.all(); },
                    first: async () => { if (!sql.includes('_sync_meta')) calls.direct++; return st.first(); },
                });
                return wrap(db.prepare(sql));
            },
        });
    });

    it(`skip >= ${DEEP_SKIP}: one main query + one expansion batch, sets correct`, async () => {
        const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/net?depth=1&limit=5&skip=${DEEP_SKIP}`), deepEnv, mockCtx);
        const rows = (await res.json()).data;
        assert.deepEqual(rows.map((/** @type {any} */ r) => r.id), [DEEP_SKIP + 1, DEEP_SKIP + 2]);
        assert.deepEqual(rows.map((/** @type {any} */ r) => r.netfac_set), [[900], []]);
        assert.equal(rows[0].org.id, 1);
        assert.equal(calls.direct, 1, 'the page query');
        assert.equal(calls.batch, 1, 'the expansions');
    });

    it(`skip < ${DEEP_SKIP}: still a single batch`, async () => {
        const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/net?depth=1&limit=5&skip=${DEEP_SKIP - 1}`), deepEnv, mockCtx);
        assert.equal((await res.json()).data.length, 3);
        assert.equal(calls.direct, 0);
        assert.equal(calls.batch, 1);
    });
});
