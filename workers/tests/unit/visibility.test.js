/**
 * @fileoverview Unit tests for poc visibility filtering.
 *
 * Verifies that:
 *   - enforceAnonFilter strips user-supplied visible= parameters
 *   - enforceAnonFilter injects the mandatory system filter
 *   - Depth expansion (both depth=1 and depth=2) applies the visibility
 *     filter on restricted child entities for anonymous callers
 *   - Authenticated callers are not filtered
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enforceAnonFilter, ENTITIES } from '../../api/entities.js';
import { expandDepth } from '../../api/depth.js';

// ── enforceAnonFilter tests ──────────────────────────────────────────────────

describe('enforceAnonFilter', () => {
    const pocEntity = ENTITIES['poc'];

    it('should inject visible=Public filter on empty filter list', () => {
        /** @type {ParsedFilter[]} */
        const filters = [];
        enforceAnonFilter(pocEntity, filters);

        assert.equal(filters.length, 1);
        assert.equal(filters[0].field, 'visible');
        assert.equal(filters[0].op, 'eq');
        assert.equal(filters[0].value, 'Public');
    });

    it('should strip user-supplied visible=Private and inject Public', () => {
        /** @type {ParsedFilter[]} */
        const filters = [
            { field: 'visible', op: 'eq', value: 'Private' },
        ];
        enforceAnonFilter(pocEntity, filters);

        assert.equal(filters.length, 1);
        assert.equal(filters[0].field, 'visible');
        assert.equal(filters[0].op, 'eq');
        assert.equal(filters[0].value, 'Public');
    });

    it('should strip user-supplied visible=Users and inject Public', () => {
        /** @type {ParsedFilter[]} */
        const filters = [
            { field: 'visible', op: 'eq', value: 'Users' },
        ];
        enforceAnonFilter(pocEntity, filters);

        assert.equal(filters.length, 1);
        assert.equal(filters[0].value, 'Public');
    });

    it('should strip visible__contains injection attempts', () => {
        /** @type {ParsedFilter[]} */
        const filters = [
            { field: 'visible', op: 'contains', value: 'Priv' },
        ];
        enforceAnonFilter(pocEntity, filters);

        assert.equal(filters.length, 1);
        assert.equal(filters[0].field, 'visible');
        assert.equal(filters[0].op, 'eq');
        assert.equal(filters[0].value, 'Public');
    });

    it('should strip visible__in injection attempts', () => {
        /** @type {ParsedFilter[]} */
        const filters = [
            { field: 'visible', op: 'in', value: 'Public,Private,Users' },
        ];
        enforceAnonFilter(pocEntity, filters);

        assert.equal(filters.length, 1);
        assert.equal(filters[0].op, 'eq');
        assert.equal(filters[0].value, 'Public');
    });

    it('should strip multiple user-supplied visible filters', () => {
        /** @type {ParsedFilter[]} */
        const filters = [
            { field: 'visible', op: 'eq', value: 'Private' },
            { field: 'visible', op: 'eq', value: 'Users' },
            { field: 'visible', op: 'contains', value: '' },
        ];
        enforceAnonFilter(pocEntity, filters);

        assert.equal(filters.length, 1);
        assert.equal(filters[0].value, 'Public');
    });

    it('should preserve non-visible filters', () => {
        /** @type {ParsedFilter[]} */
        const filters = [
            { field: 'role', op: 'eq', value: 'Abuse' },
            { field: 'visible', op: 'eq', value: 'Private' },
            { field: 'net_id', op: 'eq', value: '694' },
        ];
        enforceAnonFilter(pocEntity, filters);

        assert.equal(filters.length, 3);
        // The two non-visible filters should be untouched
        const role = filters.find(f => f.field === 'role');
        assert.ok(role);
        assert.equal(role.value, 'Abuse');
        const netId = filters.find(f => f.field === 'net_id');
        assert.ok(netId);
        assert.equal(netId.value, '694');
        // The visible filter should be the forced one
        const vis = filters.find(f => f.field === 'visible');
        assert.ok(vis);
        assert.equal(vis.value, 'Public');
    });

    it('should not touch cross-entity visible filters', () => {
        // A cross-entity filter on visible (e.g. from another entity)
        // should not be stripped since it targets a different table
        /** @type {ParsedFilter[]} */
        const filters = [
            { field: 'visible', op: 'eq', value: 'Private', entity: 'net' },
        ];
        enforceAnonFilter(pocEntity, filters);

        // Cross-entity filter preserved, system filter added
        assert.equal(filters.length, 2);
        assert.equal(filters[0].entity, 'net');
        assert.equal(filters[0].value, 'Private');
        assert.equal(filters[1].field, 'visible');
        assert.equal(filters[1].value, 'Public');
    });

    it('should be a no-op for entities without anonFilter', () => {
        const netEntity = ENTITIES['net'];
        /** @type {ParsedFilter[]} */
        const filters = [
            { field: 'asn', op: 'eq', value: '13335' },
        ];
        enforceAnonFilter(netEntity, filters);

        // Should not modify filters
        assert.equal(filters.length, 1);
        assert.equal(filters[0].field, 'asn');
    });
});

// ── Depth expansion visibility tests ─────────────────────────────────────────

/**
 * Creates a mock D1 database that captures SQL and returns pre-defined results.
 * Matches results by checking if the SQL contains a key substring.
 *
 * @param {Record<string, any[]>} responses - Map of SQL substring → results.
 * @returns {{db: D1Database, queries: string[]}} Mock DB and SQL log.
 */
function mockD1(responses) {
    /** @type {string[]} */
    const queries = [];
    const db = {
        prepare: (/** @type {string} */ sql) => {
            queries.push(sql);
            return {
                bind: (/** @type {any[]} */...args) => ({
                    all: async () => {
                        for (const [key, results] of Object.entries(responses)) {
                            if (sql.includes(key)) {
                                return { results };
                            }
                        }
                        return { results: [] };
                    }
                })
            };
        }
    };
    return { db: /** @type {any} */(db), queries };
}

function f(name, type, opts) {
    const def = { name, type };
    if (opts?.queryable === false) def.queryable = false;
    if (opts?.json === true) def.json = true;
    return def;
}

/** @type {EntityMeta} */
const NET_ENTITY = {
    tag: 'net',
    table: 'peeringdb_network',
    fields: [
        f('id', 'number'),
        f('name', 'string'),
        f('asn', 'number'),
    ],
    relationships: [
        { field: 'netfac_set', table: 'peeringdb_network_facility', fk: 'net_id' },
        { field: 'poc_set', table: 'peeringdb_network_contact', fk: 'net_id' },
    ],
};

describe('depth expansion - poc visibility filtering', () => {
    it('depth=1 anonymous should add visible=Public filter on poc_set query', async () => {
        const { db, queries } = mockD1({
            peeringdb_network_facility: [
                { id: 100, net_id: 1 },
            ],
            peeringdb_network_contact: [
                { id: 200, net_id: 1 },
            ],
        });

        const rows = [{ id: 1, name: 'Test Net' }];
        await expandDepth(db, NET_ENTITY, rows, 1, false);

        // Find the poc query and verify it includes the visibility filter
        const pocQuery = queries.find(q => q.includes('peeringdb_network_contact'));
        assert.ok(pocQuery, 'Should have queried the poc table');
        assert.ok(pocQuery.includes('AND "visible" = ?'), 'poc query should filter by visible in WHERE');

        // The netfac query should NOT have a visibility filter
        const netfacQuery = queries.find(q => q.includes('peeringdb_network_facility'));
        assert.ok(netfacQuery, 'Should have queried the netfac table');
        assert.ok(!netfacQuery.includes('"visible"'), 'netfac query should not filter by visible');
    });

    it('depth=2 anonymous should add visible=Public filter on poc_set query', async () => {
        const { db, queries } = mockD1({
            peeringdb_network_facility: [
                { id: 100, net_id: 1, name: 'DC', status: 'ok' },
            ],
            peeringdb_network_contact: [
                { id: 200, net_id: 1, role: 'NOC', visible: 'Public', name: 'NOC', email: 'noc@test.net', status: 'ok' },
            ],
        });

        const rows = [{ id: 1, name: 'Test Net' }];
        await expandDepth(db, NET_ENTITY, rows, 2, false);

        const pocQuery = queries.find(q => q.includes('peeringdb_network_contact'));
        assert.ok(pocQuery, 'Should have queried the poc table');
        // Check for the visibility filter in the WHERE clause (AND "visible" = ?)
        assert.ok(pocQuery.includes('AND "visible" = ?'), 'depth=2 poc query should filter by visible in WHERE');
    });

    it('depth=1 authenticated should NOT add visible filter on poc_set query', async () => {
        const { db, queries } = mockD1({
            peeringdb_network_facility: [],
            peeringdb_network_contact: [
                { id: 200, net_id: 1 },
            ],
        });

        const rows = [{ id: 1, name: 'Test Net' }];
        await expandDepth(db, NET_ENTITY, rows, 1, true);

        const pocQuery = queries.find(q => q.includes('peeringdb_network_contact'));
        assert.ok(pocQuery);
        assert.ok(!pocQuery.includes('AND "visible" = ?'), 'Authenticated poc query should not filter by visible');
    });

    it('depth=2 authenticated should NOT add visible filter on poc_set query', async () => {
        const { db, queries } = mockD1({
            peeringdb_network_facility: [],
            peeringdb_network_contact: [
                { id: 200, net_id: 1, role: 'NOC', visible: 'Users', name: 'NOC', email: 'noc@test.net', status: 'ok' },
            ],
        });

        const rows = [{ id: 1, name: 'Test Net' }];
        await expandDepth(db, NET_ENTITY, rows, 2, true);

        const pocQuery = queries.find(q => q.includes('peeringdb_network_contact'));
        assert.ok(pocQuery);
        assert.ok(!pocQuery.includes('AND "visible" = ?'), 'Authenticated depth=2 poc query should not filter by visible');
    });

    it('depth=0 should not query at all (unchanged behaviour)', async () => {
        const { db, queries } = mockD1({});
        const rows = [{ id: 1, name: 'Test Net' }];
        await expandDepth(db, NET_ENTITY, rows, 0, false);
        assert.equal(queries.length, 0);
    });
});
