/**
 * @fileoverview <pdb-table> custom element.
 *
 * A sortable, filterable, paginated data table that self-initializes
 * when connected to the DOM. Replaces the renderTableCard() +
 * attachTableSort() + attachTableFilter() + attachTablePaging()
 * pipeline from render.js.
 *
 * Usage:
 *   const el = document.createElement('pdb-table');
 *   el.configure({
 *       title: 'Peers',
 *       columns: [{key: 'name', label: 'Network'}, ...],
 *       rows: [...],
 *       cellRenderer: (row, col) => Node | {node, sortValue},
 *       filterable: true,
 *       filterPlaceholder: 'Filter by name...',
 *       pageSize: 50,
 *   });
 *   container.appendChild(el);
 *
 * The element builds its DOM in connectedCallback() using the config
 * set via configure(). Sorting, filtering, and paging are handled
 * internally — no external attachment functions are needed.
 *
 * Paging uses a slice-based approach: the full row dataset lives in
 * JS memory, and only the currently visible page is rendered into
 * the <tbody>. This scales to tens of thousands of rows without
 * touching the DOM for hidden rows.
 */

import { t } from '../i18n.js';

/** Default number of rows per page. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * @typedef {Object} TableColumn
 * @property {string} key - Column key used in cellRenderer dispatch.
 * @property {string} label - Display label (passed through t() for i18n).
 * @property {string} [class] - Optional CSS class for <td> elements.
 * @property {string} [width] - Optional fixed CSS width (enables table-layout: fixed).
 * @property {string} [maxWidth] - Optional max-width (used when table-layout is auto).
 */

/**
 * @typedef {Object} CellResult
 * @property {Node} node - DOM node for the cell content.
 * @property {string|number} sortValue - Value used for sorting.
 */

/**
 * @typedef {Object} TableConfig
 * @property {string} title - Card header title.
 * @property {TableColumn[]} columns - Column definitions.
 * @property {any[]} rows - Data rows.
 * @property {function(any, TableColumn): (Node|CellResult)} cellRenderer
 *     Returns a DOM node for a cell. May return a plain Node or an object
 *     with `node` and `sortValue` for sortable cells.
 * @property {boolean} [filterable] - Show a filter input.
 * @property {string} [filterPlaceholder] - Placeholder text for filter input.
 * @property {number} [pageSize] - Rows per page (default: DEFAULT_PAGE_SIZE).
 */

class PdbTable extends HTMLElement {
    constructor() {
        super();
        /** @type {TableConfig|null} */
        this._config = null;

        /** @type {any[]} Filtered + sorted row dataset (references into config.rows). */
        this._processedRows = [];

        /** @type {number} Current 1-indexed page number. */
        this._page = 1;

        /** @type {number} Active sort column index, or -1 for none. */
        this._sortColIdx = -1;

        /** @type {string} Sort direction: 'asc' or 'desc'. */
        this._sortDir = 'asc';

        /** @type {string} Current filter query (lowercased). */
        this._filterQuery = '';

        /** @type {Set<string>} Keys of hidden columns. */
        this._hiddenCols = new Set();

        // DOM references set during build
        /** @type {HTMLTableSectionElement|null} */
        this._tbody = null;
        /** @type {HTMLTableSectionElement|null} */
        this._thead = null;
        /** @type {HTMLElement|null} */
        this._pagingDiv = null;
        /** @type {HTMLSpanElement|null} */
        this._pageNumSpan = null;
        /** @type {HTMLSpanElement|null} */
        this._pageTotalSpan = null;
        /** @type {HTMLButtonElement|null} */
        this._prevBtn = null;
        /** @type {HTMLButtonElement|null} */
        this._nextBtn = null;
        /** @type {HTMLSpanElement|null} */
        this._badgeSpan = null;
    }

    /**
     * Sets the table configuration. Must be called before the element
     * is connected to the DOM (i.e., before appendChild).
     *
     * @param {TableConfig} config - Table configuration object.
     */
    configure(config) {
        this._config = config;
    }

    /**
     * Called by the browser when the element is inserted into the DOM.
     * Builds the full table structure and initializes sort/filter/paging.
     */
    connectedCallback() {
        if (!this._config) return;

        const cfg = this._config;
        const pageSize = cfg.pageSize || DEFAULT_PAGE_SIZE;

        // ── Card wrapper ─────────────────────────────────────────
        const card = document.createElement('div');
        card.className = 'card';

        // ── Header ───────────────────────────────────────────────
        const header = document.createElement('div');
        header.className = 'card__header';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'card__title';
        titleSpan.textContent = t(cfg.title);
        header.appendChild(titleSpan);

        const headerRight = document.createElement('div');
        headerRight.style.cssText = 'display:flex;align-items:center;gap:var(--space-sm)';

        // Filter input
        if (cfg.filterable) {
            const filterWrap = document.createElement('div');
            filterWrap.className = 'table-filter';

            const filterInput = document.createElement('input');
            filterInput.type = 'text';
            filterInput.className = 'table-filter__input';
            filterInput.placeholder = cfg.filterPlaceholder || t('Filter...');
            filterInput.addEventListener('input', () => {
                this._filterQuery = filterInput.value.toLowerCase();
                this._applyFilterAndSort();
                this._page = 1;
                this._renderPage();
            });
            filterWrap.appendChild(filterInput);
            headerRight.appendChild(filterWrap);
        }

        // Column visibility toggle (only if >1 column)
        if (cfg.columns.length > 1) {
            const colToggle = document.createElement('div');
            colToggle.className = 'col-toggle';

            const colBtn = document.createElement('button');
            colBtn.className = 'col-toggle__btn';
            colBtn.title = t('Toggle columns');
            colBtn.textContent = '⚙';
            colBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                colMenu.classList.toggle('is-open');
            });
            colToggle.appendChild(colBtn);

            const colMenu = document.createElement('div');
            colMenu.className = 'col-toggle__menu';

            // Skip the first column (always visible)
            for (let i = 1; i < cfg.columns.length; i++) {
                const col = cfg.columns[i];
                const label = document.createElement('label');
                label.className = 'col-toggle__item';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                cb.addEventListener('change', () => {
                    if (cb.checked) {
                        this._hiddenCols.delete(col.key);
                    } else {
                        this._hiddenCols.add(col.key);
                    }
                    this._rebuildThead();
                    this._renderPage();
                });

                label.appendChild(cb);
                label.appendChild(document.createTextNode(` ${t(col.label)}`));
                colMenu.appendChild(label);
            }

            colToggle.appendChild(colMenu);
            headerRight.appendChild(colToggle);

            // Close menu on outside click
            document.addEventListener('click', (e) => {
                if (!colToggle.contains(/** @type {Node} */ (e.target))) {
                    colMenu.classList.remove('is-open');
                }
            });
        }

        // Copy-to-clipboard buttons
        const csvBtn = document.createElement('button');
        csvBtn.className = 'col-toggle__btn';
        csvBtn.title = t('Copy as CSV');
        csvBtn.textContent = 'CSV';
        csvBtn.style.fontSize = '0.625rem';
        csvBtn.style.fontWeight = '600';
        csvBtn.addEventListener('click', () => this._copyToClipboard('csv'));
        headerRight.appendChild(csvBtn);

        const mdBtn = document.createElement('button');
        mdBtn.className = 'col-toggle__btn';
        mdBtn.title = t('Copy as Markdown');
        mdBtn.textContent = 'MD';
        mdBtn.style.fontSize = '0.625rem';
        mdBtn.style.fontWeight = '600';
        mdBtn.addEventListener('click', () => this._copyToClipboard('md'));
        headerRight.appendChild(mdBtn);

        // Count badge
        this._badgeSpan = document.createElement('span');
        this._badgeSpan.className = 'card__badge';
        this._badgeSpan.textContent = String(cfg.rows.length);
        headerRight.appendChild(this._badgeSpan);

        header.appendChild(headerRight);
        card.appendChild(header);

        // ── Table ────────────────────────────────────────────────
        const tableWrap = document.createElement('div');
        tableWrap.className = 'data-table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table';

        // Enable table-layout: fixed only when columns define explicit widths.
        // Without explicit widths, auto layout is used so max-width works.
        if (cfg.columns.some(c => c.width)) {
            table.style.tableLayout = 'fixed';
        }

        // Thead
        this._thead = document.createElement('thead');
        this._rebuildThead();
        table.appendChild(this._thead);

        // Tbody (rows are rendered via _renderPage)
        this._tbody = document.createElement('tbody');
        table.appendChild(this._tbody);

        tableWrap.appendChild(table);
        card.appendChild(tableWrap);

        // ── Paging ───────────────────────────────────────────────
        const needsPaging = cfg.rows.length > pageSize;
        if (needsPaging) {
            this._pagingDiv = document.createElement('div');
            this._pagingDiv.className = 'table-paging';

            this._prevBtn = document.createElement('button');
            this._prevBtn.className = 'table-paging__btn';
            this._prevBtn.textContent = `\u2190 ${t('Prev')}`;
            this._prevBtn.disabled = true;
            this._prevBtn.addEventListener('click', () => {
                if (this._page > 1) {
                    this._page--;
                    this._renderPage();
                }
            });

            const infoSpan = document.createElement('span');
            infoSpan.className = 'table-paging__info';
            this._pageNumSpan = document.createElement('span');
            this._pageTotalSpan = document.createElement('span');
            infoSpan.append(
                t('Page') + ' ',
                this._pageNumSpan,
                ' / ',
                this._pageTotalSpan
            );

            this._nextBtn = document.createElement('button');
            this._nextBtn.className = 'table-paging__btn';
            this._nextBtn.textContent = `${t('Next')} \u2192`;
            this._nextBtn.addEventListener('click', () => {
                const totalPages = this._totalPages();
                if (this._page < totalPages) {
                    this._page++;
                    this._renderPage();
                }
            });

            this._pagingDiv.append(this._prevBtn, infoSpan, this._nextBtn);
            card.appendChild(this._pagingDiv);
        }

        this.appendChild(card);

        // ── Initial render ───────────────────────────────────────
        this._applyFilterAndSort();

        // Default sort: first column ascending
        if (cfg.columns.length > 0) {
            this._sortColIdx = 0;
            this._sortDir = 'asc';
            const firstTh = this._thead?.querySelector('th');
            if (firstTh) firstTh.dataset.sortDir = 'asc';
            this._applySortToProcessedRows();
        }

        this._renderPage();
    }

    /**
     * Returns the configured page size.
     * @returns {number}
     */
    _pageSize() {
        return this._config?.pageSize || DEFAULT_PAGE_SIZE;
    }

    /**
     * Returns visible columns (excludes hidden ones).
     * @returns {TableColumn[]}
     */
    _visibleColumns() {
        return this._config?.columns.filter(c => !this._hiddenCols.has(c.key)) || [];
    }

    /**
     * Rebuilds the thead row based on current column visibility.
     * Preserves sort direction indicator on the active sort column.
     */
    _rebuildThead() {
        const cfg = this._config;
        if (!cfg || !this._thead) return;

        const headerRow = document.createElement('tr');
        cfg.columns.forEach((col, idx) => {
            if (this._hiddenCols.has(col.key)) return;
            const th = document.createElement('th');
            th.textContent = t(col.label);
            th.dataset.sortKey = col.key;
            th.style.cursor = 'pointer';
            if (col.width) th.style.width = col.width;
            if (col.maxWidth) th.style.maxWidth = col.maxWidth;
            if (idx === this._sortColIdx) th.dataset.sortDir = this._sortDir;
            th.addEventListener('click', () => this._onHeaderClick(idx));
            headerRow.appendChild(th);
        });
        this._thead.replaceChildren(headerRow);
    }

    /**
     * Returns the total number of pages based on filtered row count.
     * @returns {number}
     */
    _totalPages() {
        return Math.max(1, Math.ceil(this._processedRows.length / this._pageSize()));
    }

    /**
     * Handles a click on a column header. Toggles sort direction
     * if the same column, else sorts ascending on the new column.
     *
     * @param {number} colIdx - Column index that was clicked.
     */
    _onHeaderClick(colIdx) {
        if (!this._thead) return;

        // Determine new direction
        if (this._sortColIdx === colIdx) {
            this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this._sortColIdx = colIdx;
            this._sortDir = 'asc';
        }

        // Update visual indicators
        for (const th of this._thead.querySelectorAll('th')) {
            delete th.dataset.sortDir;
        }
        // Find the th for this colIdx among visible headers
        const visibleThs = this._thead.querySelectorAll('th');
        const cfg = this._config;
        if (cfg) {
            let visIdx = 0;
            for (let i = 0; i < cfg.columns.length; i++) {
                if (this._hiddenCols.has(cfg.columns[i].key)) continue;
                if (i === colIdx) {
                    if (visibleThs[visIdx]) visibleThs[visIdx].dataset.sortDir = this._sortDir;
                    break;
                }
                visIdx++;
            }
        }

        this._applySortToProcessedRows();
        this._page = 1;
        this._renderPage();
    }

    /**
     * Filters the full row set based on the current filter query.
     * Filtering works by rendering each row to text via cellRenderer
     * and checking for substring match.
     */
    _applyFilterAndSort() {
        const cfg = this._config;
        if (!cfg) return;

        if (this._filterQuery) {
            this._processedRows = cfg.rows.filter(row => {
                // Build text representation for filtering
                const text = cfg.columns.map(col => {
                    const rendered = cfg.cellRenderer(row, col);
                    if (rendered instanceof Node) {
                        return rendered.textContent || '';
                    }
                    if (typeof rendered === 'object' && rendered !== null && 'node' in rendered) {
                        return rendered.node.textContent || '';
                    }
                    return '';
                }).join(' ').toLowerCase();
                return text.includes(this._filterQuery);
            });
        } else {
            this._processedRows = cfg.rows.slice();
        }

        // Update badge with filtered count
        if (this._badgeSpan) {
            this._badgeSpan.textContent = String(this._processedRows.length);
        }

        // Re-apply current sort
        if (this._sortColIdx >= 0) {
            this._applySortToProcessedRows();
        }
    }

    /**
     * Sorts _processedRows in place by the current sort column and direction.
     * Extracts sort values by calling cellRenderer for the sort column.
     */
    _applySortToProcessedRows() {
        const cfg = this._config;
        if (!cfg || this._sortColIdx < 0) return;

        const col = cfg.columns[this._sortColIdx];
        const dir = this._sortDir;

        // Pre-compute sort keys to avoid calling cellRenderer during comparisons
        /** @type {Map<any, string|number>} */
        const sortKeys = new Map();
        for (const row of this._processedRows) {
            const rendered = cfg.cellRenderer(row, col);
            let key;
            if (rendered instanceof Node) {
                key = rendered.textContent?.trim() || '';
            } else if (typeof rendered === 'object' && rendered !== null && 'sortValue' in rendered) {
                key = rendered.sortValue;
            } else if (typeof rendered === 'object' && rendered !== null && 'node' in rendered) {
                key = rendered.node.textContent?.trim() || '';
            } else {
                key = '';
            }
            sortKeys.set(row, key);
        }

        this._processedRows.sort((a, b) => {
            const aVal = sortKeys.get(a) ?? '';
            const bVal = sortKeys.get(b) ?? '';

            const aNum = Number(aVal);
            const bNum = Number(bVal);
            if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
                return dir === 'asc' ? aNum - bNum : bNum - aNum;
            }

            const aStr = String(aVal);
            const bStr = String(bVal);
            return dir === 'asc'
                ? aStr.localeCompare(bStr)
                : bStr.localeCompare(aStr);
        });
    }

    /**
     * Renders the currently visible page of rows into the <tbody>.
     * Only the rows for the current page are added to the DOM — all
     * others exist only as data in _processedRows. This makes paging
     * O(pageSize) instead of O(totalRows).
     */
    _renderPage() {
        const cfg = this._config;
        if (!cfg || !this._tbody) return;

        const pageSize = this._pageSize();
        const totalPages = this._totalPages();
        const safePage = Math.max(1, Math.min(this._page, totalPages));
        this._page = safePage;

        const start = (safePage - 1) * pageSize;
        const end = Math.min(start + pageSize, this._processedRows.length);

        // Build the visible rows as a DocumentFragment (single DOM write)
        const frag = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
            const row = this._processedRows[i];
            const tr = document.createElement('tr');

            for (const col of cfg.columns) {
                if (this._hiddenCols.has(col.key)) continue;
                const td = document.createElement('td');
                if (col.class) td.className = col.class;
                if (col.maxWidth) {
                    td.style.maxWidth = col.maxWidth;
                    td.style.overflow = 'hidden';
                    td.style.textOverflow = 'ellipsis';
                    td.style.whiteSpace = 'nowrap';
                }

                const rendered = cfg.cellRenderer(row, col);
                if (rendered instanceof Node) {
                    td.appendChild(rendered);
                } else if (typeof rendered === 'object' && rendered !== null && 'node' in rendered) {
                    td.appendChild(rendered.node);
                    if (rendered.sortValue !== undefined) {
                        td.dataset.sortValue = String(rendered.sortValue);
                    }
                }

                tr.appendChild(td);
            }

            frag.appendChild(tr);
        }

        // Single DOM mutation: replace all tbody children
        this._tbody.replaceChildren(frag);

        // Update paging controls
        if (this._pageNumSpan) this._pageNumSpan.textContent = String(safePage);
        if (this._pageTotalSpan) this._pageTotalSpan.textContent = String(totalPages);
        if (this._prevBtn) this._prevBtn.disabled = safePage <= 1;
        if (this._nextBtn) this._nextBtn.disabled = safePage >= totalPages;
    }
    /**
     * Extracts the text content from a cellRenderer result.
     *
     * @param {any} row - Data row.
     * @param {TableColumn} col - Column definition.
     * @returns {string} Plain text value for the cell.
     */
    _cellText(row, col) {
        const cfg = this._config;
        if (!cfg) return '';
        const rendered = cfg.cellRenderer(row, col);
        if (rendered instanceof Node) return rendered.textContent?.trim() || '';
        if (typeof rendered === 'object' && rendered !== null && 'node' in rendered) {
            return rendered.node.textContent?.trim() || '';
        }
        return '';
    }

    /**
     * Builds a formatted string from the current filtered/sorted rows
     * and visible columns, then copies it to the clipboard.
     * Shows a brief visual confirmation on the clicked button.
     *
     * @param {'csv'|'md'} format - Output format.
     */
    async _copyToClipboard(format) {
        const cfg = this._config;
        if (!cfg) return;

        const cols = this._visibleColumns();
        const headers = cols.map(c => t(c.label));
        const rows = this._processedRows;

        let output;
        if (format === 'csv') {
            output = this._toCSV(headers, rows, cols);
        } else {
            output = this._toMarkdown(headers, rows, cols);
        }

        try {
            await navigator.clipboard.writeText(output);
        } catch {
            // Fallback for insecure contexts
            const ta = document.createElement('textarea');
            ta.value = output;
            ta.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
    }

    /**
     * Formats rows as CSV text. Values containing commas, quotes, or
     * newlines are wrapped in double-quotes with internal quotes escaped.
     *
     * @param {string[]} headers - Column header labels.
     * @param {any[]} rows - Data rows.
     * @param {TableColumn[]} cols - Visible column definitions.
     * @returns {string} CSV string.
     */
    _toCSV(headers, rows, cols) {
        const escape = (/** @type {string} */ v) => {
            if (v.includes(',') || v.includes('"') || v.includes('\n')) {
                return `"${v.replaceAll('"', '""')}"`;
            }
            return v;
        };
        const lines = [headers.map(escape).join(',')];
        for (const row of rows) {
            lines.push(cols.map(col => escape(this._cellText(row, col))).join(','));
        }
        return lines.join('\n');
    }

    /**
     * Formats rows as a Markdown table. Pipes are escaped in cell values.
     *
     * @param {string[]} headers - Column header labels.
     * @param {any[]} rows - Data rows.
     * @param {TableColumn[]} cols - Visible column definitions.
     * @returns {string} Markdown table string.
     */
    _toMarkdown(headers, rows, cols) {
        const escape = (/** @type {string} */ v) => v.replaceAll('|', '\\|');
        const headerLine = `| ${headers.map(escape).join(' | ')} |`;
        const sepLine = `| ${headers.map(() => '---').join(' | ')} |`;
        const dataLines = rows.map(row =>
            `| ${cols.map(col => escape(this._cellText(row, col))).join(' | ')} |`
        );
        return [headerLine, sepLine, ...dataLines].join('\n');
    }
}

customElements.define('pdb-table', PdbTable);
