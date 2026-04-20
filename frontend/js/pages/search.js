/**
 * @fileoverview Search results page renderer.
 * Queries the six navigable entity types in parallel and groups
 * results by type with count badges and click-through links.
 *
 * ASN-aware: if the query looks like an ASN (bare number or AS-prefixed),
 * an additional lookup by ASN is fired in parallel and the exact match
 * is surfaced at the top of the Networks section.
 *
 * Uses DOM-based rendering — all user data goes through textContent.
 */

import { searchWithAsn, SEARCH_ENTITIES } from '../api.js';
import { createLink, createLoading, createEmptyState } from '../render.js';
import { t } from '../i18n.js';

/**
 * Renders the search results page.
 *
 * @param {Record<string, string>} params - Route params, expects { q: string }.
 */
export async function renderSearch(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const query = params.q || '';

    document.title = `Search: ${query} — PDBFE`;

    if (!query) {
        app.replaceChildren(createEmptyState(t('Enter a search term')));
        return;
    }

    // Build initial layout with loading state
    const wrapper = document.createElement('div');
    wrapper.className = 'search-results';

    const heading = document.createElement('h1');
    heading.className = 'search-results__heading';
    heading.append(t('Results for') + ' ');
    const strong = document.createElement('strong');
    strong.textContent = query;
    heading.appendChild(strong);
    wrapper.appendChild(heading);

    const body = document.createElement('div');
    body.id = 'search-body';
    body.appendChild(createLoading(t('Searching')));
    wrapper.appendChild(body);

    app.replaceChildren(wrapper);

    // Update the header search input to reflect the query
    const headerInput = /** @type {HTMLInputElement|null} */ (document.getElementById('header-search'));
    if (headerInput) headerInput.value = query;

    try {
        const results = await searchWithAsn(query);

        const /** @type {Record<string, any[]>} */ res = /** @type {any} */ (results);
        const sections = SEARCH_ENTITIES.map(e => ({
            ...e,
            items: res[e.key] || []
        }));

        const frag = document.createDocumentFragment();
        let totalCount = 0;

        for (const section of sections) {
            const count = section.items.length;
            totalCount += count;
            if (count === 0) continue;

            const sectionDiv = document.createElement('div');
            sectionDiv.className = 'search-results__section';

            // Section title + badge
            const titleDiv = document.createElement('div');
            titleDiv.className = 'search-results__section-title';
            titleDiv.textContent = section.label;
            const badge = document.createElement('span');
            badge.className = 'card__badge';
            badge.textContent = String(count);
            titleDiv.appendChild(badge);
            sectionDiv.appendChild(titleDiv);

            // Card with items
            const card = document.createElement('div');
            card.className = 'card';
            const cardBody = document.createElement('div');
            cardBody.className = 'card__body';
            cardBody.style.padding = '0';

            for (const item of section.items) {
                const name = item.name || `ID ${item.id}`;
                const sub = section.subtitle(item);

                const itemDiv = document.createElement('div');
                itemDiv.className = 'search-dropdown__item';
                itemDiv.appendChild(createLink(section.key, item.id, name));

                if (sub) {
                    const subSpan = document.createElement('span');
                    subSpan.className = 'search-dropdown__item-sub';
                    subSpan.textContent = sub;
                    itemDiv.appendChild(subSpan);
                }

                cardBody.appendChild(itemDiv);
            }

            card.appendChild(cardBody);
            sectionDiv.appendChild(card);
            frag.appendChild(sectionDiv);
        }

        if (totalCount === 0) {
            frag.appendChild(createEmptyState(t('No results found for "{q}"', { q: query })));
        }

        body.replaceChildren(frag);
    } catch (err) {
        const errDiv = document.createElement('div');
        errDiv.className = 'error-message';
        errDiv.textContent = `${t('Search failed')}: ${err.message}`;
        body.replaceChildren(errDiv);
    }
}
