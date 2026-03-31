/**
 * @fileoverview Unit tests for depth expansion logic.
 * Uses a mock D1 database binding to verify depth=0 and depth=1
 * behaviour without a real database.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandDepth } from '../../api/depth.js';

/**
 * Creates a mock D1 database that returns pre-defined results
 * for prepared statements. The mock tracks which SQL was executed.
 *
 * @param {Record<string, any[]>} responses - Map of SQL substring → results to return.
 * @returns {{db: D1Database, queries: string[]}} Mock DB and query log.
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

const NET_ENTITY = {
    tag: "net",
    table: "peeringdb_network",
    columns: ["id", "name", "asn"],
    filters: {},
    relationships: [
        { field: "netfac_set", table: "peeringdb_network_facility", fk: "net_id" },
        { field: "poc_set", table: "peeringdb_network_contact", fk: "net_id" }
    ]
};

const ENTITY_NO_RELS = {
    tag: "ixpfx",
    table: "peeringdb_ixlan_prefix",
    columns: ["id", "prefix"],
    filters: {},
    relationships: []
};

describe("expandDepth", () => {
    it("should do nothing at depth=0", async () => {
        const { db, queries } = mockD1({});
        const rows = [{ id: 1, name: "Test" }];
        await expandDepth(db, NET_ENTITY, rows, 0);
        assert.equal(queries.length, 0);
        assert.equal(rows[0].netfac_set, undefined);
    });

    it("should do nothing for empty rows", async () => {
        const { db, queries } = mockD1({});
        await expandDepth(db, NET_ENTITY, [], 1);
        assert.equal(queries.length, 0);
    });

    it("should do nothing for entity with no relationships", async () => {
        const { db, queries } = mockD1({});
        const rows = [{ id: 1, prefix: "10.0.0.0/24" }];
        await expandDepth(db, ENTITY_NO_RELS, rows, 1);
        assert.equal(queries.length, 0);
    });

    it("should expand depth=1 with child IDs", async () => {
        const { db } = mockD1({
            peeringdb_network_facility: [
                { id: 100, net_id: 1 },
                { id: 101, net_id: 1 },
                { id: 102, net_id: 2 }
            ],
            peeringdb_network_contact: [
                { id: 200, net_id: 1 },
                { id: 201, net_id: 2 }
            ]
        });

        const rows = [
            { id: 1, name: "Net A" },
            { id: 2, name: "Net B" }
        ];

        await expandDepth(db, NET_ENTITY, rows, 1);

        // Net A should have 2 netfac IDs and 1 poc ID
        assert.deepEqual(rows[0].netfac_set, [100, 101]);
        assert.deepEqual(rows[0].poc_set, [200]);

        // Net B should have 1 netfac ID and 1 poc ID
        assert.deepEqual(rows[1].netfac_set, [102]);
        assert.deepEqual(rows[1].poc_set, [201]);
    });

    it("should return empty arrays when no children exist", async () => {
        const { db } = mockD1({
            peeringdb_network_facility: [],
            peeringdb_network_contact: []
        });

        const rows = [{ id: 1, name: "Net A" }];
        await expandDepth(db, NET_ENTITY, rows, 1);

        assert.deepEqual(rows[0].netfac_set, []);
        assert.deepEqual(rows[0].poc_set, []);
    });

    it("should handle multiple parent rows correctly", async () => {
        const { db } = mockD1({
            peeringdb_network_facility: [
                { id: 10, net_id: 1 },
                { id: 20, net_id: 3 }
            ],
            peeringdb_network_contact: []
        });

        const rows = [
            { id: 1, name: "A" },
            { id: 2, name: "B" },
            { id: 3, name: "C" }
        ];

        await expandDepth(db, NET_ENTITY, rows, 1);

        assert.deepEqual(rows[0].netfac_set, [10]);
        assert.deepEqual(rows[1].netfac_set, []);
        assert.deepEqual(rows[2].netfac_set, [20]);
    });
});
