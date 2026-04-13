/**
 * @fileoverview Unit tests for poc visibility filtering during depth expansion.
 *
 * Verifies that:
 *   - Depth expansion (both depth=1 and depth=2) applies the visibility
 *     filter on restricted child entities for anonymous callers
 *   - Authenticated callers are not filtered
 *
 * Note: Direct queries to /api/poc are handled by a short-circuit in
 * api/index.js that returns an empty response for anonymous callers.
 * There is no filter-injection function to test for that path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES } from '../../../api/entities.js';
import { expandDepth } from '../../../api/depth.js';


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
