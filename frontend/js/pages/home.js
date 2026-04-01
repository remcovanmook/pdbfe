/**
 * @fileoverview Homepage renderer.
 * Shows the search box, recent updates grid (4 columns),
 * and global entity statistics.
 */

import { fetchList, fetchCount } from '../api.js';
import { linkEntity, formatDate, escapeHTML, renderLoading } from '../render.js';

/** @type {HTMLElement} */
let _app;

/**
 * Renders the homepage into the app container.
 *
 * @param {Record<string, string>} _params - Route params (unused for homepage).
 */
export async function renderHome(_params) {
    _app = /** @type {HTMLElement} */ (document.getElementById('app'));
    document.title = 'PeeringDB';

    _app.innerHTML = `
        <div class="home-search">
            <h1 class="home-search__title">Peering<span>DB</span></h1>
            <div class="home-search__input-wrapper">
                <input type="text" class="home-search__input" placeholder="Search networks, exchanges, facilities..." id="home-search-input" autofocus>
            </div>
        </div>
        <div id="recent-updates">${renderLoading('Loading recent updates')}</div>
        <div id="global-stats"></div>
    `;

    // Search triggers navigation
    const input = /** @type {HTMLInputElement} */ (document.getElementById('home-search-input'));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
            const { navigate } = /** @type {any} */ (window).__router;
            navigate(`/search?q=${encodeURIComponent(input.value.trim())}`);
        }
    });

    // Fetch recent updates and stats in parallel
    await Promise.all([
        loadRecentUpdates(),
        loadGlobalStats()
    ]);
}

/**
 * Fetches the 5 most recently updated entities per type and renders
 * them as a 4-column grid.
 */
async function loadRecentUpdates() {
    const container = document.getElementById('recent-updates');
    if (!container) return;

    const types = [
        { type: 'ix',  label: 'Exchanges' },
        { type: 'net', label: 'Networks' },
        { type: 'fac', label: 'Facilities' },
        { type: 'org', label: 'Organizations' }
    ];

    try {
        const results = await Promise.all(
            types.map(t => fetchList(t.type, { limit: 5 }).catch(() => []))
        );

        // Sort each by updated descending (API may not guarantee order)
        for (const list of results) {
            list.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
        }

        const columns = types.map((t, i) => {
            const items = results[i].slice(0, 5).map(item => {
                const name = item.name || item.org_name || `ID ${item.id}`;
                return `<div class="recent-updates__item">
                    ${linkEntity(t.type, item.id, name)}
                    <span class="recent-updates__time">${formatDate(item.updated)}</span>
                </div>`;
            }).join('');

            return `<div class="recent-updates__column">
                <div class="recent-updates__title">${escapeHTML(t.label)}</div>
                ${items || '<div class="empty-state">No data</div>'}
            </div>`;
        }).join('');

        container.innerHTML = `<div class="recent-updates">${columns}</div>`;
    } catch (err) {
        container.innerHTML = `<div class="error-message">Failed to load recent updates</div>`;
    }
}

/**
 * Fetches global entity counts and renders a stats bar.
 * Uses the limit=0 count endpoint for each entity type.
 */
async function loadGlobalStats() {
    const container = document.getElementById('global-stats');
    if (!container) return;

    const types = [
        { type: 'net', label: 'Networks',      icon: '\u{1F310}' },
        { type: 'ix',  label: 'Exchanges',     icon: '\u21C4' },
        { type: 'fac', label: 'Facilities',    icon: '\u{1F3E2}' },
        { type: 'org', label: 'Organizations', icon: '\u{1F3DB}' }
    ];

    try {
        const counts = await Promise.all(
            types.map(t => fetchCount(t.type).catch(() => 0))
        );

        const cards = types.map((t, i) => `
            <div class="stat-card">
                <div class="stat-card__icon">${t.icon}</div>
                <div class="stat-card__value">${counts[i].toLocaleString()}</div>
                <div class="stat-card__label">${escapeHTML(t.label)}</div>
            </div>
        `).join('');

        container.innerHTML = `<div class="stats-bar">${cards}</div>`;
    } catch (err) {
        // Stats are non-critical — fail silently
    }
}
