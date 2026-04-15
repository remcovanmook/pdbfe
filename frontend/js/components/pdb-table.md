# `<pdb-table>` Custom Element

Sortable, filterable, paginated data table for PeeringDB entity detail pages.
Replaces the legacy `renderTableCard()` + manual sort/filter/paging pipeline.

## Usage

```js
const el = document.createElement('pdb-table');
el.configure({
    title: 'Connections',
    filterable: true,
    filterPlaceholder: 'Filter by name or ASN...',
    columns: [
        { key: 'name',    label: 'Network' },
        { key: 'asn',     label: 'ASN', class: 'td-right', width: '80px' },
        { key: 'city',    label: 'City', maxWidth: '250px' },
    ],
    rows: data,
    cellRenderer: (row, col) => { /* return Node | {node, sortValue} */ },
});
container.appendChild(el);
```

## Column Definition (`TableColumn`)

| Property   | Type     | Description |
|------------|----------|-------------|
| `key`      | `string` | Column key — used in `cellRenderer` dispatch and hidden-column tracking. |
| `label`    | `string` | Display label (passed through `t()` for i18n). |
| `class`    | `string?` | CSS class applied to `<td>` elements (e.g., `td-right`, `td-mono`). |
| `width`    | `string?` | Fixed CSS width. Triggers `table-layout: fixed` on the whole table. |
| `maxWidth` | `string?` | Max-width for the column. Only works when no column defines `width`. |

### `width` vs `maxWidth`

- Tables where **any** column has `width` use `table-layout: fixed`. All widths are enforced; `maxWidth` is ignored by the browser in fixed layout.
- Tables where **no** column has `width` use auto layout. `maxWidth` constrains column growth while allowing content to shrink.

Typical pattern: use `width` for data-heavy tables (IP addresses, ASN) and `maxWidth` for simpler name+city+country tables.

## Features

### Sorting
Click any column header to sort. Click again to toggle asc/desc. Sort indicator arrow shown in the active header. Uses `sortValue` from `cellRenderer` when available for numeric sorting.

### Filtering
When `filterable: true`, a text input appears in the card header. Filters by substring match across all columns (using `cellRenderer` text output). Resets to page 1 on filter change. Badge count updates to show filtered row count.

### Pagination
Automatically enabled when row count exceeds `pageSize` (default: 50). Only the current page's rows are rendered to the DOM — the full dataset lives in memory. Prev/Next buttons with page indicator.

### Column Visibility Toggle
A ⚙ gear button appears when the table has >1 column. Opens a dropdown with checkboxes for each column except the first (which is always visible). Toggling hides/shows columns in both `<thead>` and `<tbody>`. Hidden columns are tracked in `_hiddenCols` Set by column key.

### Copy to Clipboard
Two buttons in the header: **CSV** and **MD**.

- **CSV**: RFC 4180 quoting (commas, quotes, newlines escaped). Header row + all filtered/sorted rows.
- **Markdown**: GitHub-Flavored Markdown table. Pipes escaped in cell values.

Both formats:
- Export **all** filtered/sorted rows (not just the current page)
- Respect column visibility (hidden columns excluded)
- Extract text from `cellRenderer` output via `_cellText()`

Falls back to `document.execCommand('copy')` in insecure contexts (non-HTTPS).

## Internal Architecture

```
configure(cfg)          → stores config
connectedCallback()     → builds DOM: card > header + table + paging
                        → calls _applyFilterAndSort() + _renderPage()

_rebuildThead()         → reconstructs <thead> from visible columns
_applyFilterAndSort()   → filters _processedRows, updates badge
_applySortToProcessedRows() → sorts in-place using cellRenderer sort keys
_renderPage()           → slices _processedRows for current page → DOM
_cellText(row, col)     → extracts plain text from cellRenderer result
_toCSV() / _toMarkdown()→ format export strings
_copyToClipboard(fmt)   → builds string + navigator.clipboard.writeText
```

### State

| Field | Type | Description |
|-------|------|-------------|
| `_config` | `TableConfig` | Immutable after `configure()` |
| `_processedRows` | `any[]` | Filtered + sorted row references |
| `_page` | `number` | Current 1-indexed page |
| `_sortColIdx` | `number` | Active sort column index (-1 = none) |
| `_sortDir` | `string` | `'asc'` or `'desc'` |
| `_filterQuery` | `string` | Lowercased filter text |
| `_hiddenCols` | `Set<string>` | Keys of hidden columns |
