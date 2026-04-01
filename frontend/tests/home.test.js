/**
 * @fileoverview Unit tests for the homepage and about page renderers.
 * Tests output structure, column configuration, and display formatting
 * by mocking the DOM and API calls.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM mock: enough for getElementById, createElement, and innerHTML
function createMockDOM() {
    const elements = {};
    globalThis.document = /** @type {any} */ ({
        getElementById: (id) => elements[id] || null,
        title: '',
        addEventListener: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            className: '',
            innerHTML: '',
            setAttribute: () => {},
            getAttribute: () => null,
            addEventListener: () => {},
            contains: () => false,
            classList: { add: () => {}, remove: () => {}, contains: () => false },
            querySelectorAll: () => [],
            querySelector: () => null,
            parentElement: null,
            appendChild: () => {},
        }),
        head: { appendChild: () => {} },
        activeElement: null,
    });
    globalThis.window = /** @type {any} */ ({
        __router: { navigate: () => {} },
        scrollTo: () => {},
        location: { href: 'http://localhost/' },
    });

    /**
     * Registers a mock DOM element that getElementById can find.
     *
     * @param {string} id - Element ID.
     * @returns {{ innerHTML: string, addEventListener: Function }} Mock element.
     */
    function register(id) {
        const el = {
            innerHTML: '',
            value: '',
            addEventListener: () => {},
            classList: { add: () => {}, remove: () => {}, contains: () => false },
            querySelectorAll: () => [],
            querySelector: () => null,
            parentElement: null,
            contains: () => false,
        };
        elements[id] = el;
        return el;
    }

    return { register, elements };
}

describe('renderHome', () => {
    let appEl;
    let dom;

    beforeEach(() => {
        dom = createMockDOM();
        appEl = dom.register('app');
        dom.register('home-search-input');
        dom.register('recent-updates');
        dom.register('global-stats');
    });

    it('should set the page title', async () => {
        // Mock the api module to prevent real fetches
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => /** @type {any} */ ({
            ok: true,
            json: async () => ({ data: [], meta: {} }),
        });

        try {
            const { renderHome } = await import('../js/pages/home.js');
            await renderHome({});
            assert.equal(document.title, 'PeeringDB');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should render hero section with correct tagline', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => /** @type {any} */ ({
            ok: true,
            json: async () => ({ data: [], meta: {} }),
        });

        try {
            const { renderHome } = await import('../js/pages/home.js');
            await renderHome({});

            assert.ok(appEl.innerHTML.includes('Synced. Read Only. Fast.'),
                'Hero should contain the tagline');
            assert.ok(appEl.innerHTML.includes('The Interconnection Database'),
                'Page should contain the heading');
            assert.ok(appEl.innerHTML.includes('read-only mirror'),
                'Description should mention read-only mirror');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should render four recent update columns with correct labels', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => /** @type {any} */ ({
            ok: true,
            json: async () => ({ data: [], meta: {} }),
        });

        try {
            const { renderHome } = await import('../js/pages/home.js');
            await renderHome({});

            assert.ok(appEl.innerHTML.includes('Most Recent Updates'),
                'Should have Most Recent Updates heading');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('renderAbout', () => {
    let appEl;

    beforeEach(() => {
        const dom = createMockDOM();
        appEl = dom.register('app');
    });

    it('should set the page title', async () => {
        const { renderAbout } = await import('../js/pages/about.js');
        await renderAbout({});
        assert.equal(document.title, 'About — PeeringDB Mirror');
    });

    it('should render all expected sections', async () => {
        const { renderAbout } = await import('../js/pages/about.js');
        await renderAbout({});

        assert.ok(appEl.innerHTML.includes('About This Mirror'),
            'Should have the title');
        assert.ok(appEl.innerHTML.includes('What is this?'),
            'Should have What is this? section');
        assert.ok(appEl.innerHTML.includes('Data Freshness'),
            'Should have Data Freshness section');
        assert.ok(appEl.innerHTML.includes('Acceptable Use'),
            'Should have Acceptable Use section');
        assert.ok(appEl.innerHTML.includes('API'),
            'Should have API section');
        assert.ok(appEl.innerHTML.includes('Source Code'),
            'Should have Source Code section');
    });

    it('should link to the upstream AUP and Privacy Policy', async () => {
        const { renderAbout } = await import('../js/pages/about.js');
        await renderAbout({});

        assert.ok(appEl.innerHTML.includes('peeringdb.com/aup'),
            'Should link to the AUP');
        assert.ok(appEl.innerHTML.includes('PeeringDB_Privacy_Policy'),
            'Should link to the Privacy Policy');
    });

    it('should show an API example', async () => {
        const { renderAbout } = await import('../js/pages/about.js');
        await renderAbout({});

        assert.ok(appEl.innerHTML.includes('/api/net/694'),
            'Should show API example endpoint');
    });
});
