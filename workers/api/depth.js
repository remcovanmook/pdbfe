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
 * Batching: every expansion is planned up front as one statement plus an
 * `apply` step, and all of them go to D1 in a single batch() — one round
 * trip instead of one per expansion level. Statements don't bind parent ids
 * from earlier results; they select the parents with a subquery over a
 * *source* query (the main query itself, or `id IN (<ids>)`), e.g.
 *   SELECT "id", "net_id" FROM netfac WHERE "net_id" IN (SELECT "id" FROM (<source>))
 *   SELECT … FROM org WHERE "id" IN (SELECT "org_id" FROM (<source>))
 * A batch runs as one transaction, so every statement sees the same rows;
 * ORDER BY always ends on id, so LIMIT/OFFSET pick the same parents. Steps
 * are applied in plan order, and nested steps (a parent's own sets and
 * parents) are planned after the step that produces those parent rows.
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
 * Parent foreign keys expanded into objects: fields named `<target>_id` →
 * key `<target>` (netixlan.net_side_id / ix_side_id point at fac but are not
 * expanded upstream). DETAIL: all of them; LIST: org only. Cached per
 * entity object.
 *
 * @type {WeakMap<EntityMeta, { DETAIL: FieldDef[], LIST: FieldDef[] }>}
 */
const PARENT_FKS = new WeakMap();

/** @param {EntityMeta} entity @param {boolean} detail @returns {FieldDef[]} */
function parentFks(entity, detail) {
    let fks = PARENT_FKS.get(entity);
    if (!fks) {
        const all = entity.fields.filter(f => f.foreignKey && ENTITIES[f.foreignKey] && f.name === `${f.foreignKey}_id`); // ap-ok: once per entity object
        fks = { DETAIL: all, LIST: all.filter(f => f.foreignKey === 'org') }; // ap-ok: once per entity object
        PARENT_FKS.set(entity, fks);
    }
    return detail ? fks.DETAIL : fks.LIST;
}

/**
 * A source query for a set of rows of one entity: a SELECT whose result
 * carries "id" and every parent-FK column, used only inside subqueries.
 * @typedef {{ sql: string, params: any[] }} Source
 */

/**
 * One planned expansion: a statement for the batch, and the step that
 * attaches its results to the parent rows.
 * @typedef {{ stmt: any, apply: (results: Record<string, any>[]) => void }} Step
 */

/** @param {Source} src @param {string} [col='id'] @returns {string} */
const selectFrom = (src, col = 'id') => `SELECT "${col}" FROM (${src.sql})`;

/**
 * Maps row.id → row.
 *
 * @param {Record<string, any>[]} rows - Parent rows.
 * @returns {Map<number, Record<string, any>>}
 */
function buildRowMap(rows) {
    /** @type {Map<number, Record<string, any>>} */
    const rowMap = new Map();
    for (const row of rows) rowMap.set(row.id, row);
    return rowMap;
}

/** Initialises `field` to [] on every row (unless an earlier step did — fac has two netixlan_set relations). */
function initSet(/** @type {Record<string, any>[]} */ rows, /** @type {string} */ field) {
    for (const row of rows) if (!Array.isArray(row[field])) row[field] = [];
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
 * Runs the main query and every expansion in ONE D1 batch, returning the
 * expanded rows (JSON columns parsed). Used by the /api list and detail
 * handlers for depth>0.
 *
 * `main` must select every column (build it without `?fields=`): it is also
 * the source the expansion statements select their parents through, and its
 * rows need "id" and the FK columns to attach results. `fields` (the caller's
 * ?fields=) is applied afterwards: base columns not listed are dropped, the
 * expansion keys (sets, parent objects) stay.
 *
 * @param {D1Session} db - The D1 database binding.
 * @param {EntityMeta} entity - Entity of the main rows.
 * @param {Source} main - Main query, all columns.
 * @param {number} depth - Depth level (1 or 2).
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @param {boolean} pdbfe - Whether to include pdbfe-local extension columns.
 * @param {boolean} detail - Detail view (GET /api/{tag}/{id}): expand every parent FK.
 * @param {string[]} [fields] - ?fields= projection, applied after expansion.
 * @returns {Promise<Record<string, any>[]>}
 */
export async function selectWithDepth(db, entity, main, depth, authenticated, pdbfe, detail, fields = []) {
    /** @type {Record<string, any>[]} */
    let rows = [];
    /** @type {Step[]} */
    const steps = [];
    if (depth > 0) planExpansion(db, entity, main, () => rows, depth, authenticated, pdbfe, detail, steps);

    const results = await db.batch([db.prepare(main.sql).bind(...main.params), ...steps.map(s => s.stmt)]); // ap-ok: cold path behind cachedQuery
    rows = results[0]?.results || [];
    for (const row of rows) parseJsonFields(entity, row);
    if (rows.length === 0) return rows;
    const baseKeys = Object.keys(rows[0]);
    for (let i = 0; i < steps.length; i++) steps[i].apply(results[i + 1]?.results || []);

    if (fields.length > 0) {
        const keep = new Set(fields);
        const drop = baseKeys.filter(k => !keep.has(k)); // ap-ok: once per request, cold path
        for (const row of rows) for (const k of drop) delete row[k];
    }
    return rows;
}

/**
 * Expands _set fields and parents on rows that are already fetched
 * (mutates them in place); all expansions in one batch. Used by the REST
 * worker, which fetches its rows first.
 *
 * - depth=0: no expansion.
 * - depth=1: each _set is an array of child ids.
 * - depth=2: each _set holds full child objects (FK back to the parent kept).
 * - Parents: see the file overview (`detail` selects upstream's detail-view
 *   behaviour; lists expand org only).
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
 * @param {boolean} [detail=false] - Detail view: expand every parent FK.
 * @returns {Promise<void>} Resolves when expansion is complete.
 */
export async function expandDepth(db, entity, rows, depth, authenticated = false, pdbfe = false, detail = false) {
    if (depth === 0 || rows.length === 0) return;

    const fkCols = parentFks(entity, true).map(f => `, "${f.name}"`).join(''); // ap-ok: cold path behind cachedQuery
    const ids = rows.map(r => r.id); // ap-ok: cold path behind cachedQuery
    /** @type {Source} */
    const src = { sql: `SELECT "id"${fkCols} FROM "${entity.table}" WHERE "id" IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(ids)] };

    /** @type {Step[]} */
    const steps = [];
    planExpansion(db, entity, src, () => rows, depth, authenticated, pdbfe, detail, steps);
    if (steps.length === 0) return;
    const results = await db.batch(steps.map(s => s.stmt)); // ap-ok: cold path behind cachedQuery
    for (let i = 0; i < steps.length; i++) steps[i].apply(results[i]?.results || []);
}

/**
 * Plans every expansion of the rows produced by `src`: child sets, sets
 * through a link table, and parents (recursing into parents on a detail at
 * depth=2). Appends to `steps` in apply order.
 *
 * @param {D1Session} db
 * @param {EntityMeta} entity - Entity of the rows.
 * @param {Source} src - Source query for the rows.
 * @param {() => Record<string, any>[]} getRows - The rows, once fetched (read at apply time).
 * @param {number} depth - Depth level (≥1).
 * @param {boolean} authenticated
 * @param {boolean} pdbfe
 * @param {boolean} detail
 * @param {Step[]} steps - Mutated.
 */
function planExpansion(db, entity, src, getRows, depth, authenticated, pdbfe, detail, steps) {
    if (entity.relationships.length > 0) {
        if (depth >= 2) planDepthTwo(db, entity, src, getRows, authenticated, pdbfe, steps);
        else planDepthOne(db, entity, src, getRows, authenticated, steps);
    }
    if (THROUGH_SETS[entity.tag]) planThroughSets(db, entity, src, getRows, depth, authenticated, pdbfe, steps);
    planParents(db, entity, src, getRows, depth, authenticated, pdbfe, detail, steps);
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
 * Plans THROUGH_SETS: one statement per set, joined from the link table to
 * the target table.
 *
 * @param {D1Session} db
 * @param {EntityMeta} entity
 * @param {Source} src
 * @param {() => Record<string, any>[]} getRows
 * @param {number} depth - 1 (ids) or 2 (objects).
 * @param {boolean} authenticated - Caller auth state (gated target columns).
 * @param {boolean} pdbfe
 * @param {Step[]} steps
 */
function planThroughSets(db, entity, src, getRows, depth, authenticated, pdbfe, steps) {
    for (const ts of THROUGH_SETS[entity.tag]) {
        const target = ENTITIES[ts.targetTag];
        const from = ` FROM "${ts.link}" AS l JOIN "${target.table}" AS t ON t."id" = l."${ts.targetFk}"` +
            ` WHERE l."${ts.parentFk}" IN (${selectFrom(src)})`;

        if (depth >= 2) {
            const cols = getColumns(target, pdbfe).map(c => selectColumn(target.table, c, 't.', authenticated)).join(', '); // ap-ok: SQL construction
            const sql = `SELECT DISTINCT l."${ts.parentFk}" AS "__parent", ${cols}${from} ORDER BY t."id" ASC`;
            steps.push({
                stmt: db.prepare(sql).bind(...src.params),
                apply: (results) => {
                    const rows = getRows();
                    initSet(rows, ts.field);
                    const rowMap = buildRowMap(rows);
                    for (const child of results) {
                        const parentRow = rowMap.get(/** @type {number} */ (child.__parent));
                        if (!parentRow) continue;
                        delete child.__parent;
                        parseJsonFields(target, child);
                        parentRow[ts.field].push(child);
                    }
                },
            });
        } else {
            const sql = `SELECT DISTINCT l."${ts.parentFk}" AS "p", t."id" AS "c"${from} ORDER BY t."id" ASC`;
            steps.push({
                stmt: db.prepare(sql).bind(...src.params),
                apply: (results) => {
                    const rows = getRows();
                    initSet(rows, ts.field);
                    const rowMap = buildRowMap(rows);
                    for (const r of results) rowMap.get(/** @type {number} */ (r.p))?.[ts.field].push(r.c);
                },
            });
        }
    }
}

/**
 * Depth=1: per relationship, the child ids of all parent rows (one
 * statement each; an index-only lookup on the FK index).
 *
 * @param {D1Session} db
 * @param {EntityMeta} entity
 * @param {Source} src
 * @param {() => Record<string, any>[]} getRows
 * @param {boolean} authenticated
 * @param {Step[]} steps
 */
function planDepthOne(db, entity, src, getRows, authenticated, steps) {
    for (const rel of entity.relationships) {
        const childTag = TABLE_TO_TAG.get(rel.table);
        const childEntity = childTag ? ENTITIES[childTag] : null;
        const anonFilter = resolveAnonFilter(authenticated, childEntity);

        /** @type {any[]} */
        const params = [...src.params]; // ap-ok: cold path behind cachedQuery
        const sql = appendFilterAndOrder(
            `SELECT "id", "${rel.fk}" FROM "${rel.table}" WHERE "${rel.fk}" IN (${selectFrom(src)})`,
            params, anonFilter);

        steps.push({
            stmt: db.prepare(sql).bind(...params),
            apply: (results) => {
                const rows = getRows();
                initSet(rows, rel.field);
                const rowMap = buildRowMap(rows);
                for (const child of results) {
                    rowMap.get(/** @type {number} */ (child[rel.fk]))?.[rel.field].push(child.id);
                }
            },
        });
    }
}

/**
 * Depth=2: per relationship, full child objects of all parent rows (with
 * cross-entity name columns via LEFT JOINs where the relationship has
 * joinColumns). JSON-stored TEXT columns are parsed back to native values.
 *
 * Child objects keep the FK pointing back to the parent. Upstream keeps it
 * on some sets (campus.fac_set[].campus_id, carrier.carrierfac_set[].
 * carrier_id) and omits it on others; always keeping it is a superset.
 *
 * For restricted child entities (e.g. poc), anonymous callers only
 * see records matching the entity's anonFilter.
 *
 * @param {D1Session} db
 * @param {EntityMeta} entity
 * @param {Source} src
 * @param {() => Record<string, any>[]} getRows
 * @param {boolean} authenticated
 * @param {boolean} pdbfe
 * @param {Step[]} steps
 */
function planDepthTwo(db, entity, src, getRows, authenticated, pdbfe, steps) {
    for (const rel of entity.relationships) {
        // Child columns from the entity registry; fall back to SELECT * for an
        // unregistered (unexpected) child table.
        const childTag = TABLE_TO_TAG.get(rel.table);
        const childEntity = childTag ? ENTITIES[childTag] : null;
        const anonFilter = resolveAnonFilter(authenticated, childEntity);

        /** @type {string[]} */
        const childColumns = childEntity ? getColumns(childEntity, pdbfe).filter(c => c !== rel.fk) : []; // ap-ok: SQL construction

        /** @type {any[]} */
        const params = [...src.params]; // ap-ok: cold path behind cachedQuery
        const parentIds = selectFrom(src);
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
                joinParts.push(` LEFT JOIN "${j.table}" AS ${alias} ON t."${j.localFk}" = ${alias}."id"`);
                for (const [srcCol, aliasName] of Object.entries(j.columns)) {
                    joinCols.push(`${alias}."${srcCol}" AS "${aliasName}"`);
                }
            }
            const allCols = `t."${rel.fk}", ${baseCols}` + (joinCols.length > 0 ? `, ${joinCols.join(", ")}` : '');
            sql = appendFilterAndOrder(
                `SELECT ${allCols} FROM "${rel.table}" AS t${joinParts.join('')} WHERE t."${rel.fk}" IN (${parentIds})`,
                params, anonFilter, 't.');
        } else if (childColumns.length > 0) {
            const colExpr = childColumns.map(c => selectColumn(rel.table, c, '', authenticated)).join(", "); // ap-ok: SQL construction
            sql = appendFilterAndOrder(
                `SELECT "${rel.fk}", ${colExpr} FROM "${rel.table}" WHERE "${rel.fk}" IN (${parentIds})`,
                params, anonFilter);
        } else if (GATED_TABLES.has(rel.table)) {
            // Never SELECT * from a table with visibility-gated columns.
            throw new Error(`expandDepthTwo: no column list for gated table ${rel.table}`);
        } else {
            sql = appendFilterAndOrder(
                `SELECT * FROM "${rel.table}" WHERE "${rel.fk}" IN (${parentIds})`,
                params, anonFilter);
        }

        steps.push({
            stmt: db.prepare(sql).bind(...params),
            apply: (results) => {
                const rows = getRows();
                initSet(rows, rel.field);
                const rowMap = buildRowMap(rows);
                for (const child of results) {
                    const parentRow = rowMap.get(/** @type {number} */ (child[rel.fk]));
                    if (!parentRow) continue;
                    if (childEntity) parseJsonFields(childEntity, child);
                    parentRow[rel.field].push(child);
                }
            },
        });
    }
}

/**
 * Plans parent expansion (`row.<tag>` next to `row.<tag>_id`): one statement
 * per FK, selecting the parents through the source query. On a detail at
 * depth=2 the parents are expanded at depth 1 (their sets as id lists, their
 * own parents as objects), as upstream does — planned right after the parent
 * statement, with a source of their own.
 *
 * Gated parent columns (ixlan.ixf_ixp_member_list_url) go through
 * selectColumn, so anonymous callers get them nulled; api/auth_scope.js
 * marks those responses auth-sensitive.
 *
 * @param {D1Session} db
 * @param {EntityMeta} entity
 * @param {Source} src
 * @param {() => Record<string, any>[]} getRows
 * @param {number} depth - Requested depth (≥1).
 * @param {boolean} authenticated
 * @param {boolean} pdbfe
 * @param {boolean} detail - Detail view: every parent FK, recursing at depth=2.
 * @param {Step[]} steps
 */
function planParents(db, entity, src, getRows, depth, authenticated, pdbfe, detail, steps) {
    for (const fk of parentFks(entity, detail)) {
        const parentTag = /** @type {string} */ (fk.foreignKey);
        const parent = ENTITIES[parentTag];
        const parentIds = selectFrom(src, fk.name);

        /** @type {Record<string, any>[]} */
        let parents = [];
        const cols = getColumns(parent, pdbfe).map(c => selectColumn(parent.table, c, '', authenticated)).join(', '); // ap-ok: SQL construction
        steps.push({
            stmt: db.prepare(`SELECT ${cols} FROM "${parent.table}" WHERE "id" IN (${parentIds})`).bind(...src.params),
            apply: (results) => {
                parents = results;
                for (const p of parents) parseJsonFields(parent, p);
                const byId = buildRowMap(parents);
                for (const row of getRows()) {
                    const p = byId.get(row[fk.name]);
                    if (p) row[parentTag] = p;
                }
            },
        });

        if (detail && depth >= 2) {
            const parentFkCols = parentFks(parent, true).map(f => `, "${f.name}"`).join(''); // ap-ok: SQL construction
            /** @type {Source} */
            const parentSrc = { sql: `SELECT "id"${parentFkCols} FROM "${parent.table}" WHERE "id" IN (${parentIds})`, params: src.params };
            planExpansion(db, parent, parentSrc, () => parents, depth - 1, authenticated, pdbfe, true, steps);
        }
    }
}
