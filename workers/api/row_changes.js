/**
 * @fileoverview Per-object If-Modified-Since: the API worker's reader of
 * _row_changes (written by sync/row_changes.js).
 *
 * The isolate keeps the table in memory — per entity and depth, id → the
 * time the detail response last changed — and answers a detail request's
 * If-Modified-Since from it, without touching cache or D1:
 *
 *   304 when the IMS is within IMS_WINDOW_S and neither the object's mark
 *   nor its entity's whole-entity marker (id 0) at the requested depth is
 *   at or after the IMS.
 *
 * At-or-after, not after: a mark carries its sync's start time, which is
 * also the entity's new last_modified_at. A client whose copy came from a
 * read replica that had not caught up yet holds that same Last-Modified on
 * pre-change content; it must get a 200, not a 304. The cost is a 200 for
 * objects changed in their entity's latest sync until the next one.
 *
 * Loading: the whole table on the first sync poll, then — whenever the poll
 * sees last_modified_at move — the rows from the lowest new value on. The
 * sync writes marks before advancing last_modified_at, so a moved version
 * means its marks are there. From a moved version until those marks are
 * applied, ready() is false and the caller falls back to the per-entity
 * check. A changed entity's L1 cache is purged when its marks arrive: they
 * also cover changes made through another entity (an org rename changes
 * net/{id}?depth=1), which the per-entity purge misses.
 *
 * Hot path (ready, isUnchangedSince): Map lookups, no allocation.
 */

import { getEntityCache } from './cache.js';

/** If-Modified-Since older than this falls back to the per-entity check (retention is 25h). */
export const IMS_WINDOW_S = 24 * 3600;

/** Entries older than this are dropped (sync/row_changes.js ROW_CHANGES_RETENTION_S). */
const RETENTION_S = 25 * 3600;

/** Minimum gap between fetch attempts, so a failing D1 is not retried on every request. */
const FETCH_RETRY_MS = 5_000;

const FETCH_SQL = 'SELECT "entity", "id", "d0_at", "d1_at", "d2_at" FROM "_row_changes" WHERE "d2_at" >= ?';

/**
 * @typedef {{ from: number, gen: number }} RowChangesFetch
 */

/**
 * Creates a reader. One per isolate (the module exports it); tests make
 * their own.
 *
 * @param {{ purge: (tag: string) => void }} opts - purge: drop an entity's L1 cache.
 */
export function createRowChanges({ purge }) {
    /**
     * Per entity: [depth 0, depth 1, depth 2] maps of id → change time.
     * @type {Map<string, Array<Map<number, number>>>}
     */
    const marks = new Map();
    let loaded = false;
    /** Lowest d2_at still to fetch, or -1 when up to date. */
    let dueFrom = -1;
    /** Bumped on every version change, so a fetch that raced one is repeated. */
    let gen = 0;
    let fetching = false;
    let lastAttempt = -Infinity;

    /**
     * Sync-state hook (core/sync_state.js onPollApplied): versions moved, so
     * there are marks to fetch from the lowest new version on (all of them
     * on the initial poll).
     *
     * @param {Array<[string, number]>} changes
     * @param {boolean} initial
     */
    function onPollApplied(changes, initial) {
        let from = initial ? 0 : Infinity;
        for (const [, version] of changes) if (version < from) from = version;
        if (from === Infinity) return;
        dueFrom = dueFrom < 0 ? from : Math.min(dueFrom, from);
        gen++;
    }

    /**
     * Claims the due fetch, if any.
     * @param {number} now - Epoch ms.
     * @returns {RowChangesFetch|null}
     */
    function claimFetch(now) {
        if (dueFrom < 0 || fetching || now - lastAttempt < FETCH_RETRY_MS) return null;
        fetching = true;
        lastAttempt = now;
        return { from: dueFrom, gen };
    }

    /**
     * Runs a claimed fetch (in ctx.waitUntil) and applies it.
     * @param {D1Session} db
     * @param {RowChangesFetch} f
     * @returns {Promise<void>}
     */
    async function runFetch(db, f) {
        try {
            const res = await db.prepare(FETCH_SQL).bind(f.from).all();
            apply(res?.results || [], Math.floor(Date.now() / 1000));
            if (f.from === 0) loaded = true;
            if (gen === f.gen) dueFrom = -1;
        } catch (err) {
            console.error('[row_changes] fetch failed:', err);
        } finally {
            fetching = false;
        }
    }

    /**
     * Merges fetched rows, purges the L1 cache of every entity they touch,
     * and drops entries past retention.
     * @param {Record<string, any>[]} rows
     * @param {number} nowS
     */
    function apply(rows, nowS) {
        /** @type {Set<string>} */
        const touched = new Set();
        for (const r of rows) {
            const tag = /** @type {string} */ (r.entity);
            let byDepth = marks.get(tag);
            if (!byDepth) {
                byDepth = [new Map(), new Map(), new Map()];
                marks.set(tag, byDepth);
            }
            for (let d = 0; d < 3; d++) {
                const ts = /** @type {number} */ (r[`d${d}_at`]);
                if (ts > 0 && !(/** @type {number} */ (byDepth[d].get(r.id)) >= ts)) byDepth[d].set(r.id, ts);
            }
            touched.add(tag);
        }
        for (const tag of touched) purge(tag);

        const cutoff = nowS - RETENTION_S;
        for (const byDepth of marks.values()) {
            for (const m of byDepth) for (const [id, ts] of m) if (ts < cutoff) m.delete(id);
        }
    }

    /**
     * Whether isUnchangedSince can be used: the table is loaded and every
     * version change seen so far has its marks applied.
     * @returns {boolean}
     */
    function ready() {
        return loaded && dueFrom < 0;
    }

    /**
     * Whether a detail response is unchanged since `imsS` (call only when
     * ready()).
     *
     * @param {string} tag
     * @param {number} id
     * @param {number} depth - 0, 1 or 2.
     * @param {number} imsS - If-Modified-Since, epoch seconds.
     * @param {number} nowS - Current time, epoch seconds.
     * @returns {boolean}
     */
    function isUnchangedSince(tag, id, depth, imsS, nowS) {
        if (imsS < nowS - IMS_WINDOW_S) return false;
        const byDepth = marks.get(tag);
        if (!byDepth) return true;
        const m = byDepth[depth];
        const whole = m.get(0);
        if (whole !== undefined && whole >= imsS) return false;
        const own = m.get(id);
        return own === undefined || own < imsS;
    }

    return { onPollApplied, claimFetch, runFetch, ready, isUnchangedSince };
}

const reader = createRowChanges({ purge: (tag) => getEntityCache(tag)?.purge() });

export const onRowChangesPoll = reader.onPollApplied;
export const claimRowChangesFetch = reader.claimFetch;
export const runRowChangesFetch = reader.runFetch;
export const rowChangesReady = reader.ready;
export const isUnchangedSince = reader.isUnchangedSince;
