/**
 * @fileoverview Depth expansion for PeeringDB _set fields.
 * Handles depth=0 (omit sets), depth=1 (IDs only), and depth=2
 * (full child objects with FK column excluded).
 *
 * Batches child queries per relationship across all parent rows
 * to avoid N+1 patterns.
 */

import { ENTITIES, getColumns, getJsonColumns, getBoolColumns } from './entities.js';

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
 * For restricted child entities (e.g. poc), anonymous callers only
 * see records matching the entity's anonFilter (visible=Public).
 *
 * @param {D1Session} db - The D1 database binding.
 * @param {EntityMeta} entity - The parent entity metadata.
 * @param {Record<string, any>[]} rows - The parent result rows to expand.
 * @param {number} depth - Depth level (0, 1, or 2).
 * @param {boolean} [authenticated=false] - Whether the caller is authenticated.
 * @returns {Promise<void>} Resolves when expansion is complete.
 */
export async function expandDepth(db, entity, rows, depth, authenticated = false) {
    if (depth === 0 || rows.length === 0 || entity.relationships.length === 0) {
        return;
    }

    if (depth >= 2) {
        await expandDepthTwo(db, entity, rows, authenticated);
    } else {
        await expandDepthOne(db, entity, rows, authenticated);
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
 * @param {D1Session} db - The D1 database binding.
 * @param {EntityMeta} entity - The parent entity metadata.
 * @param {Record<string, any>[]} rows - The parent result rows.
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @returns {Promise<void>}
 */
async function expandDepthOne(db, entity, rows, authenticated) {
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

        // For restricted child entities, add visibility filter for anonymous callers
        const childTag = TABLE_TO_TAG.get(rel.table);
        const childEntity = childTag ? ENTITIES[childTag] : null;
        const anonFilter = (!authenticated && childEntity?._restricted && childEntity?._anonFilter) ? childEntity._anonFilter : null;

        let sql = `SELECT "id", "${rel.fk}" FROM "${rel.table}" WHERE "${rel.fk}" IN (${placeholders}) AND "status" != 'deleted'`;
        /** @type {any[]} */
        const params = [...parentIds];

        if (anonFilter) {
            sql += ` AND "${anonFilter.field}" = ?`;
            params.push(anonFilter.value);
        }

        sql += ` ORDER BY "id" ASC`;
        const result = await db.prepare(sql).bind(...params).all();

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
 * For restricted child entities (e.g. poc), anonymous callers only
 * see records matching the entity's anonFilter.
 *
 * @param {D1Session} db - The D1 database binding.
 * @param {EntityMeta} entity - The parent entity metadata.
 * @param {Record<string, any>[]} rows - The parent result rows.
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @returns {Promise<void>}
 */
async function expandDepthTwo(db, entity, rows, authenticated) {
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

        // Check if this child entity needs visibility filtering for anonymous callers
        const anonFilter = (!authenticated && childEntity?._restricted && childEntity?._anonFilter) ? childEntity._anonFilter : null;

        // Build column list, excluding the FK back to the parent
        /** @type {string[]} */
        let childColumns;
        /** @type {Set<string>} */
        let childJsonCols;
        /** @type {Set<string>} */
        let childBoolCols;
        if (childEntity) {
            childColumns = getColumns(childEntity).filter(c => c !== rel.fk);
            childJsonCols = getJsonColumns(childEntity);
            childBoolCols = getBoolColumns(childEntity);
        } else {
            childColumns = [];
            childJsonCols = new Set();
            childBoolCols = new Set();
        }

        const placeholders = parentIds.map(() => "?").join(", ");
        /** @type {any[]} */
        const params = [...parentIds];
        let sql;

        if (rel.joinColumns && rel.joinColumns.length > 0 && childColumns.length > 0) {
            // JOIN path: alias the child table, add LEFT JOINs for cross-entity names
            const baseCols = childColumns.map(c => `t."${c}"`).join(", ");

            /** @type {string[]} */
            const joinParts = [];
            /** @type {string[]} */
            const joinCols = [];
            for (let i = 0; i < rel.joinColumns.length; i++) {
                const j = rel.joinColumns[i];
                const alias = `j${i}`;
                joinParts.push(
                    ` LEFT JOIN "${j.table}" AS ${alias} ON t."${j.localFk}" = ${alias}."id"`
                );
                for (const [srcCol, aliasName] of Object.entries(j.columns)) {
                    joinCols.push(`${alias}."${srcCol}" AS "${aliasName}"`);
                }
            }

            const allCols = `t."${rel.fk}", ${baseCols}` +
                (joinCols.length > 0 ? `, ${joinCols.join(", ")}` : '');

            sql = `SELECT ${allCols} FROM "${rel.table}" AS t` +
                joinParts.join('') +
                ` WHERE t."${rel.fk}" IN (${placeholders})` +
                ` AND t."status" != 'deleted'`;

            if (anonFilter) {
                sql += ` AND t."${anonFilter.field}" = ?`;
                params.push(anonFilter.value);
            }

            sql += ` ORDER BY t."id" ASC`;
        } else if (childColumns.length > 0) {
            // Standard path: no JOINs
            const colExpr = childColumns.map(c => `"${c}"`).join(", ");
            sql = `SELECT "${rel.fk}", ${colExpr} FROM "${rel.table}"` +
                ` WHERE "${rel.fk}" IN (${placeholders})` +
                ` AND "status" != 'deleted'`;

            if (anonFilter) {
                sql += ` AND "${anonFilter.field}" = ?`;
                params.push(anonFilter.value);
            }

            sql += ` ORDER BY "id" ASC`;
        } else {
            // Fallback: unknown child entity, select everything
            sql = `SELECT * FROM "${rel.table}"` +
                ` WHERE "${rel.fk}" IN (${placeholders})` +
                ` AND "status" != 'deleted'`;

            if (anonFilter) {
                sql += ` AND "${anonFilter.field}" = ?`;
                params.push(anonFilter.value);
            }

            sql += ` ORDER BY "id" ASC`;
        }

        const result = await db.prepare(sql).bind(...params).all();

        if (result.results) {
            for (const child of result.results) {
                const parentRow = rowMap.get(/** @type {number} */(child[rel.fk]));
                if (!parentRow) continue;

                // Strip the FK column from the child object
                delete child[rel.fk];

                // Parse JSON-stored TEXT columns
                for (const col of childJsonCols) {
                    if (typeof child[col] === "string" && child[col]) {
                        try { child[col] = JSON.parse(child[col]); } catch { /* keep as string */ }
                    }
                }

                // Coerce boolean columns from SQLite's 0/1 to JS booleans
                for (const col of childBoolCols) {
                    if (col in child) child[col] = !!child[col];
                }

                parentRow[rel.field].push(child);
            }
        }
    });

    await Promise.all(tasks);
}
