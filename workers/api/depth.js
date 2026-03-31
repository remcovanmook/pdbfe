/**
 * @fileoverview Depth expansion for PeeringDB _set fields.
 * Handles depth=0 (omit sets), depth=1 (IDs only), and stubs
 * for depth=2 (full objects, Phase 2).
 *
 * Batches child queries per parent set to avoid N+1 patterns.
 */

import { ENTITIES } from './entities.js';

/**
 * Expands _set fields on an array of result rows based on the
 * requested depth level. Mutates the rows in-place by adding
 * _set properties.
 *
 * - depth=0: No expansion. _set fields are omitted entirely.
 * - depth=1: Each _set field contains an array of child IDs.
 *   Batches a single query per relationship across all parent rows.
 * - depth=2: (Phase 2) Each _set field contains full child objects.
 *
 * @param {D1Database} db - The D1 database binding.
 * @param {EntityMeta} entity - The parent entity metadata.
 * @param {Record<string, any>[]} rows - The parent result rows to expand.
 * @param {number} depth - Depth level (0, 1, or 2).
 * @returns {Promise<void>} Resolves when expansion is complete.
 */
export async function expandDepth(db, entity, rows, depth) {
    if (depth === 0 || rows.length === 0 || entity.relationships.length === 0) {
        return;
    }

    if (depth === 1) {
        await expandDepthOne(db, entity, rows);
    }
    // depth=2 is Phase 2
}

/**
 * Depth=1 expansion: for each relationship defined on the entity,
 * queries the child table for all IDs matching the parent rows,
 * then attaches an array of child IDs to each parent row.
 *
 * Uses a single batched IN query per relationship (not per row)
 * to avoid N+1 query patterns.
 *
 * @param {D1Database} db - The D1 database binding.
 * @param {EntityMeta} entity - The parent entity metadata.
 * @param {Record<string, any>[]} rows - The parent result rows.
 * @returns {Promise<void>}
 */
async function expandDepthOne(db, entity, rows) {
    const parentIds = rows.map(r => r.id);
    if (parentIds.length === 0) return;

    // Build a fast lookup from parent ID to row for attaching results
    /** @type {Map<number, Record<string, any>>} */
    const rowMap = new Map();
    for (const row of rows) {
        rowMap.set(row.id, row);
    }

    // Process all relationships in parallel
    const tasks = entity.relationships.map(async (rel) => {
        // Initialise empty arrays on all rows
        for (const row of rows) {
            row[rel.field] = [];
        }

        // Batch query: SELECT id, <fk> FROM <child_table> WHERE <fk> IN (?, ?, ...)
        const placeholders = parentIds.map(() => "?").join(", ");
        const sql = `SELECT "id", "${rel.fk}" FROM "${rel.table}" WHERE "${rel.fk}" IN (${placeholders}) AND "status" != 'deleted' ORDER BY "id" ASC`;
        const result = await db.prepare(sql).bind(...parentIds).all();

        if (result.results) {
            for (const child of result.results) {
                const parentRow = rowMap.get(/** @type {number} */(child[rel.fk]));
                if (parentRow) {
                    parentRow[rel.field].push(child.id);
                }
            }
        }
    });

    await Promise.all(tasks);
}
