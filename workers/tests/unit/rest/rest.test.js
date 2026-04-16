/**
 * @fileoverview Unit tests for the REST worker components.
 *
 * Validates the OpenAPI spec structure, Scalar UI output,
 * and REST cache configuration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── OpenAPI spec tests ──────────────────────────────────────────────────────

describe('openapi.json', () => {
    /** @type {Record<string, any>} */
    let spec;

    it('is valid JSON', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        spec = raw.default;
        assert.ok(spec);
    });

    it('has OpenAPI 3.1.0 version', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        assert.equal(raw.default.openapi, '3.1.0');
    });

    it('has info with title and version', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        assert.ok(raw.default.info.title);
        assert.ok(raw.default.info.version);
    });

    it('has 62 paths (13 entities × 2 + 36 sub-resources)', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        const pathCount = Object.keys(raw.default.paths).length;
        assert.equal(pathCount, 62);
    });

    it('has list paths for all entities', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        const entities = ['org', 'campus', 'fac', 'net', 'ix', 'carrier',
            'carrierfac', 'ixfac', 'ixlan', 'ixpfx', 'poc', 'netfac', 'netixlan'];
        for (const tag of entities) {
            assert.ok(raw.default.paths[`/v1/${tag}`], `Missing list path for ${tag}`);
        }
    });

    it('has detail paths with {id} parameter', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        assert.ok(raw.default.paths['/v1/net/{id}']);
        const params = raw.default.paths['/v1/net/{id}'].get.parameters;
        const idParam = params.find(p => p.name === 'id');
        assert.ok(idParam);
        assert.equal(idParam.in, 'path');
        assert.equal(idParam.required, true);
    });

    it('list endpoints have common query parameters', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        const netParams = raw.default.paths['/v1/net'].get.parameters;
        const paramNames = new Set(netParams.map(p => p.name));
        assert.ok(paramNames.has('limit'));
        assert.ok(paramNames.has('skip'));
        assert.ok(paramNames.has('depth'));
        assert.ok(paramNames.has('sort'));
    });

    it('list endpoints have entity-specific filter parameters', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        const netParams = raw.default.paths['/v1/net'].get.parameters;
        const paramNames = new Set(netParams.map(p => p.name));
        assert.ok(paramNames.has('asn'));
        assert.ok(paramNames.has('asn__gt'));
        assert.ok(paramNames.has('name__contains'));
    });

    it('has Error schema in components', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        assert.ok(raw.default.components.schemas.Error);
        assert.ok(raw.default.components.schemas.Error.properties.error);
    });

    it('has apiKey security scheme', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        assert.ok(raw.default.components.securitySchemes.apiKey);
        assert.equal(raw.default.components.securitySchemes.apiKey.type, 'apiKey');
    });
});

// Scalar UI HTML content is tested in tests/unit/core/branding.test.js
// via direct file reads (Node can't import .html modules without wrangler).

// ── Cache tests ─────────────────────────────────────────────────────────────

describe('REST cache', () => {
    it('exports getRestCache, getRestCacheStats, purgeRestCache', async () => {
        const mod = await import('../../../rest/cache.js');
        assert.ok(typeof mod.getRestCache === 'function');
        assert.ok(typeof mod.getRestCacheStats === 'function');
        assert.ok(typeof mod.purgeRestCache === 'function');
    });

    it('getRestCacheStats returns stats object', async () => {
        const { getRestCacheStats } = await import('../../../rest/cache.js');
        const stats = getRestCacheStats();
        assert.ok('items' in stats);
        assert.ok('bytes' in stats);
        assert.ok('limit' in stats);
    });

    it('REST_TTL is 60 minutes', async () => {
        const { REST_TTL } = await import('../../../rest/cache.js');
        assert.equal(REST_TTL, 60 * 60 * 1000);
    });
});

// ── Sub-resource map tests ──────────────────────────────────────────────────

describe('SUBRESOURCE_MAP', () => {
    it('exports a Map with entries for all entity tags', async () => {
        const { SUBRESOURCE_MAP } = await import('../../../rest/subresource.js');
        assert.ok(SUBRESOURCE_MAP instanceof Map);
        assert.ok(SUBRESOURCE_MAP.has('net'));
        assert.ok(SUBRESOURCE_MAP.has('org'));
        assert.ok(SUBRESOURCE_MAP.has('fac'));
    });

    it('org has reverse edges for networks, facilities, exchanges, carriers, campuses', async () => {
        const { SUBRESOURCE_MAP } = await import('../../../rest/subresource.js');
        const orgRels = SUBRESOURCE_MAP.get('org');
        assert.ok(orgRels.has('networks'), 'Missing org→networks');
        assert.ok(orgRels.has('facilities'), 'Missing org→facilities');
        assert.ok(orgRels.has('exchanges'), 'Missing org→exchanges');
        assert.ok(orgRels.has('carriers'), 'Missing org→carriers');
        assert.ok(orgRels.has('campuses'), 'Missing org→campuses');
    });

    it('net has a forward FK to organization', async () => {
        const { SUBRESOURCE_MAP } = await import('../../../rest/subresource.js');
        const netRels = SUBRESOURCE_MAP.get('net');
        assert.ok(netRels.has('organization'), 'Missing net→organization');
        const orgRel = netRels.get('organization');
        assert.equal(orgRel.direction, 'forward');
        assert.equal(orgRel.targetTag, 'org');
        assert.equal(orgRel.fkField, 'org_id');
    });

    it('net has reverse edges for contacts, network-facilities, network-exchange-lans', async () => {
        const { SUBRESOURCE_MAP } = await import('../../../rest/subresource.js');
        const netRels = SUBRESOURCE_MAP.get('net');
        assert.ok(netRels.has('contacts'), 'Missing net→contacts (poc)');
        assert.ok(netRels.has('network-facilities'), 'Missing net→network-facilities');
        assert.ok(netRels.has('network-exchange-lans'), 'Missing net→network-exchange-lans');

        const pocRel = netRels.get('contacts');
        assert.equal(pocRel.direction, 'reverse');
        assert.equal(pocRel.targetTag, 'poc');
    });

    it('reverse edge definitions have the correct FK field', async () => {
        const { SUBRESOURCE_MAP } = await import('../../../rest/subresource.js');
        const orgRels = SUBRESOURCE_MAP.get('org');
        const netRel = orgRels.get('networks');
        assert.equal(netRel.fkField, 'org_id');
        assert.equal(netRel.direction, 'reverse');
    });

    it('fac has forward FKs to organization and campuses', async () => {
        const { SUBRESOURCE_MAP } = await import('../../../rest/subresource.js');
        const facRels = SUBRESOURCE_MAP.get('fac');
        const orgRel = facRels.get('organization');
        assert.equal(orgRel.direction, 'forward');
        const campusRel = facRels.get('campuses');
        assert.equal(campusRel.direction, 'forward');
    });

    it('entities with no relationships still have empty Maps', async () => {
        const { SUBRESOURCE_MAP } = await import('../../../rest/subresource.js');
        // Every entity should have a Map (even if empty)
        for (const [, rels] of SUBRESOURCE_MAP) {
            assert.ok(rels instanceof Map);
        }
    });
});
