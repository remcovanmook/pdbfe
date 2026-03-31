/**
 * @fileoverview Shared rendering utilities for the PeeringDB frontend.
 * Provides functions for building data tables, info fields, loading
 * states, and formatting values commonly found in PeeringDB data.
 */

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
 * @returns {string} HTML string.
 */
export function renderField(label, value, opts = {}) {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    let valueHTML = escapeHTML(String(value));

    if (opts.linkType && opts.linkId) {
        valueHTML = linkEntity(opts.linkType, opts.linkId, String(value));
    } else if (opts.href) {
        const target = opts.external ? ' target="_blank" rel="noopener"' : '';
        valueHTML = `<a href="${escapeHTML(opts.href)}"${target}>${valueHTML}</a>`;
    }

    return `<div class="info-field">
        <span class="info-field__label">${escapeHTML(label)}</span>
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
        <div class="info-group__title">${escapeHTML(title)}</div>
        ${populated.join('\n')}
    </div>`;
}

/**
 * Renders a sortable data table inside a card container.
 *
 * @param {Object} opts - Table options.
 * @param {string} opts.title - Card header title.
 * @param {Array<{key: string, label: string, class?: string}>} opts.columns - Column definitions.
 * @param {any[]} opts.rows - Data rows.
 * @param {function(any, {key: string}): string} opts.cellRenderer - Returns HTML for a cell.
 * @param {boolean} [opts.filterable] - Show a filter input.
 * @param {string} [opts.filterPlaceholder] - Placeholder text for filter input.
 * @returns {string} HTML string for the table card.
 */
export function renderTableCard(opts) {
    const { title, columns, rows, cellRenderer, filterable, filterPlaceholder } = opts;
    const count = rows.length;

    const filterHTML = filterable
        ? `<div class="table-filter">
               <input type="text" class="table-filter__input" placeholder="${filterPlaceholder || 'Filter...'}" data-table-filter>
           </div>`
        : '';

    const headerHTML = columns.map(col =>
        `<th data-sort-key="${col.key}">${escapeHTML(col.label)}</th>`
    ).join('');

    const bodyHTML = rows.map(row => {
        const cells = columns.map(col =>
            `<td class="${col.class || ''}">${cellRenderer(row, col)}</td>`
        ).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    return `<div class="card">
        <div class="card__header">
            <span class="card__title">${escapeHTML(title)}</span>
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
    </div>`;
}

/**
 * Renders a loading spinner.
 *
 * @param {string} [message="Loading"] - Text to display beside the spinner.
 * @returns {string} HTML string.
 */
export function renderLoading(message = 'Loading') {
    return `<div class="loading">${escapeHTML(message)}</div>`;
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
 * Formats an ISO date string to a relative time for recent dates
 * or a short date for older ones.
 *
 * @param {string|null|undefined} iso - ISO 8601 date string.
 * @returns {string} Formatted time string.
 */
export function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;

    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Renders a boolean value as a styled yes/no indicator.
 *
 * @param {any} val - Value to check for truthiness.
 * @returns {string} HTML string with appropriate CSS class.
 */
export function renderBool(val) {
    if (val === true || val === 1 || val === 'Yes') {
        return '<span class="bool-yes">Yes</span>';
    }
    return '<span class="bool-no">No</span>';
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
            <span class="stats-bar__label">${escapeHTML(item.label)}</span>
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
 * Attaches client-side sorting to all [data-sortable] tables within
 * a container element. Click a <th> to toggle asc/desc sort on that column.
 *
 * @param {HTMLElement} container - DOM element containing the tables.
 */
export function attachTableSort(container) {
    for (const table of container.querySelectorAll('[data-sortable]')) {
        const thead = table.querySelector('thead');
        const tbody = table.querySelector('tbody');
        if (!thead || !tbody) continue;

        thead.addEventListener('click', (e) => {
            const th = /** @type {HTMLElement|null} */ (e.target)?.closest('th');
            if (!th) return;

            const idx = Array.from(th.parentElement?.children || []).indexOf(th);
            const currentDir = th.getAttribute('data-sort-dir');
            const newDir = currentDir === 'asc' ? 'desc' : 'asc';

            // Clear all sort indicators
            for (const h of thead.querySelectorAll('th')) {
                h.removeAttribute('data-sort-dir');
            }
            th.setAttribute('data-sort-dir', newDir);

            // Sort rows
            const rows = Array.from(tbody.querySelectorAll('tr'));
            rows.sort((a, b) => {
                const aVal = a.children[idx]?.textContent?.trim() || '';
                const bVal = b.children[idx]?.textContent?.trim() || '';

                // Try numeric sort first
                const aNum = Number(aVal);
                const bNum = Number(bVal);
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return newDir === 'asc' ? aNum - bNum : bNum - aNum;
                }

                return newDir === 'asc'
                    ? aVal.localeCompare(bVal)
                    : bVal.localeCompare(aVal);
            });

            for (const row of rows) {
                tbody.appendChild(row);
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
