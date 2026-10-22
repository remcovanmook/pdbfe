/**
 * @fileoverview Per-object If-Modified-Since end to end: the sync worker
 * writes _row_changes (sync/row_changes.js), the API worker's poll picks it
 * up (api/row_changes.js), and detail requests are answered per object.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createSqliteD1, registerAssetLoader, envFor } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';
import { syncEntity } from '../../../sync/index.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');

const TS = '2026-01-01T00:00:00Z';
const T0 = Date.parse('2026-10-22T12:00:00Z');
const V0 = T0 / 1000 - 3600;
const realFetch = globalThis.fetch;

/** @type {any} */ let env;
/** @type {import('node:sqlite').DatabaseSync} */ let sqlite;
/** @type {Promise<any>[]} */ let pending = [];
let ip = 0;
const ctx = /** @type {any} */ ({ waitUntil: (/** @type {Promise<any>} */ p) => { pending.push(p); }, passThroughOnException() {} });

/**
 * Requests `path`, then lets its background work (poll, mark fetch) finish.
 * @param {string} path
 * @param {number} [imsS] - If-Modified-Since, epoch seconds.
 */
async function get(path, imsS) {
    /** @type {Record<string, string>} */
    const headers = { 'cf-connecting-ip': `10.0.${(++ip >> 8) & 255}.${ip & 255}` };
    if (imsS !== undefined) headers['If-Modified-Since'] = new Date(imsS * 1000).toUTCString();
    const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${path}`, { headers }), env, ctx);
    const body = res.status === 200 ? await res.json() : null;
    while (pending.length) await Promise.all(pending.splice(0));
    return { status: res.status, body, lastModified: res.headers.get('Last-Modified') };
}

/** Advances the clock past the 15 s poll interval and lets a request run the poll and the mark fetch. */
async function poll() {
    mock.timers.tick(16_000);
    await get('net/100');          // poll rides along; marks fetched after it
    mock.timers.tick(6_000);
    await get('net/100');          // a fetch the first one could not claim yet
}

/**
 * Syncs one upstream row change through the sync worker.
 * @param {string} tag @param {number} id @param {(row: Record<string, any>) => void} change
 */
async function sync(tag, id, change) {
    const row = /** @type {Record<string, any>} */ (sqlite.prepare(`SELECT * FROM "${ENTITIES[tag].table}" WHERE id = ?`).get(id));
    change(row);
    globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ data: [row] })));
    const r = await syncEntity(env.PDB, tag, ENTITIES[tag], '', undefined);
    globalThis.fetch = realFetch;
    assert.ok(!r.error, r.error);
}

const version = (/** @type {string} */ tag) => /** @type {any} */ (sqlite.prepare('SELECT last_modified_at AS v FROM "_sync_meta" WHERE entity = ?').get(tag)).v;

before(async () => {
    mock.timers.enable({ apis: ['Date'], now: T0 });
    const d = createSqliteD1();
    sqlite = d.sqlite;
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org 1', '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    net.run(100, 'Net 100', 64100); net.run(101, 'Net 101', 64101);
    for (const tag of Object.keys(ENTITIES)) {
        sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, 1700000000, 1, '', ?)`).run(tag, V0);
    }
    env = envFor(d.db);
    await get('net/100');          // initial poll and full load
    mock.timers.tick(6_000);
    await get('net/100');
});
after(() => { mock.timers.reset(); globalThis.fetch = realFetch; });

describe('per-object If-Modified-Since', () => {
    it('before any change: 304 for an IMS after the entity version', async () => {
        assert.equal((await get('net/100', V0 + 60)).status, 304);
    });

    it('a sync that changes net 101 leaves net 100 at 304, where the per-entity check says changed', async () => {
        mock.timers.tick(60_000);
        await sync('net', 101, (r) => { r.name = 'Net 101 renamed'; });
        await poll();
        assert.ok(version('net') > V0 + 60, 'the net version moved past the IMS');
        assert.equal((await get('net/100', V0 + 60)).status, 304);
        assert.equal((await get('net/101', V0 + 60)).status, 200);
    });

    it('a changed object stays 200 for an IMS equal to its mark (replica lag), 304 after it', async () => {
        const v = version('net');
        assert.equal((await get('net/101', v)).status, 200);
        assert.equal((await get('net/101', v + 1)).status, 304);
    });

    it('an org rename changes net/100 at depth 1 (embedded org) but not at depth 0', async () => {
        const ims = version('net') + 1;
        // Warm L1 with the old org name.
        assert.equal((await get('net/100?depth=1')).body.data[0].org.name, 'Org 1');
        mock.timers.tick(60_000);
        await sync('org', 1, (r) => { r.name = 'Org 1 renamed'; });
        await poll();
        assert.ok(version('net') < ims, 'net itself did not change');
        assert.equal((await get('net/100', ims)).status, 304);
        assert.equal((await get('net/100?depth=1', ims)).status, 200);
        assert.equal((await get('net/100?depth=1')).body.data[0].org.name, 'Org 1 renamed', 'L1 purged for the marked entity');
    });

    it('an IMS older than 24h falls back to the per-entity check', async () => {
        assert.equal((await get('net/100', V0 - 25 * 3600)).status, 200);
    });

    it('lists keep the per-entity check', async () => {
        assert.equal((await get('net?asn=64100', version('net') - 1)).status, 200);
        assert.equal((await get('net?asn=64100', version('net'))).status, 304);
    });

    it('a 304 carries the entity Last-Modified', async () => {
        const r = await get('net/100', version('net') + 5);
        assert.equal(r.status, 304);
        assert.equal(r.lastModified, new Date(version('net') * 1000).toUTCString());
    });
});
