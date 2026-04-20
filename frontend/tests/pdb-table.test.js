/**
 * @fileoverview Unit tests for pdb-table.js.
 *
 * Tests table sort, filter, paging boundary conditions, and the
 * CSV and Markdown export formatters. Tests operate at the class level —
 * `customElements.define` is mocked so the module can load under Node.
 * `connectedCallback` (which requires a real DOM) is not tested here;
 * that path is covered by the Playwright E2E suite.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDOM } from './helpers/mock-dom.js';

// ── Module load ───────────────────────────────────────────────────────────────

/** @type {any} Dynamically loaded PdbTable class prototype. */
let PdbTableProto;

before(async () => {
    createMockDOM();

    // pdb-table.js extends HTMLElement which doesn't exist in Node.
    // Stub it before the module loads so the class declaration doesn't throw.
    if (typeof globalThis.HTMLElement === 'undefined') {
        globalThis.HTMLElement = class HTMLElement {
            appendChild() {}
            querySelector() { return null; }
            querySelectorAll() { return []; }
            getAttribute() { return null; }
            setAttribute() {}
            addEventListener() {}
            contains() { return false; }
            get textContent() { return ''; }
            set textContent(_v) {}
        };
    }

    // _applySortToProcessedRows uses `rendered instanceof Node` to extract sort keys.
    // Stub the DOM Node global so instanceof checks work against our mock objects.
    if (typeof globalThis.Node === 'undefined') {
        globalThis.Node = class Node {};
    }

    // Capture the PdbTable class via the customElements.define spy.
    /** @type {any} */
    let capturedClass = null;
    globalThis.customElements = {
        define: (/** @type {string} */ _name, /** @type {any} */ cls) => {
            capturedClass = cls;
        },
    };

    await import('../js/components/pdb-table.js');
    PdbTableProto = capturedClass;
});

/**
 * Creates a minimal `PdbTable` instance with the given rows and a simple
 * text-only cellRenderer. Bypasses `connectedCallback` entirely.
 *
 * @param {any[]} rows - Data rows.
 * @param {string[]} [keys] - Column keys (defaults to the keys of rows[0]).
 * @returns {any} Configured PdbTable instance.
 */
function makeTable(rows, keys) {
    const colKeys = keys || (rows.length > 0 ? Object.keys(rows[0]) : ['name']);
    const columns = colKeys.map(k => ({ key: k, label: k }));

    const instance = new PdbTableProto();
    instance.configure({
        title: 'Test',
        columns,
        rows,
        /**
         * Returns a plain object with `sortValue` (for sort key extraction)
         * and `node` (for _cellText extraction). This avoids the `instanceof Node`
         * path in _applySortToProcessedRows and the DOM traversal in _cellText.
         *
         * @param {any} row
         * @param {{ key: string }} col
         * @returns {{ sortValue: string|number, node: { textContent: string } }}
         */
        cellRenderer(row, col) {
            const val = row[col.key] ?? '';
            return { sortValue: val, node: { textContent: String(val) } };
        },
    });

    // Manually bootstrap _processedRows (normally done in connectedCallback)
    instance._processedRows = rows.slice();
    instance._sortColIdx = -1;
    instance._sortDir = 'asc';
    instance._filterQuery = '';
    instance._hiddenCols = new Set();

    return instance;
}

// ── _totalPages ───────────────────────────────────────────────────────────────

describe('PdbTable._totalPages', () => {
    it('returns 1 for an empty table', () => {
        const t = makeTable([]);
        t._config.pageSize = 50;
        assert.equal(t._totalPages(), 1);
    });

    it('returns 1 when rows <= pageSize', () => {
        const rows = Array.from({ length: 50 }, (_, i) => ({ name: `R${i}` }));
        const t = makeTable(rows);
        t._config.pageSize = 50;
        t._processedRows = rows;
        assert.equal(t._totalPages(), 1);
    });

    it('returns 2 when rows = pageSize + 1', () => {
        const rows = Array.from({ length: 51 }, (_, i) => ({ name: `R${i}` }));
        const t = makeTable(rows);
        t._config.pageSize = 50;
        t._processedRows = rows;
        assert.equal(t._totalPages(), 2);
    });

    it('computes correct page count for arbitrary sizes', () => {
        const rows = Array.from({ length: 123 }, (_, i) => ({ name: `R${i}` }));
        const t = makeTable(rows);
        t._config.pageSize = 50;
        t._processedRows = rows;
        assert.equal(t._totalPages(), 3); // ceil(123/50) = 3
    });
});

// ── _applyFilterAndSort ───────────────────────────────────────────────────────

describe('PdbTable._applyFilterAndSort', () => {
    it('includes all rows when no filter query is set', () => {
        const rows = [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }];
        const t = makeTable(rows);
        t._applyFilterAndSort();
        assert.equal(t._processedRows.length, 3);
    });

    it('filters rows by case-insensitive substring match', () => {
        const rows = [{ name: 'Cloudflare' }, { name: 'Amazon' }, { name: 'cloud9' }];
        const t = makeTable(rows);
        t._filterQuery = 'cloud';
        t._applyFilterAndSort();

        assert.equal(t._processedRows.length, 2);
        assert.ok(t._processedRows.every((/** @type {any} */ r) =>
            r.name.toLowerCase().includes('cloud')));
    });

    it('returns empty array when no rows match the filter', () => {
        const rows = [{ name: 'Alpha' }, { name: 'Beta' }];
        const t = makeTable(rows);
        t._filterQuery = 'zzz';
        t._applyFilterAndSort();
        assert.equal(t._processedRows.length, 0);
    });
});

// ── _applySortToProcessedRows ─────────────────────────────────────────────────

describe('PdbTable._applySortToProcessedRows', () => {
    it('sorts strings ascending', () => {
        const rows = [{ name: 'Gamma' }, { name: 'Alpha' }, { name: 'Beta' }];
        const t = makeTable(rows, ['name']);
        t._sortColIdx = 0;
        t._sortDir = 'asc';
        t._applyFilterAndSort();
        t._applySortToProcessedRows();

        assert.equal(t._processedRows[0].name, 'Alpha');
        assert.equal(t._processedRows[1].name, 'Beta');
        assert.equal(t._processedRows[2].name, 'Gamma');
    });

    it('sorts strings descending', () => {
        const rows = [{ name: 'Alpha' }, { name: 'Gamma' }, { name: 'Beta' }];
        const t = makeTable(rows, ['name']);
        t._sortColIdx = 0;
        t._sortDir = 'desc';
        t._applyFilterAndSort();
        t._applySortToProcessedRows();

        assert.equal(t._processedRows[0].name, 'Gamma');
        assert.equal(t._processedRows[2].name, 'Alpha');
    });

    it('sorts numbers correctly (numeric, not lexicographic)', () => {
        const rows = [{ speed: 1000 }, { speed: 100 }, { speed: 10000 }];
        const t = makeTable(rows, ['speed']);
        t._sortColIdx = 0;
        t._sortDir = 'asc';
        t._applyFilterAndSort();
        t._applySortToProcessedRows();

        assert.equal(t._processedRows[0].speed, 100);
        assert.equal(t._processedRows[1].speed, 1000);
        assert.equal(t._processedRows[2].speed, 10000);
    });
});

// ── _toCSV ────────────────────────────────────────────────────────────────────

describe('PdbTable._toCSV', () => {
    it('produces a header row followed by data rows', () => {
        const rows = [{ name: 'Alpha', asn: 1001 }];
        const t = makeTable(rows, ['name', 'asn']);
        t._processedRows = rows;
        t._hiddenCols = new Set();

        const csv = t._toCSV(['name', 'asn'], rows, t._config.columns);
        const lines = csv.split('\n');
        assert.equal(lines[0], 'name,asn');
        assert.equal(lines[1], 'Alpha,1001');
    });

    it('wraps values containing commas in double-quotes', () => {
        const rows = [{ name: 'Foo, Inc', asn: 100 }];
        const t = makeTable(rows, ['name', 'asn']);
        t._processedRows = rows;

        const csv = t._toCSV(['name', 'asn'], rows, t._config.columns);
        assert.ok(csv.includes('"Foo, Inc"'), 'Value with comma should be quoted');
    });

    it('escapes double quotes by doubling them', () => {
        const rows = [{ name: 'Say "hello"', asn: 200 }];
        const t = makeTable(rows, ['name', 'asn']);
        t._processedRows = rows;

        const csv = t._toCSV(['name', 'asn'], rows, t._config.columns);
        assert.ok(csv.includes('"Say ""hello"""'), 'Internal quotes should be doubled');
    });

    it('excludes hidden columns', () => {
        const rows = [{ name: 'Alpha', secret: 'hidden', asn: 300 }];
        const allCols = [
            { key: 'name', label: 'name' },
            { key: 'secret', label: 'secret' },
            { key: 'asn', label: 'asn' },
        ];
        const t = makeTable(rows, ['name', 'secret', 'asn']);
        t._processedRows = rows;
        t._hiddenCols = new Set(['secret']);

        const visibleCols = allCols.filter(c => !t._hiddenCols.has(c.key));
        const csv = t._toCSV(visibleCols.map(c => c.label), rows, visibleCols);
        assert.ok(!csv.includes('secret'), 'Hidden column should be excluded');
        assert.ok(!csv.includes('hidden'), 'Hidden column value should be excluded');
    });
});

// ── _toMarkdown ───────────────────────────────────────────────────────────────

describe('PdbTable._toMarkdown', () => {
    it('produces a valid Markdown table', () => {
        const rows = [{ name: 'Alpha', asn: 1001 }];
        const t = makeTable(rows, ['name', 'asn']);
        t._processedRows = rows;

        const md = t._toMarkdown(['name', 'asn'], rows, t._config.columns);
        const lines = md.split('\n');

        assert.equal(lines[0], '| name | asn |');
        assert.equal(lines[1], '| --- | --- |');
        assert.ok(lines[2].includes('Alpha'));
        assert.ok(lines[2].includes('1001'));
    });

    it('escapes pipe characters in cell values', () => {
        const rows = [{ name: 'A | B', asn: 0 }];
        const t = makeTable(rows, ['name', 'asn']);
        t._processedRows = rows;

        const md = t._toMarkdown(['name', 'asn'], rows, t._config.columns);
        assert.ok(md.includes(String.raw`A \| B`), 'Pipe in cell value should be escaped');
    });
});
