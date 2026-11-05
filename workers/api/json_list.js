/**
 * @fileoverview depth=0 list execution: D1 builds the JSON, the worker
 * forwards it.
 *
 * The hot path builds the `{"data":[...],"meta":{}}` envelope inside D1 with
 * json_group_array — one query, one string, no per-row V8 work. D1 refuses a
 * single computed string much over 7.5 MB (SQLITE_TOOBIG, measured on
 * production on 2026-11-05: 7.58 MB built, ~8.85 MB failed), and an aggregate
 * that exhausts D1's memory fails with SQLITE_NOMEM — which also fails
 * concurrent queries on the same database, the sync poll included.
 *
 * So every query asks for at most one page of the entity's PAGE_ROWS. Any result that fits — every list of a small table,
 * and nearly every filtered or limited one — is that single query, and its
 * envelope is forwarded exactly as D1 built it. Only a result larger than a
 * page (in practice an unfiltered list of net, netixlan, org, netfac or
 * authenticated poc) continues in pages, which are spliced into one envelope.
 * Each query also returns its row count, so the last page is known without an
 * extra query. A page that still fails TOOBIG / NOMEM is halved and retried.
 *
 * Shared by the api and rest list handlers.
 */

import { buildJsonQuery, MAX_PAGE_LIMIT } from './query.js';
import { encoder } from './http.js';

/** Envelope produced by buildJsonQuery's json_object('data',…,'meta',json_object()). */
const PREFIX = '{"data":[';
const SUFFIX = '],"meta":{}}';

/** Smallest page a TOOBIG / NOMEM retry halves down to. */
const PAGE_MIN = 250;

/**
 * Rows per page, per entity. Measured on production D1 on 2026-11-05: the
 * largest single string D1 built was 7.58 MB (6000 net rows); ~8.85 MB failed
 * SQLITE_TOOBIG. Each value keeps rows × the entity's p90 row size of the
 * list JSON under 7.5 MB, and is rounded up to a round number so that
 * ordinary table growth does not add a near-empty page to a full-table list:
 *
 *   entity    p90 B  max B   rows (2026-11-05)  page at p90  full-table pages
 *   net       1329   19747   35849              6.6 MB       8 (to 40000 rows)
 *   netixlan   454     524   66769              6.8 MB       5 (to 75000)
 *   org        610    5111   35293              6.1 MB       4 (to 40000)
 *   netfac     220     269   62762              6.6 MB       3 (to 90000)
 *   poc*       237     339   61014              7.1 MB       3 (to 90000)
 *   fac        993    3155    5886              7.0 MB       1 (to 7000)
 *   * authenticated view, which includes non-public contacts.
 *
 * Average rows run 10–20% under p90. Re-measure when columns are added or
 * row sizes grow; the TOOBIG halving covers drift until then. Entities not
 * listed are small (whole table under 1.5 MB) and get DEFAULT_PAGE_ROWS.
 * @type {Readonly<Record<string, number>>}
 */
const PAGE_ROWS = Object.freeze({
    net: 5000, netixlan: 15_000, org: 10_000, netfac: 30_000, poc: 30_000, fac: 7000,
});
const DEFAULT_PAGE_ROWS = 3000;

/**
 * Row count of each envelope built here, as D1 counted it. Kept by buffer
 * identity so it travels with the bytes through request coalescing and L1
 * without being stored or parsed: the next-page check reads it on every list
 * request, and the body may be tens of MB.
 * @type {WeakMap<Uint8Array, number>}
 */
const rowCounts = new WeakMap();

/**
 * Records an envelope's row count for rowCountOf.
 *
 * @param {Uint8Array} buf - Envelope bytes.
 * @param {number} rows - Rows in the envelope.
 * @returns {Uint8Array} buf.
 */
export function withRowCount(buf, rows) {
    rowCounts.set(buf, rows);
    return buf;
}

/**
 * Row count of an envelope built by queryJsonList or marked by withRowCount.
 *
 * @param {Uint8Array} buf - Envelope bytes.
 * @returns {number} Rows, or 0 when the count is not known.
 */
export function rowCountOf(buf) {
    return rowCounts.get(buf) ?? 0;
}

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
 * Runs over the caller's window (skip … skip+limit) in pages of PAGE_ROWS,
 * following the query's ORDER BY, which always ends in an id tiebreak, so
 * OFFSET paging neither repeats nor drops rows. A result of one page is D1's
 * envelope as built; only a multi-page result is spliced.
 *
 * @param {D1Session} db - D1 session.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed filters.
 * @param {QueryOpts} opts - Query options (depth must be 0).
 * @returns {Promise<Uint8Array|null>} Envelope bytes, or null when D1 returned no payload.
 */
export async function queryJsonList(db, entity, filters, opts) {
    const window = opts.limit > 0 && opts.limit < MAX_PAGE_LIMIT ? opts.limit : MAX_PAGE_LIMIT;
    const baseSkip = Math.max(opts.skip, 0);

    /** @type {string[]} */
    const payloads = [];
    let rows = 0;
    let offset = 0;
    let size = PAGE_ROWS[entity.tag] ?? DEFAULT_PAGE_ROWS;

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

        const n = Number(row?.n ?? 0);
        if (offset === 0 && n < want) {
            // The whole result in one query: forward D1's envelope as built.
            if (!row?.payload) return null;
            return withRowCount(encoder.encode(/** @type {string} */ (row.payload)), n);
        }
        if (n > 0) {
            payloads.push(/** @type {string} */ (row.payload));
            rows += n;
        }
        if (n < want) break; // last page
        offset += want;
    }
    if (payloads.length === 1) return withRowCount(encoder.encode(payloads[0]), rows);
    return withRowCount(splice(payloads), rows);
}

/**
 * Joins page envelopes into one: PREFIX, each page's array contents joined
 * by ',', SUFFIX, assembled once.
 *
 * @param {string[]} payloads - Page envelopes, each `{"data":[...],"meta":{}}`.
 * @returns {Uint8Array} Envelope bytes.
 */
function splice(payloads) {
    /** @type {Uint8Array[]} */
    const pages = [];
    let bytes = 0;
    for (const payload of payloads) {
        if (!payload.startsWith(PREFIX) || !payload.endsWith(SUFFIX)) {
            throw new Error('queryJsonList: unexpected payload envelope');
        }
        const page = encoder.encode(payload.slice(PREFIX.length, payload.length - SUFFIX.length));
        pages.push(page);
        bytes += page.length;
    }
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
