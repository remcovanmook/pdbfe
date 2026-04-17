/**
 * @fileoverview Unit tests for the SQL query builder.
 * Tests filter translation, parameter binding, injection prevention,
 * pagination, 'since' handling, and the default status=ok filter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRowQuery, buildJsonQuery, buildCountQuery, nextPageParams } from '../../../api/query.js';
import { validateQuery, MAX_IN_VALUES, ENTITIES, resolveImplicitFilters } from '../../../api/entities.js';
import { parseQueryFilters } from '../../../api/utils.js';

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

describe("buildRowQuery", () => {
    it("should build a basic SELECT with default status filter", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('SELECT "id", "name", "asn", "org_id", "status", "updated"'));
        assert.ok(result.sql.includes('WHERE "status" = ?'));
        assert.ok(result.sql.includes('ORDER BY "id" ASC'));
        assert.deepEqual(result.params, ["ok"]);
    });

    it("should apply equality filter alongside default status", () => {
        const filters = [{ field: "asn", op: "eq", value: "13335" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"asn" = ? COLLATE NOCASE'));
        assert.ok(result.sql.includes('"status" = ?'));
        assert.deepEqual(result.params, ["ok", 13335]);
    });

    it("should not inject default status when explicit status filter is provided", () => {
        const filters = [{ field: "status", op: "eq", value: "deleted" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        // Should have exactly one status = ? in the WHERE clause
        const whereClause = result.sql.slice(result.sql.indexOf('WHERE'));
        const statusMatches = whereClause.match(/"status" = \?/g);
        assert.equal(statusMatches?.length, 1);
        assert.deepEqual(result.params, ["deleted"]);
    });

    it("should apply numeric comparison filters", () => {
        const filters = [{ field: "id", op: "gt", value: "100" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"id" > ?'));
    });

    it("should apply lte and gte filters", () => {
        const filters = [
            { field: "id", op: "gte", value: "10" },
            { field: "id", op: "lte", value: "20" }
        ];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"id" >= ?'));
        assert.ok(result.sql.includes('"id" <= ?'));
    });

    it("should apply contains filter (case-insensitive)", () => {
        const filters = [{ field: "name", op: "contains", value: "Cloudflare" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIKE '%' || ? || '%' COLLATE NOCASE"));
    });

    it("should apply startswith filter", () => {
        const filters = [{ field: "name", op: "startswith", value: "Cloud" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIKE ? || '%' COLLATE NOCASE"));
    });

    it("should apply IN filter with multiple values", () => {
        const filters = [{ field: "id", op: "in", value: "1,5,10" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"id" IN (SELECT value FROM json_each(?))'));
    });

    it("should ignore unknown fields", () => {
        const filters = [{ field: "nonexistent", op: "eq", value: "foo" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        // Still has the default status filter
        assert.ok(result.sql.includes('"status" = ?'));
        assert.deepEqual(result.params, ["ok"]);
    });

    it("should ignore unknown operators", () => {
        const filters = [{ field: "name", op: "regex", value: ".*" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        // Only the default status filter
        assert.deepEqual(result.params, ["ok"]);
    });

    it("should handle single ID fetch", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 }, 42);
        assert.ok(result.sql.includes('"id" = ?'));
        assert.ok(result.params.includes(42));
    });

    it("should apply 'since' as datetime filter on updated", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 1700000000 });
        assert.ok(result.sql.includes('"updated" >= datetime(?, \'unixepoch\')'));
        assert.ok(result.params.includes(1700000000));
    });

    it("should apply LIMIT and OFFSET", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 0, limit: 10, skip: 20, since: 0 });
        assert.ok(result.sql.includes("LIMIT ?"));
        assert.ok(result.sql.includes("OFFSET ?"));
        assert.ok(result.params.includes(10));
        assert.ok(result.params.includes(20));
    });

    it("should cap limit at 250 when depth > 0", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 1, limit: 500, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIMIT ?"));
        assert.ok(result.params.includes(250));
    });

    it("should default limit to 250 when depth > 0 and no limit specified", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 1, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIMIT ?"));
        assert.ok(result.params.includes(250));
    });

    it("should combine explicit status filter with other filters", () => {
        const filters = [
            { field: "status", op: "eq", value: "ok" },
            { field: "asn", op: "gt", value: "1000" }
        ];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"status" = ? COLLATE NOCASE AND "asn" > ?'));
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
        const result = buildRowQuery(boolEntity, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.params.includes(1));
    });

    it("should handle skip without limit using LIMIT -1", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 50, since: 0 });
        assert.ok(result.sql.includes("LIMIT -1 OFFSET ?"));
        assert.ok(result.params.includes(50));
    });

    it("should always ORDER BY id ASC", () => {
        const result = buildRowQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 });
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
        assert.ok(result.sql.includes('t."ix_id" = ? COLLATE NOCASE'));
    });

    it("should qualify single ID fetch with table alias", () => {
        const result = buildRowQuery(NETIXLAN_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 }, 42);
        assert.ok(result.sql.includes('t."id" = ?'));
    });

    it("should qualify IN filter with table alias", () => {
        const filters = [{ field: "asn", op: "in", value: "13335,8075" }];
        const result = buildRowQuery(NETIXLAN_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('t."asn" IN (SELECT value FROM json_each(?))'));
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

    it("should accept cross-entity filter when FK exists", () => {
        // Real netixlan has net_id with foreignKey: 'net'
        const filters = [{ field: "name", op: "contains", value: "Cloud", entity: "net" }];
        assert.equal(validateQuery(ENTITIES.netixlan, filters, ''), null);
    });

    it("should reject cross-entity filter when no FK exists", () => {
        // NET_ENTITY has no FK to 'ix'
        const filters = [{ field: "name", op: "eq", value: "AMS-IX", entity: "ix" }];
        const err = validateQuery(NET_ENTITY, filters, '');
        assert.ok(err?.includes("No foreign key to 'ix'"));
    });

    it("should reject __in filter exceeding MAX_IN_VALUES", () => {
        const ids = Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => String(i + 1));
        const filters = [{ field: "id", op: "in", value: ids.join(",") }];
        const err = validateQuery(NET_ENTITY, filters, '');
        assert.ok(err?.includes("Too many values"));
        assert.ok(err?.includes(String(MAX_IN_VALUES + 1)));
    });

    it("should accept __in filter at exactly MAX_IN_VALUES", () => {
        const ids = Array.from({ length: MAX_IN_VALUES }, (_, i) => String(i + 1));
        const filters = [{ field: "id", op: "in", value: ids.join(",") }];
        assert.equal(validateQuery(NET_ENTITY, filters, ''), null);
    });
});

// ── Cross-entity filter SQL generation ───────────────────────────────────────


describe("cross-entity filters", () => {
    // Use real ENTITIES for these tests since subquery generation
    // calls resolveCrossEntityFilter which looks up ENTITIES.

    it("should generate subquery for equality filter", () => {
        const ixfac = ENTITIES.ixfac;
        const filters = [{ field: "country", op: "eq", value: "AU", entity: "fac" }];
        const result = buildRowQuery(ixfac, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"fac_id" IN (SELECT "id" FROM "peeringdb_facility" WHERE "country" = ? COLLATE NOCASE)'));
        assert.ok(result.params.includes("AU"));
    });

    it("should generate subquery for contains filter", () => {
        const ixfac = ENTITIES.ixfac;
        const filters = [{ field: "state", op: "contains", value: "NSW", entity: "fac" }];
        const result = buildRowQuery(ixfac, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"fac_id" IN (SELECT "id" FROM "peeringdb_facility" WHERE "state"'));
        assert.ok(result.sql.includes("LIKE '%' || ? || '%'"));
    });

    it("should generate subquery for IN filter", () => {
        const netixlan = ENTITIES.netixlan;
        const filters = [{ field: "asn", op: "in", value: "13335,15169", entity: "net" }];
        const result = buildRowQuery(netixlan, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"net_id" IN (SELECT "id" FROM "peeringdb_network" WHERE "asn" IN (SELECT value FROM json_each(?)))'));
        assert.deepEqual(result.params.filter(p => typeof p === 'string' && p.includes('13335')), ['[13335,15169]']);
    });

    it("should combine cross-entity filter with regular filter", () => {
        const ixfac = ENTITIES.ixfac;
        const filters = [
            { field: "country", op: "eq", value: "AU", entity: "fac" },
            { field: "ix_id", op: "eq", value: "26" }
        ];
        const result = buildRowQuery(ixfac, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"fac_id" IN (SELECT'));
        assert.ok(result.sql.includes('"ix_id" = ?'));
    });

    it("should qualify subquery FK with table alias in buildRowQuery", () => {
        const ixfac = ENTITIES.ixfac;
        const filters = [{ field: "country", op: "eq", value: "AU", entity: "fac" }];
        const result = buildRowQuery(ixfac, filters, { depth: 0, limit: 10, skip: 0, since: 0 });
        // ixfac has joinColumns, so buildRowQuery uses aliases (t."fac_id")
        assert.ok(result.sql.includes('t."fac_id" IN (SELECT'));
    });
});

// ── Implicit cross-entity filter resolution ──────────────────────────────────

describe("resolveImplicitFilters", () => {
    it("should resolve country on net to org__country", () => {
        const filters = [{ field: "country", op: "eq", value: "NL" }];
        resolveImplicitFilters(ENTITIES.net, filters);
        assert.equal(filters[0].entity, "org");
        assert.equal(filters[0].field, "country");
    });

    it("should not modify filters for fields that exist on the entity", () => {
        const filters = [{ field: "asn", op: "eq", value: "13335" }];
        resolveImplicitFilters(ENTITIES.net, filters);
        assert.equal(filters[0].entity, undefined);
    });

    it("should not modify explicit cross-entity filters", () => {
        const filters = [{ field: "country", op: "eq", value: "AU", entity: "fac" }];
        resolveImplicitFilters(ENTITIES.ixfac, filters);
        assert.equal(filters[0].entity, "fac");
    });

    it("should leave unresolvable filters untouched", () => {
        const filters = [{ field: "nonexistent_xyz", op: "eq", value: "foo" }];
        resolveImplicitFilters(ENTITIES.net, filters);
        assert.equal(filters[0].entity, undefined);
    });

    it("should resolve city on net to org__city", () => {
        const filters = [{ field: "city", op: "contains", value: "Amsterdam" }];
        resolveImplicitFilters(ENTITIES.net, filters);
        assert.equal(filters[0].entity, "org");
    });

    it("should produce valid SQL after resolution", () => {
        const filters = [{ field: "country", op: "eq", value: "NL" }];
        resolveImplicitFilters(ENTITIES.net, filters);
        const result = buildRowQuery(ENTITIES.net, filters, { depth: 0, limit: 50, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"org_id" IN (SELECT "id" FROM "peeringdb_organization" WHERE "country" = ? COLLATE NOCASE)'));
        assert.ok(result.params.includes("NL"));
    });
});

// ── Cross-entity filter parsing ──────────────────────────────────────────────


describe("parseQueryFilters cross-entity syntax", () => {
    it("should parse fac__state=NSW as cross-entity filter", () => {
        const result = parseQueryFilters("fac__state=NSW");
        assert.equal(result.filters.length, 1);
        assert.equal(result.filters[0].entity, "fac");
        assert.equal(result.filters[0].field, "state");
        assert.equal(result.filters[0].op, "eq");
        assert.equal(result.filters[0].value, "NSW");
    });

    it("should parse fac__state__contains=NSW as cross-entity filter with operator", () => {
        const result = parseQueryFilters("fac__state__contains=NSW");
        assert.equal(result.filters[0].entity, "fac");
        assert.equal(result.filters[0].field, "state");
        assert.equal(result.filters[0].op, "contains");
    });

    it("should parse net__asn__in=13335,15169 as cross-entity IN filter", () => {
        const result = parseQueryFilters("net__asn__in=13335,15169");
        assert.equal(result.filters[0].entity, "net");
        assert.equal(result.filters[0].field, "asn");
        assert.equal(result.filters[0].op, "in");
        assert.equal(result.filters[0].value, "13335,15169");
    });

    it("should not treat regular double-underscore operators as cross-entity", () => {
        const result = parseQueryFilters("asn__gt=100");
        assert.equal(result.filters[0].entity, undefined);
        assert.equal(result.filters[0].field, "asn");
        assert.equal(result.filters[0].op, "gt");
    });

    it("should handle both cross-entity and regular filters in one query", () => {
        const result = parseQueryFilters("fac__country=AU&ix_id=26");
        assert.equal(result.filters.length, 2);
        assert.equal(result.filters[0].entity, "fac");
        assert.equal(result.filters[0].field, "country");
        assert.equal(result.filters[1].entity, undefined);
        assert.equal(result.filters[1].field, "ix_id");
    });
});

// ── COLLATE NOCASE on eq ─────────────────────────────────────────────────────

describe("eq COLLATE NOCASE", () => {
    it("should emit COLLATE NOCASE for string eq filter", () => {
        const filters = [{ field: "name", op: "eq", value: "cloudflare" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"name" = ? COLLATE NOCASE'));
    });

    it("should emit COLLATE NOCASE for number eq filter (no-op in SQLite)", () => {
        const filters = [{ field: "asn", op: "eq", value: "13335" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"asn" = ? COLLATE NOCASE'));
    });

    it("should emit COLLATE NOCASE in aliased JOIN queries", () => {
        const filters = [{ field: "name", op: "eq", value: "test" }];
        const result = buildRowQuery(NETIXLAN_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('t."name" = ? COLLATE NOCASE'));
    });

    it("should emit COLLATE NOCASE in cross-entity subqueries", () => {
        const ixfac = ENTITIES.ixfac;
        const filters = [{ field: "country", op: "eq", value: "au", entity: "fac" }];
        const result = buildRowQuery(ixfac, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"country" = ? COLLATE NOCASE'));
    });
});

// ── Duplicate query parameters ───────────────────────────────────────────────

describe("parseQueryFilters duplicate params", () => {
    it("should use last value when same field+op appears twice", () => {
        const result = parseQueryFilters("asn=13335&asn=2906");
        assert.equal(result.filters.length, 1);
        assert.equal(result.filters[0].value, "2906");
    });

    it("should preserve filters with different ops on same field", () => {
        const result = parseQueryFilters("asn=13335&asn__gt=100");
        assert.equal(result.filters.length, 2);
        assert.equal(result.filters[0].op, "eq");
        assert.equal(result.filters[0].value, "13335");
        assert.equal(result.filters[1].op, "gt");
        assert.equal(result.filters[1].value, "100");
    });

    it("should use last value for duplicate reserved params", () => {
        const result = parseQueryFilters("depth=1&depth=2&limit=10&limit=20");
        assert.equal(result.depth, 2);
        assert.equal(result.limit, 20);
    });

    it("should use last value for duplicate cross-entity filters", () => {
        const result = parseQueryFilters("fac__country=AU&fac__country=NL");
        assert.equal(result.filters.length, 1);
        assert.equal(result.filters[0].value, "NL");
        assert.equal(result.filters[0].entity, "fac");
    });
});

// ── New filter operators (not, notin, endswith, isnil) ──────────────────────

describe("buildRowQuery new filter operators", () => {
    it("should apply NOT filter", () => {
        const filters = [{ field: "name", op: "not", value: "test" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"name" != ? COLLATE NOCASE'));
        assert.ok(result.params.includes("test"));
    });

    it("should apply NOT IN filter", () => {
        const filters = [{ field: "asn", op: "notin", value: "13335,2906" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"asn" NOT IN (SELECT value FROM json_each(?))'));
    });

    it("should apply endswith filter", () => {
        const filters = [{ field: "name", op: "endswith", value: "Inc." }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIKE '%' || ? COLLATE NOCASE"));
        assert.ok(result.params.includes("Inc."));
    });

    it("should apply isnil=true as IS NULL", () => {
        const filters = [{ field: "name", op: "isnil", value: "true" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"name" IS NULL'));
    });

    it("should apply isnil=false as IS NOT NULL", () => {
        const filters = [{ field: "name", op: "isnil", value: "false" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"name" IS NOT NULL'));
    });

    it("should apply isnil=1 as IS NULL", () => {
        const filters = [{ field: "name", op: "isnil", value: "1" }];
        const result = buildRowQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"name" IS NULL'));
    });
});

describe("parseQueryFilters new operators", () => {
    it("should parse __not suffix", () => {
        const result = parseQueryFilters("name__not=test");
        assert.equal(result.filters[0].op, "not");
        assert.equal(result.filters[0].value, "test");
    });

    it("should parse __notin suffix", () => {
        const result = parseQueryFilters("asn__notin=13335,2906");
        assert.equal(result.filters[0].op, "notin");
    });

    it("should parse __endswith suffix", () => {
        const result = parseQueryFilters("name__endswith=Inc.");
        assert.equal(result.filters[0].op, "endswith");
    });

    it("should parse __isnil suffix", () => {
        const result = parseQueryFilters("name__isnil=true");
        assert.equal(result.filters[0].op, "isnil");
        assert.equal(result.filters[0].value, "true");
    });
});
