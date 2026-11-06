/**
 * @fileoverview GraphQL FK and reverse-edge fields are batched per execution
 * level (extracted/graphql-resolvers.js batchLoad): a nested query costs one
 * D1 query per relation level, not one per parent row (N+1). Checks the
 * query count, that the batched results match what each parent should get
 * (per-parent limit/skip, id order, shared FK targets), and that restricted
 * children (poc) keep their anonymous visibility filter.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from '../../lib/sqlite_d1.js';
import { handleUncached } from '../../../graphql/handlers/query.js';
import { ENTITIES, getFilterType } from '../../../api/entities.js';

const TS = '2026-01-01T00:00:00Z';
/** @type {any} */ let db;
/** @type {{queries: number, sql: string[]}} */ let stats;

before(() => {
    const d1 = createSqliteD1();
    db = d1.db;
    stats = d1.stats;
    const s = d1.sqlite;
    s.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    const fac = s.prepare(`INSERT INTO "peeringdb_facility" (id, org_id, name, city, social_media, available_voltage_services, status, created, updated) VALUES (?, 1, ?, 'Amsterdam', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    fac.run(10, 'Fac 10'); fac.run(11, 'Fac 11');
    const ix = s.prepare(`INSERT INTO "peeringdb_ix" (id, org_id, name, social_media, status, created, updated) VALUES (?, 1, ?, '[]', 'ok', '${TS}', '${TS}')`);
    ix.run(26, 'IX 26'); ix.run(27, 'IX 27');
    const ixlan = s.prepare(`INSERT INTO "peeringdb_ixlan" (id, ix_id, name, status, created, updated) VALUES (?, ?, '', 'ok', '${TS}', '${TS}')`);
    ixlan.run(260, 26); ixlan.run(270, 27);
    const ixfac = s.prepare(`INSERT INTO "peeringdb_ix_facility" (id, ix_id, fac_id, status, created, updated) VALUES (?, ?, ?, 'ok', '${TS}', '${TS}')`);
    ixfac.run(500, 26, 10); ixfac.run(501, 26, 11); ixfac.run(502, 27, 10);
    const net = s.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    net.run(100, 'Net 100', 64100); net.run(101, 'Net 101', 64101); net.run(102, 'Net 102', 64102);
    const nixl = s.prepare(`INSERT INTO "peeringdb_network_ixlan" (id, net_id, ixlan_id, asn, ipaddr4, status, created, updated) VALUES (?, ?, ?, ?, ?, 'ok', '${TS}', '${TS}')`);
    // net 100 on both IXes twice, 101 on IX 26 once, 102 on IX 27 once
    nixl.run(900, 100, 260, 64100, '192.0.2.1');
    nixl.run(901, 100, 260, 64100, '192.0.2.2');
    nixl.run(902, 100, 270, 64100, '198.51.100.1');
    nixl.run(903, 101, 260, 64101, '192.0.2.3');
    nixl.run(904, 102, 270, 64102, '198.51.100.2');
    const poc = s.prepare(`INSERT INTO "peeringdb_network_contact" (id, net_id, role, visible, name, status, created, updated) VALUES (?, ?, 'NOC', ?, ?, 'ok', '${TS}', '${TS}')`);
    poc.run(1000, 100, 'Public', 'Public NOC'); poc.run(1001, 100, 'Users', 'Users NOC'); poc.run(1002, 101, 'Public', 'Public NOC 101');
});
beforeEach(() => { stats.queries = 0; stats.sql.length = 0; });

/**
 * @param {string} query
 * @param {boolean} [authenticated]
 * @returns {Promise<any>} The GraphQL `data`; fails on any GraphQL error.
 */
async function gql(query, authenticated = false) {
    const req = new Request('https://graphql.pdbfe.dev/', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
    });
    const body = await (await handleUncached(req, db, authenticated)).json();
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    return body.data;
}

describe('one D1 query per relation level', () => {
    it('net → netixlans → ixlan → ix → ixfacs → fac: 6 queries, not one per row', async () => {
        const data = await gql(`{ networks(limit: 10) { id
            networkExchangeLans { id ixlan { id ix { name exchangeFacilities { fac { name } } } } } } }`);
        // networks, netixlans, ixlans, ixes, ixfacs, facs
        assert.equal(stats.queries, 6, stats.sql.join('\n'));
        const n100 = data.networks.find((/** @type {any} */ n) => n.id === 100);
        assert.deepEqual(n100.networkExchangeLans.map((/** @type {any} */ x) => [x.id, x.ixlan.ix.name]),
            [[900, 'IX 26'], [901, 'IX 26'], [902, 'IX 27']]);
        assert.deepEqual(n100.networkExchangeLans[0].ixlan.ix.exchangeFacilities.map((/** @type {any} */ f) => f.fac.name), ['Fac 10', 'Fac 11']);
        assert.deepEqual(n100.networkExchangeLans[2].ixlan.ix.exchangeFacilities.map((/** @type {any} */ f) => f.fac.name), ['Fac 10']);
    });

    it('rows sharing an FK target fetch it once (distinct ids in one IN list)', async () => {
        await gql('{ networkExchangeLans(limit: 10) { id net { name } } }');
        assert.equal(stats.queries, 2);
        const fkSql = stats.sql[1];
        assert.match(fkSql, /json_each/);
    });

    it('ix members: exchange → ixlans → netixlans → net: 4 queries', async () => {
        const data = await gql('{ exchange(id: 26) { name exchangeLans { networkExchangeLans(limit: 1000) { asn net { name } } } } }');
        assert.equal(stats.queries, 4);
        assert.deepEqual(data.exchange.exchangeLans[0].networkExchangeLans.map((/** @type {any} */ x) => x.net.name),
            ['Net 100', 'Net 100', 'Net 101']);
    });
});

describe('batched results match the per-parent queries', () => {
    it('limit and skip apply per parent, in id order', async () => {
        const data = await gql(`{ networks(limit: 10) { id
            first: networkExchangeLans(limit: 1) { id }
            second: networkExchangeLans(limit: 1, skip: 1) { id } } }`);
        const byId = Object.fromEntries(data.networks.map((/** @type {any} */ n) => [n.id, n]));
        assert.deepEqual(byId[100].first.map((/** @type {any} */ x) => x.id), [900]);
        assert.deepEqual(byId[100].second.map((/** @type {any} */ x) => x.id), [901]);
        assert.deepEqual(byId[101].first.map((/** @type {any} */ x) => x.id), [903]);
        assert.deepEqual(byId[101].second, []);
    });

    it('a parent without children gets an empty list, a missing FK gets null', async () => {
        const data = await gql('{ facilities(limit: 10) { id networkFacilities { id } campus { id } } }');
        for (const f of data.facilities) {
            assert.deepEqual(f.networkFacilities, []);
            assert.equal(f.campus, null);
        }
    });
});

describe('restricted children keep their visibility filter when batched', () => {
    it('anonymous: only visible=Public pocs', async () => {
        const data = await gql('{ networks(limit: 10) { id pointsOfContact { name } } }');
        const byId = Object.fromEntries(data.networks.map((/** @type {any} */ n) => [n.id, n.pointsOfContact.map((/** @type {any} */ p) => p.name)]));
        assert.deepEqual(byId[100], ['Public NOC']);
        assert.deepEqual(byId[101], ['Public NOC 101']);
        assert.deepEqual(byId[102], []);
    });

    it('authenticated: Users pocs too', async () => {
        const data = await gql('{ networks(limit: 10) { id pointsOfContact { name } } }', true);
        const n100 = data.networks.find((/** @type {any} */ n) => n.id === 100);
        assert.deepEqual(n100.pointsOfContact.map((/** @type {any} */ p) => p.name), ['Public NOC', 'Users NOC']);
    });
});

describe('generated resolver config', () => {
    // buildRowQuery silently ignores a filter on a non-queryable field; for a
    // batched reverse edge that would mean an unfiltered child table.
    it('every reverse-edge fk field is a queryable filter on the child entity', () => {
        const src = readFileSync(new URL('../../../../extracted/graphql-resolvers.js', import.meta.url), 'utf8');
        const edges = [...src.matchAll(/reverseEdgeResolver\('([a-z_]+)', '([a-z]+)'\)/g)];
        assert.ok(edges.length > 10);
        for (const [, fk, child] of edges) {
            assert.ok(getFilterType(ENTITIES[child], fk), `${child}.${fk} not queryable`);
        }
    });
});
