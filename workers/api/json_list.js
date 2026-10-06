/**
 * @fileoverview depth=0 list execution with a chunked fallback for results
 * too large for a single SQLite value.
 *
 * The hot path builds the whole `{"data":[...],"meta":{}}` envelope inside
 * D1 with json_group_array — one query, one string, no per-row V8 work. D1
 * caps the size of a single string/blob, so whole-table dumps of the wide or
 * large tables (netixlan, netfac, net without `fields=`) fail with
 * SQLITE_TOOBIG. Only then do we re-run the same query in id-ordered pages
 * and splice the page arrays together as bytes.
 *
 * Shared by the api and rest list handlers.
 */

import { buildJsonQuery, MAX_PAGE_LIMIT } from './query.js';
import { encoder } from './http.js';

/** Envelope produced by buildJsonQuery's json_object('data',…,'meta',json_object()). */
const PREFIX = '{"data":[';
const SUFFIX = '],"meta":{}}';

/** First page size for the fallback; halved on SQLITE_TOOBIG down to CHUNK_MIN. */
const CHUNK_START = 5000;
const CHUNK_MIN = 250;

/**
 * Whether a D1 error is SQLite's "string or blob too big".
 *
 * @param {unknown} err - Error thrown by a D1 call.
 * @returns {boolean}
 */
export function isTooBig(err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    return msg.includes('SQLITE_TOOBIG') || msg.includes('string or blob too big');
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
    const { sql, params } = buildJsonQuery(entity, filters, opts);
    try {
        const row = await db.prepare(sql).bind(...params).first();
        return row?.payload ? encoder.encode(/** @type {string} */ (row.payload)) : null;
    } catch (err) {
        if (!isTooBig(err)) throw err;
    }
    return queryJsonListChunked(db, entity, filters, opts);
}

/**
 * Fallback: runs the list query in pages of at most `size` rows over the
 * caller's window (skip … skip+limit), halving the page on SQLITE_TOOBIG,
 * and joins the page arrays into one envelope. Pages are ordered by the
 * query's ORDER BY, which always ends in an id tiebreak, so OFFSET paging
 * neither repeats nor drops rows.
 *
 * @param {D1Session} db - D1 session.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed filters.
 * @param {QueryOpts} opts - Query options.
 * @returns {Promise<Uint8Array>} Envelope bytes.
 */
async function queryJsonListChunked(db, entity, filters, opts) {
    const window = opts.limit > 0 && opts.limit < MAX_PAGE_LIMIT ? opts.limit : MAX_PAGE_LIMIT;
    const baseSkip = Math.max(opts.skip, 0);

    /** @type {Uint8Array[]} */
    const pages = [];
    let bytes = 0;
    let offset = 0;
    let size = CHUNK_START;

    while (offset < window) {
        const want = Math.min(size, window - offset);
        /** @type {QueryOpts} */
        const pageOpts = {
            depth: 0, limit: want, skip: baseSkip + offset, since: opts.since,
            sort: opts.sort, fields: opts.fields, pdbfe: opts.pdbfe, authenticated: opts.authenticated,
        };
        const { sql, params } = buildJsonQuery(entity, filters, pageOpts);

        /** @type {string} */
        let payload;
        try {
            const row = await db.prepare(sql).bind(...params).first();
            payload = /** @type {string} */ (row?.payload ?? '');
        } catch (err) {
            if (!isTooBig(err) || size <= CHUNK_MIN) throw err;
            size = Math.max(CHUNK_MIN, size >> 1);
            continue;
        }

        if (!payload.startsWith(PREFIX) || !payload.endsWith(SUFFIX)) {
            throw new Error('queryJsonListChunked: unexpected payload envelope');
        }
        const inner = payload.slice(PREFIX.length, payload.length - SUFFIX.length);
        if (inner.length === 0) break;

        const page = encoder.encode(inner);
        pages.push(page);
        bytes += page.length;
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
