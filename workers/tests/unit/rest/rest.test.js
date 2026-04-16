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

    it('has 26 paths (13 entities × 2)', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        const pathCount = Object.keys(raw.default.paths).length;
        assert.equal(pathCount, 26);
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
        const paramNames = netParams.map(p => p.name);
        assert.ok(paramNames.includes('limit'));
        assert.ok(paramNames.includes('skip'));
        assert.ok(paramNames.includes('depth'));
        assert.ok(paramNames.includes('sort'));
    });

    it('list endpoints have entity-specific filter parameters', async () => {
        const raw = await import('../../../../extracted/openapi.json', { with: { type: 'json' } });
        const netParams = raw.default.paths['/v1/net'].get.parameters;
        const paramNames = netParams.map(p => p.name);
        assert.ok(paramNames.includes('asn'));
        assert.ok(paramNames.includes('asn__gt'));
        assert.ok(paramNames.includes('name__contains'));
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

// ── Scalar UI tests ─────────────────────────────────────────────────────────

describe('serveScalarUI', () => {
    it('returns an HTML response', async () => {
        const { serveScalarUI } = await import('../../../rest/scalar.js');
        const response = serveScalarUI();
        assert.equal(response.status, 200);
        assert.ok(response.headers.get('Content-Type').includes('text/html'));
    });

    it('HTML contains Scalar CDN script', async () => {
        const { serveScalarUI } = await import('../../../rest/scalar.js');
        const response = serveScalarUI();
        const html = await response.text();
        assert.ok(html.includes('cdn.jsdelivr.net/npm/@scalar/api-reference'));
    });

    it('HTML points at /openapi.json', async () => {
        const { serveScalarUI } = await import('../../../rest/scalar.js');
        const response = serveScalarUI();
        const html = await response.text();
        assert.ok(html.includes('/openapi.json'));
    });

    it('HTML has proper meta tags', async () => {
        const { serveScalarUI } = await import('../../../rest/scalar.js');
        const response = serveScalarUI();
        const html = await response.text();
        assert.ok(html.includes('<title>'));
        assert.ok(html.includes('charset="utf-8"'));
        assert.ok(html.includes('viewport'));
    });
});

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
