/**
 * @fileoverview Weekly mirror health check and repair (pdbfe-sync).
 *
 * Incremental ?since= syncs cannot see every upstream change: PeeringDB
 * hard-deletes some rows (pdb_rir_status removes netixlans with a QuerySet
 * .delete()) and some status changes do not advance `updated`. Over months
 * the mirror drifts: stale rows that upstream no longer lists, and rows
 * upstream lists that the mirror never received.
 *
 * Once a week, per entity: fetch upstream's id list (one request,
 * ?fields=id), diff it against D1, then repair — delete stale rows, fetch and
 * upsert missing ones (id__in, 150 per request), recount row_count — and make
 * a lot of noise about it: console.error per repaired table, and a full
 * report in _health_runs that the mirror-health GitHub workflow turns into a
 * job summary, an issue and a failed run.
 *
 * Guards (repair deletes data):
 *   - a failed or empty upstream id list skips the table (error);
 *   - deleting more than max(STALE_ABS, STALE_PCT of the table) is refused
 *     and reported as an alert — a truncated upstream response must never
 *     wipe the mirror;
 *   - at most MISSING_FETCH_CAP missing rows are fetched per table per run
 *     (alert if more);
 *   - upstream requests are spaced UPSTREAM_GAP_MS apart (published limits:
 *     40/min authenticated, ≥2s between queries).
 */

import { ENTITIES } from './entities.js';
import { upsertActiveRows, publishTasks } from './rows.js';

const API_BASE = 'https://www.peeringdb.com/api';
export const STALE_ABS = 50;
export const STALE_PCT = 0.02;
export const MISSING_FETCH_CAP = 3000;
const ID_IN_CHUNK = 150;
const UPSTREAM_GAP_MS = 3500;

/**
 * @typedef {{ tag: string, upstream: number|null, mirror: number|null,
 *   stale: number, missing: number, deleted: number[], inserted: number[],
 *   rowCount: number|null, action: 'ok'|'repaired'|'skipped'|'error',
 *   alerts: string[], error: string|null }} TableReport
 * @typedef {{ startedAt: string, finishedAt: string, repaired: number,
 *   errors: number, alerts: number, tables: TableReport[] }} HealthReport
 */

/**
 * Runs the check and repair over every entity and records the report.
 *
 * @param {PdbSyncEnv} env - Bindings (PDB, QUEUE, PEERINGDB_API_KEY).
 * @param {{ pauseMs?: number, fetchImpl?: typeof fetch, tags?: string[] }} [opts] - Test hooks
 *        (pacing, fetch, and a subset of entity tags; default: all entities).
 * @returns {Promise<HealthReport>}
 */
export async function runHealthCheck(env, opts = {}) {
    const pauseMs = opts.pauseMs ?? UPSTREAM_GAP_MS;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const headers = /** @type {Record<string, string>} */ ({ Accept: 'application/json', 'User-Agent': 'pdbfe-sync/1.0 (health)' });
    if (env.PEERINGDB_API_KEY) headers.Authorization = `Api-Key ${env.PEERINGDB_API_KEY}`;

    let lastRequest = 0;
    /** @param {string} path */
    const upstream = async (path) => {
        const wait = lastRequest + pauseMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastRequest = Date.now();
        const res = await fetchImpl(`${API_BASE}/${path}`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${path.split('?')[0]}`);
        const body = /** @type {{data?: Record<string, any>[]}} */ (await res.json());
        return body.data ?? [];
    };

    const startedAt = new Date().toISOString();
    /** @type {TableReport[]} */
    const tables = [];
    for (const [tag, meta] of Object.entries(ENTITIES)) {
        if (opts.tags && !opts.tags.includes(tag)) continue;
        // Sequential on purpose: one table at a time keeps upstream requests paced.
        tables.push(await checkTable(env, tag, meta, upstream)); // NOSONAR
    }

    /** @type {HealthReport} */
    const report = {
        startedAt,
        finishedAt: new Date().toISOString(),
        repaired: tables.filter((t) => t.action === 'repaired').length,
        errors: tables.filter((t) => t.action === 'error').length,
        alerts: tables.reduce((a, t) => a + t.alerts.length, 0),
        tables,
    };

    await env.PDB.prepare(
        'INSERT INTO "_health_runs" (started_at, finished_at, repaired, errors, alerts, report) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(report.startedAt, report.finishedAt, report.repaired, report.errors, report.alerts, JSON.stringify(report)).run();

    const verdict = report.repaired || report.errors || report.alerts ? 'ATTENTION' : 'clean';
    console.log(`[health] ${verdict}: ${report.repaired} table(s) repaired, ${report.errors} error(s), ${report.alerts} alert(s)`);
    return report;
}

/**
 * Checks and repairs one entity.
 *
 * @param {PdbSyncEnv} env
 * @param {string} tag
 * @param {Pick<EntityMeta, 'table' | 'fields'>} meta
 * @param {(path: string) => Promise<Record<string, any>[]>} upstream
 * @returns {Promise<TableReport>}
 */
async function checkTable(env, tag, meta, upstream) {
    const db = env.PDB;
    /** @type {TableReport} */
    const t = { tag, upstream: null, mirror: null, stale: 0, missing: 0, deleted: [], inserted: [], rowCount: null, action: 'ok', alerts: [], error: null };

    try {
        const upRows = await upstream(`${tag}?fields=id&depth=0&limit=0`);
        const upIds = new Set(upRows.map((r) => r.id).filter((id) => Number.isInteger(id) && id > 0));
        const mirrorRes = await db.prepare(`SELECT id FROM "${meta.table}"`).all();
        const mirrorIds = new Set((mirrorRes.results || []).map((r) => /** @type {number} */ (r.id)));
        t.upstream = upIds.size;
        t.mirror = mirrorIds.size;

        if (upIds.size === 0) throw new Error('upstream id list is empty — refusing to compare');

        const stale = [...mirrorIds].filter((id) => !upIds.has(id)).sort((a, b) => a - b);
        const missing = [...upIds].filter((id) => !mirrorIds.has(id)).sort((a, b) => a - b);
        t.stale = stale.length;
        t.missing = missing.length;

        t.deleted = await deleteStale(db, meta, stale, mirrorIds.size, t.alerts);
        const fetched = await fetchMissing(tag, missing, upstream, t.alerts);
        await upsertActiveRows(db, meta, fetched);
        t.inserted = fetched.map((r) => r.id);
        await publishTasks(env.QUEUE, tag, fetched, t.deleted);

        // Weekly recount, so the sync's incremental row_count cannot drift.
        const cnt = await db.prepare(`SELECT COUNT(*) AS cnt FROM "${meta.table}"`).first();
        t.rowCount = cnt ? /** @type {number} */ (cnt.cnt) : 0;
        await db.prepare('UPDATE "_sync_meta" SET row_count = ? WHERE entity = ?').bind(t.rowCount, tag).run();

        if (t.deleted.length || t.inserted.length) t.action = 'repaired';
    } catch (err) {
        t.action = 'error';
        t.error = /** @type {Error} */ (err).message;
    }
    logTable(t);
    return t;
}

/**
 * Deletes stale rows in one statement, unless there are suspiciously many
 * (a truncated upstream list must never wipe the mirror) — then alerts.
 *
 * @param {D1Database} db
 * @param {Pick<EntityMeta, 'table'>} meta
 * @param {number[]} stale - Ids present here but not upstream.
 * @param {number} mirrorSize - Rows in the table.
 * @param {string[]} alerts - Mutated.
 * @returns {Promise<number[]>} Ids deleted.
 */
async function deleteStale(db, meta, stale, mirrorSize, alerts) {
    if (stale.length === 0) return [];
    const limit = Math.max(STALE_ABS, Math.ceil(mirrorSize * STALE_PCT));
    if (stale.length > limit) {
        alerts.push(`${stale.length} stale rows exceed the safety limit of ${limit}; not deleting`);
        return [];
    }
    await db.prepare(`DELETE FROM "${meta.table}" WHERE id IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(stale)).run();
    return stale;
}

/**
 * Fetches missing rows from upstream by id (ID_IN_CHUNK per request, at most
 * MISSING_FETCH_CAP per run), returning the non-deleted ones.
 *
 * @param {string} tag
 * @param {number[]} missing - Ids upstream lists but the mirror lacks.
 * @param {(path: string) => Promise<Record<string, any>[]>} upstream - Paced fetcher.
 * @param {string[]} alerts - Mutated.
 * @returns {Promise<Record<string, any>[]>}
 */
async function fetchMissing(tag, missing, upstream, alerts) {
    const toFetch = missing.slice(0, MISSING_FETCH_CAP);
    if (missing.length > toFetch.length) {
        alerts.push(`${missing.length} missing rows; fetched the first ${toFetch.length} (cap ${MISSING_FETCH_CAP})`);
    }
    /** @type {Record<string, any>[]} */
    const fetched = [];
    for (let i = 0; i < toFetch.length; i += ID_IN_CHUNK) {
        const chunk = toFetch.slice(i, i + ID_IN_CHUNK);
        // Sequential on purpose: upstream requests must be paced (published rate limits).
        const rows = await upstream(`${tag}?id__in=${chunk.join(',')}&depth=0&limit=0`); // NOSONAR
        for (const r of rows) {
            if (Number.isInteger(r.id) && r.id > 0 && r.status !== 'deleted') fetched.push(r);
        }
    }
    return fetched;
}

/**
 * Logs a table's outcome loudly (console.error for anything but a clean pass).
 * @param {TableReport} t
 */
function logTable(t) {
    /** @param {number[]} xs */
    const sample = (xs) => `${xs.slice(0, 20).join(',')}${xs.length > 20 ? ',…' : ''}`;
    if (t.action === 'repaired') {
        console.error(`[health] REPAIRED ${t.tag}: deleted ${t.deleted.length} stale (${sample(t.deleted)}), inserted ${t.inserted.length} missing (${sample(t.inserted)})`);
    }
    for (const a of t.alerts) console.error(`[health] ALERT ${t.tag}: ${a}`);
    if (t.error) console.error(`[health] ${t.tag}: ${t.error}`);
}
