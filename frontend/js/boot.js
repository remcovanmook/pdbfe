/**
 * @fileoverview Application bootstrap module.
 * Registers SPA routes, wires up the header search bar,
 * initialises the router, and fetches sync status for the footer.
 */

import { addRoute, initRouter, navigate } from '/js/router.js';
import { renderHome } from '/js/pages/home.js';
import { renderSearch } from '/js/pages/search.js';
import { renderNet } from '/js/pages/net.js';
import { renderIx } from '/js/pages/ix.js';
import { renderFac } from '/js/pages/fac.js';
import { renderOrg } from '/js/pages/org.js';
import { renderCarrier } from '/js/pages/carrier.js';
import { renderCampus } from '/js/pages/campus.js';
import { renderAbout } from '/js/pages/about.js';
import { renderAsn } from '/js/pages/asn.js';
import { fetchSyncStatus } from '/js/api.js';
import { attachTypeahead } from '/js/typeahead.js';

// Register routes
addRoute('/', renderHome);
addRoute('/search', renderSearch);
addRoute('/net/:id', renderNet);
addRoute('/ix/:id', renderIx);
addRoute('/fac/:id', renderFac);
addRoute('/org/:id', renderOrg);
addRoute('/carrier/:id', renderCarrier);
addRoute('/campus/:id', renderCampus);
addRoute('/asn/:asn', renderAsn);
addRoute('/about', renderAbout);

// Expose navigate for the homepage search box
window.__router = { navigate };

// Header search: typeahead with fallback Enter-to-navigate
const headerSearch = /** @type {HTMLInputElement} */ (document.getElementById('header-search'));
attachTypeahead(headerSearch);

// Boot the router
initRouter(document.getElementById('app'));

// Fetch and display sync status in the footer
fetchSyncStatus().then(sync => {
    const el = document.getElementById('sync-status');
    if (!el || !sync?.last_sync_at) return;

    const then = new Date(sync.last_sync_at.replace(' ', 'T') + 'Z');
    const diffMs = Date.now() - then.getTime();
    const isStale = diffMs > 3 * 3600 * 1000; // >3 hours
    const timeText = formatRelativeTime(sync.last_sync_at);
    const staleClass = isStale ? ' site-footer__sync-time--stale' : '';

    el.innerHTML = `Last synced <span class="site-footer__sync-time${staleClass}">${timeText}</span>`;
    el.title = sync.last_sync_at;
}).catch(() => {
    // Non-critical — leave the sync status empty on failure
});

/**
 * Formats a UTC datetime string (e.g. "2026-04-01 14:30:00")
 * into a human-readable relative time like "12 minutes ago".
 *
 * @param {string} utcDateStr - UTC datetime from the _sync_meta table.
 * @returns {string} Relative time string.
 */
function formatRelativeTime(utcDateStr) {
    const then = new Date(utcDateStr.replace(' ', 'T') + 'Z');
    const diffMs = Date.now() - then.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60)  return 'just now';
    if (diffSec < 3600) {
        const m = Math.floor(diffSec / 60);
        return `${m} minute${m !== 1 ? 's' : ''} ago`;
    }
    if (diffSec < 86400) {
        const h = Math.floor(diffSec / 3600);
        return `${h} hour${h !== 1 ? 's' : ''} ago`;
    }
    const d = Math.floor(diffSec / 86400);
    return `${d} day${d !== 1 ? 's' : ''} ago`;
}
