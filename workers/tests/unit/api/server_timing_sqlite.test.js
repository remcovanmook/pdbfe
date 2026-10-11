/**
 * @fileoverview Server-Timing on api list/detail responses: cache tier plus
 * auth / D1 phase durations, so the cache-miss path can be measured
 * from outside (see the perf/bench analysis of small-shape latency).
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');

const TS = '2026-01-01T00:00:00Z';
/** @type {any} */
let env;

before(() => {
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (1, 1, 'Net', 64500, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    env = envFor(db);
});

beforeEach(() => purgeAllCaches());

/** @param {string} url */
const timing = async (url) => (await apiWorker.fetch(new Request(url), env, mockCtx)).headers.get('Server-Timing') ?? '';

describe('Server-Timing', () => {
    for (const url of ['https://api.pdbfe.dev/api/net?asn=64500', 'https://api.pdbfe.dev/api/net/1', 'https://api.pdbfe.dev/api/net?page=1']) {
        it(`${url.slice(26)}: miss reports auth/db, repeat reports L1 without db`, async () => {
            const miss = await timing(url);
            assert.match(miss, /cache;desc="MISS"/);
            for (const phase of ['auth', 'db']) assert.match(miss, new RegExp(`${phase};dur=\\d+`), phase);

            const hit = await timing(url);
            assert.match(hit, /cache;desc="L1"/);
            assert.doesNotMatch(hit, /db;dur=/);
        });
    }
});
