/**
 * @fileoverview Depth expansion for PeeringDB API responses.
 *
 * Child expansion (_set fields):
 *   depth=0 — omit sets entirely
 *   depth=1 — arrays of child IDs
 *   depth=2 — arrays of full child objects (including the FK back to the
 *             parent, which upstream keeps on some sets — a superset)
 *
 * Parent expansion (depth≥1): each `<tag>_id` foreign key also gets a
 * `<tag>` object, as upstream does on detail views (fac.campus,
 * netixlan.net / .ixlan, ixpfx.ixlan, …). At depth=2 on a detail, each
 * parent object is itself serialised at depth 1: its own sets as id lists
 * and its own parents as objects (e.g. fac/1?depth=2 → org.fac_set).
 * Lists expand only `org` (upstream expands none on lists; the mirror's
 * org has always been there), keeping 250-row pages cheap.
 *
 * Batches child queries per relationship across all parent rows
 * to avoid N+1 patterns.
 */

import { GATED_TABLES, selectColumn } from './field_visibility.js';
import { ENTITIES, getColumns } from './entities.js';
import { parseJsonFields } from './handlers/shared.js';

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
 * Resolves the anonymous-visibility filter for a child entity.
 * Returns null when the caller is authenticated or the entity
 * has no restriction.
 *
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @param {EntityMeta|null} childEntity - Child entity metadata (may be null for unknown tables).
 * @returns {{field: string, value: string}|null} Filter clause or null.
 */
function resolveAnonFilter(authenticated, childEntity) {
    if (!authenticated && childEntity?._restricted && childEntity?._anonFilter) {
        return childEntity._anonFilter;
    }
    return null;
}

/**
 * Parent foreign keys expanded into objects, per entity tag: fields named
 * `<target>_id` → key `<target>` (netixlan.net_side_id / ix_side_id point
 * at fac but are not expanded upstream). DETAIL: all of them; LIST: org only.
 *
 * @type {{ DETAIL: Map<string, FieldDef[]>, LIST: Map<string, FieldDef[]> }}
 */
const PARENT_FKS = { DETAIL: new Map(), LIST: new Map() };
for (const [tag, meta] of Object.entries(ENTITIES)) {
    const fks = meta.fields.filter(f => f.foreignKey && ENTITIES[f.foreignKey] && f.name === `${f.foreignKey}_id`); // ap-ok: module init, once per isolate
    PARENT_FKS.DETAIL.set(tag, fks);
    PARENT_FKS.LIST.set(tag, fks.filter(f => f.foreignKey === 'org')); // ap-ok: module init, once per isolate
}

/**
 * Membership test against a JSON array of ids bound as a single parameter.
 * D1 caps bound parameters at 100 per statement, so one `?` per id fails
 * ("too many SQL variables") as soon as a list page has >100 parents.
 * Same pattern as the `__in` filter in query.js.
 */
const IN_IDS = 'IN (SELECT value FROM json_each(?))';

/**
 * Builds a Map from row.id → row for fast parent lookup, and
 * returns the list of parent IDs.
 *
 * @param {Record<string, any>[]} rows - Parent rows.
 * @returns {{ rowMap: Map<number, Record<string, any>>, parentIds: number[] }}
 */
function buildRowMap(rows) {
    /** @type {Map<number, Record<string, any>>} */
    const rowMap = new Map();
    /** @type {number[]} */
    const parentIds = [];
    for (const row of rows) {
        rowMap.set(row.id, row);
        parentIds.push(row.id);
    }
    return { rowMap, parentIds };
}

/**
 * Appends an optional anonymous-visibility clause and ORDER BY to a
 * SQL string. Returns the final SQL and updated bind params.
 *
 * @param {string} sql - Base SQL (must already contain WHERE).
 * @param {any[]} params - Bind parameters (mutated in-place if anonFilter applies).
 * @param {{field: string, value: string}|null} anonFilter - Visibility filter or null.
 * @param {string} [prefix=''] - Table alias prefix for column references (e.g. 't.').
 * @returns {string} Final SQL with filter and ORDER BY appended.
 */
function appendFilterAndOrder(sql, params, anonFilter, prefix = '') {
    if (anonFilter) {
        sql += ` AND ${prefix}"${anonFilter.field}" = ?`;
        params.push(anonFilter.value);
    }
    sql += ` ORDER BY ${prefix}"id" ASC`;
    return sql;
}


/**
 * Expands _set fields and parent org on result rows based on
 * the requested depth level. Mutates the rows in-place.
 *
 * Child _set expansion:
 * - depth=0: No expansion. _set fields are omitted entirely.
 * - depth=1: Each _set field contains an array of child IDs.
 * - depth=2: Each _set field contains full child objects (all columns
 *   except the FK back to the parent).
 *
 * Parent expansion (depth≥1): see the file overview. `detail` selects
 * upstream's detail-view behaviour (every `<tag>_id` parent, recursing one
 * level at depth=2); lists expand org only.
 *
 * For restricted child entities (e.g. poc), anonymous callers only
 * see records matching the entity's anonFilter (visible=Public).
 *
 * @param {D1Session} db - The D1 database binding.
 * @param {EntityMeta} entity - The parent entity metadata.
 * @param {Record<string, any>[]} rows - The parent result rows to expand.
 * @param {number} depth - Depth level (0, 1, or 2).
 * @param {boolean} [authenticated=false] - Whether the caller is authenticated.
 * @param {boolean} [pdbfe=false] - Whether to include pdbfe-local extension columns.
 * @param {boolean} [detail=false] - Detail view (GET /api/{tag}/{id}): expand every parent FK.
 * @returns {Promise<void>} Resolves when expansion is complete.
 */
export async function expandDepth(db, entity, rows, depth, authenticated = false, pdbfe = false, detail = false) {
    if (depth === 0 || rows.length === 0) {
        return;
    }

    // Child _set expansion (only when relationships exist)
    if (entity.relationships.length > 0) {
        if (depth >= 2) {
            await expandDepthTwo(db, entity, rows, authenticated, pdbfe);
        } else {
            await expandDepthOne(db, entity, rows, authenticated, pdbfe);
        }
    }

    // Upstream many-to-many sets through a link table (ix.fac_set, ixlan.net_set)
    if (THROUGH_SETS[entity.tag]) {
        await expandThroughSets(db, entity, rows, depth, authenticated, pdbfe);
    }

    // Parent expansion (depth≥1): every parent on a detail, org on a list
    await expandParents(db, entity, rows, depth, authenticated, pdbfe, detail);
}

/**
 * Upstream PeeringDB sets that reach the *other* side of a link table:
 * ix.fac_set lists facilities (via ixfac), ixlan.net_set lists networks (via
 * netixlan). depth=1 → distinct target ids, depth=2 → full target objects.
 * The mirror's own link-row sets (ixfac_set, netixlan_set) stay alongside as
 * extensions; the frontend uses them.
 *
 * @type {Record<string, Array<{field: string, link: string, parentFk: string, targetFk: string, targetTag: string}>>}
 */
const THROUGH_SETS = {
    ix: [{ field: 'fac_set', link: 'peeringdb_ix_facility', parentFk: 'ix_id', targetFk: 'fac_id', targetTag: 'fac' }],
    ixlan: [{ field: 'net_set', link: 'peeringdb_network_ixlan', parentFk: 'ixlan_id', targetFk: 'net_id', targetTag: 'net' }],
};

/**
 * Expands THROUGH_SETS for the parent rows: one query per set, joined from
 * the link table to the target table, both restricted to status='ok'.
 *
 * @param {D1Session} db - The D1 database binding.
 * @param {EntityMeta} entity - The parent entity metadata.
 * @param {Record<string, any>[]} rows - The parent result rows.
 * @param {number} depth - 1 (ids) or 2 (objects).
 * @param {boolean} authenticated - Caller auth state (gated target columns).
 * @param {boolean} pdbfe - Whether to include pdbfe-local extension columns.
 * @returns {Promise<void>}
 */
async function expandThroughSets(db, entity, rows, depth, authenticated, pdbfe) {
    const { rowMap, parentIds } = buildRowMap(rows);
    if (parentIds.length === 0) return;

    const tasks = THROUGH_SETS[entity.tag].map(async (ts) => { // ap-ok: cold path behind cachedQuery
        for (const row of rows) row[ts.field] = [];

        const target = ENTITIES[ts.targetTag];
        const params = [JSON.stringify(parentIds)];
        const from = ` FROM "${ts.link}" AS l JOIN "${target.table}" AS t ON t."id" = l."${ts.targetFk}"` +
            ` WHERE l."${ts.parentFk}" ${IN_IDS} AND l."status" = 'ok' AND t."status" = 'ok'`;

        if (depth >= 2) {
            const cols = getColumns(target, pdbfe).map(c => selectColumn(target.table, c, 't.', authenticated)).join(', '); // ap-ok: SQL construction
            const sql = `SELECT DISTINCT l."${ts.parentFk}" AS "__parent", ${cols}${from} ORDER BY t."id" ASC`;
            const result = await db.prepare(sql).bind(...params).all();
            for (const child of result.results || []) {
                const parentRow = rowMap.get(/** @type {number} */ (child.__parent));
                if (!parentRow) continue;
                delete child.__parent;
                parseJsonFields(target, child);
                parentRow[ts.field].push(child);
            }
        } else {
            const sql = `SELECT DISTINCT l."${ts.parentFk}" AS "p", t."id" AS "c"${from} ORDER BY t."id" ASC`;
            const result = await db.prepare(sql).bind(...params).all();
            for (const r of result.results || []) {
                rowMap.get(/** @type {number} */ (r.p))?.[ts.field].push(r.c);
            }
        }
    });
    await Promise.all(tasks);
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
 * @param {boolean} pdbfe - Whether to include pdbfe-local extension columns.
 * @returns {Promise<void>}
 */
async function expandDepthOne(db, entity, rows, authenticated, pdbfe) {
    const { rowMap, parentIds } = buildRowMap(rows);
    if (parentIds.length === 0) return;

    const tasks = entity.relationships.map(async (rel) => { // ap-ok: cold path behind cachedQuery
        for (const row of rows) {
            row[rel.field] = [];
        }

        const childTag = TABLE_TO_TAG.get(rel.table);
        const childEntity = childTag ? ENTITIES[childTag] : null;
        const anonFilter = resolveAnonFilter(authenticated, childEntity);

        let sql = `SELECT "id", "${rel.fk}" FROM "${rel.table}" WHERE "${rel.fk}" ${IN_IDS} AND "status" != 'deleted'`;
        /** @type {any[]} */
        const params = [JSON.stringify(parentIds)];

        sql = appendFilterAndOrder(sql, params, anonFilter);

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
 * Child objects keep the FK pointing back to the parent. Upstream keeps it
 * on some sets (campus.fac_set[].campus_id, carrier.carrierfac_set[].
 * carrier_id) and omits it on others; always keeping it is a superset.
 *
 * JSON-stored TEXT columns (social_media, info_types, etc.) are parsed
 * back to native arrays/objects via parseJsonFields.
 *
 * For restricted child entities (e.g. poc), anonymous callers only
 * see records matching the entity's anonFilter.
 *
 * @param {D1Session} db - The D1 database binding.
 * @param {EntityMeta} entity - The parent entity metadata.
 * @param {Record<string, any>[]} rows - The parent result rows.
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @param {boolean} pdbfe - Whether to include pdbfe-local extension columns.
 * @returns {Promise<void>}
 */
async function expandDepthTwo(db, entity, rows, authenticated, pdbfe) {
    const { rowMap, parentIds } = buildRowMap(rows);
    if (parentIds.length === 0) return;

    const tasks = entity.relationships.map(async (rel) => { // ap-ok: cold path behind cachedQuery
        // Initialise empty arrays
        for (const row of rows) {
            row[rel.field] = [];
        }

        // Determine child columns from the entity registry.
        // If the child table isn't registered (unexpected), fall back to SELECT *.
        const childTag = TABLE_TO_TAG.get(rel.table);
        const childEntity = childTag ? ENTITIES[childTag] : null;

        const anonFilter = resolveAnonFilter(authenticated, childEntity);

        // Build column list, excluding the FK back to the parent
        /** @type {string[]} */
        let childColumns;
        if (childEntity) {
            childColumns = getColumns(childEntity, pdbfe).filter(c => c !== rel.fk); // ap-ok: SQL construction
        } else {
            childColumns = [];
        }

        /** @type {any[]} */
        const params = [JSON.stringify(parentIds)];
        let sql;

        if (rel.joinColumns && rel.joinColumns.length > 0 && childColumns.length > 0) {
            // JOIN path: alias the child table, add LEFT JOINs for cross-entity names
            const baseCols = childColumns.map(c => selectColumn(rel.table, c, 't.', authenticated)).join(", "); // ap-ok: SQL construction

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
                ` WHERE t."${rel.fk}" ${IN_IDS}` +
                ` AND t."status" != 'deleted'`;

            sql = appendFilterAndOrder(sql, params, anonFilter, 't.');
        } else if (childColumns.length > 0) {
            // Standard path: no JOINs
            const colExpr = childColumns.map(c => selectColumn(rel.table, c, '', authenticated)).join(", "); // ap-ok: SQL construction
            sql = `SELECT "${rel.fk}", ${colExpr} FROM "${rel.table}"` +
                ` WHERE "${rel.fk}" ${IN_IDS}` +
                ` AND "status" != 'deleted'`;

            sql = appendFilterAndOrder(sql, params, anonFilter);
        } else if (GATED_TABLES.has(rel.table)) {
            // Never SELECT * from a table with visibility-gated columns.
            throw new Error(`expandDepthTwo: no column list for gated table ${rel.table}`);
        } else {
            // Fallback: unknown child entity, select everything
            sql = `SELECT * FROM "${rel.table}"` +
                ` WHERE "${rel.fk}" ${IN_IDS}` +
                ` AND "status" != 'deleted'`;

            sql = appendFilterAndOrder(sql, params, anonFilter);
        }

        const result = await db.prepare(sql).bind(...params).all();

        if (result.results) {
            for (const child of result.results) {
                const parentRow = rowMap.get(/** @type {number} */(child[rel.fk]));
                if (!parentRow) continue;

                // Parse JSON, coerce booleans, nullify empty strings
                if (childEntity) {
                    parseJsonFields(childEntity, child);
                }

                parentRow[rel.field].push(child);
            }
        }
    });

    await Promise.all(tasks);
}

/**
 * Expands parent foreign keys into objects (`row.<tag>` next to
 * `row.<tag>_id`): one batched query per FK across all rows. On a detail at
 * depth=2, the fetched parents are themselves expanded at depth 1 (their
 * sets as id lists, their own parents as objects), as upstream does.
 *
 * Gated parent columns (ixlan.ixf_ixp_member_list_url) go through
 * selectColumn, so anonymous callers get them nulled; api/auth_scope.js
 * marks those responses auth-sensitive.
 *
 * @param {D1Session} db - The D1 database binding.
 * @param {EntityMeta} entity - The entity metadata for the current rows.
 * @param {Record<string, any>[]} rows - Result rows to expand in-place.
 * @param {number} depth - Requested depth (≥1).
 * @param {boolean} authenticated - Caller auth state (gated columns, restricted sets).
 * @param {boolean} pdbfe - Whether to include pdbfe-local extension columns.
 * @param {boolean} detail - Detail view: every parent FK, recursing at depth=2.
 * @returns {Promise<void>}
 */
async function expandParents(db, entity, rows, depth, authenticated, pdbfe, detail) {
    const fks = (detail ? PARENT_FKS.DETAIL : PARENT_FKS.LIST).get(entity.tag) ?? [];
    if (fks.length === 0) return;

    const tasks = fks.map(async (fk) => { // ap-ok: cold path behind cachedQuery
        const parentTag = /** @type {string} */ (fk.foreignKey);
        const parent = ENTITIES[parentTag];

        /** @type {Set<number>} */
        const ids = new Set();
        for (const row of rows) {
            const pid = row[fk.name];
            if (pid != null) ids.add(pid);
        }
        if (ids.size === 0) return;

        const cols = getColumns(parent, pdbfe).map(c => selectColumn(parent.table, c, '', authenticated)).join(', '); // ap-ok: SQL construction
        const sql = `SELECT ${cols} FROM "${parent.table}" WHERE "id" ${IN_IDS} AND "status" != 'deleted'`;
        const result = await db.prepare(sql).bind(JSON.stringify([...ids])).all(); // ap-ok: cold path behind cachedQuery
        const parents = result.results || [];
        for (const p of parents) parseJsonFields(parent, p);

        if (detail && depth >= 2) {
            await expandDepth(db, parent, parents, depth - 1, authenticated, pdbfe, true);
        }

        /** @type {Map<number, Record<string, any>>} */
        const byId = new Map();
        for (const p of parents) byId.set(/** @type {number} */ (p.id), p);
        for (const row of rows) {
            const p = byId.get(row[fk.name]);
            if (p) row[parentTag] = p;
        }
    });

    await Promise.all(tasks);
}
