/**
 * @fileoverview Unit tests for the countries module.
 *
 * Validates structural integrity of the COUNTRIES data: no duplicate
 * codes, alphabetical ordering by name, ISO-3166-1 code format, and
 * inclusion of the user-assigned XK (Kosovo) code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES } from '../js/countries.js';

describe('COUNTRIES — data integrity', () => {
    it('is a frozen non-empty array', () => {
        assert.ok(Array.isArray(COUNTRIES));
        assert.ok(COUNTRIES.length > 200, `Expected 200+ countries, got ${COUNTRIES.length}`);
        assert.ok(Object.isFrozen(COUNTRIES), 'COUNTRIES array should be frozen');
    });

    it('every entry has a two-letter uppercase code and a non-empty name', () => {
        for (const c of COUNTRIES) {
            assert.match(c.code, /^[A-Z]{2}$/, `Invalid code: ${c.code}`);
            assert.ok(c.name.length > 0, `Empty name for code ${c.code}`);
        }
    });

    it('has no duplicate country codes', () => {
        const codes = COUNTRIES.map(c => c.code);
        const unique = new Set(codes);
        assert.equal(unique.size, codes.length, 'Duplicate country codes detected');
    });

    it('is sorted alphabetically by name', () => {
        for (let i = 1; i < COUNTRIES.length; i++) {
            const prev = COUNTRIES[i - 1].name;
            const curr = COUNTRIES[i].name;
            assert.ok(
                prev.localeCompare(curr, 'en') <= 0,
                `Out of order: "${prev}" should come before "${curr}"`
            );
        }
    });

    it('includes Kosovo (XK) — user-assigned code used by PeeringDB', () => {
        const xk = COUNTRIES.find(c => c.code === 'XK');
        assert.ok(xk, 'Kosovo (XK) should be present');
        assert.equal(xk.name, 'Kosovo');
    });

    it('includes common networking countries', () => {
        const codes = new Set(COUNTRIES.map(c => c.code));
        for (const expected of ['US', 'DE', 'NL', 'GB', 'JP', 'SG', 'BR', 'AU']) {
            assert.ok(codes.has(expected), `Missing country code: ${expected}`);
        }
    });
});
