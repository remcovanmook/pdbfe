/**
 * @fileoverview Homepage renderer.
 * Shows the hero section with tagline and description, a search box,
 * the 5 most recently updated entities per type (Exchanges, Networks,
 * Facilities, Carriers), and global database statistics.
 *
 * Uses DOM-based rendering. The search box and recent updates grid are
 * built with createElement/textContent, not innerHTML.
 */

import { fetchList, fetchCount } from '../api.js';
import { createLink, createLoading, formatDate } from '../render.js';
import { attachTypeahead } from '../typeahead.js';
import { t } from '../i18n.js';
import { getLabel } from '../entities.js';

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

    // Build the page structure with DOM nodes
    const frag = document.createDocumentFragment();

    // Heading
    const h1 = document.createElement('h1');
    h1.className = 'home-heading';
    h1.textContent = t('The Interconnection Database');
    frag.appendChild(h1);

    // Search box
    const searchDiv = document.createElement('div');
    searchDiv.className = 'home-search';
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'home-search__input-wrapper';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'home-search__input';
    searchInput.placeholder = t('Search networks, exchanges, facilities...');
    searchInput.id = 'home-search-input';
    searchInput.autofocus = true;
    searchWrapper.appendChild(searchInput);
    searchDiv.appendChild(searchWrapper);
    frag.appendChild(searchDiv);

    // Top section: hero + recent updates
    const homeTop = document.createElement('div');
    homeTop.className = 'home-top';

    // Hero
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
    aboutLink.setAttribute('data-link', '');
    aboutLink.textContent = 'about this mirror';
    desc2.append(aboutLink, '.');
    hero.appendChild(desc2);

    homeTop.appendChild(hero);

    // Recent updates container
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

    homeTop.appendChild(recentDiv);
    frag.appendChild(homeTop);

    // Stats container
    const statsDiv = document.createElement('div');
    statsDiv.id = 'global-stats';
    frag.appendChild(statsDiv);

    _app.replaceChildren(frag);

    // Typeahead on the search input (now in the DOM)
    const input = /** @type {HTMLInputElement} */ (document.getElementById('home-search-input'));
    attachTypeahead(input);

    // Fetch recent updates and stats in parallel
    await Promise.all([
        loadRecentUpdates(),
        loadGlobalStats()
    ]);
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

        types.forEach((typ, i) => {
            const col = document.createElement('div');
            col.className = 'recent-updates__column';

            const title = document.createElement('div');
            title.className = 'recent-updates__title';
            title.textContent = t(typ.label);
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
        });

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

        types.forEach((typ, i) => {
            const li = document.createElement('li');
            li.className = 'global-stats__item';

            const countSpan = document.createElement('span');
            countSpan.className = 'global-stats__count';
            countSpan.textContent = counts[i].toLocaleString();
            li.appendChild(countSpan);

            li.appendChild(document.createTextNode(' ' + t(typ.label)));
            ul.appendChild(li);
        });

        wrapper.appendChild(ul);
        container.replaceChildren(wrapper);
    } catch {
        // Stats are non-critical — fail silently
    }
}
