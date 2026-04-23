/**
 * @fileoverview PeeringDB sync worker.
 * Runs on a cron schedule (every 15 minutes) and fetches incremental updates
 * from the PeeringDB API for each entity type. Uses the `since` parameter
 * (updated timestamp) to only fetch rows modified since the last sync.
 *
 * Architecture:
 *   - Reads `_sync_meta` for each entity's last sync timestamp.
 *   - Fetches `GET /api/{tag}?since={epoch}&depth=0` from PeeringDB.
 *   - Auto-evolves the D1 schema: if the API response contains columns
 *     that don't exist in the table, runs ALTER TABLE ADD COLUMN (as
 *     nullable TEXT) before inserting. Logs a warning for each addition.
 *   - Upserts returned rows into D1 via INSERT OR REPLACE.
 *   - Updates `_sync_meta` with the new timestamp and row count.
 *   - Handles deleted rows by checking status='deleted' and removing them.
 *
 * Environment bindings:
 *   PDB         - D1 database binding
 *   PDB_API_KEY - PeeringDB API key (secret)
 */

import { ENTITIES, VECTOR_ENTITY_TAGS } from './entities.js';

const API_BASE = 'https://www.peeringdb.com/api';

/** Prefix to strip from S3 logo URLs to derive R2 keys. */
const S3_MEDIA_PREFIX = 'https://peeringdb-media-prod.s3.amazonaws.com/media/';

/**
 * Entity tags that have a `logo` field and __logo_migrated column.
 * @type {Set<string>}
 */
const LOGO_ENTITIES = new Set(['org', 'net', 'ix', 'fac', 'carrier', 'campus']);

/**
 * Coerces a single API field value to a D1-compatible SQL parameter.
 * @param {string} col - Column name.
 * @param {any} v - Raw value from the API row.
 * @param {Set<string>} notNullStrings - Column names that are NOT NULL strings.
 * @returns {string|number|null} D1-compatible parameter value.
 */
function coerceValue(col, v, notNullStrings) {
    if (v === undefined || v === null) {
        // Django CharField(blank=True, null=False) stores "" not NULL.
        // Coerce to "" for NOT NULL string columns to match upstream
        // and satisfy the D1 schema constraint.
        return notNullStrings.has(col) ? '' : null;
    }
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v;
    if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

/**
 * Builds an INSERT OR REPLACE statement for a single row.
 * Handles all value types: null, boolean, number, string, array/object.
 *
 * For NOT NULL string columns, null/undefined values from the API are
 * coerced to empty string ("") to match Django's CharField convention
 * and prevent D1 NOT NULL constraint violations.
 *
 * @param {string} table - D1 table name.
 * @param {string[]} columns - Column names.
 * @param {Record<string, any>} row - Row data from the API.
 * @param {Set<string>} notNullStrings - Column names that are NOT NULL strings
 *        in the schema. null/undefined values for these columns are coerced to "".
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
 * If the upstream PeeringDB API adds new fields, this auto-evolves
 * the schema by running ALTER TABLE ADD COLUMN for each missing one.
 *
 * New columns are added as nullable TEXT — compatible with any SQLite
 * storage class and safe for unknown upstream types.
 *
 * Logs a warning for each column added so developers know to update
 * the entity definition and schema.sql.
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

        // Reject column names that don't look like valid SQL identifiers.
        // Upstream PeeringDB JSON keys are trusted but not controlled — a
        // compromised or buggy upstream could inject arbitrary keys that
        // result in SQL injection via ALTER TABLE if not validated.
        if (!/^[a-zA-Z_]\w*$/.test(col)) {
            console.error(`[sync] rejected invalid column name: ${JSON.stringify(col)} on ${table}`);
            continue;
        }

        console.warn(`[sync] auto-adding column "${col}" to ${table}`);
        await db.prepare(
            `ALTER TABLE "${table}" ADD COLUMN "${col}" TEXT`
        ).run();
    }
}

/**
 * Processes a single entity: fetch updates from PeeringDB since the last
 * sync timestamp, upsert into D1, and update _sync_meta.
 *
 * @param {D1Database} db - D1 database binding.
 * @param {string} tag - Entity tag (e.g. "net").
 * @param {Pick<EntityMeta, 'table' | 'fields'>} meta - Entity metadata (table, fields).
 * @param {string} apiKey - PeeringDB API key.
 * @returns {Promise<{ tag: string, updated: number, deleted: number, error: string }>}
 */
export async function syncEntity(db, tag, meta, apiKey) {
    const result = { tag, updated: 0, deleted: 0, error: '' };

    try {
        // Get last sync time from _sync_meta
        const syncRow = await db.prepare(
            'SELECT last_sync FROM "_sync_meta" WHERE entity = ?'
        ).bind(tag).first();

        const lastSync = syncRow ? /** @type {number} */ (syncRow.last_sync) : 0;

        // Refuse to sync from epoch. Fetching the full dataset for an entity
        // (e.g. ~300k rows for netixlan) would exceed the Worker's 128MB RAM
        // limit and crash the isolate. Fresh databases must be bootstrapped
        // via the SQLite dump pipeline (migrate-to-d1.sh).
        if (lastSync === 0) {
            result.error = 'last_sync is 0 — initial bootstrap required via SQLite dump';
            return result;
        }

        // Lock in the timestamp BEFORE the network request so any upstream
        // updates that land during the fetch are caught in the next cron run.
        const now = Math.floor(Date.now() / 1000);

        // Fetch updates since last sync
        /** @type {Record<string, string>} */
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'pdbfe-sync/1.0',
        };
        if (apiKey) {
            headers['Authorization'] = `Api-Key ${apiKey}`;
        }

        // limit=0 disables PeeringDB's default 250-item pagination cap.
        // Without it, any sync window with >250 changed rows silently
        // drops the overflow and permanently loses those updates.
        const url = `${API_BASE}/${tag}?since=${lastSync}&depth=0&limit=0`;
        const response = await fetch(url, { headers });

        if (!response.ok) {
            result.error = `HTTP ${response.status}`;
            return result;
        }

        const data = /** @type {{ data: Record<string, any>[] }} */ (await response.json());
        const rows = data.data || [];

        if (rows.length === 0) {
            // Nothing changed — just update the timestamp.
            // NULLIF handles existing '' default from the initial ALTER TABLE.
            await db.prepare(
                `INSERT OR REPLACE INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, ?, (SELECT COALESCE(row_count, 0) FROM "_sync_meta" WHERE entity = ?), datetime('now'), (SELECT COALESCE(NULLIF(last_modified_at, ''), 0) FROM "_sync_meta" WHERE entity = ?))`
            ).bind(tag, now, tag, tag).run();
            return result;
        }

        // Use all columns from the API response. If the upstream API has
        // added new fields that don't exist in the D1 table, ensureColumns
        // will ALTER TABLE to add them before the INSERT runs.
        const columns = Object.keys(rows[0]);
        await ensureColumns(db, meta.table, columns);

        // Derive NOT NULL string columns from entity field definitions.
        // The D1 schema uses NOT NULL DEFAULT '' for string/datetime fields
        // that Django models define as CharField(blank=True, null=False).
        // When the API sends null for these columns, coerce to "" to
        // satisfy the constraint and match Django's convention.
        // Fields marked nullable in the entity registry are excluded — they
        // use nullable TEXT in D1 and should store null to match upstream.
        /** @type {Set<string>} */
        const notNullStrings = new Set();
        meta.fields.forEach((/** @type {{type: string, name: string, nullable?: boolean}} */ field) => {
            if ((field.type === 'string' || field.type === 'datetime') && !field.nullable) {
                notNullStrings.add(field.name);
            }
        });

        // Separate active rows from deleted ones
        const activeRows = rows.filter(r => r.status !== 'deleted');
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
            'INSERT OR REPLACE INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, ?, ?, datetime(\'now\'), ?)'
        ).bind(tag, now, rowCount, now).run();

        return result;
    } catch (err) {
        result.error = /** @type {Error} */ (err).message;
        return result;
    }
}

/**
 * Syncs unmigrated logos for a single entity type from upstream S3
 * to the R2 bucket. Finds rows where logo is non-empty and
 * __logo_migrated is 0, fetches each image, stores it in R2, then
 * sets the flag.
 *
 * Failures are logged but do not affect the data sync or other logos.
 * Processes sequentially with a brief delay to avoid hammering S3.
 *
 * @param {D1Database} db - D1 database binding.
 * @param {R2Bucket} logos - R2 bucket binding for logo storage.
 * @param {string} tag - Entity tag (e.g. "org").
 * @param {string} table - D1 table name.
 * @returns {Promise<{ fetched: number, errors: number }>}
 */
export async function syncLogos(db, logos, tag, table) {
    const result = { fetched: 0, errors: 0 };
    if (!logos) return result;

    // Find rows with logos that haven't been synced to R2 yet.
    // Limit to 20 per cron run to stay within Worker CPU time limits.
    const rows = await db.prepare(
        `SELECT id, logo FROM "${table}" WHERE logo != '' AND logo IS NOT NULL AND "__logo_migrated" = 0 LIMIT 20`
    ).all();

    if (!rows.results || rows.results.length === 0) return result;

    const logoRows = /** @type {{id: number, logo: string}[]} */ (rows.results);
    for (let i = 0; i < logoRows.length; i++) {
        const row = logoRows[i];
        const logoUrl = row.logo;
        if (!logoUrl.startsWith(S3_MEDIA_PREFIX)) {
            // Unknown URL format — skip but mark as migrated to avoid retrying
            console.warn(`[sync-logos] ${tag}/${row.id}: unknown URL format: ${logoUrl}`);
            await db.prepare(
                `UPDATE "${table}" SET "__logo_migrated" = 1 WHERE id = ?`
            ).bind(row.id).run();
            continue;
        }

        const r2Key = logoUrl.slice(S3_MEDIA_PREFIX.length);

        try {
            // Check if already in R2 (HEAD is free)
            const existing = await logos.head(r2Key);
            if (existing) {
                // Already there — just set the flag
                await db.prepare(
                    `UPDATE "${table}" SET "__logo_migrated" = 1 WHERE id = ?`
                ).bind(row.id).run();
                result.fetched++;
                continue;
            }

            // Fetch from S3
            const resp = await fetch(logoUrl);
            if (!resp.ok) {
                if (resp.status === 404 || resp.status === 403) {
                    // Logo deleted upstream — mark as migrated to prevent retries
                    console.warn(`[sync-logos] ${tag}/${row.id}: S3 returned ${resp.status}, marking done`);
                    await db.prepare(
                        `UPDATE "${table}" SET "__logo_migrated" = 1 WHERE id = ?`
                    ).bind(row.id).run();
                    result.fetched++;
                } else {
                    console.error(`[sync-logos] ${tag}/${row.id}: S3 returned ${resp.status}`);
                    result.errors++;
                }
                continue;
            }

            const contentType = resp.headers.get('content-type') || 'application/octet-stream';
            const body = await resp.arrayBuffer();

            // Store in R2
            await logos.put(r2Key, body, {
                httpMetadata: { contentType },
            });

            // Mark as migrated
            await db.prepare(
                `UPDATE "${table}" SET "__logo_migrated" = 1 WHERE id = ?`
            ).bind(row.id).run();

            result.fetched++;
            console.log(`[sync-logos] ${tag}/${row.id}: stored ${r2Key} (${body.byteLength} bytes)`);
        } catch (err) {
            console.error(`[sync-logos] ${tag}/${row.id}: ${/** @type {Error} */(err).message}`);
            result.errors++;
        }

        // Brief delay between fetches to avoid hammering S3
        await new Promise(r => setTimeout(r, 100));
    }

    return result;
}

/**
 * Embeds unembedded entity rows into the Vectorize index.
 *
 * Queries up to VECTOR_BATCH_LIMIT rows per entity with __vector_embedded = 0,
 * calls Workers AI to generate BGE-large-en-v1.5 embeddings in batches of
 * EMBED_BATCH_SIZE, upserts into Vectorize, then sets __vector_embedded = 1.
 *
 * Vector ID scheme: '{entity}:{id}' (e.g. 'net:694') so the search worker
 * can resolve entity type from Vectorize results without a D1 lookup.
 *
 * @param {D1Database} db - D1 database binding.
 * @param {Ai} ai - Workers AI binding.
 * @param {VectorizeIndex} vectorize - Vectorize index binding.
 * @param {string} tag - Entity tag (e.g. 'net').
 * @param {string} table - D1 table name.
 * @param {string} primaryField - Field to embed (typically 'name').
 * @returns {Promise<{ embedded: number, errors: number }>}
 */
export async function syncVectors(db, ai, vectorize, tag, table, primaryField) {
    const result = { embedded: 0, errors: 0 };

    /** Maximum rows processed per entity per cron invocation.
     *  Kept low to limit CPU time — the backfill script handles bulk data. */
    const VECTOR_BATCH_LIMIT = 20;
    /** Texts sent to Workers AI per embed call. */
    const EMBED_BATCH_SIZE = 20;

    // Fetch rows that haven't been embedded yet.
    const rows = await db.prepare(
        `SELECT id, "${primaryField}" AS name FROM "${table}" WHERE "__vector_embedded" = 0 LIMIT ?`
    ).bind(VECTOR_BATCH_LIMIT).all();

    if (!rows.results || rows.results.length === 0) return result;

    const records = /** @type {{ id: number, name: string }[]} */ (rows.results);

    // Process in EMBED_BATCH_SIZE chunks.
    for (let i = 0; i < records.length; i += EMBED_BATCH_SIZE) {
        const batch = records.slice(i, i + EMBED_BATCH_SIZE);
        const texts = batch.map(r => String(r.name || ''));
        const ids = batch.map(r => r.id);

        try {
            // Generate embeddings via Workers AI.
            const aiResult = await ai.run('@cf/baai/bge-large-en-v1.5', { text: texts });
            const embeddings = aiResult.data;

            if (embeddings?.length !== batch.length) {
                console.error(`[sync-vectors] ${tag}: AI returned unexpected embedding count`);
                result.errors += batch.length;
                continue;
            }

            // Build Vectorize upsert payload.
            /** @type {VectorizeVector[]} */
            const vectors = [];
            for (let j = 0; j < batch.length; j++) {
                vectors.push({
                    id: `${tag}:${batch[j].id}`,
                    values: embeddings[j],
                    metadata: { entity: tag, id: batch[j].id },
                });
            }

            await vectorize.upsert(vectors);

            // Mark rows as embedded.
            const placeholders = ids.map(() => '?').join(',');
            await db.prepare(
                `UPDATE "${table}" SET "__vector_embedded" = 1 WHERE id IN (${placeholders})`
            ).bind(...ids).run();

            result.embedded += batch.length;
        } catch (err) {
            console.error(`[sync-vectors] ${tag} batch ${i}: ${/** @type {Error} */(err).message}`);
            result.errors += batch.length;
        }
    }

    return result;
}

/**
 * Validates a secret from the URL path against ADMIN_SECRET.
 * Uses constant-time comparison to prevent timing side-channels.
 *
 * @param {PdbSyncEnv} env - Environment bindings.
 * @param {string} provided - The secret from the URL.
 * @returns {boolean} Whether the secret is valid.
 */
function isValidSyncSecret(env, provided) {
    if (typeof env.ADMIN_SECRET !== 'string' || env.ADMIN_SECRET.length === 0) {
        return false;
    }
    if (provided.length !== env.ADMIN_SECRET.length) {
        return false;
    }
    const enc = new TextEncoder();
    const a = enc.encode(provided);
    const b = enc.encode(env.ADMIN_SECRET);
    return crypto.subtle.timingSafeEqual(a, b);
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

        // Sync logos to R2 for entity types that have them
        /** @type {string[]} */
        const logoSummary = [];
        for (const [tag, meta] of Object.entries(ENTITIES)) {
            if (!LOGO_ENTITIES.has(tag)) continue;
            const lr = await syncLogos(env.PDB, env.LOGOS, tag, meta.table);
            if (lr.fetched > 0 || lr.errors > 0) {
                logoSummary.push(`${tag}:+${lr.fetched}e${lr.errors}`);
            }
        }

        // Embed unembedded rows into Vectorize (only when bindings are present)
        /** @type {string[]} */
        const vectorSummary = [];
        if (env.AI && env.VECTORIZE) {
            for (const [tag, meta] of Object.entries(ENTITIES)) {
                if (!VECTOR_ENTITY_TAGS.has(tag)) continue;
                const vr = await syncVectors(env.PDB, env.AI, env.VECTORIZE, tag, meta.table, 'name');
                if (vr.embedded > 0 || vr.errors > 0) {
                    vectorSummary.push(`${tag}:+${vr.embedded}e${vr.errors}`);
                }
            }
        }

        const summary = results.map(r => {
            const errSuffix = r.error ? ` ERR:${r.error}` : '';
            return `${r.tag}: +${r.updated} -${r.deleted}${errSuffix}`;
        }).join(', ');

        const logoInfo = logoSummary.length > 0 ? ` | logos: ${logoSummary.join(', ')}` : '';
        const vectorInfo = vectorSummary.length > 0 ? ` | vectors: ${vectorSummary.join(', ')}` : '';
        console.log(`[sync] ${new Date().toISOString()} ${summary}${logoInfo}${vectorInfo}`);
    },

    /**
     * HTTP handler for manual sync trigger and status.
     * GET  /sync/status            — returns last sync times and row counts.
     * POST /sync/trigger.\<secret\>  — runs a full sync cycle (requires ADMIN_SECRET).
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

        if (url.pathname.startsWith('/sync/trigger.') && request.method === 'POST') {
            const secret = url.pathname.slice('/sync/trigger.'.length);
            if (!isValidSyncSecret(env, secret)) {
                return new Response(JSON.stringify({ error: 'Forbidden' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

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
