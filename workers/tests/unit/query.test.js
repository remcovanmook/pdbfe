/**
 * @fileoverview Unit tests for the SQL query builder.
 * Tests filter translation, parameter binding, injection prevention,
 * pagination, and 'since' handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, buildRowQuery, buildJsonQuery, buildCountQuery, nextPageParams } from '../../api/query.js';

// Minimal entity metadata for testing
const NET_ENTITY = {
    tag: "net",
    table: "peeringdb_network",
    columns: ["id", "name", "asn", "org_id", "status", "updated"],
    filters: {
        id: "number",
        name: "string",
        asn: "number",
        org_id: "number",
        status: "string",
        updated: "datetime"
    },
    relationships: []
};

describe("buildQuery", () => {
    it("should build a basic SELECT without filters", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.equal(result.sql, 'SELECT "id", "name", "asn", "org_id", "status", "updated" FROM "peeringdb_network" ORDER BY "id" ASC');
        assert.deepEqual(result.params, []);
    });

    it("should apply equality filter", () => {
        const filters = [{ field: "asn", op: "eq", value: "13335" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"asn" = ?'));
        assert.deepEqual(result.params, [13335]);
    });

    it("should apply numeric comparison filters", () => {
        const filters = [{ field: "id", op: "gt", value: "100" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"id" > ?'));
        assert.deepEqual(result.params, [100]);
    });

    it("should apply lte and gte filters", () => {
        const filters = [
            { field: "id", op: "gte", value: "10" },
            { field: "id", op: "lte", value: "20" }
        ];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"id" >= ?'));
        assert.ok(result.sql.includes('"id" <= ?'));
        assert.deepEqual(result.params, [10, 20]);
    });

    it("should apply contains filter (case-insensitive)", () => {
        const filters = [{ field: "name", op: "contains", value: "Cloudflare" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIKE '%' || ? || '%' COLLATE NOCASE"));
        assert.deepEqual(result.params, ["Cloudflare"]);
    });

    it("should apply startswith filter", () => {
        const filters = [{ field: "name", op: "startswith", value: "Cloud" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes("LIKE ? || '%' COLLATE NOCASE"));
        assert.deepEqual(result.params, ["Cloud"]);
    });

    it("should apply IN filter with multiple values", () => {
        const filters = [{ field: "id", op: "in", value: "1,5,10" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('"id" IN (?, ?, ?)'));
        assert.deepEqual(result.params, [1, 5, 10]);
    });

    it("should ignore unknown fields", () => {
        const filters = [{ field: "nonexistent", op: "eq", value: "foo" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(!result.sql.includes("WHERE"));
        assert.deepEqual(result.params, []);
    });

    it("should ignore unknown operators", () => {
        const filters = [{ field: "name", op: "regex", value: ".*" }];
        const result = buildQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(!result.sql.includes("WHERE"));
        assert.deepEqual(result.params, []);
    });

    it("should handle single ID fetch", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 }, 42);
        assert.ok(result.sql.includes('"id" = ?'));
        assert.deepEqual(result.params, [42]);
    });

    it("should apply 'since' as datetime filter on updated", () => {
        const result = buildQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 1700000000 });
        assert.ok(result.sql.includes('"updated" >= datetime(?, \'unixepoch\')'));
        assert.deepEqual(result.params, [1700000000]);
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

    it("should combine multiple filters with AND", () => {
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
            filters: { ...NET_ENTITY.filters, info_unicast: "boolean" }
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

// Entity with joinColumns for testing JOIN query generation
const NETIXLAN_ENTITY = {
    tag: "netixlan",
    table: "peeringdb_network_ixlan",
    columns: ["id", "net_id", "ix_id", "name", "asn", "speed", "status"],
    joinColumns: [{
        table: "peeringdb_network",
        localFk: "net_id",
        columns: { name: "net_name" }
    }],
    filters: {
        id: "number",
        net_id: "number",
        ix_id: "number",
        asn: "number",
        status: "string"
    },
    relationships: []
};

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
        assert.deepEqual(result.params, [26]);
    });

    it("should qualify single ID fetch with table alias", () => {
        const result = buildRowQuery(NETIXLAN_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 }, 42);
        assert.ok(result.sql.includes('t."id" = ?'));
        assert.deepEqual(result.params, [42]);
    });

    it("should qualify IN filter with table alias", () => {
        const filters = [{ field: "asn", op: "in", value: "13335,8075" }];
        const result = buildRowQuery(NETIXLAN_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('t."asn" IN (?, ?)'));
        assert.deepEqual(result.params, [13335, 8075]);
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
    it("should generate COUNT(*) query without pagination", () => {
        const result = buildCountQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.equal(result.sql, 'SELECT COUNT(*) AS cnt FROM "peeringdb_network"');
        assert.deepEqual(result.params, []);
    });

    it("should apply filters to COUNT query", () => {
        const filters = [{ field: "status", op: "eq", value: "ok" }];
        const result = buildCountQuery(NET_ENTITY, filters, { depth: 0, limit: 0, skip: 0, since: 0 });
        assert.ok(result.sql.includes('WHERE "status" = ?'));
        assert.deepEqual(result.params, ["ok"]);
    });

    it("should apply since filter to COUNT query", () => {
        const result = buildCountQuery(NET_ENTITY, [], { depth: 0, limit: 0, skip: 0, since: 1700000000 });
        assert.ok(result.sql.includes('"updated" >= datetime(?,'));
        assert.deepEqual(result.params, [1700000000]);
    });

    it("should ignore pagination in COUNT query", () => {
        const result = buildCountQuery(NET_ENTITY, [], { depth: 0, limit: 50, skip: 10, since: 0 });
        assert.ok(!result.sql.includes('LIMIT'));
        assert.ok(!result.sql.includes('OFFSET'));
    });
});
