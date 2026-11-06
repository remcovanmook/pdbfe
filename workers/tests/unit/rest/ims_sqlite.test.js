/**
 * @fileoverview Last-Modified and If-Modified-Since on the REST worker
 * (rest/index.js, rest/handlers/): depth=0 lists and details carry the entity
 * version as Last-Modified, already on a cold isolate's first response (the
 * _sync_meta poll rides along with its query), and answer a conditional
 * request from it; depth>0 and sub-resources carry none. The cold conditional
 * case is ims_cold_sqlite.test.js.
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';

registerAssetLoader();
const { default: restWorker } = await import('../../../rest/index.js');

const TS = '2026-01-01T00:00:00Z';
const NOW = Date.parse('2026-10-24T12:00:00Z') / 1000;
const V0 = NOW - 7200;
const V1 = NOW - 600;

/** @type {any} */ let env;
/** @type {import('node:sqlite').DatabaseSync} */ let sqlite;
/** @type {{ sql: string[] }} */ let stats;
let ip = 0;

/** @param {string} path @param {Record<string, string>} [headers] @param {any} [e] */
const get = (path, headers = {}, e = env) => restWorker.fetch(new Request(`https://rest.pdbfe.dev/v1/${path}`, {
    headers: { 'cf-connecting-ip': `10.5.0.${++ip}`, ...headers },
}), e, mockCtx);
const ims = (/** @type {number} */ s) => ({ 'If-Modified-Since': new Date(s * 1000).toUTCString() });
const http = (/** @type {number} */ s) => new Date(s * 1000).toUTCString();

before(() => {
    mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
    const d = createSqliteD1();
    ({ sqlite, stats } = d);
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org 1', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (100, 1, 'Net 100', 64100, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    for (const tag of Object.keys(ENTITIES)) {
        sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, ?, 1, '', ?)`).run(tag, V0, V0);
    }
    env = envFor(d.db);
});
after(() => mock.timers.reset());

describe('REST Last-Modified', () => {
    it("a cold isolate's first response carries the entity version, with no separate _sync_meta round trip", async () => {
        const from = stats.sql.length;
        const res = await get('net?limit=5');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('last-modified'), http(V0));
        assert.equal(stats.sql.slice(from).filter(q => q.includes('"_sync_meta"')).length, 1, 'one poll, in the batch');
        assert.equal((await get('net')).headers.get('last-modified'), http(V0), 'the full list too');
    });

    it('depth=0 details carry it; depth>0 and sub-resources do not', async () => {
        assert.equal((await get('net/100')).headers.get('last-modified'), http(V0));
        assert.equal((await get('net/100?depth=1')).headers.get('last-modified'), null);
        assert.equal((await get('org/1/net_set')).headers.get('last-modified'), null);
    });
});

describe('REST If-Modified-Since', () => {
    it('an unchanged list or depth=0 detail is a 304', async () => {
        assert.equal((await get('net', ims(V0 + 60))).status, 304);
        assert.equal((await get('net/100', ims(V0))).status, 304, 'IMS equal to the version');
    });

    it('depth>0 is not answered from the entity version', async () => {
        assert.equal((await get('net/100?depth=1', ims(V0 + 60))).status, 200);
    });

    it('a copy from before this worker version was deployed gets a full response', async () => {
        const deployed = { ...env, CF_VERSION_METADATA: { timestamp: new Date((V0 + 120) * 1000).toISOString() } };
        assert.equal((await get('net', ims(V0 + 60), deployed)).status, 200);
        assert.equal((await get('net', ims(V0 + 180), deployed)).status, 304);
    });

    it('after a sync changes the entity: 200 with the new version, then 304 against it', async () => {
        sqlite.prepare(`UPDATE "_sync_meta" SET last_modified_at = ? WHERE entity = 'net'`).run(V1);
        // The router answers from the version the isolate polled last (at
        // most 15 s old); past the interval, the next D1 query carries the
        // poll (an uncached URL, so there is one; the poll purges the L1).
        mock.timers.tick(16_000);
        assert.equal((await get('net?limit=6')).headers.get('last-modified'), http(V1));
        const res = await get('net?limit=5', ims(V0 + 60));
        assert.equal(res.status, 200, 'conditional on the old version');
        assert.equal(res.headers.get('last-modified'), http(V1));
        assert.equal((await get('net?limit=5', ims(V1))).status, 304);
    });
});
