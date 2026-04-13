/**
 * @fileoverview Unit tests for api/entities.js.
 *
 * Tests entity field accessor functions, query/field validation,
 * implicit filter resolution, and cross-entity filter resolution.
 * Uses precompiled entity definitions from the generated registry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    ENTITIES,
    ENTITY_TAGS,
    getColumns,
    getJsonColumns,
    getBoolColumns,
    getNullableColumns,
    getFilterType,
    validateFields,
    validateQuery,
    resolveImplicitFilters,
    resolveCrossEntityFilter,
    MAX_IN_VALUES,
} from '../../../api/entities.js';

// ── Entity registry ──────────────────────────────────────────────────────────

describe('ENTITIES registry', () => {
    it('contains expected core entities', () => {
        const expected = ['net', 'org', 'fac', 'ix', 'poc', 'netfac', 'netixlan', 'ixfac', 'ixlan', 'ixpfx'];
        for (const tag of expected) {
            assert.ok(ENTITY_TAGS.has(tag), `missing entity: ${tag}`);
        }
    });

    it('each entity has table and fields', () => {
        for (const tag of ENTITY_TAGS) {
            const entity = ENTITIES[tag];
            assert.ok(entity.table, `${tag} missing table`);
            assert.ok(Array.isArray(entity.fields), `${tag} missing fields`);
            assert.ok(entity.fields.length > 0, `${tag} has no fields`);
        }
    });
});

// ── Field accessor helpers ───────────────────────────────────────────────────

describe('getColumns', () => {
    it('returns array of column names for net', () => {
        const cols = getColumns(ENTITIES.net);
        assert.ok(Array.isArray(cols));
        assert.ok(cols.includes('id'));
        assert.ok(cols.includes('asn'));
        assert.ok(cols.includes('name'));
    });

    it('returns consistent results on repeated calls', () => {
        const a = getColumns(ENTITIES.org);
        const b = getColumns(ENTITIES.org);
        assert.deepEqual(a, b);
    });
});

describe('getJsonColumns', () => {
    it('returns JSON-stored columns for net', () => {
        const json = getJsonColumns(ENTITIES.net);
        // net has social_media, info_types as JSON columns
        assert.ok(json.size > 0 || json.length > 0);
    });
});

describe('getBoolColumns', () => {
    it('returns boolean columns for net', () => {
        const bools = getBoolColumns(ENTITIES.net);
        assert.ok(bools.size > 0 || bools.length > 0);
    });
});

describe('getNullableColumns', () => {
    it('returns a set (or iterable) for fac', () => {
        const nullable = getNullableColumns(ENTITIES.fac);
        // fac has nullable lat/lng
        assert.ok(nullable);
    });
});

describe('getFilterType', () => {
    it('returns type for a known field', () => {
        const type = getFilterType(ENTITIES.net, 'asn');
        assert.equal(type, 'number');
    });

    it('returns type for string field', () => {
        const type = getFilterType(ENTITIES.net, 'name');
        assert.equal(type, 'string');
    });

    it('returns null for unknown field', () => {
        const type = getFilterType(ENTITIES.net, 'nonexistent_field_xyz');
        assert.equal(type, null);
    });
});

// ── validateFields ───────────────────────────────────────────────────────────

describe('validateFields', () => {
    it('returns only valid field names', () => {
        const result = validateFields(ENTITIES.net, ['id', 'asn', 'fake_field']);
        assert.ok(result.includes('id'));
        assert.ok(result.includes('asn'));
        assert.ok(!result.includes('fake_field'));
    });

    it('returns empty array for all-invalid fields', () => {
        const result = validateFields(ENTITIES.net, ['zzz', 'yyy']);
        assert.equal(result.length, 0);
    });
});

// ── validateQuery ────────────────────────────────────────────────────────────

describe('validateQuery', () => {
    it('returns null for valid filters', () => {
        const filters = [{ field: 'asn', op: 'eq', value: '12345' }];
        const error = validateQuery(ENTITIES.net, filters, '');
        assert.equal(error, null);
    });

    it('returns error string for unknown field', () => {
        const filters = [{ field: 'nonexistent_abc', op: 'eq', value: 'x' }];
        const error = validateQuery(ENTITIES.net, filters, '');
        assert.equal(typeof error, 'string');
    });

    it('returns error for invalid sort field', () => {
        const error = validateQuery(ENTITIES.net, [], 'nonexistent_field');
        assert.equal(typeof error, 'string');
    });

    it('accepts valid sort field', () => {
        const error = validateQuery(ENTITIES.net, [], 'name');
        assert.equal(error, null);
    });

    it('accepts descending sort with - prefix', () => {
        const error = validateQuery(ENTITIES.net, [], '-name');
        assert.equal(error, null);
    });
});

// ── resolveImplicitFilters ───────────────────────────────────────────────────

describe('resolveImplicitFilters', () => {
    it('resolves FK-based cross-entity filters', () => {
        // net has org_id FK → org. 'city' is queryable on org but not a field on net.
        const filters = [{ field: 'city', op: 'eq', value: 'Amsterdam' }];
        resolveImplicitFilters(ENTITIES.net, filters);
        assert.equal(filters[0].entity, 'org');
    });

    it('leaves direct entity fields unchanged', () => {
        const filters = [{ field: 'asn', op: 'eq', value: '123' }];
        resolveImplicitFilters(ENTITIES.net, filters);
        assert.equal(filters[0].entity, undefined);
    });

    it('leaves already-explicit cross-entity filters unchanged', () => {
        const filters = [{ field: 'name', op: 'eq', value: 'Test', entity: 'org' }];
        resolveImplicitFilters(ENTITIES.net, filters);
        assert.equal(filters[0].entity, 'org');
    });
});

// ── MAX_IN_VALUES ────────────────────────────────────────────────────────────

describe('MAX_IN_VALUES', () => {
    it('is a reasonable upper bound', () => {
        assert.ok(MAX_IN_VALUES > 0);
        assert.ok(MAX_IN_VALUES <= 1000);
    });
});
