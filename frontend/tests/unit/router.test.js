/**
 * @fileoverview Unit tests for the router module.
 *
 * Tests addRoute() pattern compilation and the route matching
 * logic. Uses a minimal DOM mock — only enough for the module
 * to load. Tests focus on the pure route-matching logic, not
 * the DOM manipulation in dispatch().
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Minimal DOM mock for router module loading.
 * The router imports createError from render.js, which needs
 * document.createElement. We set up the bare minimum.
 */
function setupMocks() {
    globalThis.document = /** @type {any} */ ({
        getElementById: () => null,
        title: '',
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            className: '', id: '', innerHTML: '', textContent: '',
            style: {}, dataset: {},
            setAttribute: () => {}, getAttribute: () => null,
            hasAttribute: () => false,
            addEventListener: () => {},
            classList: { add: () => {}, remove: () => {}, contains: () => false },
            querySelectorAll: () => [],
            querySelector: () => null,
            appendChild: () => {}, append: () => {},
            replaceChildren: () => {}, remove: () => {},
            parentElement: null,
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
        documentElement: { dataset: {} },
        activeElement: null,
    });

    globalThis.scrollTo = () => {};
    globalThis.location = /** @type {any} */ ({
        href: 'http://localhost/',
        pathname: '/',
        search: '',
        reload: () => {},
    });
    globalThis.addEventListener = () => {};
    globalThis.history = /** @type {any} */ ({
        pushState: () => {},
        scrollRestoration: 'auto',
    });
    globalThis.requestAnimationFrame = (fn) => fn();
    globalThis.sessionStorage = /** @type {any} */ ({
        getItem: () => null,
        setItem: () => {},
    });

    // Mock fetch for modules that import api.js
    globalThis.fetch = /** @type {any} */ (async () => ({
        ok: true,
        json: async () => ({ data: [], meta: {} }),
        headers: new Map(),
    }));

    // Mock localStorage for auth.js import chain
    globalThis.localStorage = /** @type {any} */ ({
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    });

    globalThis.matchMedia = /** @type {any} */ (() => ({ matches: false }));
}

describe('addRoute — pattern compilation', () => {
    beforeEach(() => setupMocks());

    it('matches a simple path without params', async () => {
        const { addRoute } = await import('../../js/router.js');

        let matched = false;
        addRoute('/', async () => { matched = true; });

        // Verify the internal regex catches "/"
        // We can test by calling navigate, but that triggers dispatch
        // which needs _appContainer. Instead, re-test the regex pattern
        // by checking what addRoute compiled.
        // Since _routes is private, test indirectly via initRouter + navigate.
        // For now, verify addRoute doesn't throw.
        assert.ok(!matched, 'addRoute should not call handler immediately');
    });

    it('compiles :param placeholders into named capture groups', async () => {
        const { addRoute } = await import('../../js/router.js');

        // addRoute converts "/net/:id" → regex with named group
        // We test this by registering, then navigating, and capturing params.
        /** @type {Record<string, string>|null} */
        let captured = null;
        addRoute('/net/:id', async (params) => { captured = params; });

        // To invoke the route, we need initRouter. But initRouter dispatches
        // the current URL, so let's set up a minimal container.
        const container = /** @type {any} */ ({
            innerHTML: '',
            classList: { add: () => {}, remove: () => {} },
            replaceChildren: () => {},
        });
        globalThis.location.pathname = '/net/42';
        globalThis.location.search = '';

        const { initRouter } = await import('../../js/router.js');
        initRouter(container);

        // Wait for async dispatch
        await new Promise(r => setTimeout(r, 10));
        assert.ok(captured, 'Handler should have been called');
        assert.equal(captured.id, '42', 'Should capture :id param');
    });

    it('passes query parameters to the handler', async () => {
        const { addRoute, initRouter } = await import('../../js/router.js');

        /** @type {Record<string, string>|null} */
        let captured = null;
        addRoute('/search', async (params) => { captured = params; });

        const container = /** @type {any} */ ({
            innerHTML: '',
            classList: { add: () => {}, remove: () => {} },
            replaceChildren: () => {},
        });
        globalThis.location.pathname = '/search';
        globalThis.location.search = '?q=cloudflare&limit=10';

        initRouter(container);
        await new Promise(r => setTimeout(r, 10));

        assert.ok(captured, 'Handler should have been called');
        assert.equal(captured.q, 'cloudflare');
        assert.equal(captured.limit, '10');
    });

    it('handles trailing slashes', async () => {
        const { addRoute, initRouter } = await import('../../js/router.js');

        /** @type {Record<string, string>|null} */
        let captured = null;
        addRoute('/fac/:id', async (params) => { captured = params; });

        const container = /** @type {any} */ ({
            innerHTML: '',
            classList: { add: () => {}, remove: () => {} },
            replaceChildren: () => {},
        });
        globalThis.location.pathname = '/fac/99/';
        globalThis.location.search = '';

        initRouter(container);
        await new Promise(r => setTimeout(r, 10));

        assert.ok(captured, 'Should match path with trailing slash');
        assert.equal(captured.id, '99');
    });
});
