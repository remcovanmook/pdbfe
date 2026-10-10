/**
 * @fileoverview Real-SQLite D1 stand-in for worker tests.
 *
 * Unit tests elsewhere mock D1 and never execute SQL. This helper loads
 * extracted/schema.sql into node:sqlite and wraps it in the subset of the D1
 * API the workers use, enforcing the two D1 limits that local SQLite does not
 * have and that have caused production 500s:
 *
 *   - at most 100 bound parameters per statement ("too many SQL variables")
 *   - an optional cap on the size of any returned string value, to simulate
 *     D1 failing large json_group_array payloads with SQLITE_TOOBIG or
 *     SQLITE_NOMEM (both seen in production).
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

/** D1's per-statement bound-parameter limit. */
export const D1_MAX_PARAMS = 100;

const SCHEMA = readFileSync(new URL('../../../extracted/schema.sql', import.meta.url), 'utf8');

/**
 * Registers a module loader so the rest worker can be imported under Node.
 * It imports non-JS assets the way wrangler bundles them (openapi.json
 * without an import attribute, .html/.css as text, fonts as binary). Call
 * before the first dynamic import of rest/index.js.
 */
export function registerAssetLoader() {
    register('data:text/javascript,' + encodeURIComponent(`
        import { readFileSync } from 'node:fs';
        const TEXT = ['.html', '.css', '.txt', '.md', '.svg'];
        export async function load(url, context, next) {
            if (!url.startsWith('file:') || /\\.[cm]?js$/.test(url)) return next(url, context);
            if (url.endsWith('.json')) {
                return next(url, { ...context, importAttributes: { type: 'json' } });
            }
            const buf = readFileSync(new URL(url));
            const source = TEXT.some(ext => url.endsWith(ext))
                ? 'export default ' + JSON.stringify(buf.toString('utf8'))
                : 'export default Uint8Array.from(atob(' + JSON.stringify(buf.toString('base64')) + '), c => c.charCodeAt(0)).buffer';
            return { format: 'module', source, shortCircuit: true };
        }
    `));
}

/**
 * Creates an in-memory database with the production schema and a D1 binding
 * over it.
 *
 * @param {{maxValueBytes?: number, oversizeError?: 'toobig'|'nomem'}} [opts] -
 *     maxValueBytes: fail when any returned string column exceeds this length,
 *     with D1's SQLITE_TOOBIG (default) or SQLITE_NOMEM error.
 * @returns {{sqlite: DatabaseSync, db: any, stats: {queries: number, payloadQueries: number, tooBig: number, sql: string[]}}}
 */
export function createSqliteD1({ maxValueBytes = Infinity, oversizeError = 'toobig' } = {}) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(SCHEMA);
    /** payloadQueries: json_group_array list/detail statements (`AS payload`); sql: every statement prepared. */
    const stats = { queries: 0, payloadQueries: 0, tooBig: 0, sql: /** @type {string[]} */ ([]) };
    const oversizeMessage = oversizeError === 'nomem'
        ? 'D1_ERROR: out of memory: SQLITE_NOMEM'
        : 'D1_ERROR: string or blob too big: SQLITE_TOOBIG';

    /** @param {any} row */
    const checkSize = (row) => {
        if (!row || maxValueBytes === Infinity) return;
        for (const v of Object.values(row)) {
            if (typeof v === 'string' && v.length > maxValueBytes) {
                stats.tooBig++;
                throw new Error(oversizeMessage);
            }
        }
    };

    const prepare = (/** @type {string} */ sql) => {
        const stmt = sqlite.prepare(sql);
        stats.sql.push(sql);
        const isPayload = sql.includes('AS payload');
        const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(sql);
        /** @param {any[]} args */
        const bound = (args) => {
            if (args.length > D1_MAX_PARAMS) {
                throw new Error(`D1_ERROR: too many SQL variables (${args.length} > ${D1_MAX_PARAMS}): SQLITE_ERROR`);
            }
            return {
                all: async () => {
                    stats.queries++;
                    // Count payload queries on both paths: the request-path D1
                    // wrapper (core/d1stats.js) serves first() through all().
                    if (isPayload) stats.payloadQueries++;
                    const results = stmt.all(...args);
                    for (const r of results) checkSize(r);
                    return { results, success: true, meta: {} };
                },
                first: async () => {
                    stats.queries++;
                    if (isPayload) stats.payloadQueries++;
                    const row = stmt.get(...args) ?? null;
                    checkSize(row);
                    return row;
                },
                run: async () => {
                    const info = stmt.run(...args);
                    return { success: true, meta: { changes: Number(info.changes) }, results: [] };
                },
                // D1 batch semantics: reads return rows, writes return meta.changes.
                // Batched reads count like all()/first() (requests may batch their
                // main query with the freshness poll, core/d1stats.js riders).
                exec: async () => (isRead && (stats.queries++, isPayload && stats.payloadQueries++, true)
                    ? { success: true, meta: {}, results: stmt.all(...args) }
                    : { success: true, meta: { changes: Number(stmt.run(...args).changes) }, results: [] }),
            };
        };
        return { ...bound([]), bind: (/** @type {any[]} */ ...args) => bound(args) };
    };

    const db = {
        withSession() { return this; },
        prepare,
        batch: async (/** @type {any[]} */ stmts) => {
            const out = [];
            for (const s of stmts) out.push(await s.exec());
            return out;
        },
    };
    return { sqlite, db, stats };
}

/** @returns {any} KV mock with no sessions (every caller is anonymous). */
export function mockKV() {
    return { get: async () => null, put: async () => {}, delete: async () => {} };
}

/** No-op ExecutionContext. */
export const mockCtx = /** @type {any} */ ({ waitUntil(/** @type {Promise<any>} */ p) { p.catch(() => {}); }, passThroughOnException() {} });

/**
 * Builds a worker env over a database.
 * @param {any} db - D1 binding from createSqliteD1.
 */
export function envFor(db) {
    return { PDB: db, SESSIONS: mockKV(), ADMIN_SECRET: 'x', PDBFE_VERSION: '0.0.0' };
}
