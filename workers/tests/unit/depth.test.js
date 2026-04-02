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

function f(name, type, opts) {
    const def = { name, type };
    if (opts?.queryable === false) def.queryable = false;
    if (opts?.json === true) def.json = true;
    return def;
}

/** @type {EntityMeta} */
const NET_ENTITY = {
    tag: "net",
    table: "peeringdb_network",
    fields: [
        f("id", "number"),
        f("name", "string"),
        f("asn", "number"),
    ],
    relationships: [
        { field: "netfac_set", table: "peeringdb_network_facility", fk: "net_id" },
        { field: "poc_set", table: "peeringdb_network_contact", fk: "net_id" }
    ]
};

/** @type {EntityMeta} */
const ENTITY_NO_RELS = {
    tag: "ixpfx",
    table: "peeringdb_ixlan_prefix",
    fields: [
        f("id", "number"),
        f("prefix", "string"),
    ],
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

    it("should expand depth=2 with full child objects", async () => {
        const { db } = mockD1({
            peeringdb_network_facility: [
                { id: 100, net_id: 1, name: "Equinix DC1", city: "Ashburn", fac_id: 55, local_asn: 13335, created: "2024-01-01", updated: "2024-01-01", status: "ok" },
                { id: 101, net_id: 1, name: "Equinix DC2", city: "Chicago", fac_id: 56, local_asn: 13335, created: "2024-01-01", updated: "2024-01-01", status: "ok" }
            ],
            peeringdb_network_contact: [
                { id: 200, net_id: 1, role: "Abuse", visible: "Users", name: "NOC", phone: "+1", email: "noc@test.net", url: "", created: "2024-01-01", updated: "2024-01-01", status: "ok" }
            ]
        });

        const rows = [{ id: 1, name: "Test Net" }];
        await expandDepth(db, NET_ENTITY, rows, 2);

        // Should have full objects, not just IDs
        assert.equal(rows[0].netfac_set.length, 2);
        assert.equal(typeof rows[0].netfac_set[0], "object");
        assert.equal(rows[0].netfac_set[0].id, 100);
        assert.equal(rows[0].netfac_set[0].name, "Equinix DC1");
        assert.equal(rows[0].netfac_set[0].city, "Ashburn");

        // FK column (net_id) should be excluded from child objects
        assert.equal(rows[0].netfac_set[0].net_id, undefined);
        assert.equal(rows[0].netfac_set[1].net_id, undefined);

        // poc_set should have full objects too
        assert.equal(rows[0].poc_set.length, 1);
        assert.equal(rows[0].poc_set[0].role, "Abuse");
        assert.equal(rows[0].poc_set[0].net_id, undefined);
    });

    it("depth=2 should parse JSON-stored TEXT columns in children", async () => {
        // Test uses the carrier entity which has social_media as a json field.
        // The real carrier entity is registered in ENTITIES and used by depth.js via TABLE_TO_TAG.
        /** @type {EntityMeta} */
        const ORG_WITH_CARRIERS = {
            tag: "org",
            table: "peeringdb_organization",
            fields: [f("id", "number"), f("name", "string")],
            relationships: [
                { field: "carrier_set", table: "peeringdb_carrier", fk: "org_id" }
            ]
        };

        const { db } = mockD1({
            peeringdb_carrier: [
                { id: 100, org_id: 1, name: "Test Carrier", social_media: '[{"service":"website","identifier":"https://example.com"}]', created: "2024-01-01", updated: "2024-01-01", status: "ok" }
            ]
        });

        const rows = [{ id: 1, name: "Test Org" }];
        await expandDepth(db, ORG_WITH_CARRIERS, rows, 2);

        // social_media should be parsed from JSON string to array
        const carrier = rows[0].carrier_set[0];
        assert.ok(Array.isArray(carrier.social_media), "social_media should be parsed to array");
        assert.equal(carrier.social_media[0].service, "website");
    });

    it("depth=2 should return empty arrays when no children", async () => {
        const { db } = mockD1({
            peeringdb_network_facility: [],
            peeringdb_network_contact: []
        });

        const rows = [{ id: 1, name: "Test Net" }];
        await expandDepth(db, NET_ENTITY, rows, 2);

        assert.deepEqual(rows[0].netfac_set, []);
        assert.deepEqual(rows[0].poc_set, []);
    });

    it("depth=2 should handle multiple parents correctly", async () => {
        const { db } = mockD1({
            peeringdb_network_facility: [
                { id: 10, net_id: 1, name: "DC-A", status: "ok" },
                { id: 20, net_id: 3, name: "DC-B", status: "ok" }
            ],
            peeringdb_network_contact: []
        });

        const rows = [
            { id: 1, name: "A" },
            { id: 2, name: "B" },
            { id: 3, name: "C" }
        ];

        await expandDepth(db, NET_ENTITY, rows, 2);

        assert.equal(rows[0].netfac_set.length, 1);
        assert.equal(rows[0].netfac_set[0].name, "DC-A");
        assert.deepEqual(rows[1].netfac_set, []);
        assert.equal(rows[2].netfac_set.length, 1);
        assert.equal(rows[2].netfac_set[0].name, "DC-B");
    });

    it("depth=2 should coerce boolean fields on child objects", async () => {
        // Use ix entity as parent → ixlan children have boolean fields
        // (dot1q_support, ixf_ixp_import_enabled)
        /** @type {EntityMeta} */
        const IX_WITH_IXLAN = {
            tag: "ix",
            table: "peeringdb_ix",
            fields: [f("id", "number"), f("name", "string")],
            relationships: [
                { field: "ixlan_set", table: "peeringdb_ixlan", fk: "ix_id" }
            ]
        };

        const { db } = mockD1({
            peeringdb_ixlan: [
                // SQLite returns 0/1 for booleans; these should become false/true
                { id: 10, ix_id: 1, name: "LAN 1", descr: "", mtu: 1500, dot1q_support: 1, rs_asn: 0, arp_sponge: null, ixf_ixp_member_list_url_visible: "", ixf_ixp_import_enabled: 0, created: "2024-01-01", updated: "2024-01-01", status: "ok" }
            ]
        });

        const rows = [{ id: 1, name: "Test IX" }];
        await expandDepth(db, IX_WITH_IXLAN, rows, 2);

        const child = rows[0].ixlan_set[0];
        assert.strictEqual(child.dot1q_support, true, "dot1q_support 1 should coerce to true");
        assert.strictEqual(child.ixf_ixp_import_enabled, false, "ixf_ixp_import_enabled 0 should coerce to false");
    });
});
