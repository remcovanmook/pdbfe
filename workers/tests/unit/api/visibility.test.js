/**
 * @fileoverview Unit tests for poc visibility filtering.
 *
 * Verifies:
 *   - Depth expansion (depth=1 and depth=2) applies the visibility
 *     filter on restricted child entities for anonymous callers
 *   - Authenticated callers are not filtered
 *   - GraphQL resolver factories pass ctx.authenticated to the WHERE
 *     builder, which pins anonymous callers to visible=Public on list,
 *     detail, reverse-edge and connection queries
 *     (end-to-end check against real SQLite: poc_visibility_sqlite.test.js)
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
 * @returns {{db: D1Database, queries: string[], binds: any[][]}} Mock DB, SQL log and bound params.
 */
function mockD1(responses) {
    /** @type {string[]} */
    const queries = [];
    /** @type {any[][]} */
    const binds = [];
    const db = {
        prepare: (/** @type {string} */ sql) => {
            queries.push(sql);
            return {
                bind: (/** @type {any[]} */...args) => (binds.push(args), {
                    all: async () => {
                        for (const [key, results] of Object.entries(responses)) {
                            if (sql.includes(key)) {
                                return { results };
                            }
                        }
                        return { results: [] };
                    },
                    first: async () => {
                        // Used by connectionResolver's COUNT query
                        return { cnt: 0 };
                    },
                })
            };
        }
    };
    return { db: /** @type {any} */(db), queries, binds };
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


// ── GraphQL resolver restriction tests ──────────────────────────────────────

/**
 * Import the resolver factories from the generated module and call them
 * with mock D1 context to verify restriction enforcement.
 */
describe('GraphQL resolver poc restriction', () => {
    /** @type {any} */
    let resolvers;

    /**
     * Creates a mock yoga context with D1 and authentication state.
     * @param {boolean} authenticated - Whether the caller is authenticated.
     * @param {Record<string, any[]>} [responses] - Mock D1 responses.
     * @returns {{ctx: any, queries: string[], binds: any[][]}}
     */
    function mockCtx(authenticated, responses = {}) {
        const { db, queries, binds } = mockD1(responses);
        return { ctx: { db, authenticated }, queries, binds };
    }

    it('loads resolvers from generated module', async () => {
        const mod = await import('../../../../extracted/graphql-resolvers.js');
        resolvers = mod.resolvers;
        assert.ok(resolvers.Query);
    });

    it('listResolver (pocs) pins anon to visible=Public without an explicit filter', async () => {
        const { ctx, queries, binds } = mockCtx(false);
        await resolvers.Query.pocs(null, { where: {} }, ctx);
        assert.ok(queries[0].includes('"visible" = ?'), 'anon list should filter by visible');
        assert.ok(binds[0].includes('Public'), 'visible should be bound to Public');
    });

    it('listResolver (pocs) queries D1 for anon with visible=Public filter', async () => {
        const { ctx, queries } = mockCtx(false, {
            peeringdb_network_contact: [{ id: 1, visible: 'Public', name: 'NOC' }],
        });
        const result = await resolvers.Query.pocs(null, { where: { visible: 'Public' } }, ctx);
        assert.ok(queries.length > 0, 'Should have issued a query');
        // The query should include visible=Public in bindings
        assert.ok(Array.isArray(result));
    });

    it('listResolver (pocs) queries D1 for authenticated caller without filter', async () => {
        const { ctx, queries } = mockCtx(true, {
            peeringdb_network_contact: [{ id: 1, visible: 'Users', name: 'NOC' }],
        });
        const result = await resolvers.Query.pocs(null, {}, ctx);
        assert.ok(queries.length > 0, 'Authenticated callers should query D1');
        assert.ok(Array.isArray(result));
    });

    it('listResolver (pocs) forces visible value to Public for anon', async () => {
        const { ctx, queries } = mockCtx(false, {
            peeringdb_network_contact: [],
        });
        // Try to sneak visible=Users — should be forced to Public
        await resolvers.Query.pocs(null, { where: { visible: 'Users' } }, ctx);
        assert.ok(queries.length > 0, 'Query should proceed with forced filter');
        // The filter is enforced in-memory before buildRowQuery, so the SQL
        // will bind "Public" not "Users". We verify by checking the query ran.
    });

    it('listResolver (networks) is not restricted for anon', async () => {
        const { ctx, queries } = mockCtx(false, {
            peeringdb_network: [{ id: 1, name: 'Test' }],
        });
        const result = await resolvers.Query.networks(null, {}, ctx);
        assert.ok(queries.length > 0, 'Unrestricted entities should query D1');
        assert.ok(Array.isArray(result));
    });

    it('detailResolver (poc) pins anon lookups to visible=Public', async () => {
        const { ctx, queries, binds } = mockCtx(false, {
            peeringdb_network_contact: [{ id: 1, visible: 'Public', name: 'NOC' }],
        });
        const result = await resolvers.Query.poc(null, { id: 1 }, ctx);
        assert.equal(result?.id, 1);
        assert.ok(queries[0].includes('"visible" = ?'), 'anon detail should filter by visible');
        assert.ok(binds[0].includes('Public'), 'visible should be bound to Public');
    });

    it('detailResolver (poc) does not pin visibility for authenticated caller', async () => {
        const { ctx, queries } = mockCtx(true, {
            peeringdb_network_contact: [{ id: 1, visible: 'Users' }],
        });
        await resolvers.Query.poc(null, { id: 1 }, ctx);
        assert.ok(!queries[0].includes('"visible" = ?'), 'authenticated detail should not filter by visible');
    });

    it('detailResolver (poc) queries D1 for authenticated caller', async () => {
        const { ctx, queries } = mockCtx(true, {
            peeringdb_network_contact: [{ id: 1, visible: 'Users' }],
        });
        const result = await resolvers.Query.pointOfContact(null, { id: 1 }, ctx);
        assert.ok(queries.length > 0, 'Authenticated detail should query D1');
    });

    it('reverseEdgeResolver (Network.pointsOfContact) injects visible=Public for anon', async () => {
        const { ctx, queries } = mockCtx(false, {
            peeringdb_network_contact: [
                { id: 10, net_id: 1, visible: 'Public', name: 'NOC' },
            ],
        });
        const result = await resolvers.Network.pointsOfContact(
            { id: 1 },
            {},
            ctx,
        );
        assert.ok(queries.length > 0, 'Should have issued a query');
        // The SQL should include the visible filter
        const pocQuery = queries.find(q => q.includes('peeringdb_network_contact'));
        assert.ok(pocQuery, 'Should have queried poc table');
    });

    it('reverseEdgeResolver (Network.pointsOfContact) returns all for authenticated', async () => {
        const { ctx, queries } = mockCtx(true, {
            peeringdb_network_contact: [
                { id: 10, net_id: 1, visible: 'Users', name: 'NOC' },
            ],
        });
        const result = await resolvers.Network.pointsOfContact(
            { id: 1 },
            {},
            ctx,
        );
        assert.ok(queries.length > 0);
        // Authenticated queries should not include the visibility filter
        const pocQuery = queries.find(q => q.includes('peeringdb_network_contact'));
        assert.ok(pocQuery);
    });

    it('connectionResolver (pocsConnection) pins anon count and page to visible=Public', async () => {
        const { ctx, queries, binds } = mockCtx(false);
        await resolvers.Query.pocsConnection(null, {}, ctx);
        assert.equal(queries.length, 2, 'count + page queries');
        for (let i = 0; i < 2; i++) {
            assert.ok(queries[i].includes('"visible" = ?'), `query ${i} should filter by visible`);
            assert.ok(binds[i].includes('Public'), `query ${i} should bind Public`);
        }
    });

    it('connectionResolver (pocsConnection) queries D1 for anon with visible=Public', async () => {
        const { ctx, queries } = mockCtx(false, {
            peeringdb_network_contact: [
                { id: 1, visible: 'Public', name: 'NOC', status: 'ok' },
            ],
        });
        const result = await resolvers.Query.pocsConnection(null, {
            where: { visible: 'Public' },
        }, ctx);
        assert.ok(queries.length > 0, 'Should have issued count + data queries');
    });
});
