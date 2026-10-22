/**
 * @fileoverview Per-object change tracking for If-Modified-Since (pdbfe-sync).
 *
 * _sync_meta.last_modified_at moves for a whole entity type whenever any of
 * its rows changes — every 15-minute run for the busy types — so a per-type
 * If-Modified-Since check rarely answers 304. _row_changes records, per
 * detail response (entity, id), when it last changed at each depth:
 *
 *   d0_at — GET /api/{entity}/{id}            (depth=0)
 *   d1_at — GET /api/{entity}/{id}?depth=1    (≥ d0_at)
 *   d2_at — GET /api/{entity}/{id}?depth=2    (≥ d1_at)
 *
 * A reader answers 304 for depth d when the client's If-Modified-Since is
 * within the retention window and dN_at for that object is not later than
 * it. id 0 is a whole-entity marker (bootstrap: every object changed).
 *
 * A response changes not only when its own row does. The rules below mirror
 * api/depth.js (and the joinColumns of api/query.js) for a changed row R of
 * entity C:
 *
 *   own row      R itself                                          → depth 0
 *   parents      T rows whose parent FK points at R (net.org, and
 *                the joined net.org_name at depth≥1)               → depth 1
 *   joinColumns  T rows joining R's columns through a non-parent
 *                FK (none today; depth=0 omits joined columns)     → depth 1
 *   child sets   T rows listing R in a _set: membership (R added,
 *                deleted, moved, or its anonymous visibility
 *                changed; old and new parents)                     → depth 1
 *                any other change (full objects at depth 2)        → depth 2
 *   set joins    T rows whose depth-2 _set rows join R's columns,
 *                and ix.fac_set / ixlan.net_set objects            → depth 2
 *   through sets ix.fac_set / ixlan.net_set ids when R is added
 *                or deleted                                        → depth 1
 *   grandparent  at depth 2 each parent P is expanded at depth 1, so every
 *                depth-1 change of P marks P's children            → depth 2
 *
 * tests/unit/sync/row_changes_sqlite.test.js renders every detail at every
 * depth through the API worker before and after a change and checks that
 * each response that changed was marked — keep it passing when depth.js
 * changes.
 *
 * Marks are written after the data and before _sync_meta advances. A
 * response served in between carries the old Last-Modified, and the mark is
 * later than that, so the next revalidation returns 200.
 */

import { ENTITIES } from './entities.js';
import { THROUGH_SETS, isParentFk } from '../core/relations.js';

/** Rows older than this are pruned; readers must use a shorter window. */
export const ROW_CHANGES_RETENTION_S = 25 * 3600;

/** Statements per D1 batch (D1 caps a batch at 100). */
const BATCH_SIZE = 50;

/**
 * An id source for a mark: a SELECT yielding a column named "id".
 * @typedef {{ sql: string, params: any[] }} IdSource
 */

/**
 * @typedef {{
 *   joinedBy: Array<{tag: string, table: string, localFk: string}>,
 *   listedBy: Array<{tag: string, fk: string}>,
 *   children: Array<{tag: string, table: string, fk: string}>,
 *   setJoinedBy: Array<{tag: string, table: string, setFk: string, localFk: string}>,
 *   throughTargetOf: Array<{tag: string, link: string, parentFk: string, targetFk: string}>,
 * }} Rules
 */

/**
 * Per entity tag: who shows its rows, derived once from ENTITIES and
 * THROUGH_SETS.
 *
 * @type {Map<string, Rules>}
 */
const RULES = new Map();
for (const tag of Object.keys(ENTITIES)) {
    RULES.set(tag, { joinedBy: [], listedBy: [], children: [], setJoinedBy: [], throughTargetOf: [] });
}
/** @type {Map<string, string>} */
const TABLE_TO_TAG = new Map(Object.entries(ENTITIES).map(([tag, e]) => [e.table, tag]));

for (const [tag, entity] of Object.entries(ENTITIES)) {
    // depth=0 leaves joined columns out (api/query.js buildJsonQuery); depth≥1
    // shows them, but a join through a parent FK is covered by the parent
    // rule already. Only a join through any other FK needs its own mark.
    const parentFkNames = new Set(entity.fields.filter(f => isParentFk(ENTITIES, f)).map(f => f.name));
    for (const j of entity.joinColumns || []) {
        const src = TABLE_TO_TAG.get(j.table);
        if (src && !parentFkNames.has(j.localFk)) RULES.get(src)?.joinedBy.push({ tag, table: entity.table, localFk: j.localFk });
    }
    for (const rel of entity.relationships) {
        const child = TABLE_TO_TAG.get(rel.table);
        if (child) RULES.get(child)?.listedBy.push({ tag, fk: rel.fk });
        for (const j of rel.joinColumns || []) {
            const src = TABLE_TO_TAG.get(j.table);
            if (src) RULES.get(src)?.setJoinedBy.push({ tag, table: rel.table, setFk: rel.fk, localFk: j.localFk });
        }
    }
    for (const f of entity.fields) {
        if (isParentFk(ENTITIES, f)) RULES.get(/** @type {string} */ (f.foreignKey))?.children.push({ tag, table: entity.table, fk: f.name });
    }
}
for (const [tag, sets] of Object.entries(THROUGH_SETS)) {
    for (const ts of sets) {
        const link = TABLE_TO_TAG.get(ts.link);
        const listed = link ? RULES.get(link)?.listedBy : undefined;
        if (listed && !listed.some(l => l.tag === tag && l.fk === ts.parentFk)) listed.push({ tag, fk: ts.parentFk });
        RULES.get(ts.targetTag)?.throughTargetOf.push({ tag, link: ts.link, parentFk: ts.parentFk, targetFk: ts.targetFk });
        // The depth-2 target objects are the same marks as a set join on the link rows.
        const target = RULES.get(ts.targetTag);
        if (target && !target.setJoinedBy.some(s => s.tag === tag && s.table === ts.link && s.setFk === ts.parentFk && s.localFk === ts.targetFk)) {
            target.setJoinedBy.push({ tag, table: ts.link, setFk: ts.parentFk, localFk: ts.targetFk });
        }
    }
}

/**
 * Columns of a `tag` row that name a response listing it in a set (child
 * sets and through sets). Their old values must be read before a write:
 * a row that moves or is deleted changes its old parent's sets too.
 *
 * @param {string} tag
 * @returns {string[]}
 */
export function upwardFkColumns(tag) {
    return [...new Set((RULES.get(tag)?.listedBy || []).map(l => l.fk))];
}

/**
 * Columns whose change moves a `tag` row in or out of a set: the upward FKs
 * and the anonymous-visibility field (poc.visible — anonymous sets list
 * public rows only).
 *
 * @param {string} tag
 * @returns {string[]}
 */
function membershipColumns(tag) {
    const anon = ENTITIES[tag]._anonFilter?.field;
    const cols = upwardFkColumns(tag);
    return anon && !cols.includes(anon) ? [...cols, anon] : cols;
}

/**
 * Reads id and the membership columns of the given ids, before they are
 * overwritten or deleted (the `before` of planRowChanges). The result's
 * length is also how many of the ids already exist.
 *
 * @param {D1Database} db
 * @param {string} tag
 * @param {number[]} ids
 * @returns {Promise<Record<string, any>[]>}
 */
export async function readMembership(db, tag, ids) {
    if (ids.length === 0) return [];
    const cols = membershipColumns(tag).map(c => `, "${c}"`).join('');
    const res = await db.prepare(
        `SELECT "id"${cols} FROM "${ENTITIES[tag].table}" WHERE "id" IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify(ids)).all();
    return res.results || [];
}

/** @param {number[]} ids @returns {IdSource} */
const literal = (ids) => ({ sql: 'SELECT value AS id FROM json_each(?)', params: [JSON.stringify(ids)] });

/**
 * `table`.`outCol` of the rows whose `inCol` is one of `src`'s ids.
 * @param {string} table @param {string} outCol @param {string} inCol @param {IdSource} src
 * @returns {IdSource}
 */
const via = (table, outCol, inCol, src) => ({
    sql: `SELECT "${outCol}" AS id FROM "${table}" WHERE "${inCol}" IN (SELECT id FROM (${src.sql}))`,
    params: src.params,
});

const UPSERT_TAIL = ' WHERE id > 0 ON CONFLICT ("entity", "id") DO UPDATE SET' +
    ' "d0_at" = max("d0_at", excluded."d0_at"), "d1_at" = max("d1_at", excluded."d1_at"), "d2_at" = max("d2_at", excluded."d2_at")';

/**
 * Distinct positive integer values of `col` over `rows`.
 * @param {Array<Record<string, any>|undefined>} rows @param {string} col
 * @returns {number[]}
 */
function idsIn(rows, col) {
    /** @type {Set<number>} */
    const out = new Set();
    for (const r of rows) {
        const v = r?.[col];
        if (Number.isInteger(v) && v > 0) out.add(v);
    }
    return [...out];
}

/**
 * @typedef {{ ids: number[], deletedIds: number[], before: Record<string, any>[], after: Record<string, any>[] }} RowChange
 *   ids: every changed id (written or deleted); deletedIds: those deleted;
 *   before: the stored rows' membership columns, read before the write
 *   (readMembership); after: the written rows.
 */

/**
 * Builds the statements that record a batch of changed rows of one entity.
 *
 * @param {D1Database} db
 * @param {string} tag - Entity of the changed rows.
 * @param {number} ts - Change time (epoch seconds; the sync run's `now`).
 * @param {RowChange} change
 * @returns {any[]} Prepared statements.
 */
export function planRowChanges(db, tag, ts, { ids, deletedIds, before, after }) {
    const rules = RULES.get(tag);
    if (!rules || ids.length === 0) return [];

    // Split the ids: rows that entered or left a set (added, deleted, moved,
    // visibility changed) change their parents' depth-1 id lists; any other
    // change shows only in the parents' depth-2 objects.
    const old = new Map(before.map(r => [r.id, r]));
    const deleted = new Set(deletedIds);
    const cur = new Map(after.filter(r => !deleted.has(r.id)).map(r => [r.id, r]));
    const cols = membershipColumns(tag);
    /** @type {Array<Record<string, any>|undefined>} */
    const moved = [];
    /** @type {Array<Record<string, any>|undefined>} */
    const updated = [];
    /** @type {number[]} */
    const existence = [];
    for (const id of ids) {
        const o = old.get(id);
        const c = cur.get(id);
        if (!o || !c) {
            existence.push(id);
            moved.push(o, c);
        } else if (cols.some(col => (o[col] ?? null) !== (c[col] ?? null))) {
            moved.push(o, c);
        } else {
            updated.push(c);
        }
    }

    /** @type {any[]} */
    const stmts = [];

    /** @param {string} target @param {IdSource} src @param {0|1|2} depth */
    const mark = (target, src, depth) => {
        stmts.push(db.prepare(
            `INSERT INTO "_row_changes" ("entity", "id", "d0_at", "d1_at", "d2_at") SELECT ?, id, ?, ?, ? FROM (${src.sql})${UPSERT_TAIL}`
        ).bind(target, depth === 0 ? ts : 0, depth <= 1 ? ts : 0, ts, ...src.params));
    };
    /** A depth-1 change of `target`: its children show it, expanded at depth 1, at depth 2. */
    /** @param {string} target @param {IdSource} src */
    const markDepthOne = (target, src) => {
        mark(target, src, 1);
        for (const c of RULES.get(target)?.children || []) mark(c.tag, via(c.table, 'id', c.fk, src), 2);
    };

    const self = literal(ids);
    mark(tag, self, 0);
    for (const j of rules.joinedBy) mark(j.tag, via(j.table, 'id', j.localFk, self), 1);
    for (const l of rules.listedBy) {
        const sets = idsIn(moved, l.fk);
        if (sets.length > 0) markDepthOne(l.tag, literal(sets));
        const objects = idsIn(updated, l.fk);
        if (objects.length > 0) mark(l.tag, literal(objects), 2);
    }
    for (const c of rules.children) markDepthOne(c.tag, via(c.table, 'id', c.fk, self));
    for (const s of rules.setJoinedBy) mark(s.tag, via(s.table, s.setFk, s.localFk, self), 2);
    // An added or deleted through-set target enters or leaves the depth-1 id
    // list as well (its depth-2 object is a set join, above).
    if (existence.length > 0) {
        for (const t of rules.throughTargetOf) markDepthOne(t.tag, via(t.link, t.parentFk, t.targetFk, literal(existence)));
    }
    return stmts;
}

/**
 * Records a batch of changed rows (see planRowChanges). Call after the rows
 * are written and before _sync_meta advances.
 *
 * @param {D1Database} db
 * @param {string} tag
 * @param {number} ts
 * @param {RowChange} change
 * @returns {Promise<void>}
 */
export async function recordRowChanges(db, tag, ts, change) {
    const stmts = planRowChanges(db, tag, ts, change);
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
        // Sequential on purpose: D1 caps a batch at 100 statements.
        await db.batch(stmts.slice(i, i + BATCH_SIZE)); // NOSONAR
    }
}

/**
 * Drops entries older than the retention window.
 *
 * @param {D1Database} db
 * @param {number} now - Epoch seconds.
 * @returns {Promise<void>}
 */
export async function pruneRowChanges(db, now) {
    await db.prepare('DELETE FROM "_row_changes" WHERE "d2_at" < ?').bind(now - ROW_CHANGES_RETENTION_S).run();
}
