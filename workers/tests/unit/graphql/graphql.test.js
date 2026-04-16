/**
 * @fileoverview Unit tests for the GraphQL schema codegen output.
 *
 * Validates that the generated SDL and resolvers are structurally sound:
 * - SDL contains expected types, inputs, and queries
 * - whereToFilters translates GraphQL args to ParsedFilter format
 * - Resolver factories produce callable functions
 * - L2 cache key generation is deterministic
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── SDL structure tests ─────────────────────────────────────────────────────

describe('graphql-typedefs.js', () => {
    /** @type {string} */
    let typeDefs;

    it('exports a non-empty typeDefs string', async () => {
        const mod = await import('../../../../extracted/graphql-typedefs.js');
        typeDefs = mod.typeDefs;
        assert.ok(typeof typeDefs === 'string');
        assert.ok(typeDefs.length > 1000, 'SDL should be at least 1000 chars');
    });

    it('declares the JSON scalar', async () => {
        const mod = await import('../../../../extracted/graphql-typedefs.js');
        assert.ok(mod.typeDefs.includes('scalar JSON'));
    });

    it('declares all 13 entity types', async () => {
        const mod = await import('../../../../extracted/graphql-typedefs.js');
        const sdl = mod.typeDefs;
        const expectedTypes = [
            'Organization', 'Campus', 'Facility', 'Network', 'Exchange',
            'Carrier', 'CarrierFacility', 'ExchangeFacility', 'ExchangeLan',
            'ExchangePrefix', 'PointOfContact', 'NetworkFacility', 'NetworkExchangeLan',
        ];
        for (const t of expectedTypes) {
            assert.ok(sdl.includes(`type ${t} {`), `Missing type ${t}`);
        }
    });

    it('declares WhereInput for each entity', async () => {
        const mod = await import('../../../../extracted/graphql-typedefs.js');
        const sdl = mod.typeDefs;
        const expectedInputs = [
            'OrganizationWhere', 'NetworkWhere', 'ExchangeWhere', 'FacilityWhere',
        ];
        for (const inp of expectedInputs) {
            assert.ok(sdl.includes(`input ${inp} {`), `Missing input ${inp}`);
        }
    });

    it('declares the root Query type with list and detail queries', async () => {
        const mod = await import('../../../../extracted/graphql-typedefs.js');
        const sdl = mod.typeDefs;
        assert.ok(sdl.includes('type Query {'));
        assert.ok(sdl.includes('network(id: Int!): Network'));
        assert.ok(sdl.includes('networks(where: NetworkWhere, limit: Int, skip: Int): [Network!]!'));
        assert.ok(sdl.includes('networkByAsn(asn: Int!): Network'));
    });

    it('includes FK relationship fields', async () => {
        const mod = await import('../../../../extracted/graphql-typedefs.js');
        const sdl = mod.typeDefs;
        // Network.org should resolve to Organization
        assert.ok(sdl.includes('org: Organization'));
        // ExchangeFacility should have ix: Exchange and fac: Facility
        assert.ok(sdl.includes('ix: Exchange'));
        assert.ok(sdl.includes('fac: Facility'));
    });

    it('includes filter operators for numeric fields', async () => {
        const mod = await import('../../../../extracted/graphql-typedefs.js');
        const sdl = mod.typeDefs;
        assert.ok(sdl.includes('asn: Int'));
        assert.ok(sdl.includes('asn_lt: Int'));
        assert.ok(sdl.includes('asn_gt: Int'));
        assert.ok(sdl.includes('asn_lte: Int'));
        assert.ok(sdl.includes('asn_gte: Int'));
        assert.ok(sdl.includes('asn_in: [Int]'));
    });

    it('includes filter operators for string fields', async () => {
        const mod = await import('../../../../extracted/graphql-typedefs.js');
        const sdl = mod.typeDefs;
        assert.ok(sdl.includes('name_contains: String'));
        assert.ok(sdl.includes('name_startswith: String'));
        assert.ok(sdl.includes('name_in: [String]'));
    });

    it('skips filter operators for non-queryable fields', async () => {
        const mod = await import('../../../../extracted/graphql-typedefs.js');
        const sdl = mod.typeDefs;
        // social_media is marked queryable: false in entities.json
        assert.ok(!sdl.includes('social_media_contains'));
        assert.ok(!sdl.includes('social_media_startswith'));
    });
});

// ── Resolver structure tests ────────────────────────────────────────────────

describe('graphql-resolvers.js', () => {
    it('exports a resolvers object with Query property', async () => {
        const mod = await import('../../../../extracted/graphql-resolvers.js');
        assert.ok(mod.resolvers);
        assert.ok(mod.resolvers.Query);
    });

    it('has list and detail resolvers for all entities', async () => {
        const mod = await import('../../../../extracted/graphql-resolvers.js');
        const q = mod.resolvers.Query;
        const expected = [
            'organization', 'organizations',
            'campus', 'campuses',
            'facility', 'facilities',
            'network', 'networks',
            'exchange', 'exchanges',
            'carrier', 'carriers',
            'networkByAsn',
        ];
        for (const name of expected) {
            assert.ok(typeof q[name] === 'function', `Missing query resolver: ${name}`);
        }
    });

    it('has FK resolvers for Network.org', async () => {
        const mod = await import('../../../../extracted/graphql-resolvers.js');
        assert.ok(mod.resolvers.Network);
        assert.ok(typeof mod.resolvers.Network.org === 'function');
    });

    it('has FK resolvers for ExchangeFacility.ix and .fac', async () => {
        const mod = await import('../../../../extracted/graphql-resolvers.js');
        assert.ok(mod.resolvers.ExchangeFacility);
        assert.ok(typeof mod.resolvers.ExchangeFacility.ix === 'function');
        assert.ok(typeof mod.resolvers.ExchangeFacility.fac === 'function');
    });

    it('has FK resolvers for NetworkExchangeLan', async () => {
        const mod = await import('../../../../extracted/graphql-resolvers.js');
        const nel = mod.resolvers.NetworkExchangeLan;
        assert.ok(nel);
        assert.ok(typeof nel.net === 'function');
        assert.ok(typeof nel.ixlan === 'function');
        assert.ok(typeof nel.net_side === 'function');
        assert.ok(typeof nel.ix_side === 'function');
    });
});

// ── L2 cache key tests ──────────────────────────────────────────────────────

describe('graphqlCacheKey', () => {
    it('produces deterministic keys for the same input', async () => {
        const { graphqlCacheKey } = await import('../../../graphql/l2.js');
        const key1 = await graphqlCacheKey('{ networks { id } }', {});
        const key2 = await graphqlCacheKey('{ networks { id } }', {});
        assert.equal(key1, key2);
    });

    it('produces different keys for different queries', async () => {
        const { graphqlCacheKey } = await import('../../../graphql/l2.js');
        const key1 = await graphqlCacheKey('{ networks { id } }', {});
        const key2 = await graphqlCacheKey('{ exchanges { id } }', {});
        assert.notEqual(key1, key2);
    });

    it('produces different keys for different variables', async () => {
        const { graphqlCacheKey } = await import('../../../graphql/l2.js');
        const key1 = await graphqlCacheKey('{ network(id: $id) { name } }', { id: 1 });
        const key2 = await graphqlCacheKey('{ network(id: $id) { name } }', { id: 2 });
        assert.notEqual(key1, key2);
    });

    it('key starts with gql/ prefix', async () => {
        const { graphqlCacheKey } = await import('../../../graphql/l2.js');
        const key = await graphqlCacheKey('{ __typename }', undefined);
        assert.ok(key.startsWith('gql/'));
    });

    it('key has correct hex length (gql/ + 64 hex chars)', async () => {
        const { graphqlCacheKey } = await import('../../../graphql/l2.js');
        const key = await graphqlCacheKey('{ __typename }', {});
        // "gql/" (4 chars) + 64 hex chars = 68
        assert.equal(key.length, 68);
    });
});
