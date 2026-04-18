/**
 * @fileoverview Unit tests for the GraphQL cache layer.
 *
 * Tests graphqlCacheKey SHA-256 hash generation, cache stats/purge
 * functions, and the withGqlSWR wrapper.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    graphqlCacheKey,
    getGqlCacheStats,
    purgeGqlCache,
    getGqlCache,
    GQL_TTL,
    GQL_EMPTY_SENTINEL,
    withGqlSWR,
} from '../../../graphql/cache.js';

// ── Mock ExecutionContext ────────────────────────────────────────────────────

/**
 * Creates a minimal mock ExecutionContext.
 *
 * @returns {{ctx: ExecutionContext, waitUntilCalls: Promise<any>[]}}
 */
function mockCtx() {
    /** @type {Promise<any>[]} */
    const waitUntilCalls = [];
    return {
        ctx: /** @type {ExecutionContext} */ ({
            waitUntil: (/** @type {Promise<any>} */ p) => { waitUntilCalls.push(p); },
            passThroughOnException: () => {}
        }),
        waitUntilCalls,
    };
}

// ── graphqlCacheKey ──────────────────────────────────────────────────────────

describe('graphqlCacheKey', () => {
    it('returns a string prefixed with gql/', async () => {
        const key = await graphqlCacheKey('{ net(id:1) { name } }');
        assert.ok(key.startsWith('gql/'), `Expected gql/ prefix, got: ${key}`);
    });

    it('produces consistent hash for same query', async () => {
        const query = '{ net(asn:13335) { name asn } }';
        const key1 = await graphqlCacheKey(query);
        const key2 = await graphqlCacheKey(query);
        assert.equal(key1, key2);
    });

    it('produces different hashes for different queries', async () => {
        const key1 = await graphqlCacheKey('{ net(id:1) { name } }');
        const key2 = await graphqlCacheKey('{ ix(id:1) { name } }');
        assert.notEqual(key1, key2);
    });

    it('includes variables in hash computation', async () => {
        const query = '{ net(id: $id) { name } }';
        const key1 = await graphqlCacheKey(query, { id: 1 });
        const key2 = await graphqlCacheKey(query, { id: 2 });
        assert.notEqual(key1, key2);
    });

    it('treats undefined variables same as empty object', async () => {
        const query = '{ net { name } }';
        const key1 = await graphqlCacheKey(query);
        const key2 = await graphqlCacheKey(query, undefined);
        assert.equal(key1, key2);
    });

    it('returns a hex string (gql/ prefix + 64 hex chars)', async () => {
        const key = await graphqlCacheKey('{ net { id } }');
        const hex = key.slice(4); // Remove 'gql/'
        assert.match(hex, /^[0-9a-f]{64}$/);
    });
});

// ── Cache stats and purge ────────────────────────────────────────────────────

describe('getGqlCacheStats', () => {
    beforeEach(() => {
        purgeGqlCache();
    });

    it('returns stats object with required fields', () => {
        const stats = getGqlCacheStats();
        assert.ok('items' in stats);
        assert.ok('bytes' in stats);
        assert.ok('limit' in stats);
    });

    it('reports zero items on a fresh cache', () => {
        const stats = getGqlCacheStats();
        assert.equal(stats.items, 0);
        assert.equal(stats.bytes, 0);
    });

    it('reports items after cache population', () => {
        const cache = getGqlCache();
        const payload = new TextEncoder().encode('{"data":{"net":[]},"errors":[]}');
        cache.add('test/gql-stats', payload, { entityTag: 'graphql' }, Date.now());

        const stats = getGqlCacheStats();
        assert.ok(stats.items > 0);
        assert.ok(stats.bytes > 0);

        purgeGqlCache();
    });
});

describe('purgeGqlCache', () => {
    it('empties the cache', () => {
        const cache = getGqlCache();
        cache.add('test/purge', new Uint8Array(10), { entityTag: 'graphql' }, Date.now());
        assert.ok(getGqlCacheStats().items > 0);

        purgeGqlCache();
        assert.equal(getGqlCacheStats().items, 0);
    });
});

// ── withGqlSWR ───────────────────────────────────────────────────────────────

describe('withGqlSWR', () => {
    beforeEach(() => {
        purgeGqlCache();
    });

    it('calls queryFn on cache miss and returns MISS tier', async () => {
        const { ctx } = mockCtx();
        const payload = new TextEncoder().encode('{"data":{"net":[{"id":1}]},"errors":[]}');

        let called = false;
        const result = await withGqlSWR('test/miss-' + Date.now(), ctx, async () => {
            called = true;
            return payload;
        });

        assert.equal(called, true);
        assert.notStrictEqual(result.buf, null);
        assert.equal(result.hits, 0);
    });

    it('returns L1 hit on second access', async () => {
        const { ctx } = mockCtx();
        const key = 'test/l1hit-' + Date.now();
        const payload = new TextEncoder().encode('{"data":{"net":[]},"errors":[]}');

        // First call → miss
        await withGqlSWR(key, ctx, async () => payload);

        // Second call → L1 hit
        let called = false;
        const result = await withGqlSWR(key, ctx, async () => {
            called = true;
            return payload;
        });

        assert.equal(called, false, 'Should not call queryFn on L1 hit');
        assert.equal(result.tier, 'L1');
        assert.ok(result.hits >= 1);
    });

    it('returns null buf for negative cache entries', async () => {
        const { ctx } = mockCtx();
        const key = 'test/negative-' + Date.now();

        // Store negative entry
        const result = await withGqlSWR(key, ctx, async () => null);
        assert.equal(result.buf, null);
    });
});
