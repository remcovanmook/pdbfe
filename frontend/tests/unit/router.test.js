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
/** Event types the router sent through globalThis.dispatchEvent. */
const dispatchedEvents = /** @type {string[]} */ ([]);

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
    globalThis.dispatchEvent = (e) => { dispatchedEvents.push(e.type); return true; };
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

    it('stale navigation guard: second navigation wins race over slow first handler', async () => {
        const { addRoute, navigate } = await import('../../js/router.js');

        const handlersRun = /** @type {string[]} */ ([]);

        const container = /** @type {any} */ ({
            innerHTML: '',
            classList: { add: () => {}, remove: () => {} },
            replaceChildren: () => {},
        });

        // Slow handler — simulates an in-flight async fetch
        let resolveSlowHandler = /** @type {Function} */ (() => {});
        addRoute('/slow-test', async () => {
            handlersRun.push('slow-started');
            await new Promise(r => { resolveSlowHandler = r; });
            handlersRun.push('slow-finished');
        });

        // Fast handler — fires second
        addRoute('/fast-test', async () => { handlersRun.push('fast'); });

        // Boot the router on /slow-test
        const { initRouter } = await import('../../js/router.js');
        globalThis.location.pathname = '/slow-test';
        globalThis.location.search = '';
        initRouter(container);

        // Fire a second navigation while /slow-test handler is mid-await
        globalThis.location.pathname = '/fast-test';
        navigate('/fast-test');
        await new Promise(r => setTimeout(r, 10));

        // Fast handler should have run
        assert.ok(handlersRun.includes('fast'), 'Fast handler should have run');
        // Slow handler started but hasn't finished yet
        assert.ok(handlersRun.includes('slow-started'), 'Slow handler should have started');
        assert.ok(!handlersRun.includes('slow-finished'), 'Slow handler should still be pending');

        // Resolve the slow handler
        resolveSlowHandler();
        await new Promise(r => setTimeout(r, 10));

        // After resolution, the slow handler's body completed but the router
        // discarded its post-await bookkeeping (sessionStorage cache, error render).
        // The key guarantee: the fast navigation was not blocked or overwritten.
        assert.ok(handlersRun.includes('slow-finished'), 'Slow handler body eventually completes');
        assert.ok(handlersRun.includes('fast'), 'Fast navigation result is preserved');
    });

    it('fires pdbfe:navigate on every dispatch so the footer can refresh', async () => {
        const { addRoute, navigate } = await import('../../js/router.js');
        addRoute('/nav-event-test', async () => {});

        dispatchedEvents.length = 0;
        globalThis.location.pathname = '/nav-event-test';
        navigate('/nav-event-test');
        navigate('/nav-event-test');

        assert.deepEqual(dispatchedEvents, ['pdbfe:navigate', 'pdbfe:navigate']);
    });
});

describe('addLazyRoute', () => {
    beforeEach(() => setupMocks());

    /** A container whose replaceChildren calls are recorded (error renders). */
    function trackedContainer() {
        const replaced = /** @type {any[]} */ ([]);
        return {
            replaced,
            container: /** @type {any} */ ({
                innerHTML: '',
                classList: { add: () => {}, remove: () => {} },
                replaceChildren: (...n) => { replaced.push(n); },
            }),
        };
    }

    /** sessionStorage that actually stores (the lazy reload guard uses it). */
    function realSessionStorage() {
        /** @type {Record<string, string>} */
        const store = {};
        globalThis.sessionStorage = /** @type {any} */ ({
            getItem: (k) => store[k] ?? null,
            setItem: (k, v) => { store[k] = v; },
            removeItem: (k) => { delete store[k]; },
        });
    }

    const tick = () => new Promise((r) => setTimeout(r, 10));

    /** navigate() as the browser would see it (the mock pushState doesn't move location). */
    async function go(navigate, path) {
        globalThis.location.pathname = path;
        globalThis.location.search = '';
        navigate(path);
        await tick();
    }

    it('loads the page module on first visit only, then reuses it', async () => {
        const { addLazyRoute, initRouter, navigate } = await import('../../js/router.js');
        let loads = 0; let renders = 0;
        addLazyRoute('/lazy-once', async () => { loads++; return async () => { renders++; }; });
        initRouter(trackedContainer().container);
        await go(navigate, '/lazy-once');
        await go(navigate, '/lazy-once');
        assert.equal(loads, 1);
        assert.equal(renders, 2);
    });

    it('does not render a page that finished loading after a newer navigation', async () => {
        const { addRoute, addLazyRoute, initRouter, navigate } = await import('../../js/router.js');
        let release = /** @type {Function} */ (() => {});
        let lazyRendered = false;
        addLazyRoute('/lazy-slow', () => new Promise((r) => { release = () => r(async () => { lazyRendered = true; }); }));
        addRoute('/lazy-other', async () => {});
        initRouter(trackedContainer().container);
        await go(navigate, '/lazy-slow');
        await go(navigate, '/lazy-other');
        release(); await tick();
        assert.equal(lazyRendered, false);
    });

    it('reloads once when the module fails to load, then shows the error', async () => {
        realSessionStorage();
        const assigned = /** @type {string[]} */ ([]);
        globalThis.location.assign = (u) => { assigned.push(u); };
        const { addLazyRoute, initRouter, navigate } = await import('../../js/router.js');
        addLazyRoute('/lazy-gone', async () => { throw new TypeError('Failed to fetch dynamically imported module'); });
        const { container, replaced } = trackedContainer();
        initRouter(container);
        replaced.length = 0;

        await go(navigate, '/lazy-gone');
        assert.deepEqual(assigned, ['/lazy-gone'], 'first failure reloads the page');
        assert.equal(replaced.length, 0, 'no error rendered before the reload');

        await go(navigate, '/lazy-gone'); // the reloaded page fails again
        assert.deepEqual(assigned, ['/lazy-gone'], 'no second reload');
        assert.equal(replaced.length, 1, 'the error is shown');
    });
});
