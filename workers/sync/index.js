/**
 * @fileoverview PeeringDB sync worker.
 * Runs on a cron schedule (every 15 minutes) and fetches incremental updates
 * from the PeeringDB API for each entity type. Uses the `since` parameter
 * (updated timestamp) to only fetch rows modified since the last sync.
 *
 * Architecture:
 *   - Reads `_sync_meta` for each entity's last sync timestamp.
 *   - Fetches `GET /api/{tag}?since={epoch}&depth=0` from PeeringDB.
 *   - Upserts returned rows into D1 via INSERT OR REPLACE.
 *   - Updates `_sync_meta` with the new timestamp and row count.
 *   - Handles deleted rows by checking status='deleted' and removing them.
 *
 * Environment bindings:
 *   PDB         - D1 database binding
 *   PDB_API_KEY - PeeringDB API key (secret)
 */

import { ENTITIES } from './entities.js';

const API_BASE = 'https://www.peeringdb.com/api';

/**
 * Builds an INSERT OR REPLACE statement for a single row.
 * Handles all value types: null, boolean, number, string, array/object.
 *
 * @param {string} table - D1 table name.
 * @param {string[]} columns - Column names.
 * @param {Record<string, any>} row - Row data from the API.
 * @returns {{ sql: string, params: any[] }} Parameterised statement.
 */
function buildUpsert(table, columns, row) {
    const placeholders = columns.map(() => '?').join(',');
    const sql = `INSERT OR REPLACE INTO "${table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})`;

    const params = columns.map(col => {
        const v = row[col];
        if (v === undefined || v === null) return null;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'number') return v;
        if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
        return String(v);
    });

    return { sql, params };
}

/**
 * Processes a single entity: fetch updates from PeeringDB since the last
 * sync timestamp, upsert into D1, and update _sync_meta.
 *
 * @param {D1Database} db - D1 database binding.
 * @param {string} tag - Entity tag (e.g. "net").
 * @param {EntityMeta} meta - Entity metadata (table, columns).
 * @param {string} apiKey - PeeringDB API key.
 * @returns {Promise<{ tag: string, updated: number, deleted: number, error: string }>}
 */
async function syncEntity(db, tag, meta, apiKey) {
    const result = { tag, updated: 0, deleted: 0, error: '' };

    try {
        // Get last sync time from _sync_meta
        const syncRow = await db.prepare(
            'SELECT last_sync FROM "_sync_meta" WHERE entity = ?'
        ).bind(tag).first();

        const lastSync = syncRow ? /** @type {number} */ (syncRow.last_sync) : 0;
        const now = Math.floor(Date.now() / 1000);

        // Fetch updates since last sync
        /** @type {Record<string, string>} */
        const headers = { 'Accept': 'application/json' };
        if (apiKey) {
            headers['Authorization'] = `Api-Key ${apiKey}`;
        }

        const url = `${API_BASE}/${tag}?since=${lastSync}&depth=0`;
        const response = await fetch(url, { headers });

        if (!response.ok) {
            result.error = `HTTP ${response.status}`;
            return result;
        }

        const data = /** @type {{ data: Record<string, any>[] }} */ (await response.json());
        const rows = data.data || [];

        if (rows.length === 0) {
            // Nothing changed — just update the timestamp
            await db.prepare(
                'INSERT OR REPLACE INTO "_sync_meta" (entity, last_sync, row_count, updated_at) VALUES (?, ?, (SELECT COALESCE(row_count, 0) FROM "_sync_meta" WHERE entity = ?), datetime(\'now\'))'
            ).bind(tag, now, tag).run();
            return result;
        }

        // Determine columns from first row
        const columns = Object.keys(rows[0]);

        // Separate active rows from deleted ones
        const activeRows = rows.filter(r => r.status !== 'deleted');
        const deletedRows = rows.filter(r => r.status === 'deleted');

        // Batch upsert active rows (D1 batch limit is 100 statements)
        const BATCH_SIZE = 50;
        for (let i = 0; i < activeRows.length; i += BATCH_SIZE) {
            const batch = activeRows.slice(i, i + BATCH_SIZE);
            const statements = batch.map(row => {
                const { sql, params } = buildUpsert(meta.table, columns, row);
                return db.prepare(sql).bind(...params);
            });
            await db.batch(statements);
        }
        result.updated = activeRows.length;

        // Delete removed rows
        if (deletedRows.length > 0) {
            const deleteStmts = deletedRows.map(row =>
                db.prepare(`DELETE FROM "${meta.table}" WHERE id = ?`).bind(row.id)
            );
            await db.batch(deleteStmts);
            result.deleted = deletedRows.length;
        }

        // Update sync metadata
        const totalCount = await db.prepare(
            `SELECT COUNT(*) as cnt FROM "${meta.table}"`
        ).first();
        const rowCount = totalCount ? /** @type {number} */ (totalCount.cnt) : 0;

        await db.prepare(
            'INSERT OR REPLACE INTO "_sync_meta" (entity, last_sync, row_count, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
        ).bind(tag, now, rowCount).run();

        return result;
    } catch (err) {
        result.error = /** @type {Error} */ (err).message;
        return result;
    }
}

export default {
    /**
     * Cron trigger handler. Syncs all entities sequentially to avoid
     * overwhelming the PeeringDB API with concurrent requests.
     *
     * @param {ScheduledEvent} event - The cron event.
     * @param {PdbSyncEnv} env - Environment bindings.
     * @param {ExecutionContext} ctx - Execution context.
     */
    async scheduled(event, env, ctx) {
        const apiKey = env.PEERINGDB_API_KEY || '';
        const results = [];

        for (const [tag, meta] of Object.entries(ENTITIES)) {
            const syncResult = await syncEntity(env.PDB, tag, meta, apiKey);
            results.push(syncResult);

            // Brief pause between entities to be nice to PeeringDB
            await new Promise(r => setTimeout(r, 200));
        }

        const summary = results.map(r =>
            `${r.tag}: +${r.updated} -${r.deleted}${r.error ? ` ERR:${r.error}` : ''}`
        ).join(', ');

        console.log(`[sync] ${new Date().toISOString()} ${summary}`);
    },

    /**
     * HTTP handler for manual sync trigger and status.
     * GET /sync/status — returns last sync times and row counts.
     * POST /sync/trigger — runs a full sync cycle.
     *
     * @param {Request} request - The inbound HTTP request.
     * @param {PdbSyncEnv} env - Environment bindings.
     * @param {ExecutionContext} ctx - Execution context.
     * @returns {Promise<Response>}
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/sync/status' && request.method === 'GET') {
            const rows = await env.PDB.prepare(
                'SELECT * FROM "_sync_meta" ORDER BY entity'
            ).all();
            return new Response(JSON.stringify({ data: rows.results }, null, 2), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (url.pathname === '/sync/trigger' && request.method === 'POST') {
            // Run sync in background, return immediately
            const promise = this.scheduled(
                /** @type {ScheduledEvent} */ ({ cron: 'manual', scheduledTime: Date.now() }),
                env, ctx
            );
            ctx.waitUntil(promise);
            return new Response(JSON.stringify({ status: 'sync triggered' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response('Not found', { status: 404 });
    }
};
