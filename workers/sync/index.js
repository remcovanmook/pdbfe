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

import { ENTITIES, VECTOR_ENTITY_TAGS } from './entities.js';
import { parseURL } from '../core/utils.js';

const API_BASE = 'https://www.peeringdb.com/api';


/**
 * Coerces a single API field value to a D1-compatible SQL parameter.
 *
 * Django CharField(blank=True, null=False) stores "" not NULL. Coerce to ""
 * for NOT NULL string columns to satisfy D1 schema constraints and match
 * upstream behaviour.
 *
 * @param {string} col - Column name.
 * @param {any} v - Raw value from the API row.
 * @param {Set<string>} notNullStrings - Column names that are NOT NULL strings.
 * @returns {string|number|null} D1-compatible parameter value.
 */
function coerceValue(col, v, notNullStrings) {
    if (v === undefined || v === null) {
        return notNullStrings.has(col) ? '' : null;
    }
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v;
    if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

/**
 * Builds an INSERT OR REPLACE statement for a single row.
 *
 * For NOT NULL string columns, null/undefined values from the API are coerced
 * to empty string ("") to match Django's CharField convention and prevent D1
 * NOT NULL constraint violations.
 *
 * @param {string} table - D1 table name.
 * @param {string[]} columns - Column names.
 * @param {Record<string, any>} row - Row data from the API.
 * @param {Set<string>} notNullStrings - Column names that are NOT NULL strings.
 * @returns {{ sql: string, params: any[] }} Parameterised statement.
 */
export function buildUpsert(table, columns, row, notNullStrings) {
    const placeholders = columns.map(() => '?').join(',');
    const quotedCols = columns.map(c => `"${c}"`).join(',');
    const sql = `INSERT OR REPLACE INTO "${table}" (${quotedCols}) VALUES (${placeholders})`;
    const params = columns.map(col => coerceValue(col, row[col], notNullStrings));
    return { sql, params };
}

/**
 * Ensures all columns from the API response exist in the D1 table.
 *
 * If the upstream PeeringDB API adds new fields, this auto-evolves the schema
 * by running ALTER TABLE ADD COLUMN for each missing one. New columns are
 * added as nullable TEXT. Rejects column names that don't look like valid SQL
 * identifiers to prevent injection via compromised upstream JSON keys.
 *
 * @param {D1Database} db - D1 database binding.
 * @param {string} table - D1 table name.
 * @param {string[]} apiColumns - Column names from the API response.
 * @returns {Promise<void>}
 */
export async function ensureColumns(db, table, apiColumns) {
    const info = await db.prepare(`PRAGMA table_info("${table}")`).all();
    const existing = new Set(info.results.map(
        (/** @type {{name: string}} */ r) => r.name
    ));

    for (const col of apiColumns) {
        if (existing.has(col)) continue;

        if (!/^[a-zA-Z_]\w*$/.test(col)) {
            console.error(`[sync] rejected invalid column name: ${JSON.stringify(col)} on ${table}`);
            continue;
        }

        console.warn(`[sync] auto-adding column "${col}" to ${table}`);
        await db.prepare(`ALTER TABLE "${table}" ADD COLUMN "${col}" TEXT`).run();
    }
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
            'SELECT last_sync FROM "_sync_meta" WHERE entity = ?'
        ).bind(tag).first();

        const lastSync = syncRow ? /** @type {number} */ (syncRow.last_sync) : 0;

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

        const columns = Object.keys(rows[0]);
        await ensureColumns(db, meta.table, columns);

        /** @type {Set<string>} */
        const notNullStrings = new Set();
        meta.fields.forEach((/** @type {{type: string, name: string, nullable?: boolean}} */ field) => {
            if ((field.type === 'string' || field.type === 'datetime') && !field.nullable) {
                notNullStrings.add(field.name);
            }
        });

        const activeRows  = rows.filter(r => r.status !== 'deleted');
        const deletedRows = rows.filter(r => r.status === 'deleted');

        // Batch upsert active rows (D1 batch limit is 100 statements)
        const BATCH_SIZE = 50;
        for (let i = 0; i < activeRows.length; i += BATCH_SIZE) {
            const batch = activeRows.slice(i, i + BATCH_SIZE);
            const statements = batch.map(row => {
                const { sql, params } = buildUpsert(meta.table, columns, row, notNullStrings);
                return db.prepare(sql).bind(...params);
            });
            await db.batch(statements);
        }
        result.updated = activeRows.length;

        if (deletedRows.length > 0) {
            const deleteStmts = deletedRows.map(row =>
                db.prepare(`DELETE FROM "${meta.table}" WHERE id = ?`).bind(row.id)
            );
            await db.batch(deleteStmts);
            result.deleted = deletedRows.length;
            result.deletedIds = deletedRows.map(row => row.id);
        }

        // ── Publish Queue messages ─────────────────────────────────────────────
        // Must happen BEFORE _sync_meta is advanced so that a Queue publish
        // failure causes the next cron to re-fetch and retry.
        if (queue) {
            /** @type {QueueSendRequest<AsyncTaskMessage>[]} */
            const messages = [];

            if (VECTOR_ENTITY_TAGS.has(tag)) {
                for (const row of activeRows) {
                    messages.push({ body: { action: 'embed', tag, id: row.id } });
                }
            }

            if (VECTOR_ENTITY_TAGS.has(tag)) {
                for (const row of activeRows) {
                    if (row.logo) {
                        messages.push({ body: { action: 'logo', tag, id: row.id } });
                    }
                }
            }

            for (const id of result.deletedIds) {
                messages.push({ body: { action: 'delete', tag, id } });
            }

            // sendBatch accepts up to 250 messages; chunk if needed.
            const QUEUE_BATCH = 200;
            for (let i = 0; i < messages.length; i += QUEUE_BATCH) {
                await queue.sendBatch(messages.slice(i, i + QUEUE_BATCH));
            }
        }

        // ── Advance lastSync ───────────────────────────────────────────────────
        const totalCount = await db.prepare(
            `SELECT COUNT(*) as cnt FROM "${meta.table}"`
        ).first();
        const rowCount = totalCount ? /** @type {number} */ (totalCount.cnt) : 0;

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
