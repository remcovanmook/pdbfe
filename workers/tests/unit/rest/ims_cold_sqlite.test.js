/**
 * @fileoverview If-Modified-Since on a cold REST isolate (rest/index.js): the
 * isolate knows no entity versions yet, so a conditional request answered by
 * the entity version reads _sync_meta first and gets a 304 instead of the
 * full response. The first request of this file is the cold one: node's test
 * runner gives each file its own process. Last-Modified and the warm paths
 * are ims_sqlite.test.js.
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

/** @type {any} */ let env;
/** @type {{ sql: string[] }} */ let stats;
let ip = 0;

/** @param {string} path @param {Record<string, string>} [headers] */
const get = (path, headers = {}) => restWorker.fetch(new Request(`https://rest.pdbfe.dev/v1/${path}`, {
    headers: { 'cf-connecting-ip': `10.4.0.${++ip}`, ...headers },
}), env, mockCtx);
const ims = (/** @type {number} */ s) => ({ 'If-Modified-Since': new Date(s * 1000).toUTCString() });
/** Statements since `from` that read entity rows (not _sync_meta). */
const rowQueries = (/** @type {number} */ from) => stats.sql.slice(from).filter(q => !q.includes('"_sync_meta"'));

before(() => {
    mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
    const d = createSqliteD1();
    stats = d.stats;
    d.sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org 1', '[]', 'ok', '${TS}', '${TS}')`);
    d.sqlite.exec(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (100, 1, 'Net 100', 64100, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    for (const tag of Object.keys(ENTITIES)) {
        d.sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, ?, 1, '', ?)`).run(tag, V0, V0);
    }
    env = envFor(d.db);
});
after(() => mock.timers.reset());

describe('REST If-Modified-Since on a cold isolate', () => {
    it('the first request, conditional on an unchanged list, is a 304 from _sync_meta alone', async () => {
        const from = stats.sql.length;
        const res = await get('net', ims(V0 + 60));
        assert.equal(res.status, 304);
        assert.match(res.headers.get('cache-control') ?? '', /max-age=\d+/);
        assert.ok(stats.sql.slice(from).some(q => q.includes('"_sync_meta"')), 'read _sync_meta');
        assert.deepEqual(rowQueries(from), [], 'no entity rows read');
    });

    it('a copy older than the entity version gets the full response', async () => {
        assert.equal((await get('net', ims(V0 - 60))).status, 200);
    });
});
