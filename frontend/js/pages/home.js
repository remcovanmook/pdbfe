/**
 * @fileoverview Homepage renderer.
 * Shows the hero section with tagline and description, a search box,
 * the 5 most recently updated entities per type (Exchanges, Networks,
 * Facilities, Carriers), and global database statistics.
 *
 * Uses DOM-based rendering. The search box and recent updates grid are
 * built with createElement/textContent, not innerHTML.
 */

import { fetchList, fetchEntity } from '../api.js';
import { createLink, createLoading, formatDate, createEntityBadge } from '../render.js';
import { attachTypeahead } from '../typeahead.js';
import { t } from '../i18n.js';
import { getLabel } from '../entities.js';
import { isAuthenticated, getUser, getFavorites } from '../auth.js';

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
    tagline.textContent = t('Synced. Read Only. Fast.');
    hero.appendChild(tagline);

    // Hero description (contains links, so we build inline)
    const desc1 = document.createElement('p');
    desc1.className = 'home-hero__desc';
    desc1.append(
        t('A read-only mirror of the '),
        _extLink('https://www.peeringdb.com', 'PeeringDB'),
        t(' database, synchronised periodically and served from edge locations for low-latency lookups worldwide. Browse networks, exchanges, facilities, and carriers — or query the data through three API surfaces: the '),
        _extLink('https://www.peeringdb.com/apidocs/', t('PeeringDB-compatible')),
        t(' REST API, a '),
        _extLink('https://graphql.pdbfe.dev/', t('GraphQL endpoint')),
        t(', and an '),
        _extLink('https://rest.pdbfe.dev/', t('OpenAPI-documented REST API')),
        '.'
    );
    hero.appendChild(desc1);

    const desc2 = document.createElement('p');
    desc2.className = 'home-hero__desc';
    desc2.append(
        t('Features include '),
    );
    const advLink = document.createElement('a');
    advLink.href = '/advanced_search';
    advLink.dataset.link = '';
    advLink.textContent = t('advanced search');
    const cmpLink = document.createElement('a');
    cmpLink.href = '/compare';
    cmpLink.dataset.link = '';
    cmpLink.textContent = t('infrastructure comparison');
    desc2.append(advLink, t(' across all entity types, '), cmpLink, t(' to find shared peering points and facilities, and personal favorites to track the resources you care about.'));
    hero.appendChild(desc2);

    const desc2b = document.createElement('p');
    desc2b.className = 'home-hero__desc';
    desc2b.append(t('All data is subject to the PeeringDB '), _extLink('https://www.peeringdb.com/aup', t('Acceptable Use Policy')), '.');
    hero.appendChild(desc2b);

    const desc3 = document.createElement('p');
    desc3.className = 'home-hero__desc';
    desc3.append(t('Learn more '));
    const aboutLink = document.createElement('a');
    aboutLink.href = '/about';
    aboutLink.dataset.link = '';
    aboutLink.textContent = t('about this mirror');
    desc3.append(aboutLink, '.');
    hero.appendChild(desc3);

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

    // "My Stuff" section — only for authenticated users
    if (isAuthenticated()) {
        const user = getUser();
        const myStuffSection = buildMyStuffSection(user);
        rightCol.appendChild(myStuffSection);
    }

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
    recentBody.appendChild(createLoading(t('Loading recent updates')));
    recentDiv.appendChild(recentBody);
    frag.appendChild(recentDiv);



    _app.replaceChildren(frag);

    // Typeahead on the search input (now in the DOM)
    const input = /** @type {HTMLInputElement} */ (document.getElementById('home-search-input'));
    attachTypeahead(input);

    // Fetch recent updates, favorites live data, and extended affiliations in parallel
    const tasks = [
        loadRecentUpdates(),
    ];
    if (favorites.length > 0) {
        tasks.push(loadFavoritesLiveData(favorites));
    }
    if (isAuthenticated()) {
        tasks.push(loadMyStuffExtended());
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
 * Builds the "My Stuff" section showing the user's affiliated entities.
 * Networks are shown immediately from session data. Exchanges and
 * facilities are loaded asynchronously via loadMyStuffExtended().
 *
 * @param {SessionData|null} user - The session/user data.
 * @returns {HTMLElement} The My Stuff section element.
 */
function buildMyStuffSection(user) {
    const section = document.createElement('div');
    section.className = 'home-favorites'; // reuse the same layout

    const heading = document.createElement('a');
    heading.href = '/account';
    heading.dataset.link = '';
    heading.className = 'home-recent__heading home-recent__heading--link';
    heading.textContent = '⚡ ' + t('My Stuff');
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'favorites-grid';
    grid.id = 'home-mystuff-grid';

    const nets = user?.networks || [];
    if (nets.length === 0) {
        const hint = document.createElement('p');
        hint.className = 'home-hero__desc';
        hint.style.fontSize = '0.8125rem';
        hint.textContent = t('No network affiliations.');
        section.appendChild(hint);
        return section;
    }

    // Show networks immediately (already in session data)
    const MAX_ITEMS = 10;
    let count = 0;
    for (const net of nets) {
        if (count >= MAX_ITEMS) break;
        grid.appendChild(buildMyStuffItem('net', net.id, net.name ? `AS${net.asn} — ${net.name}` : `AS${net.asn}`));
        count++;
    }

    section.appendChild(grid);

    // Placeholder for additional items loaded asynchronously
    if (nets.length >= MAX_ITEMS) {
        const viewAll = document.createElement('a');
        viewAll.href = '/account';
        viewAll.dataset.link = '';
        viewAll.className = 'home-hero__desc';
        viewAll.style.fontSize = '0.8125rem';
        viewAll.style.display = 'block';
        viewAll.style.marginTop = 'var(--space-sm)';
        viewAll.textContent = t('View all in Account') + ' →';
        section.appendChild(viewAll);
    }

    return section;
}

/**
 * Builds a single item for the My Stuff grid.
 * Contains an entity badge, a link, and a compare shortcut.
 *
 * @param {string} tag - Entity type tag (net, ix, fac).
 * @param {number} id - Entity ID.
 * @param {string} name - Display name.
 * @returns {HTMLElement} Grid item element.
 */
function buildMyStuffItem(tag, id, name) {
    const item = document.createElement('div');
    item.className = 'favorites-grid__item';
    item.dataset.type = tag;
    item.dataset.id = String(id);

    item.appendChild(createEntityBadge(tag));

    const nameLink = createLink(tag, id, name);
    nameLink.className += ' favorites-grid__name';
    item.appendChild(nameLink);

    // Compare shortcut
    const cmpLink = document.createElement('a');
    cmpLink.href = `/compare?a=${tag}:${id}`;
    cmpLink.dataset.link = '';
    cmpLink.className = 'favorites-grid__updated'; // reuse the muted style
    cmpLink.style.fontSize = '0.6875rem';
    cmpLink.textContent = '↔ ' + t('Compare');
    cmpLink.title = t('Compare with another entity');
    item.appendChild(cmpLink);

    return item;
}

/**
 * Background-fetches the user's org affiliations to discover exchanges
 * and facilities, then appends them to the My Stuff grid.
 * Runs after initial render — networks are already visible.
 */
async function loadMyStuffExtended() {
    const grid = document.getElementById('home-mystuff-grid');
    if (!grid) return;

    const user = getUser();
    const nets = user?.networks || [];
    if (nets.length === 0) return;

    try {
        // Fetch each network at depth=0 to get org_id
        const netDetails = await Promise.all(
            nets.map(n => fetchEntity('net', String(n.id), 0).catch(/** @returns {null} */() => null))
        );

        /** @type {Set<number>} */
        const orgIds = new Set();
        for (const net of netDetails) {
            if (net?.org_id) orgIds.add(net.org_id);
        }

        // Fetch each org at depth=2 to get expanded child sets
        const orgs = await Promise.all(
            [...orgIds].map(orgId => fetchEntity('org', String(orgId), 2).catch(/** @returns {null} */() => null))
        );

        const MAX_ITEMS = 10;
        let currentCount = grid.children.length;

        for (const org of orgs) {
            if (!org) continue;
            // Add exchanges
            for (const ix of (org.ix_set || [])) {
                if (currentCount >= MAX_ITEMS) break;
                grid.appendChild(buildMyStuffItem('ix', ix.id, ix.name || `IX ${ix.id}`));
                currentCount++;
            }
            // Add facilities
            for (const fac of (org.fac_set || [])) {
                if (currentCount >= MAX_ITEMS) break;
                grid.appendChild(buildMyStuffItem('fac', fac.id, fac.name || `Fac ${fac.id}`));
                currentCount++;
            }
        }

        // Show "View all" if capped
        if (currentCount >= MAX_ITEMS) {
            const section = grid.parentElement;
            if (section && !section.querySelector('a[href="/account"]')) {
                const viewAll = document.createElement('a');
                viewAll.href = '/account';
                viewAll.dataset.link = '';
                viewAll.className = 'home-hero__desc';
                viewAll.style.fontSize = '0.8125rem';
                viewAll.style.display = 'block';
                viewAll.style.marginTop = 'var(--space-sm)';
                viewAll.textContent = t('View all in Account') + ' →';
                section.appendChild(viewAll);
            }
        }
    } catch (err) {
        console.warn('Failed to load extended affiliations for My Stuff:', err);
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
