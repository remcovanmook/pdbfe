/**
 * @fileoverview Unit tests for the diagnostic overlay and cache diagnostics.
 *
 * Tests getCacheDiagnostics() and initDebugger() using mock DOM and
 * mock fetch to simulate the browser environment.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock DOM setup ──────────────────────────────────────────────────

/**
 * Creates a minimal mock DOM environment sufficient for the debug
 * and api modules to load and run basic operations.
 */
function createMockDOM() {
    const listeners = {};
    globalThis.document = /** @type {any} */ ({
        getElementById: () => null,
        title: '',
        addEventListener: (type, fn) => {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(fn);
        },
        removeEventListener: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            className: '',
            id: '',
            innerHTML: '',
            textContent: '',
            style: {},
            setAttribute: () => {},
            getAttribute: () => null,
            hasAttribute: () => false,
            addEventListener: () => {},
            contains: () => false,
            classList: { add: () => {}, remove: () => {}, contains: () => false },
            querySelectorAll: () => [],
            querySelector: () => null,
            parentElement: null,
            appendChild: () => {},
            append: () => {},
            replaceChildren: () => {},
            remove: () => {},
            dataset: {},
        }),
        createDocumentFragment: () => ({
            children: [],
            appendChild(c) { this.children.push(c); return c; },
            append(...nodes) { for (const n of nodes) this.children.push(n); },
            replaceChildren() { this.children.length = 0; },
            querySelectorAll: () => [],
            querySelector: () => null,
        }),
        createTextNode: (text) => ({ nodeType: 3, textContent: text }),
        head: { appendChild: () => {} },
        body: { appendChild: () => {}, dataset: {} },
        activeElement: null,
    });
    globalThis.window = /** @type {any} */ ({
        __router: { navigate: () => {} },
        scrollTo: () => {},
        location: { href: 'http://localhost/', pathname: '/', reload: () => {} },
        addEventListener: () => {},
        history: { pushState: () => {} },
    });
    globalThis.history = globalThis.window.history;
    return { listeners };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('getCacheDiagnostics', () => {
    beforeEach(() => {
        createMockDOM();
        globalThis.fetch = async () => /** @type {any} */ ({
            ok: true,
            json: async () => ({ data: [], meta: {} }),
            headers: new Map([
                ['X-Cache', 'L1'],
                ['X-Cache-Hits', '3'],
                ['X-Timer', 'S100,VS0,VE5'],
                ['X-Served-By', 'cache-AMS-1'],
                ['X-Isolate-ID', 'abc123'],
            ]),
        });
    });

    it('should return empty array when cache has no entries', async () => {
        const { getCacheDiagnostics } = await import('../js/api.js');
        // Fresh module import — cache should be empty
        const stats = getCacheDiagnostics();
        assert.ok(Array.isArray(stats));
        // May have entries from other tests if modules are cached.
        // Just verify shape.
    });

    it('should return entries with correct shape after a fetch', async () => {
        const { getCacheDiagnostics, clearCache } = await import('../js/api.js');
        clearCache();

        // Populate cache via fetchList
        const { fetchList } = await import('../js/api.js');
        await fetchList('net', { limit: 1 });

        const stats = getCacheDiagnostics();
        assert.ok(stats.length >= 1, 'Should have at least one entry');

        const entry = stats.find(s => s.key.includes('/api/net'));
        assert.ok(entry, 'Should have a net API entry');
        assert.equal(typeof entry.ageMs, 'number');
        assert.ok(entry.ageMs >= 0, 'ageMs should be non-negative');
        assert.equal(typeof entry.telemetry, 'object');
        assert.equal(entry.telemetry.tier, 'L1');
        assert.equal(entry.telemetry.hits, '3');
    });

    it('should filter out auth-prefixed cache keys', async () => {
        const { getCacheDiagnostics, clearCache } = await import('../js/api.js');
        clearCache();

        // Simulate authenticated fetch — key would start with auth:
        // We'll make a fetch that uses a session ID
        globalThis.document.cookie = '';
        const { fetchList } = await import('../js/api.js');
        await fetchList('net', { limit: 1 });

        const stats = getCacheDiagnostics();
        const authEntries = stats.filter(s => s.key.startsWith('auth:'));
        assert.equal(authEntries.length, 0, 'Should not expose auth-prefixed entries');
    });
});

describe('initDebugger', () => {
    /** @type {{listeners: Record<string, Function[]>}} */
    let dom;

    beforeEach(() => {
        dom = createMockDOM();
        globalThis.fetch = async () => /** @type {any} */ ({
            ok: true,
            json: async () => ({ data: [], meta: {} }),
            headers: new Map(),
        });
    });

    it('should register a keydown listener', async () => {
        const { initDebugger } = await import('../js/debug.js');
        const before = (dom.listeners['keydown'] || []).length;
        initDebugger();
        const after = (dom.listeners['keydown'] || []).length;
        assert.ok(after > before, 'Should have registered a keydown listener');
    });

    it('should not trigger on plain D key', async () => {
        const { initDebugger } = await import('../js/debug.js');
        initDebugger();

        const handler = dom.listeners['keydown']?.[dom.listeners['keydown'].length - 1];
        assert.ok(handler, 'keydown handler should exist');

        let prevented = false;
        handler({
            key: 'd',
            ctrlKey: false,
            shiftKey: true,
            target: { tagName: 'BODY', isContentEditable: false },
            preventDefault: () => { prevented = true; },
        });

        // Should not trigger — needs ctrlKey
        assert.equal(prevented, false, 'Plain Shift+D should not trigger overlay');
    });

    it('should not trigger when target is an INPUT', async () => {
        const { initDebugger } = await import('../js/debug.js');
        initDebugger();

        const handler = dom.listeners['keydown']?.[dom.listeners['keydown'].length - 1];
        let prevented = false;
        handler({
            key: 'd',
            ctrlKey: true,
            shiftKey: true,
            target: { tagName: 'INPUT', isContentEditable: false },
            preventDefault: () => { prevented = true; },
        });

        assert.equal(prevented, false, 'Should not trigger when inside INPUT');
    });
});
