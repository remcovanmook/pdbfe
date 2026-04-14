/**
 * @fileoverview History API router for the PeeringDB frontend SPA.
 * Intercepts link clicks with [data-link] attributes and dispatches
 * to the appropriate page renderer via registered route patterns.
 */

import { createError, createEmptyState } from './render.js';

/**
 * @typedef {Object} Route
 * @property {RegExp} pattern - URL pattern to match.
 * @property {function(Record<string, string>): Promise<void>} handler - Page renderer.
 */

/** @type {Route[]} */
const _routes = [];

/** @type {HTMLElement|null} */
let _appContainer = null;

/**
 * Registers a route pattern and its handler.
 *
 * Pattern uses named groups: e.g. "/net/:id" becomes /^\/net\/(?<id>[^/]+)\/?$/
 *
 * @param {string} pattern - URL pattern with :param placeholders.
 * @param {function(Record<string, string>): Promise<void>} handler - Async page renderer.
 */
export function addRoute(pattern, handler) {
    // Convert "/net/:id" to regex with named capture groups
    const regexStr = pattern
        .replace(/:[a-zA-Z]+/g, (match) => {
            const name = match.slice(1);
            return `(?<${name}>[^/]+)`;
        });
    _routes.push({
        pattern: new RegExp(`^${regexStr}\\/?$`),
        handler
    });
}

/**
 * Initialises the router. Attaches popstate and click listeners,
 * then renders the current URL.
 *
 * @param {HTMLElement} appContainer - The DOM element to render pages into.
 */
export function initRouter(appContainer) {
    _appContainer = appContainer;

    // Prevent the browser from restoring scroll position on navigation
    if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual';
    }

    // Handle browser back/forward
    globalThis.addEventListener('popstate', () => {
        dispatch(globalThis.location.pathname + globalThis.location.search);
    });

    // Intercept clicks on [data-link] anchors for SPA navigation
    document.addEventListener('click', (e) => {
        const link = /** @type {HTMLElement|null} */ (e.target)?.closest('[data-link]');
        if (!link) return;

        // Let the browser handle Ctrl+Click, Cmd+Click, Shift+Click,
        // and middle mouse button — these open links in new tabs/windows.
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) {
            return;
        }

        e.preventDefault();
        const href = link.getAttribute('href');
        if (href && href !== globalThis.location.pathname) {
            navigate(href);
        }
    });

    // Ensure external links open in a new tab
    document.addEventListener('click', (e) => {
        const anchor = /** @type {HTMLAnchorElement|null} */ (e.target)?.closest('a');
        if (!anchor || anchor.hasAttribute('data-link')) return;

        const href = anchor.getAttribute('href') || '';
        if (/^https?:\/\/|^mailto:/i.test(href) && !anchor.hasAttribute('target')) {
            anchor.setAttribute('target', '_blank');
            anchor.setAttribute('rel', 'noopener');
        }
    });

    // Render current URL on load
    dispatch(globalThis.location.pathname + globalThis.location.search);
}

/**
 * Navigates to a new path, pushing it to the browser history.
 *
 * @param {string} path - The URL path to navigate to.
 */
export function navigate(path) {
    globalThis.history.pushState(null, '', path);
    dispatch(path);
}

/**
 * Matches the given path against registered routes and calls the
 * appropriate handler. Shows a 404 message for unmatched routes.
 *
 * @param {string} fullPath - The URL path + search string.
 */
async function dispatch(fullPath) {
    if (!_appContainer) return;

    const [path, search] = fullPath.split('?');

    // Parse search params into a plain object
    /** @type {Record<string, string>} */
    const queryParams = {};
    if (search) {
        for (const [k, v] of new URLSearchParams(search)) {
            queryParams[k] = v;
        }
    }

    for (const route of _routes) {
        const match = route.pattern.exec(path);
        if (match) {
            // Merge named groups and query params
            const params = { ...match.groups, ...queryParams };

            // Page transition
            _appContainer.classList.remove('page-active');
            _appContainer.classList.add('page-enter');

            // Flag the body so CSS can adapt header appearance per page.
            // Homepage gets a larger logo and no header search bar.
            document.body.dataset.page = (path === '/' || path === '') ? 'home' : 'detail';

            try {
                await route.handler(params);
            } catch (err) {
                _appContainer.replaceChildren(
                    createError(`Failed to load page: ${err.message}`)
                );
            }

            // Reset scroll after content is rendered
            globalThis.scrollTo(0, 0);

            // Trigger enter transition
            requestAnimationFrame(() => {
                _appContainer.classList.remove('page-enter');
                _appContainer.classList.add('page-active');
            });
            return;
        }
    }

    // No route matched
    _appContainer.replaceChildren(createEmptyState('Page not found'));
    document.title = 'Not Found — PeeringDB';
}
