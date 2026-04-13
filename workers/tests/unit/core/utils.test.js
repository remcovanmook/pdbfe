/**
 * @fileoverview Unit tests for core/utils.js — tokenizeString.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeString } from '../../../core/utils.js';

describe('tokenizeString', () => {
    describe('default delimiter (/)', () => {
        it('returns empty object when no delimiter present', () => {
            const result = tokenizeString('hello');
            assert.deepStrictEqual(result, {});
        });

        it('splits simple path into two parts', () => {
            const result = tokenizeString('api/net', '/', 2);
            assert.equal(result.p0, 'api');
            assert.equal(result.p1, 'net');
        });

        it('remainder goes into last part with maxParts=2', () => {
            const result = tokenizeString('api/net/123', '/', 2);
            assert.equal(result.p0, 'api');
            assert.equal(result.p1, 'net/123');
        });

        it('splits into three parts', () => {
            const result = tokenizeString('api/net/123', '/', 3);
            assert.equal(result.p0, 'api');
            assert.equal(result.p1, 'net');
            assert.equal(result.p2, '123');
        });

        it('three-part split with fewer segments', () => {
            const result = tokenizeString('api/net', '/', 3);
            assert.equal(result.p0, 'api');
            assert.equal(result.p1, 'net');
            assert.equal(result.p2, undefined);
        });

        it('splits into four parts', () => {
            const result = tokenizeString('a/b/c/d', '/', 4);
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, 'b');
            assert.equal(result.p2, 'c');
            assert.equal(result.p3, 'd');
        });

        it('four-part split with remainder', () => {
            const result = tokenizeString('a/b/c/d/e', '/', 4);
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, 'b');
            assert.equal(result.p2, 'c');
            assert.equal(result.p3, 'd/e');
        });

        it('splits into five parts (default maxParts)', () => {
            const result = tokenizeString('a/b/c/d/e');
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, 'b');
            assert.equal(result.p2, 'c');
            assert.equal(result.p3, 'd');
            assert.equal(result.p4, 'e');
        });

        it('five-part split with remainder', () => {
            const result = tokenizeString('a/b/c/d/e/f/g');
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, 'b');
            assert.equal(result.p2, 'c');
            assert.equal(result.p3, 'd');
            assert.equal(result.p4, 'e/f/g');
        });
    });

    describe('custom delimiter', () => {
        it('splits on comma', () => {
            const result = tokenizeString('a,b,c', ',', 3);
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, 'b');
            assert.equal(result.p2, 'c');
        });

        it('comma split with remainder', () => {
            const result = tokenizeString('a,b,c,d', ',', 2);
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, 'b,c,d');
        });

        it('splits on colon', () => {
            const result = tokenizeString('host:port', ':', 2);
            assert.equal(result.p0, 'host');
            assert.equal(result.p1, 'port');
        });
    });

    describe('edge cases', () => {
        it('returns empty object for empty string', () => {
            assert.deepStrictEqual(tokenizeString(''), {});
        });

        it('returns empty object when maxParts is 0', () => {
            assert.deepStrictEqual(tokenizeString('a/b', '/', 0), {});
        });

        it('handles maxParts=1 via generic fallback', () => {
            const result = tokenizeString('a/b/c', '/', 1);
            assert.equal(result.p0, 'a/b/c');
        });

        it('handles leading delimiter', () => {
            const result = tokenizeString('/api/net', '/', 3);
            assert.equal(result.p0, '');
            assert.equal(result.p1, 'api');
            assert.equal(result.p2, 'net');
        });

        it('handles trailing delimiter', () => {
            const result = tokenizeString('api/net/', '/', 3);
            assert.equal(result.p0, 'api');
            assert.equal(result.p1, 'net');
            assert.equal(result.p2, '');
        });

        it('handles consecutive delimiters', () => {
            const result = tokenizeString('a//b', '/', 3);
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, '');
            assert.equal(result.p2, 'b');
        });

        it('generic fallback for maxParts > 5', () => {
            const result = tokenizeString('a/b/c/d/e/f/g', '/', 7);
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, 'b');
            assert.equal(result.p2, 'c');
            assert.equal(result.p3, 'd');
            assert.equal(result.p4, 'e');
            assert.equal(result.p5, 'f');
            assert.equal(result.p6, 'g');
        });
    });

    describe('unlimited mode (maxParts=-1)', () => {
        it('splits on every delimiter', () => {
            const result = tokenizeString('a/b/c/d/e', '/', -1);
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, 'b');
            assert.equal(result.p2, 'c');
            assert.equal(result.p3, 'd');
            assert.equal(result.p4, 'e');
            assert.equal(result.p5, undefined);
        });

        it('handles single segment', () => {
            const result = tokenizeString('hello', '/', -1);
            assert.deepStrictEqual(result, {});
        });

        it('handles two segments', () => {
            const result = tokenizeString('a/b', '/', -1);
            assert.equal(result.p0, 'a');
            assert.equal(result.p1, 'b');
        });

        it('handles many segments', () => {
            const result = tokenizeString('a&b&c&d&e&f&g&h', '&', -1);
            assert.equal(result.p0, 'a');
            assert.equal(result.p7, 'h');
        });

        it('no remainder in last part', () => {
            // Unlike maxParts=2, unlimited splits every occurrence
            const limited = tokenizeString('a/b/c', '/', 2);
            assert.equal(limited.p1, 'b/c'); // remainder

            const unlimited = tokenizeString('a/b/c', '/', -1);
            assert.equal(unlimited.p1, 'b');  // no remainder
            assert.equal(unlimited.p2, 'c');
        });
    });
});
