/**
 * @fileoverview Last-Modified is the last_sync of the entity the sync worker
 * processes last (the run is complete as of it), read by primary key in the
 * same D1 batch as the query and kept with the L1 entry — so a cold
 * isolate's first response carries it, and a cache hit carries the value
 * of the snapshot it was built from.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');

const TS = '2026-01-01T00:00:00Z';
const RUN_1 = 1_800_000_000;
const RUN_2 = 1_800_000_900;
const httpDate = (/** @type {number} */ s) => new Date(s * 1000).toUTCString();

/** @type {any} */ let env;
/** @type {import('node:sqlite').DatabaseSync} */ let sqlite;
let ip = 0;
const ctx = /** @type {any} */ ({ waitUntil(/** @type {Promise<any>} */ p) { p.catch(() => {}); }, passThroughOnException() {} });

/** @param {string} path @param {Record<string, string>} [headers] */
async function get(path, headers = {}) {
    const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${path}`, {
        headers: { 'cf-connecting-ip': `10.1.0.${++ip}`, ...headers },
    }), env, ctx);
    return { status: res.status, lastModified: res.headers.get('Last-Modified'), etag: res.headers.get('ETag') };
}

const LAST = Object.keys(ENTITIES).at(-1);
/** @param {string} tag @param {number} lastSync */
const setSync = (tag, lastSync) => sqlite.prepare(`INSERT OR REPLACE INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, ?, 0, '', 0)`).run(tag, lastSync);
const setRun = (/** @type {number} */ lastSync) => setSync(/** @type {string} */ (LAST), lastSync);

before(() => {
    const d = createSqliteD1();
    sqlite = d.sqlite;
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    for (const id of [100, 101, 102, 103]) net.run(id, `Net ${id}`, 64000 + id);
    env = envFor(d.db);
});

describe('Last-Modified from the sync run', () => {
    it('none before the last entity has a _sync_meta row', async () => {
        setSync('net', RUN_2);
        assert.equal((await get('net/103')).lastModified, null);
    });

    it("a cold isolate's first miss carries it (read in the same batch as the query), whatever other entities say", async () => {
        setRun(RUN_1);
        const r = await get('net/100');
        assert.equal(r.status, 200);
        assert.equal(r.lastModified, httpDate(RUN_1));
    });

    it('lists and depth>0 details carry it too', async () => {
        assert.equal((await get('net?asn=64101')).lastModified, httpDate(RUN_1));
        assert.equal((await get('net/101?depth=2')).lastModified, httpDate(RUN_1));
    });

    it('an L1 hit carries the value of the snapshot it was built from, not the latest', async () => {
        setRun(RUN_2);
        assert.equal((await get('net/100')).lastModified, httpDate(RUN_1), 'cached under run 1');
        assert.equal((await get('net/102')).lastModified, httpDate(RUN_2), 'new miss under run 2');
    });

    it('an ETag 304 carries it', async () => {
        const { etag } = await get('net/102');
        const r = await get('net/102', { 'If-None-Match': /** @type {string} */ (etag) });
        assert.equal(r.status, 304);
        assert.equal(r.lastModified, httpDate(RUN_2));
    });
});
