/**
 * @fileoverview Shared rendering utilities for the PeeringDB frontend.
 * Provides functions for building data tables, info fields, loading
 * states, and formatting values commonly found in PeeringDB data.
 */

import { renderMarkdown } from './markdown.js';
import { t, getCurrentLang } from './i18n.js';

/**
 * Creates an internal SPA link element.
 *
 * @param {string} type - Entity type (net, ix, fac, org).
 * @param {number|string} id - Entity ID.
 * @param {string} label - Display text.
 * @returns {string} HTML string for an anchor with data-link.
 */
export function linkEntity(type, id, label) {
    const safe = escapeHTML(label);
    return `<a href="/${type}/${id}" data-link>${safe}</a>`;
}

/**
 * Renders a key/value info field for the detail sidebar.
 *
 * @param {string} label - Field label.
 * @param {string|number|null|undefined} value - Field value.
 * @param {Object} [opts] - Options.
 * @param {string} [opts.href] - Wrap value in a link.
 * @param {boolean} [opts.external] - Open link in new tab.
 * @param {string} [opts.linkType] - Entity type for SPA link.
 * @param {number|string} [opts.linkId] - Entity ID for SPA link.
 * @param {boolean} [opts.markdown] - Render value as markdown.
 * @param {boolean} [opts.translate] - Pass value through t() for enum translations.
 * @returns {string} HTML string.
 */
export function renderField(label, value, opts = {}) {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    let displayValue = opts.translate ? t(String(value)) : String(value);

    let valueHTML;

    if (opts.markdown) {
        valueHTML = renderMarkdown(displayValue);
    } else {
        valueHTML = escapeHTML(displayValue);
    }

    if (opts.linkType && opts.linkId) {
        valueHTML = linkEntity(opts.linkType, opts.linkId, String(value));
    } else if (opts.href) {
        const target = opts.external ? ' target="_blank" rel="noopener"' : '';
        valueHTML = `<a href="${escapeHTML(opts.href)}"${target}>${valueHTML}</a>`;
    }

    return `<div class="info-field">
        <span class="info-field__label">${escapeHTML(t(label))}</span>
        <span class="info-field__value">${valueHTML}</span>
    </div>`;
}

/**
 * Renders a group of info fields with a section title.
 *
 * @param {string} title - Group title.
 * @param {string[]} fields - Array of rendered field HTML strings (empty strings are filtered out).
 * @returns {string} HTML string for the group, or empty string if all fields are empty.
 */
export function renderFieldGroup(title, fields) {
    const populated = fields.filter(f => f);
    if (populated.length === 0) return '';

    return `<div class="info-group">
        <div class="info-group__title">${escapeHTML(t(title))}</div>
        ${populated.join('\n')}
    </div>`;
}

/**
 * Renders a sortable, paginated data table inside a card container.
 * Tables with more than PAGE_SIZE rows get prev/next page controls.
 *
 * @param {Object} opts - Table options.
 * @param {string} opts.title - Card header title.
 * @param {Array<{key: string, label: string, class?: string}>} opts.columns - Column definitions.
 * @param {any[]} opts.rows - Data rows.
 * @param {function(any, {key: string}): (string|{html: string, sortValue: string|number})} opts.cellRenderer
 *     Returns HTML for a cell. May return a plain string or an object
 *     with `html` (display) and `sortValue` (numeric/sortable value)
 *     to embed a `data-sort-value` attribute on the `<td>`.
 * @param {boolean} [opts.filterable] - Show a filter input.
 * @param {string} [opts.filterPlaceholder] - Placeholder text for filter input.
 * @param {number} [opts.pageSize] - Rows per page (default: PAGE_SIZE).
 * @returns {string} HTML string for the table card.
 */
export function renderTableCard(opts) {
    const { title, columns, rows, cellRenderer, filterable, filterPlaceholder } = opts;
    const count = rows.length;
    const pageSize = opts.pageSize || PAGE_SIZE;
    const needsPaging = count > pageSize;

    const filterHTML = filterable
        ? `<div class="table-filter">
               <input type="text" class="table-filter__input" placeholder="${t(filterPlaceholder || 'Filter...')}" data-table-filter>
           </div>`
        : '';

    const headerHTML = columns.map(col =>
        `<th data-sort-key="${col.key}">${escapeHTML(t(col.label))}</th>`
    ).join('');

    const bodyHTML = rows.map(row => {
        const cells = columns.map(col => {
            const rendered = cellRenderer(row, col);
            if (typeof rendered === 'object' && rendered !== null) {
                return `<td class="${col.class || ''}" data-sort-value="${rendered.sortValue}">${/* safe — cellRenderer output */ rendered.html}</td>`;
            }
            return `<td class="${col.class || ''}">${rendered}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    const pagingHTML = needsPaging
        ? `<div class="table-paging" data-page-size="${pageSize}">
               <button class="table-paging__btn" data-page-prev disabled>&larr; ${t('Prev')}</button>
               <span class="table-paging__info">${t('Page')} <span data-page-num>1</span> / <span data-page-total>${Math.ceil(count / pageSize)}</span></span>
               <button class="table-paging__btn" data-page-next>${t('Next')} &rarr;</button>
           </div>`
        : '';

    return `<div class="card">
        <div class="card__header">
            <span class="card__title">${escapeHTML(t(title))}</span>
            <div style="display:flex;align-items:center;gap:var(--space-sm)">
                ${filterHTML}
                <span class="card__badge">${count}</span>
            </div>
        </div>
        <div class="data-table-wrapper">
            <table class="data-table" data-sortable>
                <thead><tr>${headerHTML}</tr></thead>
                <tbody>${bodyHTML}</tbody>
            </table>
        </div>
        ${pagingHTML}
    </div>`;
}

/** Default number of rows per page in data tables. */
const PAGE_SIZE = 50;

/**
 * Renders a loading spinner.
 *
 * @param {string} [message="Loading"] - Text to display beside the spinner.
 * @returns {string} HTML string.
 */
export function renderLoading(message = 'Loading') {
    return `<div class="loading">${escapeHTML(t(message))}</div>`;
}

/**
 * Renders an error message.
 *
 * @param {string} message - Error text.
 * @returns {string} HTML string.
 */
export function renderError(message) {
    return `<div class="error-message">${escapeHTML(message)}</div>`;
}

/**
 * Formats a speed value in Mbps to a human-readable string.
 * 100 → "100M", 1000 → "1G", 100000 → "100G"
 *
 * @param {number|null|undefined} mbps - Speed in megabits per second.
 * @returns {string} Formatted speed string.
 */
export function formatSpeed(mbps) {
    if (!mbps) return '—';
    if (mbps >= 1_000_000) return `${mbps / 1_000_000}T`;
    if (mbps >= 1_000) return `${mbps / 1_000}G`;
    return `${mbps}M`;
}

/**
 * Formats an ISO date string as a relative time string.
 * Always returns a relative format (minutes, hours, days, months, years).
 *
 * @param {string|null|undefined} iso - ISO 8601 date string.
 * @returns {string} Relative time string (e.g. "5 minutes ago", "3 days ago").
 */
export function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return t('just now');
    if (diffMin === 1) return t('1 minute ago');
    if (diffMin < 60) return t('{n} minutes ago', { n: diffMin });
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr === 1) return t('1 hour ago');
    if (diffHr < 24) return t('{n} hours ago', { n: diffHr });
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return t('1 day ago');
    if (diffDay < 30) return t('{n} days ago', { n: diffDay });
    const diffMonth = Math.floor(diffDay / 30);
    if (diffMonth === 1) return t('1 month ago');
    if (diffMonth < 12) return t('{n} months ago', { n: diffMonth });
    const diffYear = Math.floor(diffDay / 365);
    if (diffYear === 1) return t('1 year ago');
    return t('{n} years ago', { n: diffYear });
}

/**
 * Formats an ISO date string as a locale-formatted absolute date
 * (e.g. "7 Apr 2026"). Used where a fixed calendar date is more
 * appropriate than a relative time.
 *
 * @param {string} iso - ISO 8601 date string.
 * @returns {string} Locale-formatted date, or the raw string on parse failure.
 */
export function formatLocaleDate(iso) {
    try {
        return new Date(iso).toLocaleDateString(getCurrentLang() || 'en', {
            year: 'numeric', month: 'short', day: 'numeric',
        });
    } catch {
        return iso;
    }
}

/**
 * Renders a boolean value as a styled yes/no indicator.
 *
 * @param {any} val - Value to check for truthiness.
 * @returns {string} HTML string with appropriate CSS class.
 */
export function renderBool(val) {
    if (val === true || val === 1 || val === 'Yes') {
        return `<span class="bool-yes">${t('Yes')}</span>`;
    }
    return `<span class="bool-no">${t('No')}</span>`;
}

/**
 * Renders a stats bar with label/value pairs.
 *
 * @param {Array<{label: string, value: string|number}>} items - Stats to display.
 * @returns {string} HTML string.
 */
export function renderStatsBar(items) {
    const inner = items.map(item => `
        <div class="stats-bar__item">
            <span class="stats-bar__value">${escapeHTML(String(item.value))}</span>
            <span class="stats-bar__label">${escapeHTML(t(item.label))}</span>
        </div>
    `).join('');

    return `<div class="stats-bar">${inner}</div>`;
}

/**
 * Escapes HTML special characters to prevent XSS.
 *
 * @param {string} str - Raw string.
 * @returns {string} Escaped string safe for innerHTML.
 */
export function escapeHTML(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Updates the OpenGraph meta tags in the document head.
 * Creates tags if they don't exist. This only affects client-side
 * rendering — bots that don't execute JS won't see these.
 *
 * @param {string} title - Page title for og:title.
 * @param {string} description - Page description for og:description.
 */
export function setOGTags(title, description) {
    setMetaProperty('og:title', title);
    setMetaProperty('og:description', description);
    setMetaProperty('og:url', window.location.href);
}

/**
 * Sets a single `<meta property="...">` tag's content attribute.
 * Creates the tag if it doesn't exist.
 *
 * @param {string} property - The meta property name (e.g. "og:title").
 * @param {string} content - The content value.
 */
function setMetaProperty(property, content) {
    let meta = /** @type {HTMLMetaElement|null} */ (
        document.querySelector(`meta[property="${property}"]`)
    );
    if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('property', property);
        document.head.appendChild(meta);
    }
    meta.setAttribute('content', content);
}

/**
 * Sorts a table body by the given column index and direction.
 * Used by both the initial default sort and click-triggered sorts.
 *
 * @param {HTMLElement} tbody - Table body element.
 * @param {number} colIdx - Column index to sort by.
 * @param {string} direction - "asc" or "desc".
 */
function sortTable(tbody, colIdx, direction) {
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.sort((a, b) => {
        const aCell = a.children[colIdx];
        const bCell = b.children[colIdx];
        const aVal = aCell?.getAttribute('data-sort-value') ?? aCell?.textContent?.trim() ?? '';
        const bVal = bCell?.getAttribute('data-sort-value') ?? bCell?.textContent?.trim() ?? '';

        const aNum = Number(aVal);
        const bNum = Number(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) {
            return direction === 'asc' ? aNum - bNum : bNum - aNum;
        }

        return direction === 'asc'
            ? aVal.localeCompare(bVal)
            : bVal.localeCompare(aVal);
    });

    for (const row of rows) {
        tbody.appendChild(row);
    }
}

/**
 * Applies pagination visibility to table rows.
 * Shows only the rows for the given page, hides the rest.
 * Respects filter state — hidden-by-filter rows are skipped.
 *
 * @param {HTMLElement} card - Card element containing the table and paging controls.
 * @param {number} page - 1-indexed page number.
 */
function applyPage(card, page) {
    const tbody = card.querySelector('tbody');
    const pagingDiv = card.querySelector('.table-paging');
    if (!tbody || !pagingDiv) return;

    const pageSize = parseInt(pagingDiv.getAttribute('data-page-size') || '50', 10);
    const allRows = Array.from(tbody.querySelectorAll('tr'));

    // Only count visible (not filtered-out) rows
    const visibleRows = allRows.filter(r =>
        /** @type {HTMLElement} */ (r).style.display !== 'none' ||
        /** @type {HTMLElement} */ (r).dataset.filteredOut !== '1'
    );

    const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const start = (safePage - 1) * pageSize;
    const end = start + pageSize;

    // Show/hide based on page position
    let visIdx = 0;
    for (const row of allRows) {
        const el = /** @type {HTMLElement} */ (row);
        if (el.dataset.filteredOut === '1') continue;
        el.style.display = (visIdx >= start && visIdx < end) ? '' : 'none';
        visIdx++;
    }

    // Update controls
    const numSpan = pagingDiv.querySelector('[data-page-num]');
    const totalSpan = pagingDiv.querySelector('[data-page-total]');
    const prevBtn = /** @type {HTMLButtonElement} */ (pagingDiv.querySelector('[data-page-prev]'));
    const nextBtn = /** @type {HTMLButtonElement} */ (pagingDiv.querySelector('[data-page-next]'));

    if (numSpan) numSpan.textContent = String(safePage);
    if (totalSpan) totalSpan.textContent = String(totalPages);
    if (prevBtn) prevBtn.disabled = safePage <= 1;
    if (nextBtn) nextBtn.disabled = safePage >= totalPages;

    pagingDiv.setAttribute('data-current-page', String(safePage));
}

/**
 * Attaches client-side sorting to all [data-sortable] tables within
 * a container element. Click a <th> to toggle asc/desc sort on that column.
 * Automatically sorts the first column ascending on initial render.
 *
 * @param {HTMLElement} container - DOM element containing the tables.
 */
export function attachTableSort(container) {
    for (const table of container.querySelectorAll('[data-sortable]')) {
        const thead = table.querySelector('thead');
        const tbody = table.querySelector('tbody');
        if (!thead || !tbody) continue;

        const card = table.closest('.card');

        thead.addEventListener('click', (e) => {
            const th = /** @type {HTMLElement|null} */ (e.target)?.closest('th');
            if (!th) return;

            const idx = Array.from(th.parentElement?.children || []).indexOf(th);
            const currentDir = th.getAttribute('data-sort-dir');
            const newDir = currentDir === 'asc' ? 'desc' : 'asc';

            for (const h of thead.querySelectorAll('th')) {
                h.removeAttribute('data-sort-dir');
            }
            th.setAttribute('data-sort-dir', newDir);

            sortTable(/** @type {HTMLElement} */ (tbody), idx, newDir);

            // Reset to page 1 after re-sort
            if (card?.querySelector('.table-paging')) {
                applyPage(/** @type {HTMLElement} */ (card), 1);
            }
        });

        // Default sort: first column ascending
        const firstTh = thead.querySelector('th');
        if (firstTh) {
            firstTh.setAttribute('data-sort-dir', 'asc');
            sortTable(/** @type {HTMLElement} */ (tbody), 0, 'asc');
        }

        // Apply initial pagination
        if (card?.querySelector('.table-paging')) {
            applyPage(/** @type {HTMLElement} */ (card), 1);
        }
    }
}

/**
 * Attaches click handlers to pagination prev/next buttons.
 *
 * @param {HTMLElement} container - DOM element containing paging controls.
 */
export function attachTablePaging(container) {
    for (const pagingDiv of container.querySelectorAll('.table-paging')) {
        const card = /** @type {HTMLElement} */ (pagingDiv.closest('.card'));
        if (!card) continue;

        pagingDiv.addEventListener('click', (e) => {
            const btn = /** @type {HTMLElement|null} */ (e.target)?.closest('button');
            if (!btn) return;

            const current = parseInt(pagingDiv.getAttribute('data-current-page') || '1', 10);
            if (btn.hasAttribute('data-page-prev')) {
                applyPage(card, current - 1);
            } else if (btn.hasAttribute('data-page-next')) {
                applyPage(card, current + 1);
            }
        });
    }
}

/**
 * Attaches client-side filtering to all [data-table-filter] inputs
 * within a container element. Filters table rows by matching the input
 * value against all cell text content.
 *
 * @param {HTMLElement} container - DOM element containing the filter inputs.
 */
export function attachTableFilter(container) {
    for (const input of container.querySelectorAll('[data-table-filter]')) {
        const card = input.closest('.card');
        if (!card) continue;

        const tbody = card.querySelector('tbody');
        if (!tbody) continue;

        input.addEventListener('input', () => {
            const query = /** @type {HTMLInputElement} */ (input).value.toLowerCase();
            for (const row of tbody.querySelectorAll('tr')) {
                const text = row.textContent?.toLowerCase() || '';
                /** @type {HTMLElement} */ (row).style.display = text.includes(query) ? '' : 'none';
            }
        });
    }
}
