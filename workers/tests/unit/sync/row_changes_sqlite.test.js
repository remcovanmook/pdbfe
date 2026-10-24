/**
 * @fileoverview The changed-row log (sync/row_changes.js): row_at for every
 * row the sync writes or deletes, set_at only on the direct parent when a
 * child joins or leaves its set, nothing else. Pruning. Whether responses
 * built from these rows are answered right is tests/unit/api/
 * change_check_sqlite.test.js.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1 } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';
import { syncEntity } from '../../../sync/index.js';
import { pruneRowChanges, ROW_CHANGES_RETENTION_S } from '../../../sync/row_changes.js';

const TS = '2026-01-01T00:00:00Z';
const realFetch = globalThis.fetch;

/** @type {any} */ let db;
/** @type {import('node:sqlite').DatabaseSync} */ let sqlite;

beforeEach(() => {
    ({ db, sqlite } = createSqliteD1());
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org 1', '[]', 'ok', '${TS}', '${TS}'), (2, 'Org 2', '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    net.run(100, 'Net 100', 64100); net.run(101, 'Net 101', 64101);
    sqlite.exec(`INSERT INTO "peeringdb_network_contact" (id, net_id, role, visible, name, phone, email, url, status, created, updated) VALUES (110, 100, 'NOC', 'Public', 'Poc', '', '', '', 'ok', '${TS}', '${TS}')`);
    for (const tag of ['net', 'poc']) {
        sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, 1700000000, 1, '', 0)`).run(tag);
    }
});
afterEach(() => { globalThis.fetch = realFetch; });

/**
 * Syncs one upstream version of a stored row.
 * @param {string} tag @param {number} id @param {(row: Record<string, any>) => void} change
 */
async function sync(tag, id, change) {
    const row = /** @type {Record<string, any>} */ (sqlite.prepare(`SELECT * FROM "${ENTITIES[tag].table}" WHERE id = ?`).get(id));
    change(row);
    globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ data: [row] })));
    const r = await syncEntity(db, tag, ENTITIES[tag], '', undefined);
    assert.ok(!r.error, r.error);
}

/** `entity/id row|set` for every nonzero column. */
const marks = () => /** @type {any[]} */ (sqlite.prepare('SELECT * FROM "_row_changes" ORDER BY entity, id').all())
    .flatMap(m => [m.row_at > 0 ? `${m.entity}/${m.id} row` : null, m.set_at > 0 ? `${m.entity}/${m.id} set` : null].filter(Boolean));

describe('what the sync records', () => {
    it('a plain update: the row only', async () => {
        await sync('net', 100, (r) => { r.name = 'Renamed'; });
        assert.deepEqual(marks(), ['net/100 row']);
    });

    it('a move: the row and both parents\' sets', async () => {
        await sync('net', 100, (r) => { r.org_id = 2; });
        assert.deepEqual(marks(), ['net/100 row', 'org/1 set', 'org/2 set']);
    });

    it('a delete: the row and its parent\'s set', async () => {
        await sync('net', 101, (r) => { r.status = 'deleted'; });
        assert.deepEqual(marks(), ['net/101 row', 'org/1 set']);
    });

    it('an insert: the row and its parent\'s set', async () => {
        sqlite.exec('DELETE FROM "peeringdb_network" WHERE id = 101');
        globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ data: [{
            id: 101, org_id: 2, name: 'Net 101', asn: 64101, social_media: [], info_types: [], status: 'ok', created: TS, updated: TS,
        }] })));
        await syncEntity(db, 'net', ENTITIES.net, '', undefined);
        assert.deepEqual(marks(), ['net/101 row', 'org/2 set']);
    });

    it('an anonymous-visibility change: the row and its parent\'s set', async () => {
        await sync('poc', 110, (r) => { r.visible = 'Users'; });
        assert.deepEqual(marks(), ['net/100 set', 'poc/110 row']);
    });

    it('a later change raises a mark; an earlier one never lowers it', async () => {
        await sync('net', 100, (r) => { r.name = 'A'; });
        const first = /** @type {any} */ (sqlite.prepare(`SELECT row_at FROM "_row_changes" WHERE entity = 'net' AND id = 100`).get()).row_at;
        sqlite.prepare(`UPDATE "_row_changes" SET row_at = row_at + 1000 WHERE entity = 'net' AND id = 100`).run();
        await sync('net', 100, (r) => { r.name = 'B'; });
        assert.equal(/** @type {any} */ (sqlite.prepare(`SELECT row_at FROM "_row_changes" WHERE entity = 'net' AND id = 100`).get()).row_at, first + 1000);
    });

    it('a failed sync fetch records nothing', async () => {
        globalThis.fetch = /** @type {any} */ (async () => new Response('boom', { status: 500 }));
        await syncEntity(db, 'net', ENTITIES.net, '', undefined);
        assert.deepEqual(marks(), []);
    });
});

describe('pruning', () => {
    it('drops entries whose row_at and set_at are both past the retention window', async () => {
        const now = 1_800_000_000;
        const old = now - ROW_CHANGES_RETENTION_S - 1;
        const recent = now - ROW_CHANGES_RETENTION_S + 1;
        sqlite.prepare(`INSERT INTO "_row_changes" (entity, id, row_at, set_at) VALUES ('net', 1, ?, 0), ('net', 2, ?, 0), ('net', 3, ?, ?)`)
            .run(old, recent, old, recent);
        await pruneRowChanges(db, now);
        assert.deepEqual(/** @type {any[]} */ (sqlite.prepare('SELECT id FROM "_row_changes" ORDER BY id').all()).map(r => r.id), [2, 3]);
    });
});
