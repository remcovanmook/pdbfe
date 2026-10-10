/**
 * @fileoverview The sync freshness poll rides along a request's first D1
 * call (same batch, no extra round trip); a request that makes no D1 call
 * runs it separately after the response.
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');

const TS = '2026-01-01T00:00:00Z';
/** @type {any} */ let env;
/** @type {string[][]} */ const batches = [];
/** @type {string[]} */ const direct = [];

before(() => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-10T12:00:00Z') });
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    net.run(100, 'Net 100', 64100); net.run(101, 'Net 101', 64101);
    env = envFor({
        ...db,
        withSession() { return this; },
        batch: async (/** @type {any[]} */ stmts) => { batches.push(stmts.map((s) => s.__sql)); return db.batch(stmts); },
        prepare: (/** @type {string} */ sql) => {
            const wrap = (/** @type {any} */ st) => ({
                ...st, __sql: sql,
                bind: (/** @type {any[]} */ ...a) => wrap(st.bind(...a)),
                all: async () => { direct.push(sql); return st.all(); },
                first: async () => { direct.push(sql); return st.first(); },
            });
            return wrap(db.prepare(sql));
        },
    });
});
after(() => mock.timers.reset());

const reset = () => { batches.length = 0; direct.length = 0; };
const get = async (/** @type {string} */ path) => {
    const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${path}`), env, mockCtx);
    assert.equal(res.status, 200);
    return res;
};
const isPoll = (/** @type {string} */ sql) => sql.includes('_sync_meta');

describe('sync freshness poll', () => {
    it('due + the request queries D1: one batch carries both, no separate poll query', async () => {
        reset();
        await get('net/100');
        assert.equal(batches.length, 1);
        assert.equal(batches[0].length, 2);
        assert.ok(batches[0].some(isPoll), 'poll in the batch');
        assert.equal(direct.filter(isPoll).length, 0);
    });

    it('not due (within 15 s): no poll at all', async () => {
        reset();
        mock.timers.tick(5_000);
        await get('net/101');
        assert.equal([...batches.flat(), ...direct].filter(isPoll).length, 0);
    });

    it('due + an L1 hit (no D1 call): the poll runs on its own after the response', async () => {
        reset();
        mock.timers.tick(16_000);
        await get('net/100'); // cached by the first test
        assert.equal(batches.length, 0, 'no batch: the request itself made no D1 call');
        assert.equal(direct.filter(isPoll).length, 1, 'poll sent separately');
    });
});
