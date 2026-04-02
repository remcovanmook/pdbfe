/**
 * @fileoverview Integration tests for the PeeringDB API worker router.
 * Exercises the full request handling pipeline with a mock D1 binding.
 * Tests routing, CORS, 501 for writes, 404 for unknown entities, etc.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the full handler (the default export is { fetch })
import handler from '../api/index.js';

/**
 * Creates a mock D1 database that returns configurable results.
 * Detects JSON-envelope queries (containing 'AS payload') and wraps
 * the rows in a pre-formatted JSON string, matching the behaviour
 * of buildJsonQuery's json_group_array/json_object SQL.
 *
 * @param {any[]} [rows=[]] - Rows to return from .all().
 * @returns {D1Database} Mock D1 binding.
 */
function mockD1(rows = []) {
    const db = /** @type {any} */({
        prepare: (/** @type {string} */ sql) => ({
            bind: (/** @type {any[]} */..._args) => {
                const isJsonEnvelope = sql.includes('AS payload');
                return {
                    all: async () => ({ results: rows, success: true }),
                    first: async () => {
                        if (isJsonEnvelope) {
                            // Simulate D1 returning the full JSON envelope as a string
                            return rows.length > 0
                                ? { payload: JSON.stringify({ data: rows, meta: {} }) }
                                : null;
                        }
                        return rows[0] || null;
                    }
                };
            },
            first: async () => {
                const isJsonEnvelope = sql.includes('AS payload');
                if (isJsonEnvelope) {
                    return rows.length > 0
                        ? { payload: JSON.stringify({ data: rows, meta: {} }) }
                        : null;
                }
                return rows[0] || null;
            },
            all: async () => ({ results: rows, success: true })
        }),
        /** Sessions API: returns itself since the mock already has .prepare(). */
        withSession() { return db; }
    });
    return db;
}

/**
 * Creates a Request object for testing.
 *
 * @param {string} path - URL path (without origin).
 * @param {string} [method="GET"] - HTTP method.
 * @returns {Request} The mock request.
 */
function makeRequest(path, method = "GET") {
    return new Request(`https://test.workers.dev/${path}`, {
        method,
        headers: { "Accept": "application/json" }
    });
}

/** @type {PdbApiEnv} */
const env = /** @type {any} */({
    PDB: mockD1([
        { id: 1, name: "Test Net", asn: 12345, org_id: 1, status: "ok", updated: "2024-01-01T00:00:00Z" }
    ]),
    ADMIN_SECRET: "testsecret"
});

const ctx = /** @type {ExecutionContext} */({
    waitUntil: (/** @type {Promise<any>} */ _p) => {},
    passThroughOnException: () => {}
});

describe("Router - admin endpoints", () => {
    it("should return robots.txt", async () => {
        const res = await handler.fetch(makeRequest("robots.txt"), env, ctx);
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.ok(body.includes("User-agent: *"));
    });

    it("should return health check", async () => {
        const res = await handler.fetch(makeRequest("health"), env, ctx);
        assert.ok(res.status === 200 || res.status === 503);
        const body = await res.json();
        assert.ok(body.service === "pdbfe-api");
    });

    it("should return cache status with valid secret", async () => {
        const res = await handler.fetch(makeRequest("_cache_status.testsecret"), env, ctx);
        assert.equal(res.status, 200);
    });

    it("should 404 for cache status with invalid secret", async () => {
        const res = await handler.fetch(makeRequest("_cache_status.wrongsecret"), env, ctx);
        assert.equal(res.status, 404);
    });
});

describe("Router - CORS", () => {
    it("should return CORS preflight response", async () => {
        const res = await handler.fetch(makeRequest("api/net", "OPTIONS"), env, ctx);
        assert.equal(res.status, 204);
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("should include CORS headers on API responses", async () => {
        const res = await handler.fetch(makeRequest("api/net"), env, ctx);
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });
});

describe("Router - entity list", () => {
    it("should return 200 for valid entity list", async () => {
        const res = await handler.fetch(makeRequest("api/net"), env, ctx);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(Array.isArray(body.data));
    });

    it("should return 200 for entity list with filters", async () => {
        const res = await handler.fetch(makeRequest("api/net?asn=12345"), env, ctx);
        assert.equal(res.status, 200);
    });

    it("should return 404 for unknown entity", async () => {
        const res = await handler.fetch(makeRequest("api/unknown"), env, ctx);
        assert.equal(res.status, 404);
    });

    it("should handle all valid entity tags", async () => {
        const tags = ["net", "org", "fac", "ix", "ixlan", "ixpfx",
                      "netfac", "netixlan", "poc", "carrier", "carrierfac",
                      "ixfac", "campus"];
        for (const tag of tags) {
            const res = await handler.fetch(makeRequest(`api/${tag}`), env, ctx);
            assert.equal(res.status, 200, `Failed for entity: ${tag}`);
        }
    });
});

describe("Router - entity detail", () => {
    it("should return 200 for valid entity detail", async () => {
        const res = await handler.fetch(makeRequest("api/net/1"), env, ctx);
        assert.equal(res.status, 200);
    });

    it("should handle trailing slash", async () => {
        const res = await handler.fetch(makeRequest("api/net/1/"), env, ctx);
        assert.equal(res.status, 200);
    });

    it("should return 400 for invalid ID", async () => {
        const res = await handler.fetch(makeRequest("api/net/abc"), env, ctx);
        assert.equal(res.status, 400);
    });
});

describe("Router - AS set", () => {
    it("should return 200 for valid ASN lookup", async () => {
        const res = await handler.fetch(makeRequest("api/as_set/12345"), env, ctx);
        assert.equal(res.status, 200);
    });

    it("should return 400 for invalid ASN", async () => {
        const res = await handler.fetch(makeRequest("api/as_set/abc"), env, ctx);
        assert.equal(res.status, 400);
    });
});

describe("Router - write methods (501 Not Implemented)", () => {
    it("should return 501 for POST", async () => {
        const res = await handler.fetch(makeRequest("api/net", "POST"), env, ctx);
        assert.equal(res.status, 501);
        const body = await res.json();
        assert.ok(body.error.includes("read-only"));
    });

    it("should return 501 for PUT", async () => {
        const res = await handler.fetch(makeRequest("api/net/1", "PUT"), env, ctx);
        assert.equal(res.status, 501);
    });

    it("should return 501 for DELETE", async () => {
        const res = await handler.fetch(makeRequest("api/net/1", "DELETE"), env, ctx);
        assert.equal(res.status, 501);
    });

    it("should return 501 for PATCH", async () => {
        const res = await handler.fetch(makeRequest("api/net/1", "PATCH"), env, ctx);
        assert.equal(res.status, 501);
    });
});

describe("Router - error handling", () => {
    it("should return 404 for non-API paths", async () => {
        const res = await handler.fetch(makeRequest("random/path"), env, ctx);
        assert.equal(res.status, 404);
    });

    it("should block path traversal", async () => {
        // The Request constructor normalises "../" out of URLs, so this
        // becomes "etc/passwd" which doesn't start with "api/" → 404.
        // Both 400 and 404 are safe outcomes — traversal is blocked either way.
        const res = await handler.fetch(makeRequest("api/../etc/passwd"), env, ctx);
        assert.ok(res.status === 400 || res.status === 404);
    });

    it("should block scanner probes", async () => {
        const res = await handler.fetch(makeRequest(".git/config"), env, ctx);
        assert.equal(res.status, 404);
    });

    it("should include X-Served-By header", async () => {
        const res = await handler.fetch(makeRequest("api/net"), env, ctx);
        assert.ok(res.headers.get("X-Served-By")?.includes("pdbfe-api"));
    });

    it("should include X-Timer header", async () => {
        const res = await handler.fetch(makeRequest("api/net"), env, ctx);
        assert.ok(res.headers.get("X-Timer")?.startsWith("S"));
    });
});
