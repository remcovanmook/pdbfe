/**
 * @fileoverview Search results page renderer.
 * Queries the four core entity types in parallel and groups
 * results by type with count badges and click-through links.
 */

import { searchAll } from '../api.js';
import { linkEntity, escapeHTML, renderLoading } from '../render.js';

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
        app.innerHTML = '<div class="empty-state">Enter a search term</div>';
        return;
    }

    app.innerHTML = `
        <div class="search-results">
            <h1 class="search-results__heading">Results for <strong>${escapeHTML(query)}</strong></h1>
            <div id="search-body">${renderLoading('Searching')}</div>
        </div>
    `;

    // Update the header search input to reflect the query
    const headerInput = /** @type {HTMLInputElement|null} */ (document.getElementById('header-search'));
    if (headerInput) headerInput.value = query;

    try {
        const results = await searchAll(query);
        const body = /** @type {HTMLElement} */ (document.getElementById('search-body'));

        const sections = [
            { key: 'net',     label: 'Networks',      items: results.net,     subtitle: (r) => `AS${r.asn}` },
            { key: 'ix',      label: 'Exchanges',     items: results.ix,      subtitle: (r) => r.city || '' },
            { key: 'fac',     label: 'Facilities',    items: results.fac,     subtitle: (r) => `${r.city || ''}, ${r.country || ''}` },
            { key: 'org',     label: 'Organizations', items: results.org,     subtitle: () => '' },
            { key: 'carrier', label: 'Carriers',      items: results.carrier, subtitle: () => '' },
            { key: 'campus',  label: 'Campuses',      items: results.campus,  subtitle: (r) => `${r.city || ''}, ${r.country || ''}` }
        ];

        let html = '';
        let totalCount = 0;

        for (const section of sections) {
            const count = section.items.length;
            totalCount += count;
            if (count === 0) continue;

            const itemsHTML = section.items.map(item => {
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
            html = `<div class="empty-state">No results found for "${escapeHTML(query)}"</div>`;
        }

        body.innerHTML = html;
    } catch (err) {
        const body = document.getElementById('search-body');
        if (body) {
            body.innerHTML = `<div class="error-message">Search failed: ${escapeHTML(err.message)}</div>`;
        }
    }
}
