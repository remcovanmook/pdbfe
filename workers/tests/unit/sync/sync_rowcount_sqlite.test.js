/**
 * @fileoverview The sync worker keeps _sync_meta.row_count exact without a
 * full-table COUNT(*) per run.
 *
 * D1 bills COUNT(*) as every row scanned (netixlan: 66k rows read to return
 * one number), and the sync re-counted every changed table on every run —
 * ~15-20M rows read per day for the busy tables. row_count is now updated
 * incrementally: + incoming ids that did not exist yet, - rows actually
 * deleted. A full count only runs when no previous count exists.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1 } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';
import { syncEntity } from '../../../sync/index.js';

const TS = '2026-01-01T00:00:00Z';
const NET = ENTITIES.net;
const realFetch = globalThis.fetch;

/** @type {any} */
let db;
/** @type {import('node:sqlite').DatabaseSync} */
let sqlite;
/** @type {{sql: string[]}} */
let stats;

/** @param {number|null} rowCount - seeded _sync_meta.row_count (null = no row_count) */
function setup(rowCount) {
    const d = createSqliteD1();
    ({ db, sqlite, stats } = d);
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    for (let i = 1; i <= 5; i++) net.run(i, `Net ${i}`, 64500 + i);
    sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES ('net', 1700000000, ?, '', 0)`).run(rowCount ?? 0);
}

/** Upstream ?since= response: update 3, add 6 and 7, delete 2 (exists) and 99 (never mirrored). */
function mockUpstream() {
    const row = (/** @type {number} */ id, /** @type {string} */ status) => ({
        id, org_id: 1, name: `Net ${id}`, asn: 64500 + id, social_media: [], info_types: [],
        status, created: TS, updated: '2026-10-07T13:00:00Z',
    });
    globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({
        data: [row(3, 'ok'), row(6, 'ok'), row(7, 'ok'), row(2, 'deleted'), row(99, 'deleted')],
    })));
}

const actualCount = () => /** @type {any} */ (sqlite.prepare('SELECT COUNT(*) AS n FROM "peeringdb_network"').get()).n;
const storedCount = () => /** @type {any} */ (sqlite.prepare(`SELECT row_count FROM "_sync_meta" WHERE entity = 'net'`).get()).row_count;
const fullCounts = () => stats.sql.filter((q) => /COUNT\(\*\)[^]*FROM "peeringdb_network"\s*$/i.test(q.trim()));

afterEach(() => { globalThis.fetch = realFetch; });

describe('sync row_count without full-table COUNT(*)', () => {
    beforeEach(() => { setup(5); mockUpstream(); });

    it('row_count = previous + new ids - rows actually deleted, and matches the table', async () => {
        const result = await syncEntity(db, 'net', NET, '', null);
        assert.ok(!result.error, String(result.error));
        assert.equal(actualCount(), 6); // 5 + {6,7} - {2}
        assert.equal(storedCount(), 6);
    });

    it('does not scan the whole table to count it', async () => {
        await syncEntity(db, 'net', NET, '', null);
        assert.deepEqual(fullCounts(), [], 'no unfiltered COUNT(*) FROM peeringdb_network');
    });
});

describe('fallback when no previous row_count exists', () => {
    beforeEach(() => { setup(0); mockUpstream(); });

    it('counts the table once to establish row_count', async () => {
        await syncEntity(db, 'net', NET, '', null);
        assert.equal(storedCount(), 6);
        assert.equal(fullCounts().length, 1);
    });
});

describe('D1 holds only status=ok rows', () => {
    beforeEach(() => {
        setup(5);
        const row = (/** @type {number} */ id, /** @type {string} */ status) => ({
            id, org_id: 1, name: `Net ${id}`, asn: 64500 + id, social_media: [], info_types: [],
            status, created: TS, updated: '2026-10-07T13:00:00Z',
        });
        // 4 exists and turns pending; 8 is new but pending; 9 is new and ok
        globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({
            data: [row(4, 'pending'), row(8, 'pending'), row(9, 'ok')],
        })));
    });

    it('a non-ok status is a removal: existing rows deleted, new ones never inserted', async () => {
        const result = await syncEntity(db, 'net', NET, '', null);
        assert.ok(!result.error, String(result.error));
        const ids = sqlite.prepare('SELECT id FROM "peeringdb_network" ORDER BY id').all().map((/** @type {any} */ r) => r.id);
        assert.deepEqual(ids, [1, 2, 3, 5, 9]);
        assert.deepEqual(result.deletedIds.sort((a, b) => a - b), [4, 8], "removed ids reported like deletions");
        assert.equal(storedCount(), 5); // 5 + {9} - {4}
        assert.equal(actualCount(), 5);
    });
});
