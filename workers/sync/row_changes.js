/**
 * @fileoverview Changed-row log for If-Modified-Since (pdbfe-sync).
 *
 * _row_changes records which rows the sync changed, and when — nothing
 * about which responses show them. Per (entity, id):
 *
 *   row_at — the row itself was written or deleted
 *   set_at — a row joined or left one of its child sets: a child was added,
 *            deleted, moved to another parent (old and new parent both), or
 *            changed its anonymous visibility (poc.visible). Only the direct
 *            parent; nothing further up.
 *
 * The API's depth expansion knows which rows make up a response and checks
 * them against this table itself, so the rules for what a response contains
 * live in one place (api/depth.js). set_at covers the one thing that check
 * cannot see from the current rows: a child that is no longer there.
 *
 * id 0 is a whole-entity marker (migration, bootstrap: every row changed).
 *
 * Marks are written after the data and before _sync_meta advances. Entries
 * older than ROW_CHANGES_RETENTION_S are pruned once per run.
 */

import { ENTITIES } from './entities.js';
import { THROUGH_SETS } from '../core/relations.js';

/** Rows older than this are pruned; readers must use a shorter window. */
export const ROW_CHANGES_RETENTION_S = 25 * 3600;

/** Statements per D1 batch (D1 caps a batch at 100). */
const BATCH_SIZE = 50;

/** @type {Map<string, string>} */
const TABLE_TO_TAG = new Map(Object.entries(ENTITIES).map(([tag, e]) => [e.table, tag]));

/**
 * Per child entity: the parents whose sets list its rows, as parent tag and
 * FK column on the child — child sets and through-set link tables.
 *
 * @type {Map<string, Array<{tag: string, fk: string}>>}
 */
const LISTED_BY = new Map();

/** @param {string} child @param {string} tag @param {string} fk */
function addListing(child, tag, fk) {
    let list = LISTED_BY.get(child);
    if (!list) {
        list = [];
        LISTED_BY.set(child, list);
    }
    if (!list.some(l => l.tag === tag && l.fk === fk)) list.push({ tag, fk });
}

for (const [tag, entity] of Object.entries(ENTITIES)) {
    for (const rel of entity.relationships) {
        const child = TABLE_TO_TAG.get(rel.table);
        if (child) addListing(child, tag, rel.fk);
    }
}
for (const [tag, sets] of Object.entries(THROUGH_SETS)) {
    for (const ts of sets) {
        const link = TABLE_TO_TAG.get(ts.link);
        if (link) addListing(link, tag, ts.parentFk);
    }
}

/**
 * Columns of a `tag` row that name a parent listing it in a set. Their old
 * values must be read before a write: a row that moves or is deleted leaves
 * its old parent's set.
 *
 * @param {string} tag
 * @returns {string[]}
 */
export function upwardFkColumns(tag) {
    return [...new Set((LISTED_BY.get(tag) || []).map(l => l.fk))];
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
 * Builds the statements that record a batch of changed rows of one entity:
 * row_at for the rows, set_at for the direct parents of rows that joined or
 * left a set.
 *
 * @param {D1Database} db
 * @param {string} tag - Entity of the changed rows.
 * @param {number} ts - Change time (epoch seconds; the sync run's `now`).
 * @param {RowChange} change
 * @returns {any[]} Prepared statements.
 */
export function planRowChanges(db, tag, ts, { ids, deletedIds, before, after }) {
    if (!ENTITIES[tag] || ids.length === 0) return [];
    /** @type {any[]} */
    const stmts = [];
    /** @param {string} entity @param {number[]} markIds @param {'row_at'|'set_at'} col */
    const mark = (entity, markIds, col) => {
        stmts.push(db.prepare(
            `INSERT INTO "_row_changes" ("entity", "id", "row_at", "set_at") SELECT ?, value, ?, ? FROM json_each(?) WHERE value > 0` +
            ` ON CONFLICT ("entity", "id") DO UPDATE SET "${col}" = max("${col}", excluded."${col}")`
        ).bind(entity, col === 'row_at' ? ts : 0, col === 'set_at' ? ts : 0, JSON.stringify(markIds)));
    };

    mark(tag, ids, 'row_at');

    // Rows that joined or left a set: added, deleted, moved, visibility
    // changed. Their old and new parents' sets changed.
    const old = new Map(before.map(r => [r.id, r]));
    const deleted = new Set(deletedIds);
    const cur = new Map(after.filter(r => !deleted.has(r.id)).map(r => [r.id, r]));
    const cols = membershipColumns(tag);
    /** @type {Array<Record<string, any>|undefined>} */
    const moved = [];
    for (const id of ids) {
        const o = old.get(id);
        const c = cur.get(id);
        if (!o || !c || cols.some(col => (o[col] ?? null) !== (c[col] ?? null))) moved.push(o, c);
    }
    for (const l of LISTED_BY.get(tag) || []) {
        const parents = idsIn(moved, l.fk);
        if (parents.length > 0) mark(l.tag, parents, 'set_at');
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
    const cutoff = now - ROW_CHANGES_RETENTION_S;
    await db.prepare('DELETE FROM "_row_changes" WHERE "row_at" < ? AND "set_at" < ?').bind(cutoff, cutoff).run();
}
