/**
 * @fileoverview Application bootstrap module.
 * Registers SPA routes, wires up the header search bar,
 * initialises the router, fetches sync status for the footer,
 * bootstraps OAuth session state, and initializes i18n.
 */

import { addRoute, initRouter, navigate } from './router.js';
import { renderHome } from './pages/home.js';
import { renderSearch } from './pages/search.js';
import { renderNet } from './pages/net.js';
import { renderIx } from './pages/ix.js';
import { renderFac } from './pages/fac.js';
import { renderOrg } from './pages/org.js';
import { renderCarrier } from './pages/carrier.js';
import { renderCampus } from './pages/campus.js';
import { renderAbout } from './pages/about.js';
import { renderAsn } from './pages/asn.js';
import { renderAccount } from './pages/account.js';
import { fetchSyncStatus } from './api.js';
import { formatDate } from './render.js';
import { attachTypeahead } from './typeahead.js';
import { initAuth } from './auth.js';
import { initI18n, setLanguage, getCurrentLang, LANGUAGES, t } from './i18n.js';

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
addRoute('/account', renderAccount);
addRoute('/about', renderAbout);

// Expose navigate for the homepage search box
window.__router = { navigate };

// Header search: typeahead with fallback Enter-to-navigate
const headerSearch = /** @type {HTMLInputElement} */ (document.getElementById('header-search'));
attachTypeahead(headerSearch);

// Initialize i18n (loads locale dictionary if needed) before routing
await initI18n();

// Bootstrap OAuth session state before routing, so isAuthenticated()
// returns the correct value when page handlers run.
await initAuth().catch(() => {
    // Non-critical — auth UI will show "Sign in" on failure
});

// Boot the router (dispatches the current URL immediately)
initRouter(document.getElementById('app'));

// Wire up the footer language selector
const langSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('lang-select'));
if (langSelect) {
    // Populate options
    for (const [code, name] of Object.entries(LANGUAGES)) {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = `${name} (${code})`;
        opt.selected = code === getCurrentLang();
        langSelect.appendChild(opt);
    }

    langSelect.addEventListener('change', () => {
        setLanguage(langSelect.value, () => {
            // Re-render the current route by re-dispatching
            window.location.reload();
        });
    });
}

// Fetch and display sync status in the footer
fetchSyncStatus().then(sync => {
    const el = document.getElementById('sync-status');
    if (!el || !sync?.last_sync_at) return;

    const isoDate = sync.last_sync_at.replace(' ', 'T') + 'Z';
    const then = new Date(isoDate);
    const diffMs = Date.now() - then.getTime();
    const isStale = diffMs > 3 * 3600 * 1000; // >3 hours
    const timeText = formatDate(isoDate);
    const staleClass = isStale ? ' site-footer__sync-time--stale' : '';

    el.innerHTML = `${t('Last synced')} <span class="site-footer__sync-time${staleClass}">${timeText}</span>`;
    el.title = sync.last_sync_at;
}).catch(() => {
    // Non-critical — leave the sync status empty on failure
});
