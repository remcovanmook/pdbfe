/**
 * @fileoverview Unit tests for render.js utility functions.
 *
 * Covers:
 *   - formatSpeed — unit-aware speed formatter
 *   - formatDate  — relative time formatter
 *   - DOM builder functions that do not require <template> elements:
 *       createEntityBadge, createLink, createBool,
 *       createError, createLoading, createEmptyState
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDOM } from './helpers/mock-dom.js';

// ── formatSpeed ───────────────────────────────────────────────────────────────

// formatSpeed has no DOM dependencies — import once at module scope.
import { formatSpeed } from '../js/render.js';

describe('formatSpeed', () => {
    it("returns '—' for falsy values", () => {
        assert.equal(formatSpeed(0), '—');
        assert.equal(formatSpeed(null), '—');
        assert.equal(formatSpeed(undefined), '—');
    });

    it('returns megabits for values under 1000', () => {
        assert.equal(formatSpeed(100), '100M');
        assert.equal(formatSpeed(1), '1M');
        assert.equal(formatSpeed(999), '999M');
    });

    it('returns gigabits for values 1000–999999', () => {
        assert.equal(formatSpeed(1000), '1G');
        assert.equal(formatSpeed(10000), '10G');
        assert.equal(formatSpeed(100000), '100G');
    });

    it('returns terabits for values >= 1000000', () => {
        assert.equal(formatSpeed(1000000), '1T');
        assert.equal(formatSpeed(10000000), '10T');
    });

    it('rounds to 1 decimal place', () => {
        assert.equal(formatSpeed(1500), '1.5G');
        assert.equal(formatSpeed(2750), '2.8G');
        assert.equal(formatSpeed(1234567), '1.2T');
    });

    it('drops trailing .0 for clean integers', () => {
        assert.equal(formatSpeed(2000), '2G');
        assert.equal(formatSpeed(3000000), '3T');
    });

    it('handles non-round fractions', () => {
        // 12345 Mbps = 12.345G → rounds to 12.3G
        assert.equal(formatSpeed(12345), '12.3G');
        // 5555555 Mbps = 5.555555T → rounds to 5.6T
        assert.equal(formatSpeed(5555555), '5.6T');
    });
});

// ── formatDate ────────────────────────────────────────────────────────────────

// formatDate calls t() from i18n.js which uses document.title — mock DOM first.
describe('formatDate', () => {
    beforeEach(() => createMockDOM());

    it("returns '—' for falsy input", async () => {
        const { formatDate } = await import('../js/render.js');
        assert.equal(formatDate(null), '—');
        assert.equal(formatDate(undefined), '—');
        assert.equal(formatDate(''), '—');
    });

    it("returns 'just now' for timestamps within the last minute", async () => {
        const { formatDate } = await import('../js/render.js');
        const recent = new Date(Date.now() - 30_000).toISOString(); // 30s ago
        assert.equal(formatDate(recent), 'just now');
    });

    it("returns '1 minute ago' for timestamps ~60s old", async () => {
        const { formatDate } = await import('../js/render.js');
        const ts = new Date(Date.now() - 65_000).toISOString(); // 65s ago
        assert.equal(formatDate(ts), '1 minute ago');
    });

    it("returns '{n} minutes ago' for timestamps 2–59 min old", async () => {
        const { formatDate } = await import('../js/render.js');
        const ts = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
        const result = formatDate(ts);
        assert.ok(result.includes('5') && result.includes('minute'),
            `Expected "5 minutes ago", got: ${result}`);
    });

    it("returns '1 hour ago' for timestamps ~1h old", async () => {
        const { formatDate } = await import('../js/render.js');
        const ts = new Date(Date.now() - 61 * 60_000).toISOString();
        assert.equal(formatDate(ts), '1 hour ago');
    });

    it("returns '{n} days ago' for timestamps days old", async () => {
        const { formatDate } = await import('../js/render.js');
        const ts = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
        const result = formatDate(ts);
        assert.ok(result.includes('3') && result.includes('day'),
            `Expected "3 days ago", got: ${result}`);
    });

    it("returns '{n} years ago' for old timestamps", async () => {
        const { formatDate } = await import('../js/render.js');
        const ts = new Date(Date.now() - 2 * 365 * 24 * 60 * 60_000).toISOString();
        const result = formatDate(ts);
        assert.ok(result.includes('year'),
            `Expected "years ago", got: ${result}`);
    });
});

// ── DOM builders — no <template> dependency ───────────────────────────────────

describe('createEntityBadge', () => {
    beforeEach(() => createMockDOM());

    it('creates a span with the entity type as data-type and textContent', async () => {
        const { createEntityBadge } = await import('../js/render.js');
        const badge = createEntityBadge('net');
        assert.equal(badge.tagName, 'SPAN');
        assert.equal(badge.dataset.type, 'net');
        assert.equal(badge.textContent, 'net');
        assert.ok(badge.className.includes('entity-badge'));
    });

    it('adds entity-badge--header class when header option is set', async () => {
        const { createEntityBadge } = await import('../js/render.js');
        const badge = createEntityBadge('ix', { header: true });
        assert.ok(badge.className.includes('entity-badge--header'));
    });
});

describe('createLink', () => {
    beforeEach(() => createMockDOM());

    it('creates an anchor with correct href, data-link, and textContent', async () => {
        const { createLink } = await import('../js/render.js');
        const a = createLink('net', 694, 'Cloudflare');
        assert.equal(a.tagName, 'A');
        // createLink sets a.href as a direct property assignment (not setAttribute)
        assert.equal(a.href, '/net/694');
        // createLink sets dataset.link = '' (not setAttribute)
        assert.ok('link' in a.dataset, 'Should have dataset.link property');
        assert.equal(a.textContent, 'Cloudflare');
    });
});

describe('createBool', () => {
    beforeEach(() => createMockDOM());

    it('produces bool-yes class for true, 1, and "Yes"', async () => {
        const { createBool } = await import('../js/render.js');
        for (const val of [true, 1, 'Yes']) {
            const span = createBool(val);
            assert.ok(span.className.includes('bool-yes'),
                `createBool(${JSON.stringify(val)}) should be bool-yes`);
        }
    });

    it('produces bool-no class for false, 0, null, "No"', async () => {
        const { createBool } = await import('../js/render.js');
        for (const val of [false, 0, null, 'No', undefined]) {
            const span = createBool(val);
            assert.ok(span.className.includes('bool-no'),
                `createBool(${JSON.stringify(val)}) should be bool-no`);
        }
    });
});

describe('createError', () => {
    beforeEach(() => createMockDOM());

    it('creates a div with error-message class and the given message', async () => {
        const { createError } = await import('../js/render.js');
        const el = createError('Something went wrong');
        assert.equal(el.tagName, 'DIV');
        assert.ok(el.className.includes('error-message'));
        assert.equal(el.textContent, 'Something went wrong');
    });
});

describe('createLoading', () => {
    beforeEach(() => createMockDOM());

    it('creates a div with loading class', async () => {
        const { createLoading } = await import('../js/render.js');
        const el = createLoading();
        assert.equal(el.tagName, 'DIV');
        assert.ok(el.className.includes('loading'));
    });
});

describe('createEmptyState', () => {
    beforeEach(() => createMockDOM());

    it('creates a div with empty-state class and the given message', async () => {
        const { createEmptyState } = await import('../js/render.js');
        const el = createEmptyState('No results found');
        assert.equal(el.tagName, 'DIV');
        assert.ok(el.className.includes('empty-state'));
        assert.equal(el.textContent, 'No results found');
    });
});
