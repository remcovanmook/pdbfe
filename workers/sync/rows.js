/**
 * @fileoverview Row-level D1 writes and Queue publishing shared by the
 * incremental sync (index.js) and the weekly health check (health.js).
 */

import { VECTOR_ENTITY_TAGS } from './entities.js';

/**
 * Whether an upstream row belongs in D1. The mirror serves only what
 * upstream lists — status 'ok' — so D1 holds nothing else: 'deleted',
 * 'pending' (e.g. campuses awaiting approval, which ?since= returns to an
 * authenticated sync) and any other status are removals. A pending row that
 * is approved later comes back via ?since= as 'ok' (approval saves the row
 * and advances `updated`). Rows without a status field are kept.
 *
 * @param {Record<string, any>} row - Upstream API row.
 * @returns {boolean}
 */
export function isListed(row) {
    return row.status === undefined || row.status === 'ok';
}

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
    // Treat missing values AND non-finite numbers (NaN / Infinity, which D1's
    // bind rejects and would throw, wedging the whole batch) as null.
    if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) {
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
 * @returns {Promise<Set<string>>} The set of columns that exist in the table
 *          afterwards (existing + newly added). Callers intersect the upsert
 *          column list with this so a rejected (invalid-identifier) upstream
 *          key is never emitted into an INSERT.
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
        // Sequential on purpose: schema changes, rare, one column at a time.
        await db.prepare(`ALTER TABLE "${table}" ADD COLUMN "${col}" TEXT`).run(); // NOSONAR
        existing.add(col);
    }

    return existing;
}

/**
 * Upserts active rows (INSERT OR REPLACE) in batches of 50.
 *
 * Column set = union of keys across the rows, intersected with columns that
 * exist after ensureColumns — that drops any upstream key with an invalid SQL
 * identifier (ensureColumns refuses to add those; emitting them anyway would
 * make every INSERT reference a non-existent column and wedge the entity).
 *
 * @param {D1Database} db - D1 database binding.
 * @param {Pick<EntityMeta, 'table' | 'fields'>} meta - Entity metadata.
 * @param {Record<string, any>[]} activeRows - Rows to upsert (non-deleted).
 * @returns {Promise<void>}
 */
export async function upsertActiveRows(db, meta, activeRows) {
    if (activeRows.length === 0) return;
    const apiColumnSet = new Set();
    for (const row of activeRows) {
        for (const k of Object.keys(row)) apiColumnSet.add(k);
    }
    const apiColumns = [...apiColumnSet];
    const existing = await ensureColumns(db, meta.table, apiColumns);
    const columns = apiColumns.filter(c => existing.has(c));

    /** @type {Set<string>} */
    const notNullStrings = new Set();
    meta.fields.forEach((/** @type {{type: string, name: string, nullable?: boolean}} */ field) => {
        if ((field.type === 'string' || field.type === 'datetime') && !field.nullable) {
            notNullStrings.add(field.name);
        }
    });

    // D1 batch limit is 100 statements
    const BATCH_SIZE = 50;
    for (let i = 0; i < activeRows.length; i += BATCH_SIZE) {
        const batch = activeRows.slice(i, i + BATCH_SIZE);
        const statements = batch.map(row => {
            const { sql, params } = buildUpsert(meta.table, columns, row, notNullStrings);
            return db.prepare(sql).bind(...params);
        });
        // Sequential on purpose: D1 caps a batch at 100 statements; batches are
        // written in order and memory stays bounded.
        await db.batch(statements); // NOSONAR
    }
}

/**
 * Publishes async-task messages for written / removed rows: embed and logo
 * for active rows of embeddable entities, delete for removed ids.
 *
 * Cloudflare Queues caps sendBatch at 100 messages per call; exceeding it
 * throws "batch message count of N exceeds limit of 100" and (since the sync
 * publishes before _sync_meta advances) wedges the entity — high-churn tags
 * re-fetch a growing backlog every cron and never recover. Chunked at 100.
 *
 * @param {Queue<AsyncTaskMessage>|undefined} queue - Queue producer (optional).
 * @param {string} tag - Entity tag.
 * @param {Record<string, any>[]} activeRows - Rows written.
 * @param {number[]} deletedIds - Ids removed from D1.
 * @returns {Promise<void>}
 */
export async function publishTasks(queue, tag, activeRows, deletedIds) {
    if (!queue) return;
    /** @type {QueueSendRequest<AsyncTaskMessage>[]} */
    const messages = [];
    if (VECTOR_ENTITY_TAGS.has(tag)) {
        for (const row of activeRows) {
            messages.push({ body: { action: 'embed', tag, id: row.id } });
        }
        for (const row of activeRows) {
            if (row.logo) messages.push({ body: { action: 'logo', tag, id: row.id } });
        }
    }
    for (const id of deletedIds) {
        messages.push({ body: { action: 'delete', tag, id } });
    }
    const QUEUE_BATCH = 100;
    for (let i = 0; i < messages.length; i += QUEUE_BATCH) {
        // Sequential on purpose: Queues caps sendBatch at 100 messages.
        await queue.sendBatch(messages.slice(i, i + QUEUE_BATCH)); // NOSONAR
    }
}
