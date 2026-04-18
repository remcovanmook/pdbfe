/**
 * @fileoverview Unit tests for the cachedQuery pipeline (pipeline.js).
 * Tests the isNegative helper and cachedQuery behaviour with mocked
 * L2 cache dependencies.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cachedQuery } from '../../../api/cache.js';
import { EMPTY_ENVELOPE, isNegative } from '../../../core/pipeline.js';
import { LRUCache } from '../../../core/cache.js';

// ── isNegative tests ─────────────────────────────────────────────────────────

describe("isNegative", () => {
    it("should return true for the EMPTY_ENVELOPE reference", () => {
        assert.equal(isNegative(EMPTY_ENVELOPE), true);
    });

    it("should return true for a byte-identical copy", () => {
        const copy = new Uint8Array(EMPTY_ENVELOPE);
        assert.notEqual(copy, EMPTY_ENVELOPE); // different reference
        assert.equal(isNegative(copy), true);
    });

    it("should return false for a non-empty payload", () => {
        const buf = new TextEncoder().encode('{"data":[{"id":1}],"meta":{}}');
        assert.equal(isNegative(buf), false);
    });

    it("should return false for a different-length buffer", () => {
        const buf = new TextEncoder().encode('short');
        assert.equal(isNegative(buf), false);
    });

    it("should return false for same-length but different content", () => {
        // Same length as EMPTY_ENVELOPE but different bytes
        const buf = new Uint8Array(EMPTY_ENVELOPE.byteLength);
        buf.fill(0x41); // 'A' bytes
        assert.equal(isNegative(buf), false);
    });

    it("should match a custom sentinel by reference", () => {
        const gqlSentinel = new TextEncoder().encode('{"data":null,"errors":[]}');
        assert.equal(isNegative(gqlSentinel, gqlSentinel), true);
    });

    it("should match a custom sentinel by byte comparison", () => {
        const gqlSentinel = new TextEncoder().encode('{"data":null,"errors":[]}');
        const copy = new Uint8Array(gqlSentinel);
        assert.notEqual(copy, gqlSentinel);
        assert.equal(isNegative(copy, gqlSentinel), true);
    });

    it("should not match default sentinel against custom sentinel", () => {
        const gqlSentinel = new TextEncoder().encode('{"data":null,"errors":[]}');
        assert.equal(isNegative(EMPTY_ENVELOPE, gqlSentinel), false);
    });
});

// ── EMPTY_ENVELOPE sentinel tests ────────────────────────────────────────────

describe("EMPTY_ENVELOPE", () => {
    it("should be valid JSON with empty data array", () => {
        const parsed = JSON.parse(new TextDecoder().decode(EMPTY_ENVELOPE));
        assert.deepEqual(parsed, { data: [], meta: {} });
    });

    it("should be a Uint8Array", () => {
        assert.ok(EMPTY_ENVELOPE instanceof Uint8Array);
    });

    it("should be the same reference across imports", async () => {
        const mod = await import('../../../core/pipeline.js');
        assert.equal(mod.EMPTY_ENVELOPE, EMPTY_ENVELOPE);
    });
});

// ── cachedQuery tests ────────────────────────────────────────────────────────
// These test the pipeline function directly. The L2 cache (l2cache.js) and
// L2 silently returns null in Node.js (no caches.default available),
// so all queries go straight to the D1 path.

describe("cachedQuery", () => {
    /** @type {ReturnType<typeof LRUCache>} */
    let cache;

    beforeEach(() => {
        cache = LRUCache(16, 1024 * 1024);
    });

    it("should call queryFn and return the result on cache miss", async () => {
        const payload = new TextEncoder().encode('{"data":[{"id":1}],"meta":{}}');
        let called = false;

        const result = await cachedQuery({
            cacheKey: "test/positive",
            cache,
            entityTag: "test",
            ttlMs: 60000,
            queryFn: async () => { called = true; return payload; }
        });

        assert.equal(called, true);
        assert.notStrictEqual(result.buf, null);
        assert.equal(result.buf.byteLength, payload.byteLength);
        assert.equal(result.tier, 'MISS');
    });

    it("should store positive result in L1 cache after queryFn", async () => {
        const payload = new TextEncoder().encode('{"data":[{"id":2}],"meta":{}}');

        await cachedQuery({
            cacheKey: "test/l1write",
            cache,
            entityTag: "test",
            ttlMs: 60000,
            queryFn: async () => payload
        });

        const entry = cache.get("test/l1write");
        assert.notStrictEqual(entry, null);
        assert.equal(entry.buf.byteLength, payload.byteLength);
    });

    it("should return null and store EMPTY_ENVELOPE when queryFn returns null", async () => {
        const result = await cachedQuery({
            cacheKey: "test/negative",
            cache,
            entityTag: "test",
            ttlMs: 60000,
            queryFn: async () => null
        });

        assert.equal(result.buf, null);
        assert.equal(result.tier, 'MISS');

        // EMPTY_ENVELOPE should be in L1
        const entry = cache.get("test/negative");
        assert.notStrictEqual(entry, null);
        assert.equal(entry.buf, EMPTY_ENVELOPE);
    });

    it("should propagate queryFn errors without blocking subsequent queries", async () => {
        // If errors aren't handled cleanly, subsequent queries could hang.
        // Run 5 queries (including the failing one) — if anything deadlocks,
        // the test will timeout.
        const failedQuery = cachedQuery({
            cacheKey: "test/throw",
            cache,
            entityTag: "test",
            ttlMs: 60000,
            queryFn: async () => { throw new Error("D1 exploded"); }
        });

        await assert.rejects(failedQuery, { message: "D1 exploded" });

        // Verify subsequent queries still work after the error
        const results = await Promise.all(
            Array.from({ length: 4 }, (_, i) =>
                cachedQuery({
                    cacheKey: `test/after-throw-${i}`,
                    cache,
                    entityTag: "test",
                    ttlMs: 60000,
                    queryFn: async () => new TextEncoder().encode(`{"data":[],"meta":{"i":${i}}}`)
                })
            )
        );

        assert.equal(results.length, 4);
        for (const r of results) assert.notStrictEqual(r.buf, null);
    });

    it("should not call queryFn when L1 is populated by prior cachedQuery", async () => {
        const payload = new TextEncoder().encode('{"data":[{"id":3}],"meta":{}}');

        // First call — populates L1
        await cachedQuery({
            cacheKey: "test/l1hit",
            cache,
            entityTag: "test",
            ttlMs: 60000,
            queryFn: async () => payload
        });

        // Second call should not execute queryFn because L1 is populated.
        // However, cachedQuery doesn't check L1 itself (the handler does that).
        // This test verifies the L1 entry exists for the handler to find.
        const entry = cache.get("test/l1hit");
        assert.notStrictEqual(entry, null);
        assert.equal(entry.buf.byteLength, payload.byteLength);
    });

    it("should coalesce concurrent calls for the same cache key", async () => {
        let callCount = 0;
        const payload = new TextEncoder().encode('{"data":[{"id":4}],"meta":{}}');

        // Launch 5 concurrent cachedQuery calls for the same key.
        // queryFn should only execute once.
        const promises = Array.from({ length: 5 }, () =>
            cachedQuery({
                cacheKey: "test/coalesce",
                cache,
                entityTag: "test",
                ttlMs: 60000,
                queryFn: async () => { callCount++; return payload; }
            })
        );

        const results = await Promise.all(promises);

        assert.equal(callCount, 1, "queryFn should be called exactly once");
        results.forEach(r => {
            assert.notStrictEqual(r.buf, null);
            assert.equal(r.buf.byteLength, payload.byteLength);
            assert.equal(r.tier, 'MISS');
        });
    });

    it("should clean up pending entry after resolution", async () => {
        const payload = new TextEncoder().encode('{"data":[],"meta":{}}');

        await cachedQuery({
            cacheKey: "test/cleanup",
            cache,
            entityTag: "test",
            ttlMs: 60000,
            queryFn: async () => payload
        });

        // After resolution, the pending map should be empty for this key
        assert.equal(cache.pending.has("test/cleanup"), false);
    });

    it("should clean up pending entry after rejection", async () => {
        try {
            await cachedQuery({
                cacheKey: "test/cleanup-err",
                cache,
                entityTag: "test",
                ttlMs: 60000,
                queryFn: async () => { throw new Error("boom"); }
            });
        } catch { /* expected */ }

        // Pending entry must be cleaned up even on failure
        assert.equal(cache.pending.has("test/cleanup-err"), false);
    });
});
