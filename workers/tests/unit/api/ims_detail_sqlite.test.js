/**
 * @fileoverview If-Modified-Since on the request path (api/index.js): which
 * check answers which request, the 24h window, whole-entity markers,
 * revalidations carrying If-None-Match, the deploy-time guard, and failure
 * handling. Coverage of the change check itself is
 * change_check_sqlite.test.js.
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');

const TS = '2026-01-01T00:00:00Z';
const NOW = Date.parse('2026-10-24T12:00:00Z') / 1000;
const V0 = NOW - 7200;

/** @type {any} */ let env;
/** @type {import('node:sqlite').DatabaseSync} */ let sqlite;
/** @type {{ sql: string[] }} */ let stats;
let ip = 0;

/** @param {string} path @param {Record<string, string>} [headers] */
async function get(path, headers = {}) {
    const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${path}`, {
        headers: { 'cf-connecting-ip': `10.2.0.${++ip}`, ...headers },
    }), env, mockCtx);
    return res.status;
}
const ims = (/** @type {number} */ s) => ({ 'If-Modified-Since': new Date(s * 1000).toUTCString() });
const checks = () => stats.sql.filter(q => q.includes('"_row_changes"')).length;
/** @param {string} entity @param {number} id @param {number} rowAt @param {number} [setAt] */
const markRow = (entity, id, rowAt, setAt = 0) =>
    sqlite.prepare('INSERT OR REPLACE INTO "_row_changes" (entity, id, row_at, set_at) VALUES (?, ?, ?, ?)').run(entity, id, rowAt, setAt);

before(async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
    const d = createSqliteD1();
    ({ sqlite, stats } = d);
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org 1', '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    net.run(100, 'Net 100', 64100); net.run(101, 'Net 101', 64101);
    for (const tag of Object.keys(ENTITIES)) {
        sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, ?, 1, '', ?)`).run(tag, V0, V0);
    }
    env = envFor(d.db);
    await get('net/101');   // the poll: the isolate learns the entity versions
});
after(() => mock.timers.reset());

describe('If-Modified-Since on details', () => {
    it('depth=0: the entity version answers, no D1 check', async () => {
        const before = checks();
        assert.equal(await get('net/100', ims(V0 + 60)), 304);
        assert.equal(checks(), before);
    });

    it('depth≥1: D1 answers — a change through another entity is a 200 although the net version says unchanged', async () => {
        markRow('org', 1, V0 + 120);
        assert.equal(await get('net/100?depth=1', ims(V0 + 60)), 200);
        assert.equal(await get('net/100?depth=1', ims(V0 + 180)), 304);
        assert.equal(await get('net/100', ims(V0 + 60)), 304, 'depth 0 shows no org');
    });

    it('a set change of the object is a 200 at depth≥1 only', async () => {
        markRow('net', 101, 0, V0 + 300);
        assert.equal(await get('net/101?depth=1', ims(V0 + 240)), 200);
        assert.equal(await get('net/101', ims(V0 + 240)), 304);
    });

    it('whole-entity markers newer than the IMS are a 200 (written for every entity at once, as the migration does)', async () => {
        for (const tag of Object.keys(ENTITIES)) markRow(tag, 0, V0 + 400, V0 + 400);
        assert.equal(await get('net/100?depth=1', ims(V0 + 350)), 200, 'net/100 shows its pocs at depth 1');
        assert.equal(await get('net/100?depth=1', ims(V0 + 450)), 304);
    });

    it('an IMS older than 24h is not checked: full response', async () => {
        const before = checks();
        assert.equal(await get('net/100?depth=1', ims(NOW - 25 * 3600)), 200);
        assert.equal(checks(), before);
    });

    it('also with If-None-Match (the edge revalidates with both): the cheap check answers, not the ETag path', async () => {
        const before = checks();
        assert.equal(await get('net/100?depth=1', { ...ims(NOW), 'If-None-Match': '"whatever"' }), 304);
        assert.equal(checks(), before + 1);
        markRow('net', 100, NOW - 10);
        assert.equal(await get('net/100?depth=1', { ...ims(NOW - 60), 'If-None-Match': '"whatever"' }), 200, 'changed: full response');
    });

    it('a copy from before this worker version was deployed goes to the ETag path (the format may differ)', async () => {
        const deployed = { ...env, CF_VERSION_METADATA: { id: 'v', tag: '', timestamp: new Date((NOW - 30) * 1000).toISOString() } };
        const req = (/** @type {string} */ path, /** @type {number} */ s) => apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${path}`, {
            headers: { 'cf-connecting-ip': `10.2.1.${++ip}`, ...ims(s) },
        }), deployed, mockCtx);
        const before = checks();
        assert.equal((await req('net/101?depth=1', NOW - 60)).status, 200, 'older than the deploy: no shortcut');
        assert.equal((await req('net/101', NOW - 60)).status, 200, 'per-entity shortcut too');
        assert.equal(checks(), before);
        assert.equal((await req('net/101?depth=1', NOW)).status, 304, 'since the deploy: answered');
    });

    it('a failing check counts as changed', async () => {
        sqlite.exec('ALTER TABLE "_row_changes" RENAME TO "_row_changes_gone"');
        try {
            assert.equal(await get('net/100?depth=2', ims(NOW)), 200);
        } finally {
            sqlite.exec('ALTER TABLE "_row_changes_gone" RENAME TO "_row_changes"');
        }
    });
});
