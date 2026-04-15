/**
 * @fileoverview Unit tests for render.js utility functions.
 * Covers formatSpeed — the unit-aware speed formatter used in
 * IX and net detail pages.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSpeed } from '../js/render.js';

describe("formatSpeed", () => {
    it("returns '—' for falsy values", () => {
        assert.equal(formatSpeed(0), '—');
        assert.equal(formatSpeed(null), '—');
        assert.equal(formatSpeed(undefined), '—');
    });

    it("returns megabits for values under 1000", () => {
        assert.equal(formatSpeed(100), '100M');
        assert.equal(formatSpeed(1), '1M');
        assert.equal(formatSpeed(999), '999M');
    });

    it("returns gigabits for values 1000–999999", () => {
        assert.equal(formatSpeed(1000), '1G');
        assert.equal(formatSpeed(10000), '10G');
        assert.equal(formatSpeed(100000), '100G');
    });

    it("returns terabits for values >= 1000000", () => {
        assert.equal(formatSpeed(1000000), '1T');
        assert.equal(formatSpeed(10000000), '10T');
    });

    it("rounds to 1 decimal place", () => {
        assert.equal(formatSpeed(1500), '1.5G');
        assert.equal(formatSpeed(2750), '2.8G');
        assert.equal(formatSpeed(1234567), '1.2T');
    });

    it("drops trailing .0 for clean integers", () => {
        assert.equal(formatSpeed(2000), '2G');
        assert.equal(formatSpeed(3000000), '3T');
    });

    it("handles non-round fractions", () => {
        // 12345 Mbps = 12.345G → rounds to 12.3G
        assert.equal(formatSpeed(12345), '12.3G');
        // 5555555 Mbps = 5.555555T → rounds to 5.6T
        assert.equal(formatSpeed(5555555), '5.6T');
    });
});
