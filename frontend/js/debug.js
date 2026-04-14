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
 * All content is built with DOM nodes — no innerHTML.
 *
 * @example
 *   // In boot.js:
 *   import { initDebugger } from './debug.js';
 *   initDebugger();
 */

import { getCacheDiagnostics, fetchSyncStatus, clearCache } from './api.js';
import { formatDate } from './render.js';
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
    const match = /VE(\d+)/.exec(timer);
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

// ── DOM helpers ─────────────────────────────────────────────────────

/**
 * Creates an element with optional class, text, and title.
 *
 * @param {string} tag
 * @param {Object} [opts]
 * @param {string} [opts.className]
 * @param {string} [opts.text]
 * @param {string} [opts.title]
 * @param {string} [opts.id]
 * @param {boolean} [opts.hidden]
 * @returns {HTMLElement}
 */
function _el(tag, opts = {}) {
    const node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.title) node.title = opts.title;
    if (opts.id) node.id = opts.id;
    if (opts.hidden) node.hidden = true;
    return node;
}

/**
 * Creates a <td> element with optional class and text.
 *
 * @param {string} text
 * @param {string} [className]
 * @param {string} [title]
 * @returns {HTMLTableCellElement}
 */
function _td(text, className, title) {
    const td = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
    if (className) td.className = className;
    td.textContent = text;
    if (title) td.title = title;
    return td;
}

/**
 * Creates a <th> element with text.
 *
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLTableCellElement}
 */
function _th(text, className) {
    const th = /** @type {HTMLTableCellElement} */ (document.createElement('th'));
    th.textContent = text;
    if (className) th.className = className;
    return th;
}

/**
 * Creates a <span> with a CSS class and text (for tier/swr badges).
 *
 * @param {string} text
 * @param {string} className
 * @returns {HTMLSpanElement}
 */
function _badge(text, className) {
    const span = /** @type {HTMLSpanElement} */ (document.createElement('span'));
    span.className = className;
    span.textContent = text;
    return span;
}

// ── Overlay state ───────────────────────────────────────────────────

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
        _overlay.replaceChildren(buildOverlayDOM(syncStatus, localCache));
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

    // Show loading state
    const inner = _el('div', { className: 'debug-overlay__inner' });
    const loadHeader = _el('div', { className: 'debug-header' });
    loadHeader.appendChild(_el('h3', { text: t('Pipeline Diagnostics') }));
    loadHeader.appendChild(_el('span', { className: 'debug-header__hint', text: 'Ctrl+Shift+D' }));
    inner.appendChild(loadHeader);
    inner.appendChild(_el('p', { className: 'debug-loading', text: t('Loading telemetry...') }));
    _overlay.replaceChildren(inner);

    try {
        const [syncStatus, localCache] = await Promise.all([
            fetchSyncStatus(),
            Promise.resolve(getCacheDiagnostics()),
        ]);

        if (!_overlay) return; // User closed before fetch completed

        _overlay.replaceChildren(buildOverlayDOM(syncStatus, localCache));
        wireButtons();
    } catch (err) {
        if (!_overlay) return;
        const errInner = _el('div', { className: 'debug-overlay__inner' });
        const errHeader = _el('div', { className: 'debug-header' });
        errHeader.appendChild(_el('h3', { text: t('Pipeline Diagnostics') }));
        const closeBtn = _el('button', { className: 'debug-btn', id: 'debug-close', text: '\u2715' });
        errHeader.appendChild(closeBtn);
        errInner.appendChild(errHeader);
        errInner.appendChild(_el('p', { className: 'debug-error', text: `${t('Failed to load telemetry')}: ${/** @type {Error} */ (err).message}` }));
        _overlay.replaceChildren(errInner);
        closeBtn.addEventListener('click', toggleOverlay);
    }
}

/**
 * Builds the full overlay DOM from sync status and cache diagnostics.
 *
 * @param {any} syncStatus - Response from fetchSyncStatus().
 * @param {Array<{key: string, ageMs: number, swrState: string, telemetry: import('./api.js').CacheTelemetry}>} localCache - Browser cache entries.
 * @returns {HTMLElement} The overlay inner container.
 */
function buildOverlayDOM(syncStatus, localCache) {
    const now = Date.now();
    const currentPath = window.location.pathname;

    const inner = _el('div', { className: 'debug-overlay__inner' });

    // ── Header ───────────────────────────────────────────────────
    const header = _el('div', { className: 'debug-header' });
    header.appendChild(_el('h3', { text: t('Pipeline Diagnostics') }));
    header.appendChild(_el('span', { className: 'debug-header__hint', text: 'Ctrl+Shift+D' }));
    inner.appendChild(header);

    // ── Section 1: Current Page Context ──────────────────────────
    const pageEntries = localCache.filter((/** @type {any} */ c) => {
        const path = keyToPath(c.key);
        return path.startsWith('/api' + currentPath) || path.startsWith('/status');
    });

    const pageSection = _el('div', { className: 'debug-section' });
    const pageHeading = _el('h4', { text: `${t('Current Page')}: ${currentPath}` });
    pageSection.appendChild(pageHeading);

    if (pageEntries.length > 0) {
        pageSection.appendChild(buildTelemetryTable(
            [t('Request'), t('Cache'), t('Edge'), t('Age'), t('Hits'), t('Time'), t('Served By'), t('Isolate')],
            ['', '', '', 'debug-td--right', 'debug-td--right', 'debug-td--right', '', ''],
            pageEntries.map((/** @type {any} */ c) => {
                const path = keyToPath(c.key);
                const tel = c.telemetry;
                const tier = tel?.tier || 'N/A';
                const ageSec = Math.floor(c.ageMs / 1000);
                return {
                    cells: [
                        { text: path, className: 'debug-td--truncate', title: c.key },
                        { node: _badge(c.swrState, `debug-swr--${c.swrState}`) },
                        { node: _badge(tier, `debug-tier--${tier}`) },
                        { text: `${ageSec}s`, className: 'debug-td--right' },
                        { text: tel?.hits || '0', className: 'debug-td--right' },
                        { text: parseTimer(tel?.timer || ''), className: 'debug-td--right' },
                        { text: tel?.servedBy || '—', className: 'debug-td--muted' },
                        { text: tel?.isolateId ? tel.isolateId.slice(0, 8) : '—', className: 'debug-td--muted debug-td--truncate', title: tel?.isolateId || '' },
                    ]
                };
            })
        ));
    } else {
        pageSection.appendChild(_el('p', { className: 'debug-meta', text: t('No cached API requests for this page') }));
    }
    inner.appendChild(pageSection);

    // ── Section 2: D1 Sync State ─────────────────────────────────
    const syncSection = _el('div', { className: 'debug-section debug-section--collapsible' });
    const syncToggle = _el('h4', { className: 'debug-section__toggle' });
    syncToggle.dataset.target = 'debug-sync-body';
    syncToggle.appendChild(document.createTextNode(t('D1 Edge Sync State')));
    if (syncStatus?.last_sync_at) {
        const syncMeta = _el('span', { className: 'debug-meta--inline', text: ` ${formatDate(toUTCISO(syncStatus.last_sync_at))}` });
        syncToggle.appendChild(syncMeta);
    }
    syncToggle.appendChild(_el('span', { className: 'debug-chevron', text: '\u25B8' }));
    syncSection.appendChild(syncToggle);

    const syncBody = _el('div', { className: 'debug-section__body', id: 'debug-sync-body', hidden: true });
    if (syncStatus?.entities) {
        const syncTable = document.createElement('table');
        syncTable.className = 'debug-table';
        const stHead = document.createElement('thead');
        const stHR = document.createElement('tr');
        stHR.appendChild(_th(t('Entity')));
        stHR.appendChild(_th(t('Updated')));
        stHR.appendChild(_th(t('Rows'), 'debug-td--right'));
        stHR.appendChild(_th(''));
        stHead.appendChild(stHR);
        syncTable.appendChild(stHead);

        const stBody = document.createElement('tbody');
        for (const [tag, meta] of Object.entries(syncStatus.entities)) {
            const m = /** @type {{last_sync: number, row_count: number, updated_at: string}} */ (meta);
            const syncAgeMs = now - (m.last_sync * 1000);
            const isStale = syncAgeMs > STALE_THRESHOLD_MS;

            const tr = document.createElement('tr');
            if (isStale) tr.className = 'debug-row--stale';

            tr.appendChild(_td(tag));
            tr.appendChild(_td(formatDate(toUTCISO(m.updated_at))));
            tr.appendChild(_td(m.row_count.toLocaleString(), 'debug-td--right'));

            const staleTd = document.createElement('td');
            if (isStale) {
                staleTd.appendChild(_badge('\u26A0', 'debug-stale-badge'));
                staleTd.firstElementChild?.setAttribute('title', t('Sync older than 1 hour'));
            }
            tr.appendChild(staleTd);
            stBody.appendChild(tr);
        }
        syncTable.appendChild(stBody);
        syncBody.appendChild(syncTable);
    } else {
        const emptyTr = document.createElement('p');
        emptyTr.textContent = t('No entities');
        syncBody.appendChild(emptyTr);
    }
    syncSection.appendChild(syncBody);
    inner.appendChild(syncSection);

    // ── Section 3: Full Browser Cache ────────────────────────────
    const cacheSection = _el('div', { className: 'debug-section debug-section--collapsible' });
    const cacheToggle = _el('h4', { className: 'debug-section__toggle' });
    cacheToggle.dataset.target = 'debug-cache-body';
    cacheToggle.appendChild(document.createTextNode(t('All Cached Requests')));
    cacheToggle.appendChild(_el('span', { className: 'debug-meta--inline', text: ` ${localCache.length} ${t('entries')}` }));
    cacheToggle.appendChild(_el('span', { className: 'debug-chevron', text: '\u25B8' }));
    cacheSection.appendChild(cacheToggle);

    const cacheBody = _el('div', { className: 'debug-section__body', id: 'debug-cache-body', hidden: true });
    if (localCache.length > 0) {
        cacheBody.appendChild(buildTelemetryTable(
            [t('Path'), t('Cache'), t('Edge'), t('Age'), t('Hits'), t('Time'), t('Served By')],
            ['', '', '', 'debug-td--right', 'debug-td--right', 'debug-td--right', ''],
            localCache.map((/** @type {any} */ entry) => {
                const path = keyToPath(entry.key);
                const tel = entry.telemetry;
                const tier = tel?.tier || 'N/A';
                const ageSec = Math.floor(entry.ageMs / 1000);
                const isCurrentPage = pageEntries.some((/** @type {any} */ p) => p.key === entry.key);
                return {
                    className: isCurrentPage ? 'debug-row--active' : '',
                    cells: [
                        { text: path.split('?')[0], className: 'debug-td--truncate', title: entry.key },
                        { node: _badge(entry.swrState, `debug-swr--${entry.swrState}`) },
                        { node: _badge(tier, `debug-tier--${tier}`) },
                        { text: `${ageSec}s`, className: 'debug-td--right' },
                        { text: tel?.hits || '0', className: 'debug-td--right' },
                        { text: parseTimer(tel?.timer || ''), className: 'debug-td--right' },
                        { text: tel?.servedBy || '—', className: 'debug-td--muted' },
                    ]
                };
            })
        ));
    } else {
        cacheBody.appendChild(_el('p', { text: t('Cache empty') }));
    }
    cacheSection.appendChild(cacheBody);
    inner.appendChild(cacheSection);

    // ── Actions ──────────────────────────────────────────────────
    const actions = _el('div', { className: 'debug-actions' });
    actions.appendChild(_el('button', { className: 'debug-btn', id: 'debug-clear-cache', text: t('Clear Browser Cache') }));
    actions.appendChild(_el('button', { className: 'debug-btn', id: 'debug-force-refresh', text: t('Force Reload') }));
    actions.appendChild(_el('button', { className: 'debug-btn debug-btn--close', id: 'debug-close', text: '\u2715' }));
    inner.appendChild(actions);

    return inner;
}

/**
 * Builds a telemetry data table from column headers and row data.
 *
 * @param {string[]} headers - Column header labels.
 * @param {string[]} headerClasses - CSS classes for each header th.
 * @param {Array<{className?: string, cells: Array<{text?: string, node?: Node, className?: string, title?: string}>}>} rows
 * @returns {HTMLDivElement} Wrapper div containing the table.
 */
function buildTelemetryTable(headers, headerClasses, rows) {
    const wrapper = document.createElement('div');
    const table = document.createElement('table');
    table.className = 'debug-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headers.forEach((label, i) => {
        headRow.appendChild(_th(label, headerClasses[i]));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        if (row.className) tr.className = row.className;

        for (const cell of row.cells) {
            const td = document.createElement('td');
            if (cell.className) td.className = cell.className;
            if (cell.title) td.title = cell.title;

            if (cell.node) {
                td.appendChild(cell.node);
            } else if (cell.text !== undefined) {
                td.textContent = cell.text;
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
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
            const targetId = /** @type {HTMLElement} */ (toggle).dataset.target;
            if (!targetId) return;
            const body = document.getElementById(targetId);
            if (!body) return;
            const isHidden = body.hidden;
            body.hidden = !isHidden;
            const chevron = toggle.querySelector('.debug-chevron');
            if (chevron) chevron.textContent = isHidden ? '\u25BE' : '\u25B8';
        });
    }
}
