/**
 * @fileoverview Typeahead search module for the PeeringDB frontend.
 * Attaches to a search input and renders a dropdown of results
 * as the user types, with keyboard navigation and click-to-navigate.
 *
 * Uses debounced calls to `searchAll()` from the API client.
 * Results are grouped by entity type in a dropdown overlay.
 */

import { searchWithAsn, SEARCH_ENTITIES } from './api.js';
import { escapeHTML } from './render.js';
import { navigate } from './router.js';



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
     * Fetches and renders search results for the given query.
     *
     * @param {string} query - The search term.
     */
    async function doSearch(query) {
        if (query.length < MIN_QUERY_LENGTH) {
            closeDropdown();
            return;
        }

        try {
            const results = await searchWithAsn(query);
            renderDropdown(results);
        } catch {
            closeDropdown();
        }
    }

    /**
     * Renders search results into the dropdown.
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

        let html = '';
        let hasResults = false;

        for (const group of groups) {
            if (group.items.length === 0) continue;
            hasResults = true;

            html += `<div class="search-dropdown__group">
                <div class="search-dropdown__label">${escapeHTML(group.label)}</div>`;

            for (const item of group.items) {
                const name = escapeHTML(item.name || `ID ${item.id}`);
                const sub = group.subtitle(item);
                html += `<div class="search-dropdown__item" data-href="/${group.key}/${item.id}" role="option">
                    <span>${/* safe — escapeHTML() on line 99 */ name}</span>
                    ${sub ? `<span class="search-dropdown__item-sub">${escapeHTML(sub)}</span>` : ''}
                </div>`;
            }

            html += '</div>';
        }

        if (!hasResults) {
            closeDropdown();
            return;
        }

        dropdown.innerHTML = html;
        dropdown.classList.add('is-open');
        activeIndex = -1;
    }

    /** Closes the dropdown and resets state. */
    function closeDropdown() {
        dropdown.classList.remove('is-open');
        dropdown.innerHTML = '';
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
                    const href = items[activeIndex].getAttribute('data-href');
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
        const item = /** @type {HTMLElement|null} */ (e.target)?.closest('.search-dropdown__item');
        if (!item) return;

        const href = item.getAttribute('data-href');
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
