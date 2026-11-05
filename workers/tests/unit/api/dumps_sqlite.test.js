/**
 * @fileoverview Full-table R2 dumps (api/dumps.js) end to end, on real
 * SQLite and an in-memory R2 that enforces R2's multipart rules:
 *   - the async `dump` task writes the same bytes the API lists, in equal
 *     8 MiB parts, and keys it in _sync_meta only for the version it holds;
 *   - superseded dumps are deleted after DUMP_KEEP_MS, never the current one;
 *   - the API and REST serve a current dump for the default full-table list
 *     (no D1 page query, Content-Length from R2), and stream from D1 when the
 *     dump is stale or missing or the request is not the default list;
 *   - the sync carries dump_key through its _sync_meta rewrites and asks for
 *     a dump only after recording the new version.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';
import { createMemoryR2 } from '../../lib/mock_r2.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { default: restWorker } = await import('../../../rest/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');
const { purgeRestCache } = await import('../../../rest/cache.js');
const { refreshSyncState } = await import('../../../api/sync_state.js');
const { refreshSyncState: refreshRestSyncState } = await import('../../../rest/cache.js');
const { ENTITIES } = await import('../../../api/entities.js');
const { queryJsonList } = await import('../../../api/json_list.js');
const { handleDump, deleteOldDumps } = await import('../../../async/dump.js');
const { DUMP_KEEP_MS, dumpKey, isDumpRequest } = await import('../../../api/dumps.js');
const { syncEntity } = await import('../../../sync/index.js');

const TS = '2026-01-01T00:00:00Z';
const NOTES = 'x'.repeat(600);
const NETS = 12_000; // ~10 MB of list JSON: two 8 MiB parts
const V1 = 1_793_900_000;

/**
 * @param {import('node:sqlite').DatabaseSync} sqlite
 * @param {number} n
 */
function seed(sqlite, n) {
    const org = sqlite.prepare(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (?, ?, '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, notes, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec('BEGIN');
    for (let i = 1; i <= n; i++) {
        org.run(i, `Org ${i}`);
        net.run(i, i, `Net ${i} — café`, 64_000 + i, NOTES);
    }
    sqlite.exec('COMMIT');
    sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES ('net', ?, ?, '', ?)`).run(V1, n, V1);
}

/** The default full-table list, as the API builds it. */
const DEFAULT_OPTS = { depth: 0, limit: 0, skip: 0, since: 0, sort: '', fields: [], pdbfe: false, authenticated: false };

/** @param {import('node:sqlite').DatabaseSync} sqlite */
const metaOf = (sqlite) => /** @type {any} */ (sqlite.prepare(`SELECT last_modified_at, dump_key FROM "_sync_meta" WHERE entity = 'net'`).get());

describe('async dump task', () => {
    /** @type {any} */ let db;
    /** @type {import('node:sqlite').DatabaseSync} */ let sqlite;
    /** @type {ReturnType<typeof createMemoryR2>} */ let r2;
    before(() => {
        ({ db, sqlite } = createSqliteD1());
        seed(sqlite, NETS);
    });
    beforeEach(() => { r2 = createMemoryR2(); sqlite.prepare(`UPDATE "_sync_meta" SET dump_key = '', last_modified_at = ?`).run(V1); });

    it('writes the bytes the API lists, in equal 8 MiB parts, and keys it', async () => {
        assert.equal(await handleDump(db, r2.bucket, 'net'), 'written');
        const key = dumpKey('net', V1);
        const stored = /** @type {any} */ (r2.objects.get(key));
        const listed = await queryJsonList(db, ENTITIES.net, [], DEFAULT_OPTS);
        assert.deepEqual(stored.bytes, listed);
        assert.equal(JSON.parse(new TextDecoder().decode(stored.bytes)).data.length, NETS);
        assert.equal(stored.contentType, 'application/json; charset=utf-8');
        const [{ partSizes }] = r2.uploads;
        assert.ok(partSizes.length >= 2, 'more than one part');
        assert.ok(partSizes.slice(0, -1).every((s) => s === 8 * 1024 * 1024));
        assert.equal(metaOf(sqlite).dump_key, key);
    });

    it('does nothing when the dump is current', async () => {
        await handleDump(db, r2.bucket, 'net');
        assert.equal(await handleDump(db, r2.bucket, 'net'), 'current');
        assert.equal(r2.uploads.length, 1);
    });

    it('does not key a dump of a version the table has moved past', async () => {
        let moved = false;
        const racing = {
            ...db,
            prepare(/** @type {string} */ sql) {
                // The table changes while the dump is being written.
                if (!moved && sql.includes('AS frag')) { moved = true; sqlite.prepare(`UPDATE "_sync_meta" SET last_modified_at = ?`).run(V1 + 900); }
                return db.prepare(sql);
            },
        };
        assert.equal(await handleDump(/** @type {any} */ (racing), r2.bucket, 'net'), 'superseded');
        assert.equal(metaOf(sqlite).dump_key, '');
    });

    it('skips tables without a dump (poc, small tables)', async () => {
        assert.equal(await handleDump(db, r2.bucket, 'poc'), 'skipped');
        assert.equal(await handleDump(db, r2.bucket, 'ixlan'), 'skipped');
        assert.equal(r2.uploads.length, 0);
    });
});

describe('deleteOldDumps', () => {
    it('deletes superseded dumps older than DUMP_KEEP_MS, never the current one', async () => {
        const t = 2_000_000_000_000;
        const r2 = createMemoryR2();
        const put = (/** @type {string} */ key, /** @type {number} */ age) => r2.objects.set(key, { bytes: new Uint8Array(1), uploaded: new Date(t - age), contentType: '' });
        put('dumps/net/1.json', DUMP_KEEP_MS + 1);
        put('dumps/net/2.json', DUMP_KEEP_MS - 1);
        put('dumps/net/3.json', DUMP_KEEP_MS * 5); // current, however old
        put('dumps/org/1.json', DUMP_KEEP_MS * 5); // another table
        assert.deepEqual(await deleteOldDumps(r2.bucket, 'net', 'dumps/net/3.json', t), ['dumps/net/1.json']);
        assert.deepEqual([...r2.objects.keys()].sort(), ['dumps/net/2.json', 'dumps/net/3.json', 'dumps/org/1.json']);
    });
});

describe('isDumpRequest', () => {
    const opts = (/** @type {any} */ o = {}) => ({ ...DEFAULT_OPTS, ...o });
    it('only the default full-table list of a dumped table', () => {
        assert.equal(isDumpRequest('net', [], opts()), true);
        assert.equal(isDumpRequest('net', [], opts({ limit: -1 })), true);
        assert.equal(isDumpRequest('poc', [], opts()), false);
        assert.equal(isDumpRequest('ixlan', [], opts()), false);
        assert.equal(isDumpRequest('net', [/** @type {any} */ ({ field: 'asn', op: 'eq', value: '1' })], opts()), false);
        for (const o of [{ depth: 1 }, { since: 5 }, { limit: 10 }, { skip: 5 }, { sort: 'name' }, { fields: ['id'] }, { pdbfe: true }]) {
            assert.equal(isDumpRequest('net', [], opts(o)), false, JSON.stringify(o));
        }
    });
});

describe('API and REST serve the current dump', () => {
    /** @type {any} */ let env;
    /** @type {any} */ let db;
    /** @type {import('node:sqlite').DatabaseSync} */ let sqlite;
    /** @type {{payloadQueries: number}} */ let stats;
    /** @type {ReturnType<typeof createMemoryR2>} */ let r2;
    before(async () => {
        purgeAllCaches();
        purgeRestCache();
        ({ db, sqlite, stats } = createSqliteD1());
        seed(sqlite, 6000);
        r2 = createMemoryR2();
        env = { ...envFor(db), DUMPS: r2.bucket };
        assert.equal(await handleDump(db, r2.bucket, 'net'), 'written');
        await refreshSyncState(db);
        await refreshRestSyncState(db);
    });

    it('api: the dump object, with its size as Content-Length, and no D1 page query', async () => {
        const before = stats.payloadQueries;
        const res = await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/net'), env, mockCtx);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('X-Cache'), 'R2');
        const body = new Uint8Array(await res.arrayBuffer());
        assert.deepEqual(body, /** @type {any} */ (r2.objects.get(dumpKey('net', V1))).bytes);
        assert.equal(res.headers.get('Content-Length'), String(body.byteLength));
        assert.equal(res.headers.get('Last-Modified'), new Date(V1 * 1000).toUTCString());
        assert.match(res.headers.get('Cache-Control') ?? '', /^public, max-age=\d+, stale-while-revalidate=\d+$/);
        assert.equal(stats.payloadQueries - before, 0);
    });

    it('rest: the same dump', async () => {
        const res = await restWorker.fetch(new Request('https://rest.pdbfe.dev/v1/net'), env, mockCtx);
        assert.equal(res.headers.get('X-Cache'), 'R2');
        assert.equal(JSON.parse(await res.text()).data.length, 6000);
    });

    it('limit=0 is the default list too', async () => {
        const res = await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/net?limit=0'), env, mockCtx);
        assert.equal(res.headers.get('X-Cache'), 'R2');
        await res.arrayBuffer();
    });

    it('any other request shape comes from D1', async () => {
        for (const path of ['/api/net?fields=id', '/api/net?sort=name', '/api/net?limit=10', '/api/net?skip=1', '/api/net?asn=64001', '/api/net?depth=1&limit=5']) {
            const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev${path}`), env, mockCtx);
            assert.equal(res.status, 200, path);
            assert.notEqual(res.headers.get('X-Cache'), 'R2', path);
            await res.arrayBuffer();
        }
    });

    it('a stale dump is not served: the table changed, the stream takes over', async () => {
        sqlite.prepare(`UPDATE "_sync_meta" SET last_modified_at = ?`).run(V1 + 900);
        await refreshSyncState(db);
        const res = await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/net'), env, mockCtx);
        assert.notEqual(res.headers.get('X-Cache'), 'R2');
        assert.equal(res.headers.get('Content-Length'), null, 'streamed');
        assert.equal(JSON.parse(await res.text()).data.length, 6000);
        sqlite.prepare(`UPDATE "_sync_meta" SET last_modified_at = ?`).run(V1);
        await refreshSyncState(db);
    });

    it('a missing object falls back to the stream', async () => {
        const saved = r2.objects.get(dumpKey('net', V1));
        r2.objects.delete(dumpKey('net', V1));
        const res = await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/net'), env, mockCtx);
        assert.notEqual(res.headers.get('X-Cache'), 'R2');
        assert.equal(JSON.parse(await res.text()).data.length, 6000);
        r2.objects.set(dumpKey('net', V1), /** @type {any} */ (saved));
    });

    it('without a DUMPS binding everything streams from D1', async () => {
        const res = await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/net'), envFor(db), mockCtx);
        assert.notEqual(res.headers.get('X-Cache'), 'R2');
        await res.arrayBuffer();
    });
});

describe('sync keeps dump_key and asks for a dump after recording the version', () => {
    const realFetch = globalThis.fetch;
    /** @type {any} */ let db;
    /** @type {import('node:sqlite').DatabaseSync} */ let sqlite;
    /** @type {{ msg: any, lastModifiedAt: number }[]} */ let sent;
    /** @type {any} */ let queue;
    beforeEach(() => {
        ({ db, sqlite } = createSqliteD1());
        seed(sqlite, 5);
        sqlite.prepare(`UPDATE "_sync_meta" SET dump_key = ?`).run(dumpKey('net', V1));
        sent = [];
        queue = {
            async send(/** @type {any} */ msg) { sent.push({ msg, lastModifiedAt: metaOf(sqlite).last_modified_at }); },
            async sendBatch() {},
        };
    });
    afterEach(() => { globalThis.fetch = realFetch; });

    /** @param {any[]} rows */
    const upstream = (rows) => { globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ data: rows }))); };
    const row = (/** @type {number} */ id, /** @type {string} */ updated) => ({
        id, org_id: id, name: `Net ${id} — café`, asn: 64_000 + id, notes: NOTES, social_media: [], info_types: [],
        status: 'ok', created: TS, updated,
    });

    it('a run without changes keeps dump_key and sends nothing', async () => {
        upstream([row(1, TS)]);
        const r = await syncEntity(db, 'net', ENTITIES.net, '', queue);
        assert.ok(!r.error, r.error);
        assert.equal(metaOf(sqlite).dump_key, dumpKey('net', V1));
        assert.equal(sent.length, 0);
    });

    it('a run without changes asks for the dump when it is missing or behind', async () => {
        sqlite.prepare(`UPDATE "_sync_meta" SET dump_key = ''`).run();
        upstream([row(1, TS)]);
        await syncEntity(db, 'net', ENTITIES.net, '', queue);
        assert.deepEqual(sent.map((s) => s.msg), [{ action: 'dump', tag: 'net', id: 0 }]);
    });

    it('tables without a dump are never asked for one', async () => {
        sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES ('ixlan', ?, 0, '', ?)`).run(V1, V1);
        upstream([]);
        await syncEntity(db, 'ixlan', ENTITIES.ixlan, '', queue);
        assert.equal(sent.length, 0);
    });

    it('a run with changes keeps the old dump_key (now stale) and sends dump after last_modified_at moved', async () => {
        upstream([row(1, '2026-10-07T13:00:00Z')]);
        const r = await syncEntity(db, 'net', ENTITIES.net, '', queue);
        assert.ok(!r.error, r.error);
        const meta = metaOf(sqlite);
        assert.ok(meta.last_modified_at > V1, 'version advanced');
        assert.equal(meta.dump_key, dumpKey('net', V1), 'carried over, no longer current');
        assert.deepEqual(sent.map((s) => s.msg), [{ action: 'dump', tag: 'net', id: 0 }]);
        assert.equal(sent[0].lastModifiedAt, meta.last_modified_at, 'sent after the new version was recorded');
    });
});
