/**
 * @fileoverview Typeahead search module for the PeeringDB frontend.
 * Attaches to a search input and renders a dropdown of results
 * as the user types, with keyboard navigation and click-to-navigate.
 *
 * Uses debounced calls to `searchWithAsn()` from the API client.
 * Results are grouped by entity type in a dropdown overlay.
 *
 * Dropdown items are built with DOM nodes and template cloning.
 * All user data is assigned via textContent (XSS-safe by construction).
 */

import { searchWithAsn, SEARCH_ENTITIES } from './api.js';
import { navigate } from './router.js';
import { createEntityBadge } from './render.js';



/**
 * Minimum characters before triggering a search.
 * @type {number}
 */
const MIN_QUERY_LENGTH = 2;

/**
 * Debounce delay in milliseconds.
 * @type {number}
 */
const DEBOUNCE_MS = 250;

/**
 * Attaches typeahead behaviour to a search input. Creates a dropdown
 * element if one doesn't exist, and wires up input, keyboard, and
 * click handlers.
 *
 * @param {HTMLInputElement} input - The search input element.
 * @param {Object} [opts] - Options.
 * @param {boolean} [opts.navigateOnEnter=true] - Navigate to /search on Enter
 *   when no dropdown item is highlighted.
 */
export function attachTypeahead(input, opts = {}) {
    const navigateOnEnter = opts.navigateOnEnter !== false;

    // Create or find the dropdown container
    let dropdown = input.parentElement?.querySelector('.search-dropdown');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.className = 'search-dropdown';
        dropdown.setAttribute('role', 'listbox');
        input.parentElement?.appendChild(dropdown);
    }

    /** @type {number|null} */
    let debounceTimer = null;

    /** Index of the currently highlighted item (-1 = none) */
    let activeIndex = -1;

    /**
     * AbortController for the current in-flight search request.
     * Aborted when a new keystroke triggers a search, preventing
     * stale results from overwriting newer ones.
     * @type {AbortController|null}
     */
    let searchController = null;

    /**
     * Fetches and renders search results for the given query.
     *
     * @param {string} query - The search term.
     */
    async function doSearch(query) {
        if (query.length < MIN_QUERY_LENGTH) {
            closeDropdown();
            return;
        }

        // Cancel any previous in-flight search to prevent stale results
        // from overwriting newer ones (fast-typer race condition).
        if (searchController) {
            searchController.abort();
        }
        searchController = new AbortController();

        try {
            const results = await searchWithAsn(query, searchController.signal);
            renderDropdown(results);
        } catch (err) {
            // Aborted searches are expected — ignore them silently
            if (/** @type {Error} */ (err).name === 'AbortError') return;
            closeDropdown();
        }
    }

    /**
     * Renders search results into the dropdown using DOM nodes.
     * All data is assigned via textContent — XSS-safe by construction.
     *
     * @param {{net: any[], ix: any[], fac: any[], org: any[], carrier: any[], campus: any[]}} results
     */
    function renderDropdown(results) {
        const /** @type {Record<string, any[]>} */ res = /** @type {any} */ (results);
        const primaryKeys = new Set(['net', 'ix', 'fac']);
        const groups = SEARCH_ENTITIES.map(e => ({
            ...e,
            items: (res[e.key] || []).slice(0, primaryKeys.has(e.key) ? 5 : 3)
        }));

        const tpl = /** @type {HTMLTemplateElement|null} */ (
            document.getElementById('tpl-typeahead-item')
        );

        const frag = document.createDocumentFragment();
        let hasResults = false;

        for (const group of groups) {
            if (group.items.length === 0) continue;
            hasResults = true;

            const groupDiv = document.createElement('div');
            groupDiv.className = 'search-dropdown__group';

            const labelDiv = document.createElement('div');
            labelDiv.className = 'search-dropdown__label';
            labelDiv.appendChild(createEntityBadge(group.key));
            labelDiv.appendChild(document.createTextNode(` ${group.label}`));
            groupDiv.appendChild(labelDiv);

            for (const item of group.items) {
                const name = item.name || `ID ${item.id}`;
                const sub = group.subtitle(item);

                /** @type {HTMLDivElement} */
                let itemDiv;

                if (tpl) {
                    itemDiv = /** @type {HTMLDivElement} */ (
                        /** @type {DocumentFragment} */ (tpl.content.cloneNode(true)).firstElementChild
                    );
                    /** @type {HTMLSpanElement} */ (
                        itemDiv.querySelector('.search-dropdown__item-name')
                    ).textContent = name;

                    const subEl = itemDiv.querySelector('.search-dropdown__item-sub');
                    if (sub && subEl) {
                        subEl.textContent = sub;
                    } else if (subEl) {
                        subEl.remove();
                    }
                } else {
                    // Fallback: build without template
                    itemDiv = document.createElement('div');
                    itemDiv.className = 'search-dropdown__item';

                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'search-dropdown__item-name';
                    nameSpan.textContent = name;
                    itemDiv.appendChild(nameSpan);

                    if (sub) {
                        const subSpan = document.createElement('span');
                        subSpan.className = 'search-dropdown__item-sub';
                        subSpan.textContent = sub;
                        itemDiv.appendChild(subSpan);
                    }
                }

                itemDiv.dataset.href = `/${group.key}/${item.id}`;
                itemDiv.setAttribute('role', 'option');
                groupDiv.appendChild(itemDiv);
            }

            frag.appendChild(groupDiv);
        }

        if (!hasResults) {
            closeDropdown();
            return;
        }

        dropdown.replaceChildren(frag);
        dropdown.classList.add('is-open');
        activeIndex = -1;
    }

    /** Closes the dropdown and resets state. */
    function closeDropdown() {
        dropdown.classList.remove('is-open');
        dropdown.replaceChildren();
        activeIndex = -1;
    }

    /**
     * Returns all navigable item elements in the dropdown.
     * @returns {HTMLElement[]}
     */
    function getItems() {
        return /** @type {HTMLElement[]} */ (
            Array.from(dropdown.querySelectorAll('.search-dropdown__item'))
        );
    }

    /**
     * Updates the visual highlight on dropdown items.
     * @param {number} newIndex - The index to highlight.
     */
    function setActive(newIndex) {
        const items = getItems();
        if (items.length === 0) return;

        // Remove previous highlight
        if (activeIndex >= 0 && activeIndex < items.length) {
            items[activeIndex].classList.remove('is-active');
        }

        activeIndex = Math.max(-1, Math.min(newIndex, items.length - 1));

        if (activeIndex >= 0) {
            items[activeIndex].classList.add('is-active');
            items[activeIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    // ── Event handlers ─────────────────────────────────────────────

    input.addEventListener('input', () => {
        const val = input.value.trim();
        if (debounceTimer !== null) clearTimeout(debounceTimer);

        if (val.length < MIN_QUERY_LENGTH) {
            closeDropdown();
            return;
        }

        debounceTimer = setTimeout(() => doSearch(val), DEBOUNCE_MS);
    });

    input.addEventListener('keydown', (e) => {
        const items = getItems();

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (!dropdown.classList.contains('is-open')) {
                    doSearch(input.value.trim());
                } else {
                    setActive(activeIndex + 1);
                }
                break;

            case 'ArrowUp':
                e.preventDefault();
                setActive(activeIndex - 1);
                break;

            case 'Enter':
                if (activeIndex >= 0 && activeIndex < items.length) {
                    e.preventDefault();
                    const href = items[activeIndex].dataset.href;
                    if (href) {
                        closeDropdown();
                        navigate(href);
                    }
                } else if (navigateOnEnter && input.value.trim()) {
                    closeDropdown();
                    navigate(`/search?q=${encodeURIComponent(input.value.trim())}`);
                }
                break;

            case 'Escape':
                closeDropdown();
                break;
        }
    });

    // Click on dropdown item → navigate
    dropdown.addEventListener('click', (e) => {
        const item = /** @type {HTMLElement|null} */ (/** @type {Element} */ (e.target).closest('.search-dropdown__item'));
        if (!item) return;

        const href = item.dataset.href;
        if (href) {
            closeDropdown();
            navigate(href);
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!input.contains(/** @type {Node} */ (e.target))
            && !dropdown.contains(/** @type {Node} */ (e.target))) {
            closeDropdown();
        }
    });

    // Close dropdown on blur (with a small delay so click handlers fire first)
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (!dropdown.contains(document.activeElement)) {
                closeDropdown();
            }
        }, 150);
    });
}
