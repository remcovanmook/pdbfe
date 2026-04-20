/**
 * @fileoverview Unit tests for the theme module.
 *
 * Tests getTheme(), setTheme(), and initTheme() with minimal
 * localStorage and document.documentElement mocks.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** @type {Map<string, string>} */
let store;

/** @type {Record<string, string>} */
let datasetTheme;

/**
 * Installs minimal mocks for localStorage and document.documentElement.
 */
function setupMocks() {
    store = new Map();
    datasetTheme = {};

    globalThis.localStorage = /** @type {any} */ ({
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    });

    globalThis.document = /** @type {any} */ ({
        documentElement: { dataset: datasetTheme },
    });

    // Default: no OS light preference (= dark)
    globalThis.matchMedia = /** @type {any} */ ((query) => ({
        matches: false,
        media: query,
    }));
}

describe('getTheme', () => {
    beforeEach(() => setupMocks());

    it('returns "auto" when nothing is stored', async () => {
        const { getTheme } = await import('../../js/theme.js');
        assert.equal(getTheme(), 'auto');
    });

    it('returns "dark" when "dark" is stored', async () => {
        store.set('pdbfe-theme', 'dark');
        const { getTheme } = await import('../../js/theme.js');
        assert.equal(getTheme(), 'dark');
    });

    it('returns "light" when "light" is stored', async () => {
        store.set('pdbfe-theme', 'light');
        const { getTheme } = await import('../../js/theme.js');
        assert.equal(getTheme(), 'light');
    });
});

describe('setTheme', () => {
    beforeEach(() => setupMocks());

    it('persists "dark" and removes data-theme attribute', async () => {
        const { setTheme } = await import('../../js/theme.js');
        setTheme('dark');
        assert.equal(store.get('pdbfe-theme'), 'dark');
        assert.equal(datasetTheme.theme, undefined, 'Dark mode should delete data-theme');
    });

    it('persists "light" and sets data-theme="light"', async () => {
        const { setTheme } = await import('../../js/theme.js');
        setTheme('light');
        assert.equal(store.get('pdbfe-theme'), 'light');
        assert.equal(datasetTheme.theme, 'light');
    });

    it('"auto" removes stored preference and uses OS theme', async () => {
        store.set('pdbfe-theme', 'light');
        const { setTheme } = await import('../../js/theme.js');
        setTheme('auto');
        assert.equal(store.has('pdbfe-theme'), false, 'auto should remove stored key');
    });

    it('ignores invalid theme values', async () => {
        const { setTheme } = await import('../../js/theme.js');
        setTheme('neon');
        assert.equal(store.has('pdbfe-theme'), false, 'Invalid theme should not be stored');
    });

    it('"auto" applies light when OS prefers light', async () => {
        globalThis.matchMedia = /** @type {any} */ ((query) => ({
            matches: query === '(prefers-color-scheme: light)',
            media: query,
        }));
        const { setTheme } = await import('../../js/theme.js');
        setTheme('auto');
        assert.equal(datasetTheme.theme, 'light');
    });
});

describe('initTheme', () => {
    beforeEach(() => setupMocks());

    it('applies light when "light" is stored', async () => {
        store.set('pdbfe-theme', 'light');
        const { initTheme } = await import('../../js/theme.js');
        initTheme();
        assert.equal(datasetTheme.theme, 'light');
    });

    it('applies dark when "dark" is stored', async () => {
        store.set('pdbfe-theme', 'dark');
        const { initTheme } = await import('../../js/theme.js');
        initTheme();
        assert.equal(datasetTheme.theme, undefined, 'Dark mode removes data-theme');
    });

    it('follows OS preference when nothing is stored', async () => {
        const { initTheme } = await import('../../js/theme.js');
        initTheme();
        // Default matchMedia returns false for light → dark mode
        assert.equal(datasetTheme.theme, undefined);
    });
});
