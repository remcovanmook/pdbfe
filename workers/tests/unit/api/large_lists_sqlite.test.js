/**
 * @fileoverview Regression tests for two production 500s on large lists,
 * run against real SQLite with D1's limits enforced (tests/lib/sqlite_d1.js).
 *
 * 1. depth>=1 lists with >100 parents: depth expansion bound one `?` per
 *    parent id and hit D1's 100-parameter cap ("too many SQL variables").
 * 2. Large depth=0 lists: the json_group_array envelope exceeded D1's max
 *    string size (SQLITE_TOOBIG) or memory (SQLITE_NOMEM — which also failed
 *    concurrent queries). Large/unbounded lists are now paged from the start
 *    and small ones fall back to paging on either error. These tests force
 *    both errors with a small value-size cap and check the paged result is
 *    identical in rows and order to a direct SQL query.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { default: restWorker } = await import('../../../rest/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');
const { purgeRestCache } = await import('../../../rest/cache.js');

/** Each suite seeds its own database; drop isolate caches so no response leaks across. */
function freshCaches() {
    purgeAllCaches();
    purgeRestCache();
}

const TS = '2026-01-01T00:00:00Z';
const NOTES = 'x'.repeat(400); // ~0.6KB per net row in the JSON envelope

/**
 * Seeds `nets` networks, each with its own org and two netfac rows.
 * @param {import('node:sqlite').DatabaseSync} sqlite
 * @param {number} nets
 */
function seed(sqlite, nets) {
    // JSON-typed TEXT columns default to '' in the schema; the sync writes
    // valid JSON, and the json() wrappers in the list query require it.
    const org = sqlite.prepare(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (?, ?, '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, notes, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    const fac = sqlite.prepare(`INSERT INTO "peeringdb_facility" (id, org_id, name, social_media, available_voltage_services, status, created, updated) VALUES (?, 1, ?, '[]', '[]', 'ok', '${TS}', '${TS}')`);
    const netfac = sqlite.prepare(`INSERT INTO "peeringdb_network_facility" (id, net_id, fac_id, local_asn, status, created, updated) VALUES (?, ?, ?, ?, 'ok', '${TS}', '${TS}')`);
    sqlite.exec('BEGIN');
    for (let f = 1; f <= 5; f++) fac.run(f, `Fac ${f}`);
    for (let i = 1; i <= nets; i++) {
        org.run(i, `Org ${i}`);
        // name repeats every 7 rows so sort=name has ties to break
        net.run(i, i, `Net ${i % 7}`, 64_000 + i, NOTES);
        netfac.run(i * 2 - 1, i, (i % 5) + 1, 64_000 + i);
        netfac.run(i * 2, i, ((i + 1) % 5) + 1, 64_000 + i);
    }
    sqlite.exec('COMMIT');
}

/**
 * @param {any} worker
 * @param {any} env
 * @param {string} url
 */
async function getJSON(worker, env, url) {
    const res = await worker.fetch(new Request(url), env, mockCtx);
    const text = await res.text();
    return { status: res.status, body: res.ok ? JSON.parse(text) : text };
}

describe('depth expansion over D1\'s 100-parameter cap', () => {
    /** @type {any} */
    let env;
    before(() => {
        freshCaches();
        const { sqlite, db } = createSqliteD1();
        seed(sqlite, 300);
        env = envFor(db);
    });

    it('api: net?limit=250&depth=1 expands all 250 parents', async () => {
        const { status, body } = await getJSON(apiWorker, env, 'https://api.pdbfe.dev/api/net?limit=250&depth=1');
        assert.equal(status, 200, String(body));
        assert.equal(body.data.length, 250);
        for (const n of body.data) {
            assert.deepEqual(n.netfac_set, [n.id * 2 - 1, n.id * 2], `netfac_set of net ${n.id}`);
            assert.equal(n.org?.id, n.id, `org of net ${n.id}`);
        }
    });

    it('api: net?limit=150&depth=2 expands full child objects', async () => {
        const { status, body } = await getJSON(apiWorker, env, 'https://api.pdbfe.dev/api/net?limit=150&depth=2');
        assert.equal(status, 200, String(body));
        assert.equal(body.data.length, 150);
        assert.deepEqual(body.data[149].netfac_set.map((/** @type {any} */ c) => c.id), [299, 300]);
    });

    it('rest: v1/net?limit=250&depth=1 expands all 250 parents', async () => {
        const { status, body } = await getJSON(restWorker, env, 'https://rest.pdbfe.dev/v1/net?limit=250&depth=1');
        assert.equal(status, 200, String(body));
        assert.equal(body.data.length, 250);
        assert.deepEqual(body.data[0].netfac_set, [1, 2]);
    });
});

for (const oversizeError of /** @type {const} */ (['toobig', 'nomem'])) describe(`paged list when D1 can't build the envelope (${oversizeError})`, () => {
    const NETS = 2000;
    /** @type {any} */
    let env;
    /** @type {import('node:sqlite').DatabaseSync} */
    let sqlite;
    /** @type {{queries: number, tooBig: number}} */
    let stats;

    before(() => {
        freshCaches();
        // ~1.3MB for the full net list; 400KB cap forces the fallback and
        // at least one page-size halving (5000 → … → 312 rows per page).
        const d = createSqliteD1({ maxValueBytes: 400_000, oversizeError });
        sqlite = d.sqlite;
        stats = d.stats;
        seed(sqlite, NETS);
        env = envFor(d.db);
    });

    /**
     * Ids the list should return, straight from SQLite.
     * @param {string} orderBy
     * @param {number} limit
     * @param {number} skip
     */
    const expectedIds = (orderBy, limit, skip) => sqlite
        .prepare(`SELECT id FROM "peeringdb_network" WHERE status = 'ok' ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .all(limit, skip).map((/** @type {any} */ r) => r.id);

    const cases = [
        { label: 'whole table (no limit)', path: '/api/net', order: '"id" ASC', limit: -1, skip: 0 },
        { label: 'limit=-1', path: '/api/net?limit=-1', order: '"id" ASC', limit: -1, skip: 0 },
        { label: 'skip + limit window', path: '/api/net?skip=150&limit=1500', order: '"id" ASC', limit: 1500, skip: 150 },
        { label: 'sort with ties (id tiebreak)', path: '/api/net?sort=name', order: '"name" ASC, "id" ASC', limit: -1, skip: 0 },
        { label: 'descending sort with ties', path: '/api/net?sort=-name&skip=10', order: '"name" DESC, "id" ASC', limit: -1, skip: 10 },
    ];

    for (const c of cases) {
        it(`api: ${c.label} returns every row once, in order`, async () => {
            const before = stats.tooBig;
            const { status, body } = await getJSON(apiWorker, env, `https://api.pdbfe.dev${c.path}`);
            assert.equal(status, 200, String(body));
            assert.ok(stats.tooBig > before, 'page-size halving should have been exercised');
            assert.deepEqual(body.data.map((/** @type {any} */ r) => r.id), expectedIds(c.order, c.limit, c.skip));
            assert.equal(body.data[0].notes, 'x'.repeat(400));
            assert.deepEqual(body.meta, {});
        });
    }

    it('rest: v1/net whole table returns every row once', async () => {
        const { status, body } = await getJSON(restWorker, env, 'https://rest.pdbfe.dev/v1/net');
        assert.equal(status, 200, String(body));
        assert.deepEqual(body.data.map((/** @type {any} */ r) => r.id), expectedIds('"id" ASC', -1, 0));
    });

    it('small lists stay on the single-query hot path', async () => {
        const before = stats.tooBig;
        const { status, body } = await getJSON(apiWorker, env, 'https://api.pdbfe.dev/api/net?limit=100');
        assert.equal(status, 200);
        assert.equal(body.data.length, 100);
        assert.equal(stats.tooBig, before, 'no TOOBIG for a small list');
    });
});

describe('paging cost on an unconstrained database', () => {
    /** @type {any} */
    let env;
    /** @type {{queries: number, payloadQueries: number, tooBig: number}} */
    let stats;
    before(() => {
        freshCaches();
        const d = createSqliteD1();
        seed(d.sqlite, 5000);
        stats = d.stats;
        env = envFor(d.db);
    });

    it('an unbounded list that fits one page costs exactly one query', async () => {
        const before = stats.payloadQueries;
        const { status, body } = await getJSON(apiWorker, env, 'https://api.pdbfe.dev/api/net?asn__lt=65000');
        assert.equal(status, 200);
        assert.equal(body.data.length, 999);
        assert.equal(stats.payloadQueries - before, 1);
    });

    it('a large unbounded list is never fetched in one statement', async () => {
        const before = stats.payloadQueries;
        const { status, body } = await getJSON(apiWorker, env, 'https://api.pdbfe.dev/api/net');
        assert.equal(status, 200);
        assert.equal(body.data.length, 5000);
        assert.deepEqual(body.data.map((/** @type {any} */ r) => r.id), Array.from({ length: 5000 }, (_, i) => i + 1));
        assert.ok(stats.payloadQueries - before > 1, 'should page');
    });
});
