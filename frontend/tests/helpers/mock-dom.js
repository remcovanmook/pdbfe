/**
 * @fileoverview Shared mock DOM helpers for the frontend unit test suite.
 *
 * Provides `mockElement`, `mockTextNode`, `mockDocumentFragment`, and
 * `createMockDOM` — a full global DOM environment suitable for loading
 * and exercising the frontend modules under `node --test`.
 *
 * Import this module at the top of any test file that needs DOM access:
 *
 *   import { createMockDOM } from './helpers/mock-dom.js';
 *
 * Call `createMockDOM()` inside a `beforeEach` to reset state between tests.
 */

// ── Element helpers ────────────────────────────────────────────────────────

/**
 * Recursive querySelector implementation for the mock DOM.
 * Supports: `.class`, `tag`, `tag.class`, `[attr]`, `[attr="val"]`.
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
 * Checks whether a mock element matches a simple CSS selector.
 * Supports `.class`, `tag`, `tag.class`.
 *
 * @param {any} el
 * @param {string} sel
 * @returns {boolean}
 */
function _matches(el, sel) {
    if (!el || el.nodeType !== 1) return false;
    if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return el.className?.split(/\s+/).includes(cls) || el.classList?.has?.(cls) || false;
    }
    if (sel.includes('.')) {
        const [tag, cls] = sel.split('.');
        return el.tagName === tag.toUpperCase() && (
            el.className?.split(/\s+/).includes(cls) || el.classList?.has?.(cls) || false
        );
    }
    return el.tagName === sel.toUpperCase();
}

// ── Public constructors ────────────────────────────────────────────────────

/**
 * Creates a mock DOM element with enough fidelity to support the DOM-based
 * rendering pipeline (appendChild, replaceChildren, textContent, querySelector).
 *
 * @param {string} tag - Element tag name.
 * @returns {object} Mock element.
 */
export function mockElement(tag) {
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
            add(c) { classList.add(c); el.className = [...classList].join(' '); },
            remove(c) { classList.delete(c); el.className = [...classList].join(' '); },
            contains(c) { return classList.has(c); },
            has(c) { return classList.has(c); },
            toggle(c, force) {
                if (force === undefined) {
                    if (classList.has(c)) { classList.delete(c); } else { classList.add(c); }
                } else if (force) {
                    classList.add(c);
                } else {
                    classList.delete(c);
                }
                el.className = [...classList].join(' ');
            },
        },

        /**
         * Appends a child node, unwrapping DocumentFragments.
         * @param {any} child
         * @returns {any}
         */
        appendChild(child) {
            if (child && child._isFragment) {
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
         * Appends multiple children, converting strings to text nodes.
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
         * Replaces all children — main render path.
         * @param {...any} nodes
         */
        replaceChildren(...nodes) {
            children.length = 0;
            for (const n of nodes) el.appendChild(n);
        },

        get firstElementChild() {
            return children.find(c => c.nodeType === 1) ?? null;
        },

        /** Recursively collects text content from the tree. */
        get textContent() {
            if (el._textContent !== undefined) return el._textContent;
            return children.map(c => c.textContent ?? '').join('');
        },
        set textContent(v) {
            el._textContent = v;
            children.length = 0;
        },
        _textContent: undefined,

        /**
         * @param {string} sel
         * @returns {any|null}
         */
        querySelector(sel) { return _queryAll(el, sel)[0] ?? null; },

        /**
         * @param {string} sel
         * @returns {any[]}
         */
        querySelectorAll(sel) { return _queryAll(el, sel); },
    };

    return el;
}

/**
 * Creates a mock text node.
 *
 * @param {string} text
 * @returns {object}
 */
export function mockTextNode(text) {
    return { nodeType: 3, textContent: text, parentElement: null, children: [] };
}

/**
 * Creates a mock DocumentFragment.
 *
 * @returns {object}
 */
export function mockDocumentFragment() {
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
 * Sets up the global mock DOM environment and returns a `register` helper
 * for associating elements with `getElementById` IDs.
 *
 * Resets all `globalThis` browser globals to safe stubs. Call this in
 * `beforeEach` to prevent state leakage between tests.
 *
 * @returns {{ register: (id: string, tag?: string) => any, elements: Record<string, any> }}
 */
export function createMockDOM() {
    const elements = {};

    globalThis.document = /** @type {any} */ ({
        getElementById: (id) => elements[id] || null,
        title: '',
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: (tag) => mockElement(tag),
        createDocumentFragment: () => mockDocumentFragment(),
        createTextNode: (text) => mockTextNode(text),
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
    globalThis.removeEventListener = () => {};
    globalThis.history = /** @type {any} */ ({
        pushState: () => {},
        replaceState: () => {},
        scrollRestoration: 'auto',
    });
    globalThis.requestAnimationFrame = (fn) => fn();
    globalThis.sessionStorage = /** @type {any} */ ({
        getItem: () => null,
        setItem: () => {},
    });
    globalThis.localStorage = /** @type {any} */ ({
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    });
    globalThis.matchMedia = /** @type {any} */ (() => ({ matches: false }));
    globalThis.__router = { navigate: () => {} };
    globalThis.customElements = /** @type {any} */ ({ define: () => {} });

    globalThis.fetch = /** @type {any} */ (async () => ({
        ok: true,
        json: async () => ({ data: [], meta: {} }),
        text: async () => '',
        headers: new Map(),
    }));

    /**
     * Registers a mock DOM element that `getElementById` can find.
     *
     * @param {string} id - Element ID.
     * @param {string} [tag='div'] - Element tag name.
     * @returns {any} The mock element.
     */
    function register(id, tag = 'div') {
        const el = mockElement(tag);
        el.id = id;
        elements[id] = el;
        return el;
    }

    return { register, elements };
}
