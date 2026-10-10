/**
 * @fileoverview Upstream-compatibility fixes found by the comparison
 * benchmark, end to end on real SQLite:
 *
 *   1. ?since= compares against upstream's ISO timestamps (it used
 *      datetime(), whose '2026-10-07 10:00:00' form sorts below every
 *      '2026-10-07T…Z' value of the same day).
 *   2. Unknown query parameters are ignored, as upstream does (peeringdb-py
 *      sends ?pk=); known-but-not-filterable fields still 400.
 *   3. ix.fac_set / ixlan.net_set: upstream's sets through the link table
 *      (target ids at depth=1, target objects at depth=2), alongside the
 *      mirror's link-row sets.
 *   4. limit=0 means no limit (every row), as upstream; it used to be a
 *      count mode upstream never had.
 *   5. Detail views expand every `<tag>_id` parent into a `<tag>` object at
 *      depth≥1, and at depth=2 serialise those parents at depth 1 (their
 *      sets as ids, their own parents as objects), as upstream. Lists keep
 *      expanding org only. depth=2 child objects keep their FK back-reference.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { default: restWorker } = await import('../../../rest/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');
const { purgeRestCache } = await import('../../../rest/cache.js');

const TS = '2026-01-01T00:00:00Z';
/** @type {any} */
let env;

before(() => {
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);

    // Networks with updated timestamps spread over one day (+ the day before).
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', ?)`);
    net.run(100, 'Net 100', 64100, '2026-10-06T23:00:00Z');
    net.run(101, 'Net 101', 64101, '2026-10-07T01:00:00Z');
    net.run(102, 'Net 102', 64102, '2026-10-07T10:30:00Z');
    net.run(103, 'Net 103', 64103, '2026-10-07T11:00:00Z');

    // One IX with two of three facilities linked and a LAN with
    // net 100 present twice (two addresses) and net 101 once.
    sqlite.exec(`INSERT INTO "peeringdb_ix" (id, org_id, name, social_media, status, created, updated) VALUES (1, 1, 'IX One', '[]', 'ok', '${TS}', '${TS}')`);
    const fac = sqlite.prepare(`INSERT INTO "peeringdb_facility" (id, org_id, name, city, social_media, available_voltage_services, status, created, updated) VALUES (?, 1, ?, 'Amsterdam', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    for (const id of [10, 11, 12]) fac.run(id, `Fac ${id}`);
    sqlite.exec(`INSERT INTO "peeringdb_campus" (id, org_id, name, social_media, status, created, updated) VALUES (5, 1, 'Campus Five', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`UPDATE "peeringdb_facility" SET campus_id = 5 WHERE id IN (10, 11)`);
    const ixfac = sqlite.prepare(`INSERT INTO "peeringdb_ix_facility" (id, ix_id, fac_id, status, created, updated) VALUES (?, 1, ?, ?, '${TS}', '${TS}')`);
    ixfac.run(501, 10, 'ok');
    ixfac.run(502, 11, 'ok');
    sqlite.exec(`INSERT INTO "peeringdb_ixlan" (id, ix_id, name, ixf_ixp_member_list_url_visible, status, created, updated) VALUES (1, 1, '', 'Private', 'ok', '${TS}', '${TS}')`);
    const nix = sqlite.prepare(`INSERT INTO "peeringdb_network_ixlan" (id, net_id, ixlan_id, asn, speed, ipaddr4, status, created, updated) VALUES (?, ?, 1, ?, 10000, ?, 'ok', '${TS}', '${TS}')`);
    nix.run(901, 100, 64100, '192.0.2.1');
    nix.run(902, 100, 64100, '192.0.2.2');
    nix.run(903, 101, 64101, '192.0.2.3');

    env = envFor(db);
});

beforeEach(() => { purgeAllCaches(); purgeRestCache(); });

/** @param {any} worker @param {string} url */
async function get(worker, url) {
    const res = await worker.fetch(new Request(url), env, mockCtx);
    const text = await res.text();
    return { status: res.status, body: res.ok ? JSON.parse(text) : text };
}
const API = 'https://api.pdbfe.dev/api';
const ids = (/** @type {any} */ b) => b.data.map((/** @type {any} */ r) => r.id);

describe('?since= compares ISO timestamps', () => {
    const since = Date.parse('2026-10-07T10:00:00Z') / 1000;

    for (const shape of [`net?since=${since}`, `net?since=${since}&depth=0`]) {
        it(`${shape} returns only rows updated at/after 10:00 that day`, async () => {
            const { status, body } = await get(apiWorker, `${API}/${shape}`);
            assert.equal(status, 200);
            assert.deepEqual(ids(body), [102, 103]); // not 101 (01:00, same day)
        });
    }

    it('boundary is inclusive', async () => {
        const at = Date.parse('2026-10-07T10:30:00Z') / 1000;
        assert.deepEqual(ids((await get(apiWorker, `${API}/net?since=${at}`)).body), [102, 103]);
    });
});

describe('unknown query parameters are ignored', () => {
    for (const q of ['zzz=1', 'pk=101', 'name__bogus=x', 'org__nope=1', 'sort=nonexistent', 'asn__regex=1']) {
        it(`api net?${q} → 200, unfiltered`, async () => {
            const { status, body } = await get(apiWorker, `${API}/net?${q}`);
            assert.equal(status, 200, String(body));
            assert.deepEqual(ids(body), [100, 101, 102, 103]);
        });
    }

    it('dropped unknowns do not make a response auth-sensitive (still shared)', async () => {
        const res = await apiWorker.fetch(new Request(`${API}/net?name__bogus=x&org__nope=1`), env, mockCtx);
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('Cache-Control')?.startsWith('public'));
        assert.equal(res.headers.get('Vary'), null);
    });

    it('known filters still apply next to unknown ones', async () => {
        const { body } = await get(apiWorker, `${API}/net?pk=1&asn=64102&zzz=2`);
        assert.deepEqual(ids(body), [102]);
    });

    it('known but not filterable fields are still rejected (would silently mis-filter)', async () => {
        const { status } = await get(apiWorker, `${API}/net?social_media=x`);
        assert.equal(status, 400);
    });

    it('rest ignores unknown parameters too', async () => {
        const { status, body } = await get(restWorker, `https://rest.pdbfe.dev/v1/net?zzz=1`);
        assert.equal(status, 200, String(body));
        assert.equal(body.data.length, 4);
    });
});

describe('ix.fac_set / ixlan.net_set (upstream sets through the link table)', () => {
    it('ix depth=1: fac_set = facility ids, ixfac_set kept', async () => {
        const ix = (await get(apiWorker, `${API}/ix/1?depth=1`)).body.data[0];
        assert.deepEqual(ix.fac_set, [10, 11]);
        assert.deepEqual(ix.ixfac_set, [501, 502]);
    });

    it('ix depth=2: fac_set = facility objects', async () => {
        const ix = (await get(apiWorker, `${API}/ix/1?depth=2`)).body.data[0];
        assert.deepEqual(ix.fac_set.map((/** @type {any} */ f) => [f.id, f.name, f.city]), [[10, 'Fac 10', 'Amsterdam'], [11, 'Fac 11', 'Amsterdam']]);
        assert.equal('fac_id' in ix.fac_set[0], false, 'target objects, not link rows');
    });

    it('ixlan depth=1: net_set = distinct network ids, netixlan_set kept', async () => {
        const lan = (await get(apiWorker, `${API}/ixlan/1?depth=1`)).body.data[0];
        assert.deepEqual(lan.net_set, [100, 101]);
        assert.deepEqual(lan.netixlan_set, [901, 902, 903]);
    });

    it('ixlan depth=2: net_set = network objects, each once', async () => {
        const lan = (await get(apiWorker, `${API}/ixlan/1?depth=2`)).body.data[0];
        assert.deepEqual(lan.net_set.map((/** @type {any} */ n) => [n.id, n.asn]), [[100, 64100], [101, 64101]]);
        assert.ok(Array.isArray(lan.net_set[0].info_types), 'JSON columns parsed');
    });

    it('list depth=1 expands per parent', async () => {
        const { body } = await get(apiWorker, `${API}/ix?depth=1`);
        assert.deepEqual(body.data[0].fac_set, [10, 11]);
    });
});

describe('limit=0 returns every row (as upstream)', () => {
    it('api net?limit=0 → all networks, no count envelope', async () => {
        const { status, body } = await get(apiWorker, `${API}/net?limit=0`);
        assert.equal(status, 200);
        assert.deepEqual(ids(body), [100, 101, 102, 103]);
        assert.equal(body.meta.count, undefined);
    });

    it('limit=0 with a filter and with skip', async () => {
        assert.deepEqual(ids((await get(apiWorker, `${API}/net?limit=0&asn__gte=64102`)).body), [102, 103]);
        assert.deepEqual(ids((await get(apiWorker, `${API}/net?limit=0&skip=2`)).body), [102, 103]);
    });
});

describe('detail views expand parent FKs (as upstream)', () => {
    /** @param {any} o */
    const sets = (o) => Object.keys(o).filter((k) => k.endsWith('_set')).sort();

    it('depth=1: every <tag>_id parent becomes a plain <tag> object', async () => {
        const fac = (await get(apiWorker, `${API}/fac/10?depth=1`)).body.data[0];
        assert.equal(fac.campus.id, 5);
        assert.equal(fac.campus.name, 'Campus Five');
        assert.equal(fac.org.id, 1);
        assert.deepEqual(sets(fac.campus), [], 'depth-0 parent: no sets');

        const nix = (await get(apiWorker, `${API}/netixlan/901?depth=1`)).body.data[0];
        assert.equal(nix.net.id, 100);
        assert.equal(nix.ixlan.id, 1);
        assert.equal('net_side' in nix || 'ix_side' in nix, false, 'side facilities are not expanded (not upstream)');

        const ixfac = (await get(apiWorker, `${API}/ixfac/501?depth=1`)).body.data[0];
        assert.deepEqual([ixfac.ix.id, ixfac.fac.id], [1, 10]);
    });

    it('depth=2: parents are serialised at depth 1 (sets as ids, own parents as objects)', async () => {
        const fac = (await get(apiWorker, `${API}/fac/10?depth=2`)).body.data[0];
        assert.deepEqual(fac.campus.fac_set, [10, 11]);
        assert.equal(fac.campus.org.id, 1, "parent's parent as an object");
        assert.deepEqual(fac.org.fac_set, [10, 11, 12]);
        assert.deepEqual(fac.org.net_set, [100, 101, 102, 103]);

        const ixfac = (await get(apiWorker, `${API}/ixfac/501?depth=2`)).body.data[0];
        assert.deepEqual(ixfac.ix.fac_set, [10, 11]);
        assert.deepEqual(ixfac.ix.ixlan_set, [1]);
        assert.equal(ixfac.fac.campus.id, 5);

        const nix = (await get(apiWorker, `${API}/netixlan/901?depth=2`)).body.data[0];
        assert.deepEqual(nix.net.netixlan_set, [901, 902]);
        assert.equal(nix.ixlan.ix.id, 1);
        assert.deepEqual(nix.ixlan.net_set, [100, 101]);
    });

    it('lists still expand org only', async () => {
        const fac = (await get(apiWorker, `${API}/fac?depth=1`)).body.data[0];
        assert.equal(fac.org.id, 1);
        assert.equal('campus' in fac, false);
        const nix = (await get(apiWorker, `${API}/netixlan?depth=1`)).body.data[0];
        assert.equal('net' in nix || 'ixlan' in nix, false);
    });

    it('rest detail views are unchanged (their own OpenAPI schema)', async () => {
        const { status, body } = await get(restWorker, 'https://rest.pdbfe.dev/v1/fac/10?depth=1');
        assert.equal(status, 200);
        const fac = body.data?.[0] ?? body;
        assert.equal('campus' in fac, false);
    });

    it('depth=2 child objects keep the FK back to the parent', async () => {
        const ix = (await get(apiWorker, `${API}/ix/1?depth=2`)).body.data[0];
        assert.equal(ix.ixfac_set[0].ix_id, 1);
        const campus = (await get(apiWorker, `${API}/campus/5?depth=2`)).body.data[0];
        assert.deepEqual(campus.fac_set.map((/** @type {any} */ f) => f.campus_id), [5, 5]);
    });
});
