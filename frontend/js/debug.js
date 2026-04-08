/**
 * @fileoverview Hidden diagnostic overlay for power users.
 *
 * Displays the state of the distributed cache pipeline:
 *   1. D1 Edge Sync — entity-level sync timestamps and row counts.
 *   2. Browser SWR Cache — local cache entries with edge telemetry
 *      (X-Cache tier, X-Timer, X-Served-By, X-Isolate-ID).
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

/** @type {HTMLElement|null} */
let _overlay = null;

/**
 * Registers the keyboard shortcut listener for the debug overlay.
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
 * @param {Array<{key: string, ageMs: number, telemetry: import('./api.js').CacheTelemetry}>} localCache - Browser cache entries.
 * @returns {string} HTML string for the overlay content.
 */
function buildOverlayHTML(syncStatus, localCache) {
    const now = Date.now();

    // ── Section 1: D1 Sync State ─────────────────────────────────
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

    const syncSection = `<div class="debug-section">
        <h4>${escapeHTML(t('D1 Edge Sync State'))}</h4>
        ${syncStatus?.last_sync_at
            ? `<p class="debug-meta">${escapeHTML(t('Last sync'))}: ${/* safe — formatDate output */ formatDate(toUTCISO(syncStatus.last_sync_at))}</p>`
            : `<p class="debug-meta debug-error">${escapeHTML(t('No sync data available'))}</p>`
        }
        <table class="debug-table">
            <thead><tr>
                <th>${escapeHTML(t('Entity'))}</th>
                <th>${escapeHTML(t('Updated'))}</th>
                <th class="debug-td--right">${escapeHTML(t('Rows'))}</th>
                <th></th>
            </tr></thead>
            <tbody>${/* safe — built from escapeHTML calls */ syncRows || `<tr><td colspan="4">${escapeHTML(t('No entities'))}</td></tr>`}</tbody>
        </table>
    </div>`;

    // ── Section 2: Browser SWR Cache ─────────────────────────────
    let cacheRows = '';
    for (const entry of localCache) {
        const path = entry.key.replace(/^https?:\/\/[^/]+/, '');
        const tier = entry.telemetry?.tier || 'N/A';
        const tierClass = `debug-tier--${tier}`;
        const ageSec = Math.floor(entry.ageMs / 1000);
        const servedBy = entry.telemetry?.servedBy || '';
        const colo = servedBy.replace(/^cache-/, '').split('-')[0] || '';

        cacheRows += `<tr>
            <td class="debug-td--truncate" title="${escapeHTML(entry.key)}">${escapeHTML(path.split('?')[0])}</td>
            <td class="debug-td--right">${/* safe — numeric */ ageSec}s</td>
            <td><span class="${/* safe — CSS class from header */ tierClass}">${escapeHTML(tier)}</span></td>
            <td class="debug-td--muted">${escapeHTML(colo)}</td>
        </tr>`;
    }

    const cacheSection = `<div class="debug-section">
        <h4>${escapeHTML(t('Browser SWR Cache'))}</h4>
        <table class="debug-table">
            <thead><tr>
                <th>${escapeHTML(t('Path'))}</th>
                <th class="debug-td--right">${escapeHTML(t('Age'))}</th>
                <th>${escapeHTML(t('Edge Tier'))}</th>
                <th>${escapeHTML(t('Colo'))}</th>
            </tr></thead>
            <tbody>${/* safe — built from escapeHTML calls */ cacheRows || `<tr><td colspan="4">${escapeHTML(t('Cache empty'))}</td></tr>`}</tbody>
        </table>
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
        ${syncSection}
        ${cacheSection}
        ${actions}
    </div>`;
}

/**
 * Wires up click handlers on the overlay action buttons.
 * Called after the overlay HTML is inserted into the DOM.
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
}
