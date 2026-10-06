/**
 * @fileoverview depth=0 list execution that never asks D1 for a whole large
 * table in one statement.
 *
 * The hot path builds the `{"data":[...],"meta":{}}` envelope inside D1 with
 * json_group_array — one query, one string, no per-row V8 work. For a large
 * table that single statement fails: SQLITE_TOOBIG when the string passes
 * D1's max value size, or SQLITE_NOMEM when the aggregate exhausts D1's
 * memory — and NOMEM is not contained to the request: concurrent queries on
 * the same database (including the sync poll) fail with it too.
 *
 * So:
 *   - windows of at most PAGE_START rows (explicit small limit) run as one
 *     query, as before;
 *   - unbounded or large windows are fetched in pages from the start. Each
 *     page also returns its row count, so a result that fits in the first
 *     page still costs exactly one query. Page size adapts to payload bytes:
 *     doubled while pages stay small, halved on TOOBIG / NOMEM.
 *
 * Shared by the api and rest list handlers.
 */

import { buildJsonQuery, MAX_PAGE_LIMIT } from './query.js';
import { encoder } from './http.js';

/** Envelope produced by buildJsonQuery's json_object('data',…,'meta',json_object()). */
const PREFIX = '{"data":[';
const SUFFIX = '],"meta":{}}';

/** First page size, and the largest window still run as a single query. */
const PAGE_START = 2000;
const PAGE_MIN = 250;
const PAGE_MAX = 32_000;
/** Pages under this many bytes double the next page size. */
const PAGE_GROW_BELOW = 1_000_000;

/**
 * Whether a D1 error means the statement's result was too large to build:
 * SQLITE_TOOBIG (value over D1's max length) or SQLITE_NOMEM (out of memory).
 *
 * @param {unknown} err - Error thrown by a D1 call.
 * @returns {boolean}
 */
export function isTooLarge(err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    return msg.includes('SQLITE_TOOBIG') || msg.includes('string or blob too big')
        || msg.includes('SQLITE_NOMEM') || msg.includes('out of memory');
}

/**
 * Executes a depth=0 list query and returns the JSON envelope bytes.
 *
 * @param {D1Session} db - D1 session.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed filters.
 * @param {QueryOpts} opts - Query options (depth must be 0).
 * @returns {Promise<Uint8Array|null>} Envelope bytes, or null when D1 returned no payload.
 */
export async function queryJsonList(db, entity, filters, opts) {
    if (opts.limit > 0 && opts.limit <= PAGE_START) {
        const { sql, params } = buildJsonQuery(entity, filters, opts);
        try {
            const row = await db.prepare(sql).bind(...params).first();
            return row?.payload ? encoder.encode(/** @type {string} */ (row.payload)) : null;
        } catch (err) {
            if (!isTooLarge(err)) throw err;
        }
    }
    return queryJsonListPaged(db, entity, filters, opts);
}

/**
 * Runs the list query in pages over the caller's window (skip … skip+limit)
 * and joins the page arrays into one envelope. Pages follow the query's
 * ORDER BY, which always ends in an id tiebreak, so OFFSET paging neither
 * repeats nor drops rows.
 *
 * @param {D1Session} db - D1 session.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed filters.
 * @param {QueryOpts} opts - Query options.
 * @returns {Promise<Uint8Array>} Envelope bytes.
 */
async function queryJsonListPaged(db, entity, filters, opts) {
    const window = opts.limit > 0 && opts.limit < MAX_PAGE_LIMIT ? opts.limit : MAX_PAGE_LIMIT;
    const baseSkip = Math.max(opts.skip, 0);

    /** @type {Uint8Array[]} */
    const pages = [];
    let bytes = 0;
    let offset = 0;
    let size = PAGE_START;

    while (offset < window) {
        const want = Math.min(size, window - offset);
        /** @type {QueryOpts} */
        const pageOpts = {
            depth: 0, limit: want, skip: baseSkip + offset, since: opts.since,
            sort: opts.sort, fields: opts.fields, pdbfe: opts.pdbfe, authenticated: opts.authenticated,
        };
        const { sql, params } = buildJsonQuery(entity, filters, pageOpts, null, true);

        /** @type {any} */
        let row;
        try {
            row = await db.prepare(sql).bind(...params).first();
        } catch (err) {
            if (!isTooLarge(err) || size <= PAGE_MIN) throw err;
            size = Math.max(PAGE_MIN, size >> 1);
            continue;
        }

        const payload = /** @type {string} */ (row?.payload ?? '');
        const n = Number(row?.n ?? 0);
        if (n > 0) {
            if (!payload.startsWith(PREFIX) || !payload.endsWith(SUFFIX)) {
                throw new Error('queryJsonListPaged: unexpected payload envelope');
            }
            const page = encoder.encode(payload.slice(PREFIX.length, payload.length - SUFFIX.length));
            pages.push(page);
            bytes += page.length;
            if (page.length < PAGE_GROW_BELOW && size < PAGE_MAX) size = Math.min(PAGE_MAX, size * 2);
        }
        if (n < want) break; // last page
        offset += want;
    }

    // PREFIX + pages joined by ',' + SUFFIX, assembled once.
    const head = encoder.encode(PREFIX);
    const tail = encoder.encode(SUFFIX);
    const out = new Uint8Array(head.length + bytes + Math.max(pages.length - 1, 0) + tail.length);
    let pos = 0;
    out.set(head, pos); pos += head.length;
    for (let i = 0; i < pages.length; i++) {
        if (i > 0) out[pos++] = 0x2c; // ','
        out.set(pages[i], pos); pos += pages[i].length;
    }
    out.set(tail, pos);
    return out;
}
