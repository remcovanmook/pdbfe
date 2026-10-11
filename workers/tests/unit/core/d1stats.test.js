/**
 * @fileoverview core/d1stats.js: per-request D1 accounting (round trips,
 * D1-reported SQL time, rows read) behind Server-Timing `d1`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withD1Stats } from '../../../core/d1stats.js';
import { serverTiming } from '../../../api/http.js';

/** Fake D1: every statement returns `rows` with a fixed meta. */
function fakeD1(/** @type {any[]} */ rows, meta = { duration: 2.5, rows_read: 10 }) {
    const stmt = (/** @type {string} */ sql) => ({
        sql,
        bind() { return this; },
        all: async () => ({ results: rows, meta }),
        run: async () => ({ results: [], meta }),
        first: async () => { throw new Error('wrapper must not call first() (it returns no meta)'); },
    });
    return {
        prepare: stmt,
        batch: async (/** @type {any[]} */ stmts) => stmts.map((s) => {
            assert.equal(typeof s.sql, 'string', 'batch receives the real statements, unwrapped');
            return { results: rows, meta };
        }),
    };
}

describe('withD1Stats', () => {
    it('counts one round trip per call and sums D1 SQL time and rows read', async () => {
        const { db, stats } = withD1Stats(fakeD1([{ id: 1 }]));
        await db.prepare('SELECT 1').bind(1).all();
        await db.batch([db.prepare('a').bind(), db.prepare('b')]);
        assert.deepEqual(stats, { calls: 2, sqlMs: 7.5, rowsRead: 30 }); // 1 + batch of 2 statements
    });

    it('first() goes through all(): same row, and meta is recorded', async () => {
        const { db, stats } = withD1Stats(fakeD1([{ id: 7, name: 'x' }, { id: 8 }]));
        assert.deepEqual(await db.prepare('q').first(), { id: 7, name: 'x' });
        assert.equal(await db.prepare('q').first('name'), 'x');
        assert.equal(stats.calls, 2);
        assert.equal(stats.rowsRead, 20);
        const empty = withD1Stats(fakeD1([]));
        assert.equal(await empty.db.prepare('q').first(), null);
    });

    it('prefers timings.sql_duration_ms over duration', async () => {
        const { db, stats } = withD1Stats(fakeD1([], { duration: 9, timings: { sql_duration_ms: 1.25 }, rows_read: 0 }));
        await db.prepare('q').all();
        assert.equal(stats.sqlMs, 1.25);
    });
});

describe('serverTiming d1 segment', () => {
    it('appended when D1 was called', () => {
        assert.equal(serverTiming(0, { tier: 'MISS', dbMs: 40 }, { calls: 2, sqlMs: 4.34, rowsRead: 250 }),
            'cache;desc="MISS", auth;dur=0, db;dur=40, d1;dur=4.3;desc="2 rt, 250 rows"');
    });
    it('omitted on cache hits (no D1 call)', () => {
        assert.equal(serverTiming(0, { tier: 'L1' }, { calls: 0, sqlMs: 0, rowsRead: 0 }), 'cache;desc="L1", auth;dur=0');
    });
});

describe('riders (the sync poll sent with the request’s first D1 call)', () => {
    /** Fake D1 that records batches; rows depend on the SQL. */
    function recordingD1() {
        /** @type {string[][]} */
        const batches = [];
        /** @type {string[]} */
        const direct = [];
        const stmt = (/** @type {string} */ sql) => ({
            sql,
            bind() { return this; },
            all: async () => { direct.push(sql); return { results: [{ from: sql }], meta: { duration: 1, rows_read: 1 } }; },
        });
        return {
            batches, direct,
            db: {
                prepare: stmt,
                batch: async (/** @type {any[]} */ stmts) => {
                    batches.push(stmts.map((s) => s.sql));
                    return stmts.map((s) => ({ results: [{ from: s.sql }], meta: { duration: s.sql === 'POLL' ? 50 : 1, rows_read: s.sql === 'POLL' ? 99 : 1 } }));
                },
            },
        };
    }

    it('all()/first() send the rider in the same batch; its rows go to apply, not the caller', async () => {
        const f = recordingD1();
        const { db, stats } = withD1Stats(f.db);
        /** @type {any[]} */
        let polled = [];
        db.carry({ sql: 'POLL', apply: (rows) => { polled = rows; } });
        const row = await db.prepare('MAIN').first();
        assert.deepEqual(row, { from: 'MAIN' });
        assert.deepEqual(f.batches, [['MAIN', 'POLL']]);
        assert.deepEqual(f.direct, []);
        assert.deepEqual(polled, [{ from: 'POLL' }]);
        assert.deepEqual(stats, { calls: 1, sqlMs: 1, rowsRead: 1 }, 'rider meta not counted');
        await db.prepare('NEXT').all();
        assert.deepEqual(f.direct, ['NEXT'], 'only the first call carries it');
    });

    it('batch() appends the rider and strips its result', async () => {
        const f = recordingD1();
        const { db } = withD1Stats(f.db);
        let polled = 0;
        db.carry({ sql: 'POLL', apply: (rows) => { polled = rows.length; } });
        const results = await db.batch([db.prepare('A'), db.prepare('B')]);
        assert.deepEqual(f.batches, [['A', 'B', 'POLL']]);
        assert.deepEqual(results.map((/** @type {any} */ r) => r.results[0].from), ['A', 'B']);
        assert.equal(polled, 1);
    });

    it('takeRider() hands back an unsent rider, then nothing', () => {
        const { db } = withD1Stats(recordingD1().db);
        const r = { sql: 'POLL', apply: () => {} };
        db.carry(r);
        assert.equal(db.takeRider(), r);
        assert.equal(db.takeRider(), null);
    });

    it('a failing apply does not fail the request', async () => {
        const { db } = withD1Stats(recordingD1().db);
        db.carry({ sql: 'POLL', apply: () => { throw new Error('boom'); } });
        assert.deepEqual(await db.prepare('MAIN').first(), { from: 'MAIN' });
    });
});
