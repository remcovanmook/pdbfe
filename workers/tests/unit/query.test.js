/**
 * @fileoverview Unit tests for the SQL query builder.
 * Tests filter translation, parameter binding, injection prevention,
 * pagination, 'since' handling, and the default status=ok filter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, buildRowQuery, buildJsonQuery, buildCountQuery, nextPageParams } from '../../api/query.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Shorthand field definition (queryable by default).
 * @param {string} name
 * @param {'string'|'number'|'boolean'|'datetime'} type
 * @param {Object} [opts]
 * @returns {FieldDef}
 */
function f(name, type, opts) {
    const def = { name, type };
    if (opts?.queryable === false) def.queryable = false;
    if (opts?.json === true) def.json = true;
    return def;
}

// ── Mock entities ────────────────────────────────────────────────────────────

/** @type {EntityMeta} */
const NET_ENTITY = {
    tag: "net",
    table: "peeringdb_network",
    fields: [
        f("id", "number"),
        f("name", "string"),
        f("asn", "number"),
        f("org_id", "number"),
        f("status", "string"),
        f("updated", "datetime"),
    ],
    relationships: []
};

/** @type {EntityMeta} */
const NETIXLAN_ENTITY = {
    tag: "netixlan",
    table: "peeringdb_network_ixlan",
    fields: [
        f("id", "number"),
        f("net_id", "number"),
        f("ix_id", "number"),
        f("name", "string"),
        f("asn", "number"),
        f("speed", "number"),
        f("status", "string"),
    ],
    joinColumns: [{
        table: "peeringdb_network",
        localFk: "net_id",
        columns: { name: "net_name" }
    }],
    relationships: []
};

// Because the default status=ok filter is now injected, tests that previously
// expected no WHERE clause will see one. Tests that provide an explicit
// status filter will not get the default injected.

describe("buildQuery", () => {
    it("should build a basic SELECT with default status filter", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('SELECT "id", "name", "asn", "org_id", "status", "updated"'));
        assert.ok(result.sql.includes('WHERE "status" = ?'));
        assert.ok(result.sql.includes('ORDER BY "id" ASC'));
        assert.deepEqual(result.params, ["ok"]);
    });

    it("should apply equality filter alongside default status", () => {
        const filters = [{ field: "asn", op: "eq", value: "13335" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"asn" = ?'));
        assert.ok(result.sql.includes('"status" = ?'));
        assert.deepEqual(result.params, ["ok", 13335]);
    });

    it("should not inject default status when explicit status filter is provided", () => {
        const filters = [{ field: "status", op: "eq", value: "deleted" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        // Should have exactly one status = ? in the WHERE clause
        const whereClause = result.sql.slice(result.sql.indexOf('WHERE'));
        const statusMatches = whereClause.match(/"status" = \?/g);
        assert.equal(statusMatches?.length, 1);
        assert.deepEqual(result.params, ["deleted"]);
    });

    it("should apply numeric comparison filters", () => {
        const filters = [{ field: "id", op: "gt", value: "100" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"id" > ?'));
    });

    it("should apply lte and gte filters", () => {
        const filters = [
            { field: "id", op: "gte", value: "10" },
            { field: "id", op: "lte", value: "20" }
        ];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"id" >= ?'));
        assert.ok(result.sql.includes('"id" <= ?'));
    });

    it("should apply contains filter (case-insensitive)", () => {
        const filters = [{ field: "name", op: "contains", value: "Cloudflare" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIKE '%' || ? || '%' COLLATE NOCASE"));
    });

    it("should apply startswith filter", () => {
        const filters = [{ field: "name", op: "startswith", value: "Cloud" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIKE ? || '%' COLLATE NOCASE"));
    });

    it("should apply IN filter with multiple values", () => {
        const filters = [{ field: "id", op: "in", value: "1,5,10" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"id" IN (?, ?, ?)'));
    });

    it("should ignore unknown fields", () => {
        const filters = [{ field: "nonexistent", op: "eq", value: "foo" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        // Still has the default status filter
        assert.ok(result.sql.includes('"status" = ?'));
        assert.deepEqual(result.params, ["ok"]);
    });

    it("should ignore unknown operators", () => {
        const filters = [{ field: "name", op: "regex", value: ".*" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        // Only the default status filter
        assert.deepEqual(result.params, ["ok"]);
    });

    it("should handle single ID fetch", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 }, 42);
        assert.ok(result.sql.includes('"id" = ?'));
        assert.ok(result.params.includes(42));
    });

    it("should apply 'since' as datetime filter on updated", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 1700000000 });
        assert.ok(result.sql.includes('"updated" >= datetime(?, \'unixepoch\')'));
        assert.ok(result.params.includes(1700000000));
    });

    it("should apply LIMIT and OFFSET", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 0, limit: 10, skip: 20, since: 0 });
        assert.ok(result.sql.includes("LIMIT ?"));
        assert.ok(result.sql.includes("OFFSET ?"));
        assert.ok(result.params.includes(10));
        assert.ok(result.params.includes(20));
    });

    it("should cap limit at 250 when depth > 0", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 1, limit: 500, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIMIT ?"));
        assert.ok(result.params.includes(250));
    });

    it("should default limit to 250 when depth > 0 and no limit specified", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 1, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIMIT ?"));
        assert.ok(result.params.includes(250));
    });

    it("should combine explicit status filter with other filters", () => {
        const filters = [
            { field: "status", op: "eq", value: "ok" },
            { field: "asn", op: "gt", value: "1000" }
        ];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"status" = ? AND "asn" > ?'));
        assert.deepEqual(result.params, ["ok", 1000]);
    });

    it("should coerce boolean filter values", () => {
        const boolEntity = {
            ...NET_ENTITY,
            fields: [
                ...NET_ENTITY.fields,
                f("info_unicast", "boolean"),
            ]
        };
        const filters = [{ field: "info_unicast", op: "eq", value: "true" }];
        const result = buildQuery(boolEntity, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.params.includes(1));
    });

    it("should handle skip without limit using LIMIT -1", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 50, since: 0 });
        assert.ok(result.sql.includes("LIMIT -1 OFFSET ?"));
        assert.ok(result.params.includes(50));
    });

    it("should always ORDER BY id ASC", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('ORDER BY "id" ASC'));
    });
});

describe("nextPageParams", () => {
    it("should return null when no limit is set", () => {
        const result = nextPageParams([], { depth: 0, limit: 0, skip: 0, since: 0 }, 100);
        assert.equal(result, null);
    });

    it("should return null when result count is less than limit (last page)", () => {
        const result = nextPageParams([], { depth: 0, limit: 50, skip: 0, since: 0 }, 30);
        assert.equal(result, null);
    });

    it("should return next page params when result fills the limit", () => {
        const result = nextPageParams([], { depth: 0, limit: 50, skip: 0, since: 0 }, 50);
        assert.deepEqual(result, { limit: 50, skip: 50 });
    });

    it("should accumulate skip for subsequent pages", () => {
        const result = nextPageParams([], { depth: 0, limit: 50, skip: 100, since: 0 }, 50);
        assert.deepEqual(result, { limit: 50, skip: 150 });
    });

    it("should use 250 as effective limit when depth > 0 and no explicit limit", () => {
        const result = nextPageParams([], { depth: 1, limit: 0, skip: 0, since: 0 }, 250);
        assert.deepEqual(result, { limit: 250, skip: 250 });
    });
});

describe("buildRowQuery with joinColumns", () => {
    it("should generate LEFT JOIN and aliased SELECT columns", () => {
        const result = buildRowQuery(NETIXLAN_ENTITY, [], { depth: 0, limit: 10, skip: 0, since: 0 });
        assert.ok(result.sql.includes('LEFT JOIN "peeringdb_network" AS j0'));
        assert.ok(result.sql.includes('ON t."net_id" = j0."id"'));
        assert.ok(result.sql.includes('j0."name" AS "net_name"'));
        assert.ok(result.sql.includes('FROM "peeringdb_network_ixlan" AS t'));
        assert.ok(result.sql.includes('ORDER BY t."id" ASC'));
    });

    it("should qualify WHERE filters with table alias", () => {
        const filters = [{ field: "ix_id", op: "eq", value: "26" }];
        const result = buildRowQuery(NETIXLAN_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('t."ix_id" = ?'));
    });

    it("should qualify single ID fetch with table alias", () => {
        const result = buildRowQuery(NETIXLAN_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 }, 42);
        assert.ok(result.sql.includes('t."id" = ?'));
    });

    it("should qualify IN filter with table alias", () => {
        const filters = [{ field: "asn", op: "in", value: "13335,8075" }];
        const result = buildRowQuery(NETIXLAN_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('t."asn" IN (?, ?)'));
    });
});

describe("buildJsonQuery with joinColumns", () => {
    it("should generate subquery with JOIN and outer json_object", () => {
        const result = buildJsonQuery(NETIXLAN_ENTITY, [], { depth: 0, limit: 5, skip: 0, since: 0 });
        assert.ok(result.sql.includes('json_group_array'));
        assert.ok(result.sql.includes('json_object'));
        assert.ok(result.sql.includes('LEFT JOIN "peeringdb_network"'));
        assert.ok(result.sql.includes('"net_name"'));
        assert.ok(result.sql.includes('AS payload'));
    });
});

describe("buildCountQuery", () => {
    it("should generate COUNT(*) query with default status filter", () => {
        const result = buildCountQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.equal(result.sql, 'SELECT COUNT(*) AS cnt FROM "peeringdb_network" WHERE "status" = ?');
        assert.deepEqual(result.params, ["ok"]);
    });

    it("should apply explicit status filter to COUNT query", () => {
        const filters = [{ field: "status", op: "eq", value: "ok" }];
        const result = buildCountQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('WHERE "status" = ?'));
        assert.deepEqual(result.params, ["ok"]);
    });

    it("should apply since filter to COUNT query", () => {
        const result = buildCountQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 1700000000 });
        assert.ok(result.sql.includes('"updated" >= datetime(?,'));
        assert.ok(result.params.includes(1700000000));
    });

    it("should ignore pagination in COUNT query", () => {
        const result = buildCountQuery(NET_ENTITY, [], { depth: 0, limit: 50, skip: 10, since: 0 });
        assert.ok(!result.sql.includes('LIMIT'));
        assert.ok(!result.sql.includes('OFFSET'));
    });
});

describe("fields parameter", () => {
    it("should restrict columns when fields option is provided", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 0, limit: 5, skip: 0, since: 0, fields: ["id", "name", "asn"] });
        assert.ok(result.sql.includes('"id"'));
        assert.ok(result.sql.includes('"name"'));
        assert.ok(result.sql.includes('"asn"'));
        assert.ok(!result.sql.includes('"org_id"'));
        assert.ok(!result.sql.includes('"updated"'));
    });

    it("should return all columns when fields is empty", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 0, limit: 5, skip: 0, since: 0, fields: [] });
        assert.ok(result.sql.includes('"org_id"'));
        assert.ok(result.sql.includes('"updated"'));
    });

    it("should restrict json_object columns in buildJsonQuery", () => {
        const result = buildJsonQuery(NET_ENTITY, [], { depth: 0, limit: 5, skip: 0, since: 0, fields: ["id", "name"] });
        assert.ok(result.sql.includes("'name'"));
        assert.ok(!result.sql.includes("'org_id'"));
    });
});

// ── validateQuery ────────────────────────────────────────────────────────────

import { validateQuery } from '../../api/entities.js';

describe("validateQuery", () => {
    it("should return null for valid filters", () => {
        const filters = [{ field: "asn", op: "eq", value: "13335" }];
        assert.equal(validateQuery(NET_ENTITY, filters, ''), null);
    });

    it("should return null for valid sort", () => {
        assert.equal(validateQuery(NET_ENTITY, [], '-name'), null);
        assert.equal(validateQuery(NET_ENTITY, [], 'asn'), null);
    });

    it("should reject unknown filter field", () => {
        const filters = [{ field: "nonexistent", op: "eq", value: "foo" }];
        const err = validateQuery(NET_ENTITY, filters, '');
        assert.ok(err?.includes("Unknown field 'nonexistent'"));
    });

    it("should reject non-queryable field", () => {
        /** @type {EntityMeta} */
        const entity = {
            ...NET_ENTITY,
            fields: [
                ...NET_ENTITY.fields,
                { name: 'logo', type: 'string', queryable: false },
            ]
        };
        const filters = [{ field: "logo", op: "eq", value: "test" }];
        const err = validateQuery(entity, filters, '');
        assert.ok(err?.includes("not filterable"));
    });

    it("should reject unknown operator", () => {
        const filters = [{ field: "name", op: "regex", value: ".*" }];
        const err = validateQuery(NET_ENTITY, filters, '');
        assert.ok(err?.includes("Unknown filter operator 'regex'"));
    });

    it("should reject unknown sort column", () => {
        const err = validateQuery(NET_ENTITY, [], 'nonexistent');
        assert.ok(err?.includes("Unknown sort column 'nonexistent'"));
    });

    it("should reject unknown descending sort column", () => {
        const err = validateQuery(NET_ENTITY, [], '-bogus');
        assert.ok(err?.includes("Unknown sort column 'bogus'"));
    });

    it("should accept empty filters and no sort", () => {
        assert.equal(validateQuery(NET_ENTITY, [], ''), null);
    });
});
