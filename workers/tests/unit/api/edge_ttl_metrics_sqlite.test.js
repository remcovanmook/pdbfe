/**
 * @fileoverview Sync-aligned edge TTL, no L2 phase, and the
 * cache-tier Analytics Engine data points.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';
import { secondsUntilFreshData, syncAlignedCacheControl, SYNC_INTERVAL_S, SYNC_GRACE_S, SWR_S } from '../../../api/http.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');

const TS = '2026-01-01T00:00:00Z';
/** @type {any} */
let env;
/** @type {any[]} */
const points = [];

before(() => {
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (1, 1, 'Net', 64500, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    env = { ...envFor(db), METRICS: { writeDataPoint: (/** @type {any} */ p) => points.push(p) } };
});

beforeEach(() => { purgeAllCaches(); points.length = 0; });

const at = (/** @type {string} */ iso) => Date.parse(iso) / 1000;

describe('secondsUntilFreshData (absolute expiry after the next sync)', () => {
    const cases = [
        ['2026-10-07T12:41:00Z', 300], // → 12:46:00
        ['2026-10-07T12:44:59Z', 61],  // → 12:46:00
        ['2026-10-07T12:45:00Z', 60],  // sync running → end of its grace window
        ['2026-10-07T12:45:59Z', 1],
        ['2026-10-07T12:46:00Z', 900], // grace over → after the 13:00 run
        ['2026-10-07T12:59:30Z', 90],
    ];
    for (const [iso, expected] of cases) {
        it(`${iso} → ${expected}s`, () => assert.equal(secondsUntilFreshData(at(iso)), expected));
    }

    it('header carries the aligned max-age plus stale-while-revalidate', () => {
        assert.equal(syncAlignedCacheControl(at('2026-10-07T12:41:00Z') * 1000), `public, max-age=300, stale-while-revalidate=${SWR_S}`);
    });

    it('interval matches the sync worker cron', () => {
        const toml = readFileSync(new URL('../../../wrangler-sync.toml.example', import.meta.url), 'utf8');
        const m = toml.match(/crons\s*=\s*\[[^\]]*"\*\/(\d+) \* \* \* \*"/);
        assert.ok(m, 'cron of the form */N * * * *');
        assert.equal(Number(m[1]) * 60, SYNC_INTERVAL_S);
        assert.ok(SYNC_GRACE_S < SYNC_INTERVAL_S);
    });
});

describe('API responses', () => {
    it('public responses use the aligned TTL', async () => {
        const res = await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/net?asn=64500'), env, mockCtx);
        const cc = res.headers.get('Cache-Control') ?? '';
        const m = cc.match(/^public, max-age=(\d+), stale-while-revalidate=\d+$/);
        assert.ok(m, cc);
        assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= SYNC_INTERVAL_S + SYNC_GRACE_S);
    });

    it('a miss goes straight to D1: no l2 phase in Server-Timing', async () => {
        for (const path of ['net?since=1700000000', 'net?asn=64500&limit=3']) {
            const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${path}`), env, mockCtx);
            const st = res.headers.get('Server-Timing') ?? '';
            assert.doesNotMatch(st, /l2;dur/, path);
            assert.match(st, /db;dur=\d+/, path);
        }
    });

    it('writes one cache-tier data point per request', async () => {
        await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/net?since=1700000000'), env, mockCtx);
        await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/net?since=1700000000'), env, mockCtx);
        assert.equal(points.length, 2);
        assert.deepEqual(points[0].blobs, ['MISS', 'shared', 'net', 'since', '200']);
        assert.equal(points[0].doubles[1], -1, 'double2 (the former L2 time) stays -1');
        assert.ok(points[0].doubles[2] >= 0, 'db phase timed');
        assert.equal(points[1].blobs[0], 'L1');
        assert.deepEqual(points[0].indexes, ['net']);
    });
});
