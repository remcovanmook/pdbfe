/**
 * @fileoverview Property-based fuzz test for the query filter parser.
 *
 * Generates 1000 random query strings with arbitrary field names,
 * operator suffixes, and values, then verifies parseQueryFilters
 * never throws. Errors from invalid input are acceptable — the
 * contract is no exceptions on untrusted input.
 *
 * Uses a seeded PRNG for reproducible results across runs.
 *
 * Derived from peeringdb-plus/internal/pdbcompat/fuzz_test.go.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQueryFilters } from '../../../api/utils.js';

// ── Seeded PRNG (xorshift32) ─────────────────────────────────────────────────

/**
 * Creates a deterministic pseudo-random number generator.
 * Uses xorshift32 for simplicity and reproducibility.
 *
 * @param {number} seed - Initial seed value (must be non-zero).
 * @returns {{next: () => number, nextInt: (max: number) => number, pick: <T>(arr: T[]) => T}}
 */
function createRng(seed) {
    let state = seed >>> 0 || 1;

    function next() {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0xFFFFFFFF;
    }

    function nextInt(max) {
        return Math.floor(next() * max);
    }

    function pick(arr) {
        return arr[nextInt(arr.length)];
    }

    return { next, nextInt, pick };
}

// ── Random input generators ─────────────────────────────────────────────────

/** Valid PeeringDB field names for realistic fuzzing. */
const VALID_FIELDS = [
    'id', 'name', 'asn', 'org_id', 'net_id', 'fac_id', 'ix_id',
    'status', 'country', 'city', 'info_prefixes4', 'info_unicast',
    'created', 'updated', 'speed', 'ipaddr4', 'ipaddr6',
    'info_traffic', 'info_ratio', 'policy_general',
];

/** Known PeeringDB filter operators. */
const VALID_OPS = ['', '__contains', '__startswith', '__in', '__lt', '__gt', '__lte', '__gte'];

/** Garbage strings for adversarial inputs. */
const GARBAGE = [
    '', '__', '___', '____', '__regex', '__exec', '__proto__',
    'constructor', 'toString', 'valueOf', '__contains__in',
    'a'.repeat(200), '日本語', '<script>', '${evil}',
    '%00', '%0a', '\n', '\t', '\r\n',
];

/**
 * Generates a random query string with 1-5 key=value pairs.
 *
 * @param {ReturnType<typeof createRng>} rng - PRNG instance.
 * @returns {string} A raw query string (no leading ?).
 */
function randomQueryString(rng) {
    const pairCount = rng.nextInt(5) + 1;
    const pairs = [];

    for (let i = 0; i < pairCount; i++) {
        // 70% chance of valid field, 30% garbage
        const field = rng.next() < 0.7
            ? rng.pick(VALID_FIELDS)
            : rng.pick(GARBAGE);

        // 60% chance of valid operator, 40% garbage
        const op = rng.next() < 0.6
            ? rng.pick(VALID_OPS)
            : rng.pick(GARBAGE);

        // Random value
        const valueKind = rng.nextInt(6);
        let value;
        switch (valueKind) {
            case 0: value = ''; break;
            case 1: value = String(rng.nextInt(100000)); break;
            case 2: value = 'test_string'; break;
            case 3: value = rng.pick(GARBAGE); break;
            case 4: value = `${rng.nextInt(1000)},${rng.nextInt(1000)}`; break;
            case 5: value = 'true'; break;
        }

        pairs.push(`${encodeURIComponent(field + op)}=${encodeURIComponent(value)}`);
    }

    return pairs.join('&');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Filter parser fuzz', () => {
    const ITERATIONS = 1000;
    const SEED = 0xDEADBEEF;

    it(`parseQueryFilters does not throw on ${ITERATIONS} random inputs`, () => {
        const rng = createRng(SEED);
        let crashCount = 0;

        for (let i = 0; i < ITERATIONS; i++) {
            const qs = randomQueryString(rng);
            try {
                parseQueryFilters(qs);
            } catch (err) {
                crashCount++;
                // Log the first few crashes for debugging.
                if (crashCount <= 5) {
                    console.error(`  Crash at iteration ${i}: qs=${JSON.stringify(qs)}`);
                    console.error(`  Error: ${err.message}`);
                }
            }
        }

        assert.equal(crashCount, 0,
            `parseQueryFilters crashed on ${crashCount}/${ITERATIONS} random inputs`);
    });

    it('handles edge case: empty string', () => {
        assert.doesNotThrow(() => parseQueryFilters(''));
    });

    it('handles edge case: single equals sign', () => {
        assert.doesNotThrow(() => parseQueryFilters('='));
    });

    it('handles edge case: key without value', () => {
        assert.doesNotThrow(() => parseQueryFilters('name'));
    });

    it('handles edge case: multiple ampersands', () => {
        assert.doesNotThrow(() => parseQueryFilters('&&&'));
    });

    it('handles edge case: encoded null byte', () => {
        assert.doesNotThrow(() => parseQueryFilters('name=%00'));
    });

    it('handles edge case: very long value', () => {
        assert.doesNotThrow(() => parseQueryFilters(`name=${'x'.repeat(10000)}`));
    });

    it('handles edge case: unicode field name', () => {
        assert.doesNotThrow(() => parseQueryFilters('名前=value'));
    });

    it('handles edge case: double-encoded percent', () => {
        assert.doesNotThrow(() => parseQueryFilters('name=%2525'));
    });

    it('handles edge case: __proto__ as field name', () => {
        const result = parseQueryFilters('__proto__=test');
        // Should parse without throwing; filter may or may not be created
        assert.ok(result);
    });

    it('handles edge case: constructor as field name', () => {
        const result = parseQueryFilters('constructor=test');
        assert.ok(result);
    });
});
