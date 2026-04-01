/**
 * @fileoverview Homepage renderer.
 * Shows the hero section with tagline and description, a search box,
 * the 5 most recently updated entities per type (Exchanges, Networks,
 * Facilities, Carriers), and global database statistics.
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
        <h1 class="home-heading">The Interconnection Database</h1>
        <div class="home-search">
            <div class="home-search__input-wrapper">
                <input type="text" class="home-search__input" placeholder="Search networks, exchanges, facilities..." id="home-search-input" autofocus>
            </div>
        </div>
        <div class="home-top">
            <div class="home-hero">
                <h2 class="home-hero__tagline">Synced. Read Only. Fast.</h2>
                <p class="home-hero__desc">
                    This is a read-only mirror of the
                    <a href="https://www.peeringdb.com" target="_blank" rel="noopener">PeeringDB</a>
                    database. The data is synchronised periodically and served
                    from edge locations for low-latency lookups. All data is
                    subject to the PeeringDB
                    <a href="https://www.peeringdb.com/aup" target="_blank" rel="noopener">Acceptable Use Policy</a>.
                </p>
                <p class="home-hero__desc">
                    Learn more <a href="/about" data-link>about this mirror</a>.
                </p>
            </div>
            <div class="home-recent">
                <h2 class="home-recent__heading">Most Recent Updates</h2>
                <div id="recent-updates">${renderLoading('Loading recent updates')}</div>
            </div>
        </div>
        <div id="global-stats"></div>
    `;

    // Homepage search triggers navigation
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
 * them as a 4-column grid. Fetches a larger batch (100) and sorts
 * client-side by `updated` descending to get genuinely recent entries,
 * since the API returns results ordered by ID.
 */
async function loadRecentUpdates() {
    const container = document.getElementById('recent-updates');
    if (!container) return;

    const types = [
        { type: 'ix',      label: 'Exchanges' },
        { type: 'net',     label: 'Networks' },
        { type: 'fac',     label: 'Facilities' },
        { type: 'carrier', label: 'Carriers' }
    ];

    try {
        // Match upstream Django query exactly:
        //   Model.handleref.filter(status="ok").order_by("-updated")[:5]
        // Our API now supports the sort parameter for server-side ordering.
        const results = await Promise.all(
            types.map(t => fetchList(t.type, { sort: '-updated', limit: 5 }).catch(() => []))
        );

        const columns = types.map((t, i) => {
            const items = results[i].slice(0, 5).map(/** @param {any} item */ item => {
                let displayName = item.name || item.org_name || `ID ${item.id}`;

                // Show ASN in parentheses for networks
                if (t.type === 'net' && item.asn) {
                    displayName = `${displayName} (${item.asn})`;
                }

                return `<div class="recent-updates__item">
                    ${linkEntity(t.type, item.id, displayName)}
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
 * Fetches global entity counts for all database-backed types and
 * renders them as a statistics list matching the upstream
 * "Global System Statistics" format.
 */
async function loadGlobalStats() {
    const container = document.getElementById('global-stats');
    if (!container) return;

    const types = [
        { type: 'ix',       label: 'Exchanges' },
        { type: 'net',      label: 'Networks' },
        { type: 'fac',      label: 'Facilities' },
        { type: 'campus',   label: 'Campuses' },
        { type: 'carrier',  label: 'Carriers' },
        { type: 'netixlan', label: 'Connections to Exchanges' },
        { type: 'netfac',   label: 'Connections to Facilities' },
        { type: 'org',      label: 'Organizations' }
    ];

    try {
        const counts = await Promise.all(
            types.map(t => fetchCount(t.type).catch(() => 0))
        );

        const items = types.map((t, i) =>
            `<li class="global-stats__item">
                <span class="global-stats__count">${counts[i].toLocaleString()}</span>
                ${escapeHTML(t.label)}
            </li>`
        ).join('');

        container.innerHTML = `
            <div class="global-stats">
                <h3 class="global-stats__heading">Global System Statistics</h3>
                <ul class="global-stats__list">${items}</ul>
            </div>`;
    } catch (err) {
        // Stats are non-critical — fail silently
    }
}
