/**
 * @fileoverview Equality filters on numeric fields use the column's index
 * (api/query.js nocase): a COLLATE NOCASE on an INTEGER comparison changes
 * no result but makes SQLite scan the table — netixlan?ix_id= read all 66k
 * rows per call, 92% of production's D1 rows read. Checked on the real
 * schema's query plans; string filters (eq and __in) keep their
 * case-insensitive match.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1 } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';
import { buildRowQuery, buildJsonQuery } from '../../../api/query.js';
import { changeCheckSql } from '../../../api/depth.js';

const { sqlite } = createSqliteD1();
const OPTS = { depth: 0, limit: 0, skip: 0, since: 0 };

/** @param {{sql: string, params: any[]}} q @returns {string[]} */
const plan = (q) => /** @type {any[]} */ (sqlite.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.params)).map(r => r.detail);

/** A full scan of `table` (not via an index) anywhere in the plan. @param {string[]} p @param {string} table */
const scans = (p, table) => p.some(d => new RegExp(`^SCAN ${table}\\b|^SCAN t\\b`).test(d) && !/USING (COVERING )?INDEX/.test(d));

describe('numeric equality filters use the index', () => {
    const cases = [
        ['netixlan', 'ix_id', '26'],
        ['netixlan', 'net_id', '694'],
        ['net', 'asn', '13335'],
        ['ixpfx', 'ixlan_id', '171'],
        ['netfac', 'fac_id', '18'],
    ];
    for (const [tag, field, value] of cases) {
        it(`${tag}?${field}=${value}`, () => {
            const entity = ENTITIES[tag];
            for (const build of [buildRowQuery, buildJsonQuery]) {
                const p = plan(build(entity, [{ field, op: 'eq', value }], OPTS));
                assert.ok(!scans(p, entity.table), `${build.name}: full scan of ${entity.table}\n  ${p.join('\n  ')}`);
            }
        });
    }
});

describe('string equality filters stay case-insensitive', () => {
    it('net?name= matches regardless of case', () => {
        sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '2026-01-01', '2026-01-01')`);
        sqlite.exec(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (1, 1, 'Cloudflare', 13335, '[]', '[]', '[]', 'ok', '2026-01-01', '2026-01-01')`);
        const q = buildRowQuery(ENTITIES.net, [{ field: 'name', op: 'eq', value: 'cLoUdFlArE' }], OPTS);
        assert.equal(/** @type {any[]} */ (sqlite.prepare(q.sql).all(...q.params)).length, 1);
    });
});

describe('string __in filters are case-insensitive like upstream', () => {
    // Upstream: fac?country__in=nl,be and ixfac?fac__country__in=nl match
    // the same rows as NL,BE / NL; a BINARY IN matched nothing.
    const TS = '2026-01-01';
    /** @param {any} entity @param {any[]} filters */
    const count = (entity, filters) => {
        const q = buildRowQuery(entity, filters, OPTS);
        return /** @type {any[]} */ (sqlite.prepare(q.sql).all(...q.params)).length;
    };

    it('direct, cross-entity and joined (t.-qualified) filters', () => {
        sqlite.exec(`INSERT OR IGNORE INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
        sqlite.exec(`INSERT INTO "peeringdb_facility" (id, org_id, name, country, social_media, available_voltage_services, status, created, updated) VALUES (50, 1, 'Fac NL', 'NL', '[]', '[]', 'ok', '${TS}', '${TS}'), (51, 1, 'Fac BE', 'BE', '[]', '[]', 'ok', '${TS}', '${TS}')`);
        sqlite.exec(`INSERT INTO "peeringdb_ix" (id, org_id, name, social_media, status, created, updated) VALUES (60, 1, 'IX', '[]', 'ok', '${TS}', '${TS}')`);
        sqlite.exec(`INSERT INTO "peeringdb_ix_facility" (id, ix_id, fac_id, status, created, updated) VALUES (70, 60, 50, 'ok', '${TS}', '${TS}')`);
        sqlite.exec(`INSERT INTO "peeringdb_ixlan" (id, ix_id, name, status, created, updated) VALUES (80, 60, '', 'ok', '${TS}', '${TS}')`);
        sqlite.exec(`INSERT OR IGNORE INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (1, 1, 'Cloudflare', 13335, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
        sqlite.exec(`INSERT INTO "peeringdb_network_ixlan" (id, net_id, ixlan_id, asn, ipaddr6, status, created, updated) VALUES (90, 1, 80, 13335, '2001:DB8::A', 'ok', '${TS}', '${TS}')`);

        assert.equal(count(ENTITIES.fac, [{ field: 'country', op: 'in', value: 'nl,be' }]), 2);
        assert.equal(count(ENTITIES.ixfac, [{ field: 'country', op: 'in', value: 'nl', entity: 'fac' }]), 1);
        assert.equal(count(ENTITIES.netixlan, [{ field: 'ipaddr6', op: 'in', value: '2001:db8::a' }]), 1);
    });

    it('numeric __in still uses the index', () => {
        for (const [tag, field] of [['netixlan', 'ix_id'], ['net', 'asn'], ['netfac', 'fac_id']]) {
            const entity = ENTITIES[tag];
            const p = plan(buildRowQuery(entity, [{ field, op: 'in', value: '1,2' }], OPTS));
            assert.ok(!scans(p, entity.table), `${tag}.${field}: full scan\n  ${p.join('\n  ')}`);
        }
    });
});

describe('the If-Modified-Since change check uses the primary key', () => {
    // Its marker clause once filtered on id alone and scanned _row_changes
    // on every call: 88% of production's D1 rows read.
    for (const [tag, entity] of Object.entries(ENTITIES)) {
        it(`${tag} at depth 0, 1 and 2: no scan of _row_changes`, () => {
            for (const depth of [0, 1, 2]) {
                const p = plan({ sql: changeCheckSql(entity, depth), params: [0, 1] });
                const bad = p.filter(d => /^SCAN _row_changes\b/.test(d.trim()));
                assert.deepEqual(bad, [], `depth ${depth}:\n  ${p.join('\n  ')}`);
            }
        });
    }
});
