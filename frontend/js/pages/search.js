/**
 * @fileoverview Search results page renderer.
 * Queries the six navigable entity types in parallel and groups
 * results by type with count badges and click-through links.
 *
 * ASN-aware: if the query looks like an ASN (bare number or AS-prefixed),
 * an additional lookup by ASN is fired in parallel and the exact match
 * is surfaced at the top of the Networks section.
 */

import { searchWithAsn, SEARCH_ENTITIES } from '../api.js';
import { linkEntity, escapeHTML, renderLoading } from '../render.js';
import { t } from '../i18n.js';



/**
 * Renders the search results page.
 *
 * @param {Record<string, string>} params - Route params, expects { q: string }.
 */
export async function renderSearch(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const query = params.q || '';

    document.title = `Search: ${query} — PeeringDB`;

    if (!query) {
        app.innerHTML = `<div class="empty-state">${escapeHTML(t('Enter a search term'))}</div>`;
        return;
    }

    app.innerHTML = `
        <div class="search-results">
            <h1 class="search-results__heading">${t('Results for')} <strong>${escapeHTML(query)}</strong></h1>
            <div id="search-body">${renderLoading('Searching')}</div>
        </div>
    `;

    // Update the header search input to reflect the query
    const headerInput = /** @type {HTMLInputElement|null} */ (document.getElementById('header-search'));
    if (headerInput) headerInput.value = query;

    try {
        const results = await searchWithAsn(query);

        const body = /** @type {HTMLElement} */ (document.getElementById('search-body'));

        const /** @type {Record<string, any[]>} */ res = /** @type {any} */ (results);
        const sections = SEARCH_ENTITIES.map(e => ({
            ...e,
            items: res[e.key] || []
        }));

        let html = '';
        let totalCount = 0;

        for (const section of sections) {
            const count = section.items.length;
            totalCount += count;
            if (count === 0) continue;

            const itemsHTML = section.items.map(/** @param {any} item */ (item) => {
                const name = item.name || `ID ${item.id}`;
                const sub = section.subtitle(item);
                return `<div class="search-dropdown__item">
                    ${linkEntity(section.key, item.id, name)}
                    ${sub ? `<span class="search-dropdown__item-sub">${escapeHTML(sub)}</span>` : ''}
                </div>`;
            }).join('');

            html += `<div class="search-results__section">
                <div class="search-results__section-title">
                    ${escapeHTML(section.label)}
                    <span class="card__badge">${count}</span>
                </div>
                <div class="card">
                    <div class="card__body" style="padding:0">${itemsHTML}</div>
                </div>
            </div>`;
        }

        if (totalCount === 0) {
            html = `<div class="empty-state">${escapeHTML(t('No results found for "{q}"', { q: query }))}</div>`;
        }

        body.innerHTML = html;
    } catch (err) {
        const body = document.getElementById('search-body');
        if (body) {
            body.innerHTML = `<div class="error-message">${escapeHTML(t('Search failed'))}: ${escapeHTML(err.message)}</div>`;
        }
    }
}

