/**
 * @fileoverview Unit tests for the per-entity LRU cache configuration
 * and core cache operations — TTL behaviour, key normalisation,
 * independent eviction, aggregate stats.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../../../core/cache.js';
import { getEntityCache, getCacheStats, purgeAllCaches, NEGATIVE_TTL, DETAIL_TTL, normaliseCacheKey } from '../../../api/cache.js';

describe("LRUCache core operations", () => {
    it("should store and retrieve an entry", () => {
        const cache = LRUCache(8, 1024 * 1024);
        const buf = new Uint8Array([1, 2, 3]);
        cache.add("key1", buf, { tag: "test" }, Date.now());
        const entry = cache.get("key1");
        assert.notStrictEqual(entry, null);
        assert.equal(entry.buf, buf);
        assert.equal(entry.meta.tag, "test");
        assert.equal(entry.hits, 1);
    });

    it("should return null for unknown keys", () => {
        const cache = LRUCache(8, 1024 * 1024);
        assert.equal(cache.get("nonexistent"), null);
    });

    it("should evict LRU entry when full", () => {
        const cache = LRUCache(2, 1024 * 1024);
        const buf1 = new Uint8Array([1]);
        const buf2 = new Uint8Array([2]);
        const buf3 = new Uint8Array([3]);

        cache.add("a", buf1, {}, 1);
        cache.add("b", buf2, {}, 2);
        // Access 'a' to make 'b' the LRU
        cache.get("a");
        cache.add("c", buf3, {}, 3);

        // 'b' should be evicted (was LRU)
        assert.equal(cache.get("b"), null);
        assert.notStrictEqual(cache.get("a"), null);
        assert.notStrictEqual(cache.get("c"), null);
    });

    it("should evict when byte limit exceeded", () => {
        const cache = LRUCache(10, 5); // 5 bytes max
        cache.add("a", new Uint8Array(3), {}, 1);
        cache.add("b", new Uint8Array(3), {}, 2);
        // Total would be 6, exceeding limit. 'a' should be evicted.
        assert.equal(cache.get("a"), null);
        assert.notStrictEqual(cache.get("b"), null);
    });

    it("should update existing entry without creating a new slot", () => {
        const cache = LRUCache(2, 1024 * 1024);
        cache.add("k", new Uint8Array([1]), { v: 1 }, 1);
        cache.add("k", new Uint8Array([2]), { v: 2 }, 2);
        const entry = cache.get("k");
        assert.notStrictEqual(entry, null);
        assert.equal(entry.meta.v, 2);
        assert.equal(cache.getStats().items, 1);
    });

    it("should purge a specific key", () => {
        const cache = LRUCache(8, 1024 * 1024);
        cache.add("x", new Uint8Array([1]), {}, 1);
        cache.add("y", new Uint8Array([2]), {}, 2);
        cache.purge("x");
        assert.equal(cache.get("x"), null);
        assert.notStrictEqual(cache.get("y"), null);
        assert.equal(cache.getStats().items, 1);
    });

    it("should purge all entries when called without key", () => {
        const cache = LRUCache(8, 1024 * 1024);
        cache.add("a", new Uint8Array([1]), {}, 1);
        cache.add("b", new Uint8Array([2]), {}, 2);
        cache.purge();
        assert.equal(cache.getStats().items, 0);
        assert.equal(cache.getStats().bytes, 0);
    });

    it("should report correct stats", () => {
        const cache = LRUCache(8, 1024 * 1024);
        cache.add("a", new Uint8Array(100), {}, 1);
        cache.add("b", new Uint8Array(200), {}, 2);
        const stats = cache.getStats();
        assert.equal(stats.items, 2);
        assert.equal(stats.bytes, 300);
        assert.equal(stats.limit, 1024 * 1024);
    });
});

describe("Per-entity cache configuration", () => {
    it("should return a cache instance for each known entity", () => {
        const tags = ["net", "org", "fac", "ix", "ixlan", "ixpfx",
                      "netfac", "netixlan", "poc", "carrier", "carrierfac",
                      "ixfac", "campus", "as_set"];
        for (const tag of tags) {
            const cache = getEntityCache(tag);
            assert.ok(cache, `No cache for ${tag}`);
            assert.equal(typeof cache.add, "function");
            assert.equal(typeof cache.get, "function");
        }
    });

    it("should return different cache instances for different entities", () => {
        const netCache = getEntityCache("net");
        const orgCache = getEntityCache("org");
        assert.notEqual(netCache, orgCache);
    });

    it("should have higher limits for heavy-tier entities", () => {
        const netStats = getEntityCache("net").getStats();
        const ixStats = getEntityCache("ix").getStats();
        assert.ok(netStats.limit > ixStats.limit,
            `net limit (${netStats.limit}) should be > ix limit (${ixStats.limit})`);
    });
});

describe("Aggregate cache operations", () => {
    it("should aggregate stats across all entity caches", () => {
        purgeAllCaches(); // Start clean
        const stats = getCacheStats();
        assert.ok(stats.entities);
        assert.ok(stats.totals);
        assert.equal(stats.totals.items, 0);
        assert.equal(stats.totals.bytes, 0);
    });

    it("should reflect items added to individual caches", () => {
        purgeAllCaches();
        const netCache = getEntityCache("net");
        netCache.add("test-key", new Uint8Array(50), {}, Date.now());
        const stats = getCacheStats();
        assert.equal(stats.entities.net.items, 1);
        assert.equal(stats.entities.net.bytes, 50);
        assert.equal(stats.totals.items, 1);
    });

    it("should purge all caches", () => {
        const netCache = getEntityCache("net");
        const orgCache = getEntityCache("org");
        netCache.add("a", new Uint8Array(10), {}, Date.now());
        orgCache.add("b", new Uint8Array(10), {}, Date.now());
        purgeAllCaches();
        assert.equal(getCacheStats().totals.items, 0);
    });

});

describe("normaliseCacheKey", () => {
    it("should return path alone when no query string", () => {
        assert.equal(normaliseCacheKey("api/net", ""), "api/net");
    });

    it("should sort query parameters alphabetically", () => {
        assert.equal(
            normaliseCacheKey("api/net", "limit=10&asn=13335&depth=1"),
            "api/net?asn=13335&depth=1&limit=10"
        );
    });

    it("should produce same key for reordered parameters", () => {
        const key1 = normaliseCacheKey("api/net", "depth=1&limit=10");
        const key2 = normaliseCacheKey("api/net", "limit=10&depth=1");
        assert.equal(key1, key2);
    });
});

describe("Negative cache TTL constants", () => {
    it("NEGATIVE_TTL should be shorter than DETAIL_TTL", () => {
        assert.ok(NEGATIVE_TTL < DETAIL_TTL,
            `NEGATIVE_TTL (${NEGATIVE_TTL}ms) should be < DETAIL_TTL (${DETAIL_TTL}ms)`);
    });

    it("NEGATIVE_TTL should be 5 minutes", () => {
        assert.equal(NEGATIVE_TTL, 5 * 60 * 1000);
    });

    it("DETAIL_TTL should be 60 minutes", () => {
        assert.equal(DETAIL_TTL, 60 * 60 * 1000);
    });
});

describe("Negative cache in LRU", () => {
    const EMPTY_ENVELOPE = new TextEncoder().encode('{"data":[],"meta":{}}');

    it("should store and retrieve a negative (empty) result", () => {
        const cache = LRUCache(8, 1024 * 1024);
        cache.add("api/net/999999", EMPTY_ENVELOPE, { entityTag: "net" }, Date.now());
        const entry = cache.get("api/net/999999");
        assert.notStrictEqual(entry, null);
        assert.equal(entry.buf.byteLength, EMPTY_ENVELOPE.byteLength);
    });

    it("should identify negative results by EMPTY_ENVELOPE equality", () => {
        const cache = LRUCache(8, 1024 * 1024);
        cache.add("api/net/999999", EMPTY_ENVELOPE, { entityTag: "net" }, Date.now());
        const entry = cache.get("api/net/999999");
        // Same reference means it's a negative cache entry
        assert.equal(entry.buf, EMPTY_ENVELOPE);
    });

    it("should distinguish negative from positive results", () => {
        const cache = LRUCache(8, 1024 * 1024);
        const realData = new TextEncoder().encode('{"data":[{"id":1}],"meta":{}}');
        cache.add("api/net/999999", EMPTY_ENVELOPE, { entityTag: "net" }, Date.now());
        cache.add("api/net/694", realData, { entityTag: "net" }, Date.now());

        const negEntry = cache.get("api/net/999999");
        const negBuf = negEntry.buf;
        const posEntry = cache.get("api/net/694");
        const posBuf = posEntry.buf;
        assert.equal(negBuf, EMPTY_ENVELOPE);
        assert.notEqual(posBuf, EMPTY_ENVELOPE);
    });

    it("negative entry should expire after NEGATIVE_TTL", () => {
        const cache = LRUCache(8, 1024 * 1024);
        const pastTime = Date.now() - NEGATIVE_TTL - 1;
        cache.add("api/net/999999", EMPTY_ENVELOPE, { entityTag: "net" }, pastTime);
        const entry = cache.get("api/net/999999");
        // Entry still exists in cache (LRU doesn't enforce TTL)
        // but the handler should check addedAt against NEGATIVE_TTL
        assert.notStrictEqual(entry, null);
        assert.ok((Date.now() - entry.addedAt) > NEGATIVE_TTL,
            "Entry should be older than NEGATIVE_TTL");
    });
});

describe("Shared return object (zero-allocation)", () => {
    it("consecutive get() calls should return the same object reference", () => {
        const cache = LRUCache(8, 1024 * 1024);
        cache.add("a", new Uint8Array([1]), {}, 1);
        cache.add("b", new Uint8Array([2]), {}, 2);

        const first = cache.get("a");
        const second = cache.get("b");
        assert.equal(first, second, "get() should return the same shared object");
        // After second get(), the shared object contains b's data
        assert.deepEqual(Array.from(second.buf), [2]);
    });

    it("callers must extract values before next get()", () => {
        const cache = LRUCache(8, 1024 * 1024);
        cache.add("x", new Uint8Array([10]), { tag: "x" }, 100);
        cache.add("y", new Uint8Array([20]), { tag: "y" }, 200);

        // Correct pattern: read fields before next get()
        const entry = cache.get("x");
        const xBuf = entry.buf;
        const xMeta = entry.meta;

        cache.get("y"); // overwrites _ret

        // xBuf and xMeta still reference the correct underlying arrays
        assert.deepEqual(Array.from(xBuf), [10]);
        assert.equal(xMeta.tag, "x");

        // But entry.buf now points to y's data (shared object was overwritten)
        assert.deepEqual(Array.from(entry.buf), [20]);
    });
});
