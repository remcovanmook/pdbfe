/**
 * @fileoverview Unit tests for the GraphQL complexity validation rule
 * (depth + field-count bounds, fragment resolution, cycle guard).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, validate, buildSchema } from 'graphql';
import { createComplexityRule, MAX_QUERY_DEPTH, MAX_QUERY_FIELDS } from '../../../graphql/security.js';

// Minimal schema — validate() runs ONLY the rule we pass, so no type checking
// happens and arbitrary field names in the query AST are fine.
const schema = buildSchema('type Query { x: Int }');

/**
 * @param {string} query
 * @param {{maxDepth?: number, maxFields?: number}} [opts]
 * @returns {readonly import('graphql').GraphQLError[]}
 */
function check(query, opts) {
    return validate(schema, parse(query), [createComplexityRule(opts)]);
}

/** Build a query nested `n` selection sets deep: { a { a { ... x } } }. */
function deep(n) {
    let inner = 'x';
    for (let i = 0; i < n; i++) inner = `a { ${inner} }`;
    return `{ ${inner} }`;
}

describe('GraphQL complexity rule — depth', () => {
    it('passes a shallow query', () => {
        assert.equal(check('{ a { b { c } } }', { maxDepth: 5 }).length, 0);
    });

    it('passes a query exactly at the depth limit', () => {
        assert.equal(check(deep(3), { maxDepth: 3 }).length, 0);
    });

    it('rejects a query past the depth limit', () => {
        const errs = check(deep(4), { maxDepth: 3 });
        assert.equal(errs.length, 1);
        assert.match(errs[0].message, /deeply nested/);
    });

    it('rejects a pathologically deep query under the real default', () => {
        const errs = check(deep(MAX_QUERY_DEPTH + 5));
        assert.ok(errs.some(e => /deeply nested/.test(e.message)));
    });
});

describe('GraphQL complexity rule — field count', () => {
    it('passes a query within the field budget', () => {
        assert.equal(check('{ a b c }', { maxFields: 5 }).length, 0);
    });

    it('rejects a query with too many fields (alias amplification)', () => {
        // 6 aliased fields > maxFields 5.
        const q = '{ ' + Array.from({ length: 6 }, (_, i) => `f${i}: x`).join(' ') + ' }';
        const errs = check(q, { maxFields: 5 });
        assert.equal(errs.length, 1);
        assert.match(errs[0].message, /too many fields/);
    });

    it('a normal query is under the default field budget', () => {
        assert.ok(MAX_QUERY_FIELDS > 100);
        assert.equal(check('{ net { id name org { id name } } }').length, 0);
    });
});

describe('GraphQL complexity rule — fragments', () => {
    it('counts depth/fields through fragment spreads', () => {
        const q = `query { ...F } fragment F on Query { a { b { c } } }`;
        // Fragment adds depth 2 (a>b) — exceeds maxDepth 1.
        const errs = check(q, { maxDepth: 1 });
        assert.ok(errs.some(e => /deeply nested/.test(e.message)));
    });

    it('does not hang or crash on a cyclic fragment (guard)', () => {
        const q = `query { ...A } fragment A on Query { ...B } fragment B on Query { ...A }`;
        // Must terminate; we only assert it returns (no infinite recursion).
        assert.doesNotThrow(() => check(q, { maxDepth: 3 }));
    });
});
