/**
 * @fileoverview Unit tests for the homepage and about page renderers.
 * Tests output structure, column configuration, and display formatting
 * by mocking the DOM and API calls.
 *
 * The renderers now produce DOM nodes (not HTML strings). The mock DOM
 * tracks child nodes and provides a textContent getter that recursively
 * collects text from the tree, allowing assertions against the rendered
 * output without a real browser.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock DOM ────────────────────────────────────────────────────────

/**
 * Creates a mock DOM element with enough fidelity to support the
 * DOM-based rendering pipeline (appendChild, replaceChildren,
 * textContent, querySelector, etc.).
 *
 * @param {string} tag - Element tag name (lowercased).
 * @returns {object} Mock element.
 */
function mockElement(tag) {
    /** @type {any[]} */
    const children = [];
    const attrs = {};
    const classList = new Set();
    const style = {};

    const dataset = {};

    const el = {
        tagName: tag.toUpperCase(),
        nodeType: 1,
        className: '',
        id: '',
        innerHTML: '',
        style,
        dataset,
        children,
        childNodes: children,
        parentElement: null,
        autofocus: false,
        type: '',
        value: '',
        placeholder: '',

        /** @param {string} k @param {string} v */
        setAttribute(k, v) { attrs[k] = v; },
        /** @param {string} k @returns {string|null} */
        getAttribute(k) { return attrs[k] ?? null; },
        /** @param {string} k @returns {boolean} */
        hasAttribute(k) { return k in attrs; },
        /** @param {string} k */
        removeAttribute(k) { delete attrs[k]; },

        addEventListener() {},
        contains() { return false; },
        scrollIntoView() {},
        focus() {},
        remove() {
            if (el.parentElement) {
                const idx = el.parentElement.children.indexOf(el);
                if (idx >= 0) el.parentElement.children.splice(idx, 1);
            }
        },

        classList: {
            add(c) { classList.add(c); },
            remove(c) { classList.delete(c); },
            contains(c) { return classList.has(c); },
        },

        /**
         * Appends a child node. Supports both elements and text nodes.
         * @param {any} child
         * @returns {any}
         */
        appendChild(child) {
            if (child && child._isFragment) {
                // DocumentFragment: move all children
                for (const c of child.children.splice(0)) {
                    c.parentElement = el;
                    children.push(c);
                }
            } else if (child) {
                child.parentElement = el;
                children.push(child);
            }
            return child;
        },

        /**
         * Appends multiple children — mirrors Element.append().
         * Strings are converted to text nodes.
         * @param {...any} nodes
         */
        append(...nodes) {
            for (const n of nodes) {
                if (typeof n === 'string') {
                    el.appendChild(mockTextNode(n));
                } else {
                    el.appendChild(n);
                }
            }
        },

        /**
         * Replaces all children — the primary render path.
         * @param {...any} nodes
         */
        replaceChildren(...nodes) {
            children.length = 0;
            for (const n of nodes) {
                el.appendChild(n);
            }
        },

        get firstElementChild() {
            return children.find(c => c.nodeType === 1) ?? null;
        },

        /**
         * Recursively collects text content from the element tree.
         * This is what tests use to verify rendered output.
         */
        get textContent() {
            if (el._textContent !== undefined) return el._textContent;
            return children.map(c => c.textContent ?? '').join('');
        },
        set textContent(v) {
            el._textContent = v;
            // Setting textContent clears children in real DOM
            children.length = 0;
        },
        _textContent: undefined,

        /**
         * Searches children recursively for matching selector.
         * Supports simple class (.foo) and tag (div) selectors.
         * @param {string} sel
         * @returns {any|null}
         */
        querySelector(sel) {
            return _queryAll(el, sel)[0] ?? null;
        },

        /**
         * @param {string} sel
         * @returns {any[]}
         */
        querySelectorAll(sel) {
            return _queryAll(el, sel);
        },
    };

    return el;
}

/**
 * Creates a mock text node.
 * @param {string} text
 * @returns {object}
 */
function mockTextNode(text) {
    return { nodeType: 3, textContent: text, parentElement: null, children: [] };
}

/**
 * Creates a mock DocumentFragment.
 * @returns {object}
 */
function mockDocumentFragment() {
    const children = [];
    return {
        _isFragment: true,
        nodeType: 11,
        children,
        childNodes: children,
        appendChild(child) {
            if (child && child._isFragment) {
                for (const c of child.children.splice(0)) {
                    c.parentElement = this;
                    children.push(c);
                }
            } else if (child) {
                child.parentElement = this;
                children.push(child);
            }
            return child;
        },
        append(...nodes) {
            for (const n of nodes) {
                if (typeof n === 'string') {
                    this.appendChild(mockTextNode(n));
                } else {
                    this.appendChild(n);
                }
            }
        },
        replaceChildren(...nodes) {
            children.length = 0;
            for (const n of nodes) this.appendChild(n);
        },
        get firstElementChild() {
            return children.find(c => c.nodeType === 1) ?? null;
        },
        get textContent() {
            return children.map(c => c.textContent ?? '').join('');
        },
        querySelectorAll(sel) { return _queryAll(this, sel); },
        querySelector(sel) { return _queryAll(this, sel)[0] ?? null; },
    };
}

/**
 * Simple recursive querySelector implementation for the mock DOM.
 * Supports: .class, tag, tag.class
 *
 * @param {any} root
 * @param {string} sel
 * @returns {any[]}
 */
function _queryAll(root, sel) {
    const results = [];
    for (const child of (root.children || [])) {
        if (_matches(child, sel)) results.push(child);
        results.push(..._queryAll(child, sel));
    }
    return results;
}

/**
 * Checks if a mock element matches a simple CSS selector.
 * @param {any} el
 * @param {string} sel
 * @returns {boolean}
 */
function _matches(el, sel) {
    if (!el || el.nodeType !== 1) return false;
    if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return el.className.split(/\s+/).includes(cls) || el.classList?.has?.(cls);
    }
    if (sel.includes('.')) {
        const [tag, cls] = sel.split('.');
        return el.tagName === tag.toUpperCase() && (
            el.className.split(/\s+/).includes(cls) || el.classList?.has?.(cls)
        );
    }
    return el.tagName === sel.toUpperCase();
}

/**
 * Sets up the global mock DOM and returns a register function
 * to create named elements for getElementById lookups.
 */
function createMockDOM() {
    const elements = {};

    globalThis.document = /** @type {any} */ ({
        getElementById: (id) => elements[id] || null,
        title: '',
        addEventListener: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: (tag) => mockElement(tag),
        createDocumentFragment: () => mockDocumentFragment(),
        createTextNode: (text) => mockTextNode(text),
        head: { appendChild: () => {} },
        body: { appendChild: () => {}, dataset: {} },
        activeElement: null,
    });

    globalThis.__router = { navigate: () => {} };
    globalThis.scrollTo = () => {};
    globalThis.location = /** @type {any} */ ({ href: 'http://localhost/', pathname: '/', search: '' });

    /**
     * Registers a mock DOM element that getElementById can find.
     * @param {string} id
     * @returns {any}
     */
    function register(id) {
        const el = mockElement('div');
        el.id = id;
        elements[id] = el;
        return el;
    }

    return { register, elements };
}

// ── Tests ───────────────────────────────────────────────────────────

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

            const text = appEl.textContent;
            assert.ok(text.includes('Synced. Read Only. Fast.'),
                'Hero should contain the tagline');
            assert.ok(text.includes('The Interconnection Database'),
                'Page should contain the heading');
            assert.ok(text.includes('read-only mirror'),
                'Description should mention read-only mirror');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should render Most Recent Updates heading', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => /** @type {any} */ ({
            ok: true,
            json: async () => ({ data: [], meta: {} }),
        });

        try {
            const { renderHome } = await import('../js/pages/home.js');
            await renderHome({});

            assert.ok(appEl.textContent.includes('Most Recent Updates'),
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
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            if (typeof url === 'string' && url.includes('about.md')) {
                return /** @type {any} */ ({
                    ok: true,
                    text: async () => '# About This Mirror\n\nTest content',
                });
            }
            return /** @type {any} */ ({ ok: true, json: async () => ({ data: [], meta: {} }) });
        };

        try {
            const { renderAbout } = await import('../js/pages/about.js');
            await renderAbout({});
            assert.equal(document.title, 'About — PeeringDB Mirror');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should render markdown content from fetched file', async () => {
        const aboutMd = [
            '# About This Mirror',
            '',
            '## What is this?',
            '',
            'A read-only mirror.',
            '',
            '## Data Freshness',
            '',
            'Synced periodically.',
            '',
            '## Acceptable Use',
            '',
            'Subject to the PeeringDB [Acceptable Use Policy](https://www.peeringdb.com/aup).',
            'Also see the [Privacy Policy](https://docs.peeringdb.com/gov/misc/2017-04-02-PeeringDB_Privacy_Policy.pdf).',
            '',
            '## API',
            '',
            'Example: GET /api/net/694?depth=2',
            '',
            '## Source Code',
            '',
            'Open source.',
        ].join('\n');

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            if (typeof url === 'string' && url.includes('about.md')) {
                return /** @type {any} */ ({ ok: true, text: async () => aboutMd });
            }
            return /** @type {any} */ ({ ok: true, json: async () => ({ data: [], meta: {} }) });
        };

        try {
            const { renderAbout } = await import('../js/pages/about.js');
            await renderAbout({});

            // About page uses innerHTML on the article element after renderMarkdown,
            // so we check the innerHTML of the first child (the article element).
            const article = appEl.children[0];
            assert.ok(article, 'Should render an article element');
            assert.ok(article.innerHTML.includes('About This Mirror'),
                'Should have the title');
            assert.ok(article.innerHTML.includes('What is this?'),
                'Should have What is this? section');
            assert.ok(article.innerHTML.includes('Data Freshness'),
                'Should have Data Freshness section');
            assert.ok(article.innerHTML.includes('Acceptable Use'),
                'Should have Acceptable Use section');
            assert.ok(article.innerHTML.includes('peeringdb.com/aup'),
                'Should link to the AUP');
            assert.ok(article.innerHTML.includes('PeeringDB_Privacy_Policy'),
                'Should link to the Privacy Policy');
            assert.ok(article.innerHTML.includes('/api/net/694'),
                'Should show API example endpoint');
            assert.ok(article.innerHTML.includes('Source Code'),
                'Should have Source Code section');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should show error on fetch failure', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            if (typeof url === 'string' && url.includes('about.md')) {
                return /** @type {any} */ ({ ok: false, status: 404 });
            }
            return /** @type {any} */ ({ ok: true, json: async () => ({ data: [], meta: {} }) });
        };

        try {
            const { renderAbout } = await import('../js/pages/about.js');
            await renderAbout({});

            const text = appEl.textContent;
            assert.ok(text.includes('Failed to load'),
                'Should show error message on fetch failure');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
