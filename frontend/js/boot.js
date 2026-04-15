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
import { initAuth, fetchPreferenceOptions } from './auth.js';
import { initI18n, setLanguage, getCurrentLang, LANGUAGES, t } from './i18n.js';
import { initDebugger } from './debug.js';
import { initTheme, getTheme, setTheme } from './theme.js';
import { getTimezonePreference, setTimezone } from './timezone.js';

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

// Populate footer selectors and sync status in parallel (non-blocking).
// Both are non-critical — failures are silently ignored.
const [prefResult, syncResult] = await Promise.allSettled([
    fetchPreferenceOptions(),
    fetchSyncStatus(),
]);

// ── Preference selectors ─────────────────────────────────────────────
if (prefResult.status === 'fulfilled') {
    const prefOptions = prefResult.value;

    // Language
    const langSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('lang-select'));
    if (langSelect) {
        const storedLang = localStorage.getItem('pdbfe-lang');
        const activeLang = storedLang || 'auto';
        const langCodes = prefOptions.language || ['auto', ...Object.keys(LANGUAGES)];
        for (const code of langCodes) {
            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = code === 'auto' ? 'Auto' : `${LANGUAGES[code] || code} (${code})`;
            opt.selected = code === activeLang;
            langSelect.appendChild(opt);
        }

        langSelect.addEventListener('change', () => {
            setLanguage(langSelect.value, () => {
                globalThis.location.reload();
            });
        });
    }

    // Theme
    const themeSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('theme-select'));
    if (themeSelect) {
        const activeTheme = getTheme();
        /** @type {Record<string, string>} */
        const themeLabels = { auto: 'Auto', dark: 'Dark', light: 'Light' };
        const themeValues = prefOptions.theme || ['auto', 'dark', 'light'];
        for (const value of themeValues) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = themeLabels[value] || value;
            opt.selected = value === activeTheme;
            themeSelect.appendChild(opt);
        }

        themeSelect.addEventListener('change', () => {
            setTheme(themeSelect.value);
        });
    }

    // Timezone
    const tzSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('tz-select'));
    if (tzSelect) {
        const activeTz = getTimezonePreference();
        const tzValues = prefOptions.timezone || ['auto', 'UTC'];
        for (const value of tzValues) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = value === 'auto' ? 'Auto' : value.replaceAll('_', ' ');
            opt.selected = value === activeTz;
            tzSelect.appendChild(opt);
        }

        tzSelect.addEventListener('change', () => {
            setTimezone(tzSelect.value);
        });
    }
}

// ── Sync status indicator ────────────────────────────────────────────
if (syncResult.status === 'fulfilled') {
    const sync = syncResult.value;
    const el = document.getElementById('sync-status');

    if (el && sync?.rate_limited) {
        // /status itself returned 429
        const timeSpan = document.createElement('span');
        timeSpan.className = 'site-footer__sync-time site-footer__sync-time--warn';
        timeSpan.textContent = `● ${t('Rate limited — try again shortly')}`;
        el.replaceChildren(timeSpan);
    } else if (el && sync?.last_modified_at) {
        const epochMs = sync.last_modified_at * 1000;
        const isoDate = new Date(epochMs).toISOString();
        const diffMin = (Date.now() - epochMs) / 60_000;
        const timeText = formatDate(isoDate);

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
    }
}

// ── Rate-limit modal ─────────────────────────────────────────────────
// Shown once per page load when any API request returns 429.
// The user can dismiss it; it won't re-appear until the next page load.
let rateLimitShown = false;
globalThis.addEventListener('pdbfe:ratelimit', () => {
    if (rateLimitShown) return;
    rateLimitShown = true;

    const overlay = document.createElement('div');
    overlay.className = 'rate-limit-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-label', 'Rate limited');

    const dialog = document.createElement('div');
    dialog.className = 'rate-limit-dialog';

    const heading = document.createElement('h3');
    heading.textContent = t('Rate Limited');
    dialog.appendChild(heading);

    const msg = document.createElement('p');
    msg.textContent = t('Too many requests. Please wait a moment and try again.');
    dialog.appendChild(msg);

    const btn = document.createElement('button');
    btn.className = 'rate-limit-dismiss';
    btn.textContent = t('Dismiss');
    btn.addEventListener('click', () => overlay.remove());
    dialog.appendChild(btn);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
});
