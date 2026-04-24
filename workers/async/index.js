/**
 * @fileoverview Async task worker (pdbfe-async).
 *
 * Consumes the pdbfe-tasks Cloudflare Queue. Handles three action types:
 *
 *   embed  — Places a new or updated entity in the Vectorize graph embedding
 *             space using neighbor averaging over existing graph vectors.
 *             Requires the entity to exist in D1 with __vector_embedded = 0.
 *
 *   delete — Removes a deleted entity's graph vector from Vectorize.
 *             Requires the entity to be absent from D1 (confirming deletion).
 *
 *   logo   — Fetches an entity logo from S3 and stores it in the R2 bucket.
 *             Requires the entity to exist in D1 with __logo_migrated = 0.
 *
 * All three handlers perform a D1 pre-check before touching Vectorize or R2.
 * This ensures idempotency: duplicate messages are safely discarded.
 *
 * Architecture:
 *   pdbfe-sync (cron) → Queue message → pdbfe-async (queue consumer)
 *
 * Environment bindings:
 *   PDB       - D1 database (read/write)
 *   VECTORIZE - Vectorize index (pdbfe-vectors)
 *   LOGOS     - R2 bucket (pdbfe-logos)
 */

import { ENTITIES, VECTOR_ENTITY_TAGS } from './entities.js';

/** S3 prefix stripped when deriving R2 keys from logo URLs. */
const S3_MEDIA_PREFIX = 'https://peeringdb-media-prod.s3.amazonaws.com/media/';

/**
 * Reverse lookup from D1 table name to entity tag.
 * Pre-computed at module load from the ENTITIES registry.
 * @type {Map<string, string>}
 */
const TABLE_TO_TAG = new Map(
    Object.entries(ENTITIES).map(([tag, meta]) => [/** @type {any} */ (meta).table, tag])
);

/**
 * Queries D1 for graph-neighbor vector IDs for a given entity.
 *
 * Two neighbor categories are derived entirely from the ENTITIES registry:
 *
 *   1. Direct FK fields: fields with `foreignKey` set to a tag in
 *      VECTOR_ENTITY_TAGS. A single query fetches all FK column values
 *      from the entity's own row.
 *
 *   2. Junction-table neighbors: for each relationship whose junction table
 *      is not itself a vector entity, scanss joinColumns for references to
 *      vector-entity tables, then queries the junction table for matching IDs.
 *      For relationships whose table IS a vector entity (simple reverse FK),
 *      queries that table directly for child IDs.
 *
 * Returned IDs follow the '{tag}:{id}' Vectorize key schema.
 * Results are deduplicated — the same neighbor may appear in multiple paths.
 *
 * @param {D1Database} db - D1 database binding.
 * @param {string} tag - Entity type tag.
 * @param {number} id - Numeric entity ID.
 * @returns {Promise<string[]>} Deduplicated Vectorize ID strings for this entity's neighbors.
 */
async function getNeighborVectorIds(db, tag, id) {
    const meta = /** @type {any} */ (ENTITIES[tag]);
    if (!meta) return [];

    const seen = new Set();
    const LIMIT = 15;

    /**
     * @param {string} neighborTag
     * @param {number|string} neighborId
     */
    function add(neighborTag, neighborId) {
        if (neighborId != null) seen.add(`${neighborTag}:${neighborId}`);
    }

    // ── 1. Direct FK fields ────────────────────────────────────────────────
    // Collect all FK columns that point to a vector entity in a single query.
    const fkFields = meta.fields.filter(
        (/** @type {any} */ f) => f.foreignKey && VECTOR_ENTITY_TAGS.has(f.foreignKey)
    );
    if (fkFields.length) {
        const cols = fkFields.map((/** @type {any} */ f) => `"${f.name}"`).join(', ');
        const row = await db.prepare(
            `SELECT ${cols} FROM "${meta.table}" WHERE id = ?`
        ).bind(id).first();
        if (row) {
            for (const f of fkFields) add(f.foreignKey, row[f.name]);
        }
    }

    // ── 2. Relationship neighbors ──────────────────────────────────────────
    for (const rel of (meta.relationships || [])) {
        const directTag = TABLE_TO_TAG.get(rel.table);

        if (directTag && VECTOR_ENTITY_TAGS.has(directTag)) {
            // Simple reverse FK: the relationship table is itself a vector entity.
            // e.g. org → net_set: SELECT id FROM peeringdb_network WHERE org_id = ?
            const rows = await db.prepare(
                `SELECT id FROM "${rel.table}" WHERE "${rel.fk}" = ? LIMIT ${LIMIT}`
            ).bind(id).all();
            for (const r of rows.results) add(directTag, r.id);
        } else {
            // Junction table: scan joinColumns for vector-entity references.
            // e.g. net → netfac_set: SELECT fac_id FROM peeringdb_network_facility WHERE net_id = ?
            for (const jc of (rel.joinColumns || [])) {
                const neighborTag = TABLE_TO_TAG.get(jc.table);
                if (!neighborTag || !VECTOR_ENTITY_TAGS.has(neighborTag)) continue;
                const rows = await db.prepare(
                    `SELECT "${jc.localFk}" FROM "${rel.table}" WHERE "${rel.fk}" = ? AND "${jc.localFk}" IS NOT NULL LIMIT ${LIMIT}`
                ).bind(id).all();
                for (const r of rows.results) add(neighborTag, r[jc.localFk]);
            }
        }
    }

    return Array.from(seen);
}

/**
 * Computes the element-wise mean of a set of vectors.
 *
 * @param {VectorizeVector[]} vectors - Source vectors; must all have the same dimensionality.
 * @returns {number[] | null} Averaged vector, or null if input is empty.
 */
function averageVectors(vectors) {
    if (!vectors.length) return null;
    const dim = vectors[0].values.length;
    const avg = new Float32Array(dim);
    for (const v of vectors) {
        for (let i = 0; i < dim; i++) avg[i] += v.values[i];
    }
    for (let i = 0; i < dim; i++) avg[i] /= vectors.length;
    return Array.from(avg);
}

/**
 * Handles an 'embed' task message.
 *
 * D1 pre-checks: entity must exist with status='ok' and __vector_embedded=0.
 * If no neighbor vectors are found yet the message is acked silently — the
 * sync worker will re-queue on the next cron when a new edge arrives.
 *
 * @param {D1Database} db - D1 database binding.
 * @param {VectorizeIndex} vectorize - Vectorize index binding.
 * @param {string} tag - Entity type tag.
 * @param {number} id - Numeric entity ID.
 * @returns {Promise<void>}
 */
async function handleEmbed(db, vectorize, tag, id) {
    const table = ENTITIES[tag]?.table;
    if (!table) {
        console.warn(`[async-embed] unknown tag: ${tag}`);
        return;
    }

    const row = await db.prepare(
        `SELECT id, "__vector_embedded" as embedded FROM "${table}" WHERE id = ? AND status = 'ok'`
    ).bind(id).first();

    if (!row || row.embedded === 1) return;

    const neighborIds = await getNeighborVectorIds(db, tag, id);
    if (!neighborIds.length) return;

    const stored = await vectorize.getByIds(neighborIds);
    const avg = averageVectors(stored);
    if (!avg) return;

    await vectorize.upsert([{
        id: `${tag}:${id}`,
        values: avg,
        metadata: { entity: tag, id, embedding_type: 'neighbor_avg' },
    }]);

    await db.prepare(
        `UPDATE "${table}" SET "__vector_embedded" = 1 WHERE id = ?`
    ).bind(id).run();

    console.log(`[async-embed] ${tag}:${id} embedded via ${stored.length} neighbors`);
}

/**
 * Handles a 'delete' task message.
 *
 * D1 pre-check: entity must no longer exist in D1 (confirming it was deleted).
 * If it has been re-created since the delete message was pushed, acks and skips.
 *
 * @param {D1Database} db - D1 database binding.
 * @param {VectorizeIndex} vectorize - Vectorize index binding.
 * @param {string} tag - Entity type tag.
 * @param {number} id - Numeric entity ID.
 * @returns {Promise<void>}
 */
async function handleDelete(db, vectorize, tag, id) {
    const table = ENTITIES[tag]?.table;
    if (!table) {
        console.warn(`[async-delete] unknown tag: ${tag}`);
        return;
    }

    const row = await db.prepare(
        `SELECT id FROM "${table}" WHERE id = ?`
    ).bind(id).first();

    if (row) return; // re-created after delete message was pushed

    await vectorize.deleteByIds([`${tag}:${id}`]);
    console.log(`[async-delete] removed vector ${tag}:${id}`);
}

/**
 * Handles a 'logo' task message.
 *
 * D1 pre-check: entity must exist with a non-empty logo field and
 * __logo_migrated=0. Fetches from S3 and stores in R2. Marks as migrated
 * on success, on S3 404/403, and for unrecognised URL formats to prevent
 * indefinite retries.
 *
 * @param {D1Database} db - D1 database binding.
 * @param {R2Bucket} logos - R2 bucket binding.
 * @param {string} tag - Entity type tag.
 * @param {number} id - Numeric entity ID.
 * @returns {Promise<void>}
 */
async function handleLogo(db, logos, tag, id) {
    const table = ENTITIES[tag]?.table;
    if (!table) {
        console.warn(`[async-logo] unknown tag: ${tag}`);
        return;
    }

    const row = await db.prepare(
        `SELECT id, logo, "__logo_migrated" as migrated FROM "${table}" WHERE id = ? AND logo != '' AND logo IS NOT NULL`
    ).bind(id).first();

    if (!row || row.migrated === 1) return;

    const logoUrl = /** @type {string} */ (row.logo);

    if (!logoUrl.startsWith(S3_MEDIA_PREFIX)) {
        console.warn(`[async-logo] ${tag}/${id}: unknown URL format — marking done`);
        await db.prepare(`UPDATE "${table}" SET "__logo_migrated" = 1 WHERE id = ?`).bind(id).run();
        return;
    }

    const r2Key = logoUrl.slice(S3_MEDIA_PREFIX.length);

    const existing = await logos.head(r2Key);
    if (existing) {
        await db.prepare(`UPDATE "${table}" SET "__logo_migrated" = 1 WHERE id = ?`).bind(id).run();
        return;
    }

    const resp = await fetch(logoUrl);
    if (!resp.ok) {
        if (resp.status === 404 || resp.status === 403) {
            console.warn(`[async-logo] ${tag}/${id}: S3 returned ${resp.status} — marking done`);
            await db.prepare(`UPDATE "${table}" SET "__logo_migrated" = 1 WHERE id = ?`).bind(id).run();
        } else {
            console.error(`[async-logo] ${tag}/${id}: S3 returned ${resp.status}`);
            throw new Error(`S3 ${resp.status}`);
        }
        return;
    }

    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const body = await resp.arrayBuffer();
    await logos.put(r2Key, body, { httpMetadata: { contentType } });
    await db.prepare(`UPDATE "${table}" SET "__logo_migrated" = 1 WHERE id = ?`).bind(id).run();
    console.log(`[async-logo] ${tag}/${id}: stored ${r2Key} (${body.byteLength} bytes)`);
}

export default {
    /**
     * Queue consumer handler. Processes a batch of AsyncTaskMessage messages
     * from the pdbfe-tasks Queue.
     *
     * Each message is processed individually. On success it is acked.
     * On unhandled error it is retried (CF redelivers up to max_retries times).
     *
     * @param {MessageBatch<AsyncTaskMessage>} batch - Incoming message batch.
     * @param {PdbAsyncEnv} env - Environment bindings.
     * @param {ExecutionContext} _ctx - Execution context (unused).
     * @returns {Promise<void>}
     */
    async queue(batch, env, _ctx) {
        for (const msg of batch.messages) {
            const { action, tag, id } = msg.body;
            try {
                if (action === 'embed') {
                    await handleEmbed(env.PDB, env.VECTORIZE, tag, id);
                } else if (action === 'delete') {
                    await handleDelete(env.PDB, env.VECTORIZE, tag, id);
                } else if (action === 'logo') {
                    await handleLogo(env.PDB, env.LOGOS, tag, id);
                } else {
                    console.warn(`[async] unknown action: ${action} for ${tag}:${id}`);
                }
                msg.ack();
            } catch (err) {
                console.error(`[async] ${action}/${tag}/${id} failed: ${/** @type {Error} */(err).message}`);
                msg.retry();
            }
        }
    },

    /**
     * HTTP handler — minimal health endpoint only.
     *
     * @param {Request} _request
     * @param {PdbAsyncEnv} _env
     * @returns {Response}
     */
    fetch(_request, _env) {
        return new Response('ok', { status: 200 });
    },
};
