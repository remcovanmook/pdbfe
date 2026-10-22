/**
 * @fileoverview The per-object If-Modified-Since reader (api/row_changes.js):
 * loading, readiness around version changes, the at-or-after rule, the
 * whole-entity marker, depth, the IMS window, L1 purges, and retention.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRowChanges, IMS_WINDOW_S } from '../../../api/row_changes.js';

const NOW = 1_800_000_000;

/**
 * A reader over a fake D1 whose _row_changes rows are `rows`.
 * @param {Record<string, any>[]} rows
 */
function setup(rows) {
    /** @type {string[]} */ const purged = [];
    /** @type {number[]} */ const froms = [];
    let fail = false;
    const db = /** @type {any} */ ({
        prepare: () => ({
            bind: (/** @type {number} */ from) => ({
                all: async () => {
                    froms.push(from);
                    if (fail) throw new Error('D1 down');
                    return { results: rows.filter(r => r.d2_at >= from) };
                },
            }),
        }),
    });
    const rc = createRowChanges({ purge: (tag) => purged.push(tag) });
    /** @param {number} ms */
    const fetchNow = async (ms) => {
        const f = rc.claimFetch(ms);
        if (f) await rc.runFetch(db, f);
        return f;
    };
    return { rc, purged, froms, fetchNow, setFail: (/** @type {boolean} */ v) => { fail = v; } };
}

const mark = (/** @type {string} */ entity, /** @type {number} */ id, /** @type {number} */ d0, /** @type {number} */ d1, /** @type {number} */ d2) =>
    ({ entity, id, d0_at: d0, d1_at: d1, d2_at: d2 });

describe('loading and readiness', () => {
    it('is not ready before the initial load, and loads the whole table first', async () => {
        const { rc, froms, fetchNow } = setup([mark('net', 1, NOW - 100, NOW - 100, NOW - 100)]);
        assert.equal(rc.ready(), false);
        assert.equal(rc.claimFetch(NOW * 1000), null, 'nothing due before a poll');
        rc.onPollApplied([['net', NOW - 100]], true);
        assert.equal(rc.ready(), false);
        await fetchNow(NOW * 1000);
        assert.deepEqual(froms, [0]);
        assert.equal(rc.ready(), true);
    });

    it('a version change makes it unready until the marks from the lowest new version are applied', async () => {
        const { rc, froms, fetchNow } = setup([]);
        rc.onPollApplied([], true);
        await fetchNow(NOW * 1000);
        rc.onPollApplied([['net', NOW - 50], ['org', NOW - 80]], false);
        assert.equal(rc.ready(), false);
        await fetchNow(NOW * 1000 + 10_000);
        assert.deepEqual(froms, [0, NOW - 80]);
        assert.equal(rc.ready(), true);
    });

    it('a version change during a fetch is fetched again', async () => {
        const { rc, froms, fetchNow } = setup([]);
        rc.onPollApplied([], true);
        const f = /** @type {any} */ (rc.claimFetch(NOW * 1000));
        rc.onPollApplied([['net', NOW - 10]], false);
        await rc.runFetch(/** @type {any} */ ({ prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) }), f);
        assert.equal(rc.ready(), false, 'the fetch started before the change');
        await fetchNow(NOW * 1000 + 10_000);
        assert.deepEqual(froms, [0]);
        assert.equal(rc.ready(), true);
    });

    it('a failed fetch stays due, retried no sooner than 5 s later', async () => {
        const { rc, setFail, fetchNow } = setup([]);
        rc.onPollApplied([], true);
        setFail(true);
        assert.ok(await fetchNow(NOW * 1000));
        assert.equal(rc.ready(), false);
        assert.equal(rc.claimFetch(NOW * 1000 + 1000), null);
        setFail(false);
        assert.ok(await fetchNow(NOW * 1000 + 6000));
        assert.equal(rc.ready(), true);
    });

    it('one fetch at a time', () => {
        const { rc } = setup([]);
        rc.onPollApplied([], true);
        assert.ok(rc.claimFetch(NOW * 1000));
        assert.equal(rc.claimFetch(NOW * 1000 + 60_000), null);
    });
});

describe('isUnchangedSince', () => {
    /** @param {Record<string, any>[]} rows */
    async function loaded(rows) {
        const s = setup(rows);
        s.rc.onPollApplied([], true);
        await s.fetchNow(NOW * 1000);
        return s;
    }

    it('unmarked objects are unchanged; marked ones are changed when the mark is at or after the IMS', async () => {
        const { rc } = await loaded([mark('net', 1, NOW - 100, NOW - 100, NOW - 100)]);
        assert.equal(rc.isUnchangedSince('net', 2, 0, NOW - 1000, NOW), true);
        assert.equal(rc.isUnchangedSince('ix', 1, 0, NOW - 1000, NOW), true);
        assert.equal(rc.isUnchangedSince('net', 1, 0, NOW - 101, NOW), false);
        assert.equal(rc.isUnchangedSince('net', 1, 0, NOW - 100, NOW), false, 'a mark equal to the IMS is a change');
        assert.equal(rc.isUnchangedSince('net', 1, 0, NOW - 99, NOW), true);
    });

    it('goes by the requested depth', async () => {
        const { rc } = await loaded([mark('net', 1, 0, NOW - 100, NOW - 100), mark('net', 2, 0, 0, NOW - 100)]);
        assert.equal(rc.isUnchangedSince('net', 1, 0, NOW - 1000, NOW), true);
        assert.equal(rc.isUnchangedSince('net', 1, 1, NOW - 1000, NOW), false);
        assert.equal(rc.isUnchangedSince('net', 2, 1, NOW - 1000, NOW), true);
        assert.equal(rc.isUnchangedSince('net', 2, 2, NOW - 1000, NOW), false);
    });

    it('the whole-entity marker (id 0) changes every object of the entity', async () => {
        const { rc } = await loaded([mark('net', 0, NOW - 100, NOW - 100, NOW - 100)]);
        assert.equal(rc.isUnchangedSince('net', 7, 0, NOW - 1000, NOW), false);
        assert.equal(rc.isUnchangedSince('net', 7, 0, NOW - 50, NOW), true);
        assert.equal(rc.isUnchangedSince('org', 7, 0, NOW - 1000, NOW), true);
    });

    it('an IMS older than the window is never answered from marks', async () => {
        const { rc } = await loaded([]);
        assert.equal(rc.isUnchangedSince('net', 1, 0, NOW - IMS_WINDOW_S, NOW), true);
        assert.equal(rc.isUnchangedSince('net', 1, 0, NOW - IMS_WINDOW_S - 1, NOW), false);
    });

    it('a refetch never lowers a mark', async () => {
        const rows = [mark('net', 1, NOW - 100, NOW - 100, NOW - 100)];
        const { rc, fetchNow } = await loaded(rows);
        rows[0] = mark('net', 1, NOW - 500, NOW - 500, NOW - 500);
        rc.onPollApplied([['net', NOW - 500]], false);
        await fetchNow(NOW * 1000 + 10_000);
        assert.equal(rc.ready(), true);
        assert.equal(rc.isUnchangedSince('net', 1, 0, NOW - 100, NOW), false);
    });
});

describe('L1 purge and retention', () => {
    it('purges the L1 cache of every entity a fetch brings marks for', async () => {
        const { rc, purged, fetchNow } = setup([mark('net', 1, NOW, NOW, NOW), mark('org', 2, 0, NOW, NOW), mark('net', 3, NOW, NOW, NOW)]);
        rc.onPollApplied([], true);
        await fetchNow(NOW * 1000);
        assert.deepEqual(purged.sort(), ['net', 'org']);
    });

    it('drops entries past the 25h retention', async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
        const { rc, fetchNow } = setup([mark('net', 1, NOW - 26 * 3600, NOW - 26 * 3600, NOW - 26 * 3600)]);
        rc.onPollApplied([], true);
        await fetchNow(NOW * 1000);
        // An IMS before the mark, with a `now` that keeps it inside the window:
        // a kept mark would answer "changed".
        assert.equal(rc.isUnchangedSince('net', 1, 0, NOW - 27 * 3600, NOW - 27 * 3600 + 10), true, 'dropped on load');
    });
});
