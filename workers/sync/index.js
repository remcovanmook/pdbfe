/**
 * @fileoverview PeeringDB sync worker (pdbfe-sync).
 *
 * Runs on a cron schedule (every 15 minutes) and fetches incremental updates
 * from the PeeringDB API for each entity type via the `?since=` parameter.
 *
 * This worker has a single responsibility: write API delta rows to D1 and
 * publish task messages to the pdbfe-tasks Queue. It has zero touch points
 * with Vectorize, R2, or Workers AI — all side-effect operations are
 * delegated to the pdbfe-async worker via the Queue.
 *
 * Queue messages published per sync cycle:
 *   embed  — for every active row of an embeddable entity type
 *   delete — for every row removed from D1
 *   logo   — for every active row with a non-empty logo field
 *
 * Messages are published BEFORE _sync_meta is advanced. This gives
 * at-least-once Queue delivery semantics: if Queue publish fails, lastSync
 * is not updated, and the next cron re-fetches and re-publishes. INSERT OR
 * REPLACE makes the D1 re-upsert idempotent. The async worker's D1 pre-checks
 * make duplicate message processing safe.
 *
 * Environment bindings:
 *   PDB   — D1 database
 *   QUEUE — pdbfe-tasks Queue producer (optional; sync operates without it)
 */

import { ENTITIES } from './entities.js';
import { parseURL } from '../core/utils.js';
import { upsertActiveRows, publishTasks } from './rows.js';
import { runHealthCheck } from './health.js';

export { buildUpsert, ensureColumns } from './rows.js';

const API_BASE = 'https://www.peeringdb.com/api';

/** Weekly health check cron: Sunday 03:07 UTC, off the quarter-hour sync slots. Must match wrangler-sync.toml. */
export const HEALTH_CRON = '7 3 * * 0';


/**
 * row_count after a sync run: previous count + net change when a previous
 * count exists; otherwise one full COUNT(*) to establish it.
 *
 * @param {D1Database} db
 * @param {string} table
 * @param {number|null} prevCount
 * @param {number} delta - New rows minus rows actually deleted.
 * @returns {Promise<number>}
 */
async function nextRowCount(db, table, prevCount, delta) {
    if (prevCount !== null) return Math.max(0, prevCount + delta);
    const total = await db.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).first();
    return total ? /** @type {number} */ (total.cnt) : 0;
}

/**
 * Processes a single entity: fetches updates from PeeringDB since last sync,
 * upserts active rows into D1, deletes removed rows, publishes Queue messages,
 * then advances lastSync in _sync_meta.
 *
 * Queue messages are published BEFORE _sync_meta is updated so that a publish
 * failure causes the next cron to re-fetch the same rows and retry. D1 upserts
 * are idempotent (INSERT OR REPLACE).
 *
 * @param {D1Database} db - D1 database binding.
 * @param {string} tag - Entity tag (e.g. "net").
 * @param {Pick<EntityMeta, 'table' | 'fields'>} meta - Entity metadata.
 * @param {string} apiKey - PeeringDB API key.
 * @param {Queue<AsyncTaskMessage>} [queue] - pdbfe-tasks Queue producer. Optional.
 * @returns {Promise<{ tag: string, updated: number, deleted: number, deletedIds: number[], error: string }>}
 */
export async function syncEntity(db, tag, meta, apiKey, queue) {
    const result = { tag, updated: 0, deleted: 0, deletedIds: /** @type {number[]} */ ([]), error: '' };

    try {
        const syncRow = await db.prepare(
            'SELECT last_sync, row_count FROM "_sync_meta" WHERE entity = ?'
        ).bind(tag).first();

        const lastSync = syncRow ? /** @type {number} */ (syncRow.last_sync) : 0;
        // Previous row count, maintained incrementally below; null when unknown
        // (no row yet or never counted), which triggers a one-off full count.
        const prevCount = syncRow && typeof syncRow.row_count === 'number' && syncRow.row_count > 0
            ? /** @type {number} */ (syncRow.row_count) : null;

        // Refuse to sync from epoch. Full datasets (e.g. ~300k netixlan rows)
        // exceed the 128MB isolate RAM limit. Bootstrap via the SQLite dump pipeline.
        if (lastSync === 0) {
            result.error = 'last_sync is 0 — initial bootstrap required via SQLite dump';
            return result;
        }

        // Lock in the timestamp BEFORE the network request so upstream updates
        // that land during the fetch are caught on the next cron run.
        const now = Math.floor(Date.now() / 1000);

        /** @type {Record<string, string>} */
        const headers = {
            'Accept':     'application/json',
            'User-Agent': 'pdbfe-sync/1.0',
        };
        if (apiKey) headers['Authorization'] = `Api-Key ${apiKey}`;

        // limit=0 disables PeeringDB's default 250-item pagination cap so that
        // any sync window with >250 changed rows is captured in one request.
        const url = `${API_BASE}/${tag}?since=${lastSync}&depth=0&limit=0`;
        const response = await fetch(url, { headers });

        if (!response.ok) {
            result.error = `HTTP ${response.status}`;
            return result;
        }

        const data = /** @type {{ data: Record<string, any>[] }} */ (await response.json());
        const rows = data.data || [];

        if (rows.length === 0) {
            await db.prepare(
                `INSERT OR REPLACE INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, ?, (SELECT COALESCE(row_count, 0) FROM "_sync_meta" WHERE entity = ?), datetime('now'), (SELECT COALESCE(NULLIF(last_modified_at, ''), 0) FROM "_sync_meta" WHERE entity = ?))`
            ).bind(tag, now, tag, tag).run();
            return result;
        }

        // Split active/deleted, dropping rows without a usable integer id — a
        // malformed upstream record would otherwise INSERT a null primary key
        // (a junk auto-rowid row) or DELETE/publish an `undefined` id.
        const activeRows = rows.filter(r => Number.isInteger(r.id) && r.id > 0 && r.status !== 'deleted');
        const deletedRows = rows.filter(r => Number.isInteger(r.id) && r.id > 0 && r.status === 'deleted');
        const skipped = rows.length - activeRows.length - deletedRows.length;
        if (skipped > 0) console.warn(`[sync] ${tag}: skipped ${skipped} row(s) with missing/invalid id`);

        // How many incoming active ids already exist, read BEFORE the upsert so
        // row_count can be advanced by the genuinely new rows. One json_each
        // probe reads only those ids — a COUNT(*) of the whole table instead
        // bills every row (66k for netixlan) on every run.
        let existingActive = 0;
        const activeIds = new Set(activeRows.map(r => r.id));
        if (prevCount !== null && activeIds.size > 0) {
            const ids = JSON.stringify([...activeIds]);
            const probe = await db.prepare(
                `SELECT COUNT(*) as cnt FROM "${meta.table}" WHERE id IN (SELECT value FROM json_each(?))`
            ).bind(ids).first();
            existingActive = probe ? /** @type {number} */ (probe.cnt) : 0;
        }

        await upsertActiveRows(db, meta, activeRows);
        result.updated = activeRows.length;

        let actuallyDeleted = 0;
        if (deletedRows.length > 0) {
            const deleteStmts = deletedRows.map(row =>
                db.prepare(`DELETE FROM "${meta.table}" WHERE id = ?`).bind(row.id)
            );
            const deleteResults = await db.batch(deleteStmts);
            // Upstream reports deletions of rows the mirror may never have had.
            for (const r of deleteResults || []) actuallyDeleted += Number(r?.meta?.changes ?? 0);
            result.deleted = deletedRows.length;
            result.deletedIds = deletedRows.map(row => row.id);
        }

        // ── Publish Queue messages ─────────────────────────────────────────────
        // Must happen BEFORE _sync_meta is advanced so that a Queue publish
        // failure causes the next cron to re-fetch and retry.
        await publishTasks(queue, tag, activeRows, result.deletedIds);

        // ── Advance lastSync ───────────────────────────────────────────────────
        // row_count: incremental when a previous count exists (new ids minus
        // rows actually deleted); a full count only to establish it once.
        const rowCount = await nextRowCount(db, meta.table, prevCount, activeIds.size - existingActive - actuallyDeleted);

        await db.prepare(
            'INSERT OR REPLACE INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, ?, ?, datetime(\'now\'), ?)'
        ).bind(tag, now, rowCount, now).run();

        return result;
    } catch (err) {
        result.error = /** @type {Error} */ (err).message;
        return result;
    }
}

/**
 * Validates a secret from the URL path against ADMIN_SECRET using constant-time
 * comparison to prevent timing side-channels.
 *
 * @param {PdbSyncEnv} env - Environment bindings.
 * @param {string} provided - The secret extracted from the URL.
 * @returns {boolean}
 */
function isValidSyncSecret(env, provided) {
    if (typeof env.ADMIN_SECRET !== 'string' || env.ADMIN_SECRET.length === 0) return false;
    if (provided.length !== env.ADMIN_SECRET.length) return false;
    const enc = new TextEncoder();
    return crypto.subtle.timingSafeEqual(enc.encode(provided), enc.encode(env.ADMIN_SECRET));
}

export default {
    /**
     * Cron trigger handler. Syncs all entities sequentially to avoid
     * overwhelming the PeeringDB API with concurrent requests.
     *
     * @param {ScheduledEvent} _event - The cron event.
     * @param {PdbSyncEnv} env - Environment bindings.
     * @param {ExecutionContext} _ctx - Execution context.
     */
    async scheduled(_event, env, _ctx) {
        if (_event.cron === HEALTH_CRON) {
            await runHealthCheck(env);
            return;
        }
        const apiKey = env.PEERINGDB_API_KEY || '';
        const queue  = env.QUEUE;
        const results = [];

        for (const [tag, meta] of Object.entries(ENTITIES)) {
            const syncResult = await syncEntity(env.PDB, tag, meta, apiKey, queue);
            results.push(syncResult);
            // Brief pause between entities to be a courteous API consumer.
            await new Promise(r => setTimeout(r, 200));
        }

        const summary = results.map(r => {
            const errSuffix = r.error ? ` ERR:${r.error}` : '';
            return `${r.tag}: +${r.updated} -${r.deleted}${errSuffix}`;
        }).join(', ');

        console.log(`[sync] ${new Date().toISOString()} ${summary}`);
    },

    /**
     * HTTP handler for manual sync trigger and status.
     *   GET  /sync/status             — returns last sync times and row counts.
     *   POST /sync/trigger.<secret>   — runs a full sync cycle (requires ADMIN_SECRET).
     *   GET  /sync/health             — latest weekly health check report.
     *   POST /sync/health.<secret>    — runs the health check now (requires ADMIN_SECRET).
     *
     * @param {Request} request - The inbound HTTP request.
     * @param {PdbSyncEnv} env - Environment bindings.
     * @param {ExecutionContext} ctx - Execution context.
     * @returns {Promise<Response>}
     */
    async fetch(request, env, ctx) {
        const { rawPath } = parseURL(request);

        if (rawPath === 'sync/status' && request.method === 'GET') {
            const rows = await env.PDB.prepare(
                'SELECT * FROM "_sync_meta" ORDER BY entity'
            ).all();
            return new Response(JSON.stringify({ data: rows.results }, null, 2), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Latest health check report (ids and counts only — no sensitive data).
        if (rawPath === 'sync/health' && request.method === 'GET') {
            const row = await env.PDB.prepare(
                'SELECT report FROM "_health_runs" ORDER BY id DESC LIMIT 1'
            ).first();
            return new Response(row ? /** @type {string} */ (row.report) : '{"error":"no health run yet"}', {
                status: row ? 200 : 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Run the health check now (same secret as the sync trigger).
        if (rawPath.startsWith('sync/health.') && request.method === 'POST') {
            if (!isValidSyncSecret(env, rawPath.slice('sync/health.'.length))) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            ctx.waitUntil(runHealthCheck(env));
            return new Response(JSON.stringify({ status: 'health check triggered' }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (rawPath.startsWith('sync/trigger.') && request.method === 'POST') {
            const secret = rawPath.slice('sync/trigger.'.length);
            if (!isValidSyncSecret(env, secret)) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            const promise = this.scheduled(
                /** @type {ScheduledEvent} */ ({ cron: 'manual', scheduledTime: Date.now() }),
                env, ctx
            );
            ctx.waitUntil(promise);
            return new Response(JSON.stringify({ status: 'sync triggered' }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response('Not found', { status: 404 });
    },
};
