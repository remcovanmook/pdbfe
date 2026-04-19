/**
 * @fileoverview Unit tests for the entities module.
 *
 * Validates the ENTITY_SCHEMA structure, ENTITIES map, ENTITY_TAGS
 * array, and the getLabel() helper. All tests are pure — no DOM or
 * fetch mocking required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES, ENTITY_TAGS, getLabel, ENTITY_SCHEMA } from '../js/entities.js';

/** The 13 PeeringDB entity types we sync and serve. */
const ALL_TAGS = [
    'org', 'fac', 'net', 'ix', 'carrier', 'carrierfac',
    'ixfac', 'ixlan', 'ixpfx', 'poc', 'netfac', 'netixlan', 'campus',
];

/** The 6 navigable top-level types with detail pages. */
const TOP_LEVEL = ['net', 'ix', 'fac', 'org', 'carrier', 'campus'];

describe('ENTITY_SCHEMA — structure', () => {
    it('has an entities map with all 13 PeeringDB types', () => {
        assert.ok(ENTITY_SCHEMA.entities, 'ENTITY_SCHEMA.entities should exist');
        for (const tag of ALL_TAGS) {
            assert.ok(ENTITY_SCHEMA.entities[tag], `Missing entity: ${tag}`);
        }
    });
});

describe('ENTITIES — entity definitions', () => {
    it('contains all 13 entity types', () => {
        for (const tag of ALL_TAGS) {
            assert.ok(ENTITIES[tag], `Missing entity: ${tag}`);
        }
    });

    it('each entity has required shape (tag, label, table, fields, naming)', () => {
        for (const tag of ALL_TAGS) {
            const e = ENTITIES[tag];
            assert.equal(e.tag, tag, `tag mismatch for ${tag}`);
            assert.equal(typeof e.label, 'string', `${tag}.label should be a string`);
            assert.ok(e.label.length > 0, `${tag}.label should not be empty`);
            assert.equal(typeof e.table, 'string', `${tag}.table should be a string`);
            assert.ok(e.table.startsWith('peeringdb_'), `${tag}.table should start with peeringdb_`);
            assert.ok(Array.isArray(e.fields), `${tag}.fields should be an array`);
            assert.ok(e.fields.length > 0, `${tag}.fields should not be empty`);
            assert.ok(e.naming, `${tag}.naming should exist`);
            assert.equal(typeof e.naming.type, 'string', `${tag}.naming.type should be a string`);
            assert.equal(typeof e.naming.singular, 'string', `${tag}.naming.singular should be a string`);
            assert.equal(typeof e.naming.plural, 'string', `${tag}.naming.plural should be a string`);
        }
    });

    it('each field has a name and a valid type', () => {
        const validTypes = new Set(['string', 'number', 'boolean', 'datetime', 'json']);
        for (const tag of ALL_TAGS) {
            for (const field of ENTITIES[tag].fields) {
                assert.equal(typeof field.name, 'string', `${tag}: field name should be a string`);
                assert.ok(field.name.length > 0, `${tag}: field name should not be empty`);
                assert.ok(validTypes.has(field.type), `${tag}.${field.name}: invalid type "${field.type}"`);
            }
        }
    });

    it('no duplicate field names within an entity', () => {
        for (const tag of ALL_TAGS) {
            const names = ENTITIES[tag].fields.map(f => f.name);
            const unique = new Set(names);
            assert.equal(unique.size, names.length, `${tag}: duplicate field names detected`);
        }
    });

    it('poc is the only restricted entity', () => {
        for (const tag of ALL_TAGS) {
            if (tag === 'poc') {
                assert.equal(ENTITIES[tag].restricted, true, 'poc should be restricted');
                assert.ok(ENTITIES[tag].anonFilter, 'poc should have an anonFilter');
                assert.equal(ENTITIES[tag].anonFilter.field, 'visible');
                assert.equal(ENTITIES[tag].anonFilter.value, 'Public');
            } else {
                assert.equal(ENTITIES[tag].restricted, false, `${tag} should not be restricted`);
            }
        }
    });

    it('navigable entities (except org) have an org_id foreign key', () => {
        // org is the parent — it doesn't FK to itself
        const withOrgFk = TOP_LEVEL.filter(t => t !== 'org');
        for (const tag of withOrgFk) {
            const orgField = ENTITIES[tag].fields.find(f => f.name === 'org_id');
            assert.ok(orgField, `${tag} should have an org_id field`);
            assert.equal(orgField.foreignKey, 'org', `${tag}.org_id should FK to org`);
        }
    });
});

describe('ENTITY_TAGS — ordered tag list', () => {
    it('is an array of strings matching ENTITIES keys', () => {
        assert.ok(Array.isArray(ENTITY_TAGS));
        assert.deepEqual(ENTITY_TAGS, Object.keys(ENTITIES));
    });

    it('has 13 entries', () => {
        assert.equal(ENTITY_TAGS.length, ALL_TAGS.length);
    });
});

describe('getLabel — display label lookup', () => {
    it('returns the label for known entity tags', () => {
        assert.equal(getLabel('net'), 'Networks');
        assert.equal(getLabel('ix'), 'Exchanges');
        assert.equal(getLabel('fac'), 'Facilities');
        assert.equal(getLabel('org'), 'Organizations');
        assert.equal(getLabel('poc'), 'Points of Contact');
    });

    it('returns the tag itself for unknown tags', () => {
        assert.equal(getLabel('nonexistent'), 'nonexistent');
        assert.equal(getLabel(''), '');
    });
});
