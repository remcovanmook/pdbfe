/**
 * @fileoverview Unit tests for the structural JSON comparison engine.
 *
 * Tests all diff kinds (missing_field, extra_field, type_mismatch),
 * null compatibility, nested recursion, and array probing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareStructure, compareResponses, jsonType } from '../../lib/compare.js';

// ── jsonType ─────────────────────────────────────────────────────────────────

describe('jsonType', () => {
    it('null → "null"', () => assert.equal(jsonType(null), 'null'));
    it('undefined → "null"', () => assert.equal(jsonType(undefined), 'null'));
    it('true → "bool"', () => assert.equal(jsonType(true), 'bool'));
    it('false → "bool"', () => assert.equal(jsonType(false), 'bool'));
    it('42 → "number"', () => assert.equal(jsonType(42), 'number'));
    it('0 → "number"', () => assert.equal(jsonType(0), 'number'));
    it('"hello" → "string"', () => assert.equal(jsonType('hello'), 'string'));
    it('"" → "string"', () => assert.equal(jsonType(''), 'string'));
    it('[] → "array"', () => assert.equal(jsonType([]), 'array'));
    it('{} → "object"', () => assert.equal(jsonType({}), 'object'));
});

// ── compareStructure ─────────────────────────────────────────────────────────

describe('compareStructure', () => {
    it('identical objects → no diffs', () => {
        const obj = { id: 1, name: 'Test', active: true };
        assert.deepEqual(compareStructure(obj, obj), []);
    });

    it('detects missing field', () => {
        const ref = { id: 1, name: 'Test' };
        const act = { id: 1 };
        const diffs = compareStructure(ref, act);
        assert.equal(diffs.length, 1);
        assert.equal(diffs[0].path, 'name');
        assert.equal(diffs[0].kind, 'missing_field');
    });

    it('detects extra field', () => {
        const ref = { id: 1 };
        const act = { id: 1, extra: 'boom' };
        const diffs = compareStructure(ref, act);
        assert.equal(diffs.length, 1);
        assert.equal(diffs[0].path, 'extra');
        assert.equal(diffs[0].kind, 'extra_field');
    });

    it('detects type mismatch', () => {
        const ref = { speed: 10000 };
        const act = { speed: '10000' };
        const diffs = compareStructure(ref, act);
        assert.equal(diffs.length, 1);
        assert.equal(diffs[0].path, 'speed');
        assert.equal(diffs[0].kind, 'type_mismatch');
    });

    it('null is compatible with any type (no diff)', () => {
        const ref = { logo: 'https://example.com/logo.png' };
        const act = { logo: null };
        assert.deepEqual(compareStructure(ref, act), []);
    });

    it('null in reference is compatible with populated actual', () => {
        const ref = { logo: null };
        const act = { logo: 'https://example.com/logo.png' };
        assert.deepEqual(compareStructure(ref, act), []);
    });

    it('recurses into nested objects', () => {
        const ref = { org: { id: 1, name: 'Org' } };
        const act = { org: { id: 1 } };
        const diffs = compareStructure(ref, act);
        assert.equal(diffs.length, 1);
        assert.equal(diffs[0].path, 'org.name');
        assert.equal(diffs[0].kind, 'missing_field');
    });

    it('probes array elements via [0]', () => {
        const ref = { data: [{ id: 1, name: 'Net' }] };
        const act = { data: [{ id: 1 }] };
        const diffs = compareStructure(ref, act);
        assert.equal(diffs.length, 1);
        assert.equal(diffs[0].path, 'data[0].name');
        assert.equal(diffs[0].kind, 'missing_field');
    });

    it('empty arrays produce no diffs', () => {
        const ref = { data: [] };
        const act = { data: [] };
        assert.deepEqual(compareStructure(ref, act), []);
    });

    it('empty ref array vs populated actual → no diffs (can not probe)', () => {
        const ref = { data: [] };
        const act = { data: [{ id: 1 }] };
        assert.deepEqual(compareStructure(ref, act), []);
    });

    it('both empty objects → no diffs', () => {
        assert.deepEqual(compareStructure({}, {}), []);
    });

    it('diffs are sorted by path', () => {
        const ref = { z: 1, a: 1, m: 1 };
        const act = {};
        const diffs = compareStructure(ref, act);
        const paths = diffs.map(d => d.path);
        assert.deepEqual(paths, ['a', 'm', 'z']);
    });

    it('detects multiple kinds simultaneously', () => {
        const ref = { id: 1, name: 'Test' };
        const act = { id: '1', extra: true };
        const diffs = compareStructure(ref, act);
        const kinds = new Set(diffs.map(d => d.kind));
        assert.ok(kinds.has('type_mismatch'));
        assert.ok(kinds.has('missing_field'));
        assert.ok(kinds.has('extra_field'));
    });

    it('deeply nested type mismatch reports full path', () => {
        const ref = { data: [{ org: { meta: { count: 42 } } }] };
        const act = { data: [{ org: { meta: { count: '42' } } }] };
        const diffs = compareStructure(ref, act);
        assert.equal(diffs.length, 1);
        assert.equal(diffs[0].path, 'data[0].org.meta.count');
    });
});

// ── compareResponses ─────────────────────────────────────────────────────────

describe('compareResponses', () => {
    it('parses JSON and compares', () => {
        const ref = JSON.stringify({ data: [{ id: 1 }] });
        const act = JSON.stringify({ data: [{ id: 1, name: 'X' }] });
        const diffs = compareResponses(ref, act);
        assert.equal(diffs.length, 1);
        assert.equal(diffs[0].kind, 'extra_field');
    });

    it('identical JSON → no diffs', () => {
        const json = JSON.stringify({ data: [{ id: 1, name: 'Test' }], meta: {} });
        assert.deepEqual(compareResponses(json, json), []);
    });
});
