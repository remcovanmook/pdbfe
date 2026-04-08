/**
 * @fileoverview Hidden diagnostic overlay for power users.
 *
 * Displays the state of the distributed cache pipeline in context:
 *   1. Current Page — full telemetry for the API request(s) backing
 *      the page you're looking at right now.
 *   2. D1 Edge Sync — entity-level sync timestamps and row counts.
 *   3. Browser SWR Cache — all local cache entries with full edge
 *      telemetry (tier, hits, timer, served-by, isolate-id).
 *
 * Triggered by Ctrl+Shift+D. Invisible to normal users — no UI
 * footprint until activated. Designed for network engineers debugging
 * stale data in the distributed system.
 *
 * @example
 *   // In boot.js:
 *   import { initDebugger } from './debug.js';
 *   initDebugger();
 */

import { getCacheDiagnostics, fetchSyncStatus, clearCache } from './api.js';
import { escapeHTML, formatDate } from './render.js';
import { t } from './i18n.js';

/** Staleness threshold for sync data — 1 hour in milliseconds. */
const STALE_THRESHOLD_MS = 3600_000;

/**
 * Normalizes a SQLite datetime string to ISO 8601 with UTC timezone.
 * SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" with no timezone
 * indicator. Browsers parse this as local time, which causes a clock
 * offset equal to the user's UTC offset. Appending 'Z' forces UTC.
 *
 * @param {string} sqliteDatetime - e.g. "2026-04-08 09:45:47"
 * @returns {string} ISO 8601 string, e.g. "2026-04-08T09:45:47Z"
 */
function toUTCISO(sqliteDatetime) {
    return sqliteDatetime.replace(' ', 'T') + 'Z';
}

/**
 * Parses the X-Timer header into a human-readable duration string.
 * Format: S<epoch>,VS0,VE<ms>  →  "<ms>ms"
 *
 * @param {string} timer - Raw X-Timer header value.
 * @returns {string} Duration string, e.g. "5ms", or the raw value on parse failure.
 */
function parseTimer(timer) {
    if (!timer) return '—';
    const match = timer.match(/VE(\d+)/);
    return match ? `${match[1]}ms` : timer;
}

/**
 * Extracts the path portion from a cache key URL, stripping the origin.
 *
 * @param {string} key - Full URL or cache key.
 * @returns {string} Path string, e.g. "/api/net/694?depth=2".
 */
function keyToPath(key) {
    return key.replace(/^https?:\/\/[^/]+/, '');
}

/** @type {HTMLElement|null} */
let _overlay = null;

/**
 * Registers the keyboard shortcut listener for the debug overlay
 * and hooks into SPA navigation so the overlay auto-refreshes
 * when the user clicks between pages.
 *
 * Call once at boot time. Does not create any DOM elements until
 * the shortcut is pressed.
 */
export function initDebugger() {
    document.addEventListener('keydown', (e) => {
        // Ctrl+Shift+D — guarded against input elements
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
            const tag = /** @type {HTMLElement} */ (e.target).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (/** @type {HTMLElement} */ (e.target).isContentEditable) return;

            e.preventDefault();
            toggleOverlay();
        }
    });

    // Re-render overlay on SPA navigation (popstate = back/forward,
    // pushState = link clicks via the router).
    window.addEventListener('popstate', () => refreshOverlay());

    const origPush = history.pushState.bind(history);
    history.pushState = function(...args) {
        origPush(...args);
        // Small delay so the page renderer has time to fire its fetches,
        // which populate the SWR cache that we read for diagnostics.
        setTimeout(() => refreshOverlay(), 300);
    };
}

/**
 * Re-renders the overlay content if it's currently visible.
 * Called on SPA navigation so the "Current Page" section stays
 * in sync with whatever the user is looking at.
 */
async function refreshOverlay() {
    if (!_overlay) return;

    try {
        const [syncStatus, localCache] = await Promise.all([
            fetchSyncStatus(),
            Promise.resolve(getCacheDiagnostics()),
        ]);
        if (!_overlay) return;
        _overlay.innerHTML = buildOverlayHTML(syncStatus, localCache);
        wireButtons();
    } catch {
        // Non-critical — leave current content on failure
    }
}

/**
 * Opens or closes the diagnostic overlay. When opening, fetches
 * fresh sync status and reads the browser cache diagnostics.
 */
async function toggleOverlay() {
    if (_overlay) {
        _overlay.remove();
        _overlay = null;
        return;
    }

    _overlay = document.createElement('div');
    _overlay.className = 'debug-overlay';
    _overlay.id = 'debug-overlay';
    document.body.appendChild(_overlay);

    _overlay.innerHTML = `<div class="debug-overlay__inner">
        <div class="debug-header">
            <h3>${t('Pipeline Diagnostics')}</h3>
            <span class="debug-header__hint">Ctrl+Shift+D</span>
        </div>
        <p class="debug-loading">${escapeHTML(t('Loading telemetry...'))}</p>
    </div>`;

    try {
        const [syncStatus, localCache] = await Promise.all([
            fetchSyncStatus(),
            Promise.resolve(getCacheDiagnostics()),
        ]);

        if (!_overlay) return; // User closed before fetch completed

        _overlay.innerHTML = buildOverlayHTML(syncStatus, localCache);
        wireButtons();
    } catch (err) {
        if (!_overlay) return;
        _overlay.innerHTML = `<div class="debug-overlay__inner">
            <div class="debug-header">
                <h3>${t('Pipeline Diagnostics')}</h3>
                <button class="debug-btn" id="debug-close">\u2715</button>
            </div>
            <p class="debug-error">${escapeHTML(t('Failed to load telemetry'))}: ${escapeHTML(/** @type {Error} */(err).message)}</p>
        </div>`;
        document.getElementById('debug-close')?.addEventListener('click', toggleOverlay);
    }
}

/**
 * Builds the full overlay HTML from sync status and cache diagnostics.
 *
 * @param {any} syncStatus - Response from fetchSyncStatus().
 * @param {Array<{key: string, ageMs: number, swrState: string, telemetry: import('./api.js').CacheTelemetry}>} localCache - Browser cache entries.
 * @returns {string} HTML string for the overlay content.
 */
function buildOverlayHTML(syncStatus, localCache) {
    const now = Date.now();
    const currentPath = window.location.pathname;

    // ── Section 1: Current Page Context ──────────────────────────

    // Find cache entries relevant to the current page by matching
    // the URL path prefix. E.g. viewing /net/694 matches /api/net/694.
    const pageEntries = localCache.filter(c => {
        const path = keyToPath(c.key);
        // Match /api/<entity>/<id> against /<entity>/<id>
        return path.startsWith('/api' + currentPath) ||
               path.startsWith('/status');
    });

    let currentPageSection = '';
    if (pageEntries.length > 0) {
        const rows = pageEntries.map(c => {
            const path = keyToPath(c.key);
            const tel = c.telemetry;
            const tier = tel?.tier || 'N/A';
            const ageSec = Math.floor(c.ageMs / 1000);

            return `<tr>
                <td class="debug-td--truncate" title="${escapeHTML(c.key)}">${escapeHTML(path)}</td>
                <td><span class="${/* safe — CSS class */ `debug-swr--${c.swrState}`}">${escapeHTML(c.swrState)}</span></td>
                <td><span class="${/* safe — CSS class */ `debug-tier--${tier}`}">${escapeHTML(tier)}</span></td>
                <td class="debug-td--right">${/* safe — numeric */ ageSec}s</td>
                <td class="debug-td--right">${escapeHTML(tel?.hits || '0')}</td>
                <td class="debug-td--right">${escapeHTML(parseTimer(tel?.timer || ''))}</td>
                <td class="debug-td--muted">${escapeHTML(tel?.servedBy || '—')}</td>
                <td class="debug-td--muted debug-td--truncate" title="${escapeHTML(tel?.isolateId || '')}">${escapeHTML(tel?.isolateId ? tel.isolateId.slice(0, 8) : '—')}</td>
            </tr>`;
        }).join('');

        currentPageSection = `<div class="debug-section">
            <h4>${escapeHTML(t('Current Page'))}: ${escapeHTML(currentPath)}</h4>
            <table class="debug-table">
                <thead><tr>
                    <th>${escapeHTML(t('Request'))}</th>
                    <th>${escapeHTML(t('Cache'))}</th>
                    <th>${escapeHTML(t('Edge'))}</th>
                    <th class="debug-td--right">${escapeHTML(t('Age'))}</th>
                    <th class="debug-td--right">${escapeHTML(t('Hits'))}</th>
                    <th class="debug-td--right">${escapeHTML(t('Time'))}</th>
                    <th>${escapeHTML(t('Served By'))}</th>
                    <th>${escapeHTML(t('Isolate'))}</th>
                </tr></thead>
                <tbody>${/* safe — built from escapeHTML calls */ rows}</tbody>
            </table>
        </div>`;
    } else {
        currentPageSection = `<div class="debug-section">
            <h4>${escapeHTML(t('Current Page'))}: ${escapeHTML(currentPath)}</h4>
            <p class="debug-meta">${escapeHTML(t('No cached API requests for this page'))}</p>
        </div>`;
    }

    // ── Section 2: D1 Sync State ─────────────────────────────────
    let syncRows = '';
    if (syncStatus?.entities) {
        for (const [tag, meta] of Object.entries(syncStatus.entities)) {
            const m = /** @type {{last_sync: number, row_count: number, updated_at: string}} */ (meta);
            const syncAgeMs = now - (m.last_sync * 1000);
            const isStale = syncAgeMs > STALE_THRESHOLD_MS;
            const staleClass = isStale ? ' debug-row--stale' : '';

            syncRows += `<tr class="${staleClass}">
                <td>${escapeHTML(tag)}</td>
                <td>${/* safe — formatDate output */ formatDate(toUTCISO(m.updated_at))}</td>
                <td class="debug-td--right">${/* safe — numeric */ m.row_count.toLocaleString()}</td>
                <td>${/* safe — boolean-derived HTML */ isStale ? '<span class="debug-stale-badge" title="' + escapeHTML(t('Sync older than 1 hour')) + '">⚠</span>' : ''}</td>
            </tr>`;
        }
    }

    const syncSection = `<div class="debug-section debug-section--collapsible">
        <h4 class="debug-section__toggle" data-target="debug-sync-body">
            ${escapeHTML(t('D1 Edge Sync State'))}
            ${syncStatus?.last_sync_at
                ? ` <span class="debug-meta--inline">${/* safe — formatDate output */ formatDate(toUTCISO(syncStatus.last_sync_at))}</span>`
                : ''
            }
            <span class="debug-chevron">▸</span>
        </h4>
        <div class="debug-section__body" id="debug-sync-body" hidden>
            <table class="debug-table">
                <thead><tr>
                    <th>${escapeHTML(t('Entity'))}</th>
                    <th>${escapeHTML(t('Updated'))}</th>
                    <th class="debug-td--right">${escapeHTML(t('Rows'))}</th>
                    <th></th>
                </tr></thead>
                <tbody>${/* safe — built from escapeHTML calls */ syncRows || `<tr><td colspan="4">${escapeHTML(t('No entities'))}</td></tr>`}</tbody>
            </table>
        </div>
    </div>`;

    // ── Section 3: Full Browser Cache ────────────────────────────
    let cacheRows = '';
    for (const entry of localCache) {
        const path = keyToPath(entry.key);
        const tel = entry.telemetry;
        const tier = tel?.tier || 'N/A';
        const ageSec = Math.floor(entry.ageMs / 1000);
        const isCurrentPage = pageEntries.some(p => p.key === entry.key);

        cacheRows += `<tr class="${isCurrentPage ? 'debug-row--active' : ''}">
            <td class="debug-td--truncate" title="${escapeHTML(entry.key)}">${escapeHTML(path.split('?')[0])}</td>
            <td><span class="${/* safe — CSS class */ `debug-swr--${entry.swrState}`}">${escapeHTML(entry.swrState)}</span></td>
            <td><span class="${/* safe — CSS class */ `debug-tier--${tier}`}">${escapeHTML(tier)}</span></td>
            <td class="debug-td--right">${/* safe — numeric */ ageSec}s</td>
            <td class="debug-td--right">${escapeHTML(tel?.hits || '0')}</td>
            <td class="debug-td--right">${escapeHTML(parseTimer(tel?.timer || ''))}</td>
            <td class="debug-td--muted">${escapeHTML(tel?.servedBy || '—')}</td>
        </tr>`;
    }

    const cacheSection = `<div class="debug-section debug-section--collapsible">
        <h4 class="debug-section__toggle" data-target="debug-cache-body">
            ${escapeHTML(t('All Cached Requests'))}
            <span class="debug-meta--inline">${/* safe — numeric */ localCache.length} ${escapeHTML(t('entries'))}</span>
            <span class="debug-chevron">▸</span>
        </h4>
        <div class="debug-section__body" id="debug-cache-body" hidden>
            <table class="debug-table">
                <thead><tr>
                    <th>${escapeHTML(t('Path'))}</th>
                    <th>${escapeHTML(t('Cache'))}</th>
                    <th>${escapeHTML(t('Edge'))}</th>
                    <th class="debug-td--right">${escapeHTML(t('Age'))}</th>
                    <th class="debug-td--right">${escapeHTML(t('Hits'))}</th>
                    <th class="debug-td--right">${escapeHTML(t('Time'))}</th>
                    <th>${escapeHTML(t('Served By'))}</th>
                </tr></thead>
                <tbody>${/* safe — built from escapeHTML calls */ cacheRows || `<tr><td colspan="7">${escapeHTML(t('Cache empty'))}</td></tr>`}</tbody>
            </table>
        </div>
    </div>`;

    // ── Actions ──────────────────────────────────────────────────
    const actions = `<div class="debug-actions">
        <button class="debug-btn" id="debug-clear-cache">${escapeHTML(t('Clear Browser Cache'))}</button>
        <button class="debug-btn" id="debug-force-refresh">${escapeHTML(t('Force Reload'))}</button>
        <button class="debug-btn debug-btn--close" id="debug-close">\u2715</button>
    </div>`;

    return `<div class="debug-overlay__inner">
        <div class="debug-header">
            <h3>${t('Pipeline Diagnostics')}</h3>
            <span class="debug-header__hint">Ctrl+Shift+D</span>
        </div>
        ${currentPageSection}
        ${syncSection}
        ${cacheSection}
        ${actions}
    </div>`;
}

/**
 * Wires up click handlers on the overlay action buttons and
 * collapsible section toggles.
 */
function wireButtons() {
    document.getElementById('debug-close')?.addEventListener('click', toggleOverlay);

    document.getElementById('debug-clear-cache')?.addEventListener('click', () => {
        clearCache();
        toggleOverlay();
    });

    document.getElementById('debug-force-refresh')?.addEventListener('click', () => {
        clearCache();
        window.location.reload();
    });

    // Collapsible section toggles
    for (const toggle of document.querySelectorAll('.debug-section__toggle')) {
        toggle.addEventListener('click', () => {
            const targetId = toggle.getAttribute('data-target');
            if (!targetId) return;
            const body = document.getElementById(targetId);
            if (!body) return;
            const isHidden = body.hidden;
            body.hidden = !isHidden;
            const chevron = toggle.querySelector('.debug-chevron');
            if (chevron) chevron.textContent = isHidden ? '▾' : '▸';
        });
    }
}
