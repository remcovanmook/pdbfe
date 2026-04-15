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
import { initDebugger } from './debug.js';
import { initTheme, getTheme, setTheme } from './theme.js';

// Register Web Components — must execute before the router dispatches.
import './components/pdb-table.js';
import './components/pdb-field-group.js';
import './components/pdb-stats-bar.js';

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
globalThis.__router = { navigate };

// Header search: typeahead with fallback Enter-to-navigate
const headerSearch = /** @type {HTMLInputElement} */ (document.getElementById('header-search'));
attachTypeahead(headerSearch);

// Initialise theme before first paint to avoid a flash of wrong colours.
initTheme();

// Initialize i18n (loads locale dictionary if needed) before routing
await initI18n();

// Bootstrap OAuth session state before routing, so isAuthenticated()
// returns the correct value when page handlers run. initAuth() also
// fetches the user profile and may apply a server-side language preference,
// which updates getCurrentLang().
await initAuth().catch(() => {
    // Non-critical — auth UI will show "Sign in" on failure
});

// Boot the router (dispatches the current URL immediately)
initRouter(document.getElementById('app'));

// Register Ctrl+Shift+D diagnostic overlay (no DOM footprint until triggered)
initDebugger();

// Wire up the footer language selector. Populated after initAuth() so that
// getCurrentLang() reflects any server-side language preference applied
// during profile fetch.
const langSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('lang-select'));
if (langSelect) {
    const activeLang = getCurrentLang();
    for (const [code, name] of Object.entries(LANGUAGES)) {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = `${name} (${code})`;
        opt.selected = code === activeLang;
        langSelect.appendChild(opt);
    }

    langSelect.addEventListener('change', () => {
        setLanguage(langSelect.value, () => {
            // Re-render the current route by re-dispatching
            globalThis.location.reload();
        });
    });
}

// Wire up the footer theme selector
const themeSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('theme-select'));
if (themeSelect) {
    const activeTheme = getTheme();
    for (const [value, label] of [['dark', '🌙 Dark'], ['light', '☀️ Light']]) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        opt.selected = value === activeTheme;
        themeSelect.appendChild(opt);
    }

    themeSelect.addEventListener('change', () => {
        setTheme(themeSelect.value);
    });
}

// Fetch and display sync status in the footer
fetchSyncStatus().then(sync => {
    const el = document.getElementById('sync-status');
    if (!el || !sync?.last_modified_at) return;

    const epochMs = sync.last_modified_at * 1000;
    const isoDate = new Date(epochMs).toISOString();
    const diffMin = (Date.now() - epochMs) / 60_000;
    const timeText = formatDate(isoDate);

    // Determine freshness tier
    let freshClass = '';
    let prefix = '';
    if (diffMin > 60) {
        freshClass = ' site-footer__sync-time--error';
        prefix = '✕ ';
    } else if (diffMin > 15) {
        freshClass = ' site-footer__sync-time--warn';
        prefix = '● ';
    } else {
        freshClass = ' site-footer__sync-time--ok';
        prefix = '✓ ';
    }

    const textNode = document.createTextNode(t('Last synced') + ' ');
    const timeSpan = document.createElement('span');
    timeSpan.className = `site-footer__sync-time${freshClass}`;
    timeSpan.textContent = prefix + timeText;
    el.replaceChildren(textNode, timeSpan);
    el.title = isoDate;
}).catch(() => {
    // Non-critical — leave the sync status empty on failure
});
