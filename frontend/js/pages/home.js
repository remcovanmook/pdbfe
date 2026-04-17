/**
 * @fileoverview Homepage renderer.
 * Shows the hero section with tagline and description, a search box,
 * the 5 most recently updated entities per type (Exchanges, Networks,
 * Facilities, Carriers), and global database statistics.
 *
 * Uses DOM-based rendering. The search box and recent updates grid are
 * built with createElement/textContent, not innerHTML.
 */

import { fetchList, fetchCount, fetchEntity } from '../api.js';
import { createLink, createLoading, formatDate, createEntityBadge } from '../render.js';
import { attachTypeahead } from '../typeahead.js';
import { t } from '../i18n.js';
import { getLabel } from '../entities.js';
import { getFavorites } from '../auth.js';

/** @type {HTMLElement} */
let _app;

/**
 * Renders the homepage into the app container.
 *
 * @param {Record<string, string>} _params - Route params (unused for homepage).
 */
export async function renderHome(_params) {
    _app = /** @type {HTMLElement} */ (document.getElementById('app'));
    document.title = 'PDBFE';

    // Build the page structure with DOM nodes
    const frag = document.createDocumentFragment();

    // Heading
    const h1 = document.createElement('h1');
    h1.className = 'home-heading';
    h1.textContent = t('The Interconnection Database');
    frag.appendChild(h1);

    // Top section: hero (left) + search & favorites (right)
    const homeTop = document.createElement('div');
    homeTop.className = 'home-top';

    // ── Left column: hero text ──
    const hero = document.createElement('div');
    hero.className = 'home-hero';

    const tagline = document.createElement('h2');
    tagline.className = 'home-hero__tagline';
    tagline.textContent = 'Synced. Read Only. Fast.';
    hero.appendChild(tagline);

    // Hero description (contains links, so we build inline)
    const desc1 = document.createElement('p');
    desc1.className = 'home-hero__desc';
    desc1.append(
        'This is a read-only mirror of the ',
        _extLink('https://www.peeringdb.com', 'PeeringDB'),
        ' database. The data is synchronised periodically and served from edge locations for low-latency lookups. All data is subject to the PeeringDB ',
        _extLink('https://www.peeringdb.com/aup', 'Acceptable Use Policy'),
        '.'
    );
    hero.appendChild(desc1);

    const desc2 = document.createElement('p');
    desc2.className = 'home-hero__desc';
    desc2.append('Learn more ');
    const aboutLink = document.createElement('a');
    aboutLink.href = '/about';
    aboutLink.dataset.link = '';
    aboutLink.textContent = 'about this mirror';
    desc2.append(aboutLink, '.');
    hero.appendChild(desc2);

    homeTop.appendChild(hero);

    // ── Right column: search + favorites ──
    const rightCol = document.createElement('div');
    rightCol.className = 'home-right';

    // Search box
    const searchDiv = document.createElement('div');
    searchDiv.className = 'home-search';
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'home-search__input-wrapper';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'home-search__input';
    searchInput.placeholder = t('Search networks, exchanges, facilities...');
    searchInput.setAttribute('aria-label', t('Search networks, exchanges, facilities'));
    searchInput.id = 'home-search-input';
    searchInput.autofocus = true;
    searchWrapper.appendChild(searchInput);
    searchDiv.appendChild(searchWrapper);
    rightCol.appendChild(searchDiv);

    // Favorites section — always visible; links to /favorites management page
    const favorites = getFavorites();
    const favsSection = document.createElement('div');
    favsSection.className = 'home-favorites';
    const favsHeading = document.createElement('a');
    favsHeading.href = '/favorites';
    favsHeading.dataset.link = '';
    favsHeading.className = 'home-recent__heading home-recent__heading--link';
    favsHeading.textContent = '★ ' + t('Your Favorites');
    favsSection.appendChild(favsHeading);

    if (favorites.length > 0) {
        const favsGrid = document.createElement('div');
        favsGrid.className = 'favorites-grid';
        favsGrid.id = 'home-favorites-grid';

        for (const fav of favorites) {
            const item = document.createElement('div');
            item.className = 'favorites-grid__item';
            item.dataset.type = fav.entity_type;
            item.dataset.id = String(fav.entity_id);

            item.appendChild(createEntityBadge(fav.entity_type));

            const nameLink = createLink(fav.entity_type, fav.entity_id, fav.label || `${fav.entity_type} ${fav.entity_id}`);
            nameLink.className += ' favorites-grid__name';
            item.appendChild(nameLink);

            const updatedSpan = document.createElement('span');
            updatedSpan.className = 'favorites-grid__updated';
            updatedSpan.textContent = '...';
            item.appendChild(updatedSpan);

            favsGrid.appendChild(item);
        }

        favsSection.appendChild(favsGrid);
    } else {
        const hint = document.createElement('p');
        hint.className = 'home-hero__desc';
        hint.style.fontSize = '0.8125rem';
        hint.textContent = t('Use the ★ on any entity page to add favorites.');
        favsSection.appendChild(hint);
    }
    rightCol.appendChild(favsSection);

    // Compare widget
    const compareSection = document.createElement('div');
    compareSection.className = 'home-compare';
    compareSection.style.marginTop = 'var(--space-lg)';
    const compareHeading = document.createElement('a');
    compareHeading.href = '/compare';
    compareHeading.dataset.link = '';
    compareHeading.className = 'home-recent__heading home-recent__heading--link';
    compareHeading.textContent = '↔ ' + t('Compare Infrastructure');
    compareSection.appendChild(compareHeading);

    const compareDesc = document.createElement('p');
    compareDesc.className = 'home-hero__desc';
    compareDesc.style.fontSize = 'var(--font-size-sm)';
    compareDesc.textContent = t('Analyze redundant topology and intersections between Networks, Exchanges, and Facilities.');
    compareSection.appendChild(compareDesc);

    rightCol.appendChild(compareSection);

    homeTop.appendChild(rightCol);
    frag.appendChild(homeTop);

    // Recent updates — full width below the hero section
    const recentDiv = document.createElement('div');
    recentDiv.className = 'home-recent';
    const recentHeading = document.createElement('h2');
    recentHeading.className = 'home-recent__heading';
    recentHeading.textContent = t('Most Recent Updates');
    recentDiv.appendChild(recentHeading);

    const recentBody = document.createElement('div');
    recentBody.id = 'recent-updates';
    recentBody.appendChild(createLoading('Loading recent updates'));
    recentDiv.appendChild(recentBody);
    frag.appendChild(recentDiv);

    // Stats container
    const statsDiv = document.createElement('div');
    statsDiv.id = 'global-stats';
    frag.appendChild(statsDiv);

    _app.replaceChildren(frag);

    // Typeahead on the search input (now in the DOM)
    const input = /** @type {HTMLInputElement} */ (document.getElementById('home-search-input'));
    attachTypeahead(input);

    // Fetch recent updates, stats, and favorites live data in parallel
    const tasks = [
        loadRecentUpdates(),
        loadGlobalStats(),
    ];
    if (favorites.length > 0) {
        tasks.push(loadFavoritesLiveData(favorites));
    }
    await Promise.all(tasks);
}

/**
 * Creates an external link element.
 *
 * @param {string} href - URL.
 * @param {string} text - Link text.
 * @returns {HTMLAnchorElement}
 */
function _extLink(href, text) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    return a;
}

/**
 * Fetches the 5 most recently updated entities per type and renders
 * them as a 4-column grid using DOM nodes.
 */
async function loadRecentUpdates() {
    const container = document.getElementById('recent-updates');
    if (!container) return;

    const types = ['ix', 'net', 'fac', 'carrier']
        .map(tag => ({ type: tag, label: getLabel(tag) }));

    try {
        const results = await Promise.all(
            types.map(typ => fetchList(typ.type, { sort: '-updated', limit: 5 }).catch(/** @returns {any[]} */() => []))
        );

        const grid = document.createElement('div');
        grid.className = 'recent-updates';

        for (const [i, typ] of types.entries()) {
            const col = document.createElement('div');
            col.className = 'recent-updates__column';

            const title = document.createElement('div');
            title.className = 'recent-updates__title';
            title.appendChild(createEntityBadge(typ.type));
            const titleText = document.createElement('span');
            titleText.textContent = t(typ.label);
            title.appendChild(titleText);
            col.appendChild(title);

            const items = results[i].slice(0, 5);
            if (items.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                empty.textContent = t('No data');
                col.appendChild(empty);
            } else {
                for (const item of items) {
                    let displayName = item.name || item.org_name || `ID ${item.id}`;
                    if (typ.type === 'net' && item.asn) {
                        displayName = `${displayName} (${item.asn})`;
                    }

                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'recent-updates__item';
                    itemDiv.appendChild(createLink(typ.type, item.id, displayName));

                    const timeSpan = document.createElement('span');
                    timeSpan.className = 'recent-updates__time';
                    timeSpan.textContent = formatDate(item.updated);
                    itemDiv.appendChild(timeSpan);

                    col.appendChild(itemDiv);
                }
            }

            grid.appendChild(col);
        }

        container.replaceChildren(grid);
    } catch {
        const errDiv = document.createElement('div');
        errDiv.className = 'error-message';
        errDiv.textContent = t('Failed to load recent updates');
        container.replaceChildren(errDiv);
    }
}

/**
 * Fetches global entity counts for all database-backed types and
 * renders them as a statistics list.
 */
async function loadGlobalStats() {
    const container = document.getElementById('global-stats');
    if (!container) return;

    /** @type {Record<string, string>} */
    const statLabels = {
        netixlan: 'Connections to Exchanges',
        netfac: 'Connections to Facilities',
    };
    const types = ['ix', 'net', 'fac', 'campus', 'carrier', 'netixlan', 'netfac', 'org']
        .map(tag => ({ type: tag, label: statLabels[tag] || getLabel(tag) }));

    try {
        const counts = await Promise.all(
            types.map(typ => fetchCount(typ.type).catch(() => 0))
        );

        const wrapper = document.createElement('div');
        wrapper.className = 'global-stats';

        const heading = document.createElement('h3');
        heading.className = 'global-stats__heading';
        heading.textContent = t('Global System Statistics');
        wrapper.appendChild(heading);

        const ul = document.createElement('ul');
        ul.className = 'global-stats__list';

        for (const [i, typ] of types.entries()) {
            const li = document.createElement('li');
            li.className = 'global-stats__item';

            const countSpan = document.createElement('span');
            countSpan.className = 'global-stats__count';
            countSpan.textContent = counts[i].toLocaleString();
            li.appendChild(countSpan);

            li.appendChild(document.createTextNode(' ' + t(typ.label)));
            ul.appendChild(li);
        }

        wrapper.appendChild(ul);
        container.replaceChildren(wrapper);
    } catch {
        // Stats are non-critical — fail silently
    }
}

/**
 * Fetches live entity data for each favorite and updates the grid.
 * Runs in the background — the grid renders immediately with cached
 * labels, then each cell updates as the API response arrives.
 *
 * @param {Array<{entity_type: string, entity_id: number, label: string}>} favorites - The user's favorites.
 */
async function loadFavoritesLiveData(favorites) {
    const grid = document.getElementById('home-favorites-grid');
    if (!grid) return;

    await Promise.all(favorites.map(async (fav) => {
        try {
            const entity = await fetchEntity(fav.entity_type, String(fav.entity_id), 0);
            if (!entity) return;

            // Find the matching grid item
            const item = grid.querySelector(
                `.favorites-grid__item[data-type="${fav.entity_type}"][data-id="${fav.entity_id}"]`
            );
            if (!item) return;

            // Update name (may have changed since cached)
            const nameEl = item.querySelector('.favorites-grid__name');
            if (nameEl) {
                let displayName = entity.name || fav.label;
                if (fav.entity_type === 'net' && entity.asn) {
                    displayName += ` (AS${entity.asn})`;
                }
                nameEl.textContent = displayName;
            }

            // Update timestamp
            const updatedEl = item.querySelector('.favorites-grid__updated');
            if (updatedEl) {
                updatedEl.textContent = entity.updated ? formatDate(entity.updated) : '';
            }
        } catch {
            // Non-critical — keep the cached label
        }
    }));
}
