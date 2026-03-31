/**
 * @fileoverview Depth expansion for PeeringDB _set fields.
 * Handles depth=0 (omit sets), depth=1 (IDs only), and depth=2
 * (full child objects with FK column excluded).
 *
 * Batches child queries per relationship across all parent rows
 * to avoid N+1 patterns.
 */

import { ENTITIES } from './entities.js';

/**
 * Reverse lookup: maps a D1 table name to the EntityMeta tag.
 * Built once at module load from ENTITIES. Used by depth=2 to find
 * the child entity's column list and JSON-stored columns.
 *
 * @type {Map<string, string>}
 */
const TABLE_TO_TAG = new Map();
for (const [tag, meta] of Object.entries(ENTITIES)) {
    TABLE_TO_TAG.set(meta.table, tag);
}

/**
 * Columns that store JSON arrays/objects as TEXT in D1.
 * Must be JSON.parse'd when returning full child objects at depth=2.
 *
 * @type {Set<string>}
 */
const JSON_COLS = new Set(["social_media", "info_types", "available_voltage_services"]);

/**
 * Expands _set fields on an array of result rows based on the
 * requested depth level. Mutates the rows in-place by adding
 * _set properties.
 *
 * - depth=0: No expansion. _set fields are omitted entirely.
 * - depth=1: Each _set field contains an array of child IDs.
 *   Batches a single query per relationship across all parent rows.
 * - depth=2: Each _set field contains full child objects (all columns
 *   except the FK back to the parent). Matches upstream PeeringDB
 *   behaviour.
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

    if (depth >= 2) {
        await expandDepthTwo(db, entity, rows);
    } else {
        await expandDepthOne(db, entity, rows);
    }
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

    /** @type {Map<number, Record<string, any>>} */
    const rowMap = new Map();
    for (const row of rows) {
        rowMap.set(row.id, row);
    }

    const tasks = entity.relationships.map(async (rel) => {
        for (const row of rows) {
            row[rel.field] = [];
        }

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

/**
 * Depth=2 expansion: for each relationship, queries the child table
 * for all columns matching the parent rows, then attaches full child
 * objects (with the FK column excluded) to each parent row.
 *
 * Matches upstream PeeringDB depth=2 behaviour where child objects
 * include all their own fields but omit the FK pointing back to
 * the parent (e.g. netfac_set entries exclude net_id).
 *
 * JSON-stored TEXT columns (social_media, info_types, etc.) are parsed
 * back to native arrays/objects.
 *
 * @param {D1Database} db - The D1 database binding.
 * @param {EntityMeta} entity - The parent entity metadata.
 * @param {Record<string, any>[]} rows - The parent result rows.
 * @returns {Promise<void>}
 */
async function expandDepthTwo(db, entity, rows) {
    const parentIds = rows.map(r => r.id);
    if (parentIds.length === 0) return;

    /** @type {Map<number, Record<string, any>>} */
    const rowMap = new Map();
    for (const row of rows) {
        rowMap.set(row.id, row);
    }

    const tasks = entity.relationships.map(async (rel) => {
        // Initialise empty arrays
        for (const row of rows) {
            row[rel.field] = [];
        }

        // Determine child columns from the entity registry.
        // If the child table isn't registered (unexpected), fall back to SELECT *.
        const childTag = TABLE_TO_TAG.get(rel.table);
        const childEntity = childTag ? ENTITIES[childTag] : null;

        // Build column list, excluding the FK back to the parent
        let colExpr;
        /** @type {string[]} */
        let childColumns;
        if (childEntity) {
            childColumns = childEntity.columns.filter(c => c !== rel.fk);
            colExpr = childColumns.map(c => `"${c}"`).join(", ");
        } else {
            childColumns = [];
            colExpr = "*";
        }

        const placeholders = parentIds.map(() => "?").join(", ");
        // Include FK in the SELECT for grouping, even though we strip it from the output
        const sql = `SELECT "${rel.fk}", ${colExpr} FROM "${rel.table}" WHERE "${rel.fk}" IN (${placeholders}) AND "status" != 'deleted' ORDER BY "id" ASC`;
        const result = await db.prepare(sql).bind(...parentIds).all();

        if (result.results) {
            for (const child of result.results) {
                const parentRow = rowMap.get(/** @type {number} */(child[rel.fk]));
                if (!parentRow) continue;

                // Strip the FK column from the child object
                delete child[rel.fk];

                // Parse JSON-stored TEXT columns
                for (const col of JSON_COLS) {
                    if (typeof child[col] === "string" && child[col]) {
                        try { child[col] = JSON.parse(child[col]); } catch { /* keep as string */ }
                    }
                }

                parentRow[rel.field].push(child);
            }
        }
    });

    await Promise.all(tasks);
}
