/**
 * @fileoverview depth=0 list execution: D1 builds the JSON, the worker
 * forwards it.
 *
 * Each query asks D1 for one page of rows already serialised and joined
 * (buildJsonFragmentQuery: `group_concat(json_object(...), ',')` plus the
 * row count), with no array or envelope around them. The worker writes the
 * envelope itself — `{"data":[` + page + `,` + page … + `],"meta":{}}` — so
 * no D1 output is ever unwrapped, checked or parsed.
 *
 * The binding hands each page over as a JS string (a BLOB comes back as an
 * Array of numbers, measured 2026-11-05, so bytes can't come through it), and
 * a page with any non-Latin-1 character is held two bytes per character. So
 * each page string is encoded once, on its own, as soon as it arrives, and
 * dropped; the envelope is assembled from byte chunks — constant PREFIX,
 * COMMA and SUFFIX bytes and the encoded pages — never by joining strings.
 *
 * D1 refuses a single computed string much over 7.5 MB (SQLITE_TOOBIG,
 * measured on production on 2026-11-05: 7.58 MB built, ~8.85 MB failed), and
 * an aggregate that exhausts D1's memory fails with SQLITE_NOMEM — which also
 * fails concurrent queries on the same database, the sync poll included. So a
 * page is at most the entity's PAGE_ROWS, and a page that still fails is
 * halved and retried.
 *
 * Two ways out:
 *   - queryJsonList: the envelope as one buffer, for the cache pipeline.
 *     Nearly every result is one page, so one query. Filtered lists use it.
 *   - streamJsonList: the outliers — an unfiltered list of a table larger
 *     than a page (isStreamedList). A pull-based stream: the next page is
 *     queried only once the client has taken the last one, so the first
 *     byte goes out after the first page, one page is in memory at a time,
 *     and nothing is cached (they would not fit L1, and isolates rarely live
 *     long enough for L1 to matter). ANTI_PATTERNS.md §9 lists the exception.
 *
 * Pages follow the query's ORDER BY, which always ends in an id tiebreak, so
 * OFFSET paging neither repeats nor drops rows. Shared by the api and rest
 * list handlers.
 */

import { buildJsonFragmentQuery, MAX_PAGE_LIMIT } from './query.js';
import { encoder } from './http.js';

const PREFIX = encoder.encode('{"data":[');
const COMMA = encoder.encode(',');
const SUFFIX = encoder.encode('],"meta":{}}');

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
 * Rows the caller asked for: the limit, or everything.
 * @param {QueryOpts} opts
 * @returns {number}
 */
function windowOf(opts) {
    return opts.limit > 0 && opts.limit < MAX_PAGE_LIMIT ? opts.limit : MAX_PAGE_LIMIT;
}

/**
 * Whether a list is one of the outliers streamJsonList serves: no filters
 * (so the whole table), on a table larger than one page, asking for more
 * than one page. Everything else is a filtered or small result for the cache
 * pipeline.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed filters.
 * @param {QueryOpts} opts - Query options.
 * @returns {boolean}
 */
export function isStreamedList(entity, filters, opts) {
    const rows = PAGE_ROWS[entity.tag];
    return rows !== undefined && opts.depth === 0 && filters.length === 0 && opts.since <= 0 && windowOf(opts) > rows;
}

/**
 * Fetches one page: up to `want` rows at `skip`, halving on TOOBIG / NOMEM.
 *
 * @param {D1Session} db
 * @param {EntityMeta} entity
 * @param {ParsedFilter[]} filters
 * @param {QueryOpts} opts
 * @param {number} skip
 * @param {number} want
 * @returns {Promise<{frag: string|null, n: number, want: number}>} The rows,
 *          their count, and the page size that worked (want, or less).
 */
async function fetchPage(db, entity, filters, opts, skip, want) {
    for (;;) {
        /** @type {QueryOpts} */
        const pageOpts = {
            depth: 0, limit: want, skip, since: opts.since,
            sort: opts.sort, fields: opts.fields, pdbfe: opts.pdbfe, authenticated: opts.authenticated,
        };
        const { sql, params } = buildJsonFragmentQuery(entity, filters, pageOpts);
        try {
            const row = await db.prepare(sql).bind(...params).first();
            return { frag: /** @type {string|null} */ (row?.frag ?? null), n: Number(row?.n ?? 0), want };
        } catch (err) {
            if (!isTooLarge(err) || want <= PAGE_MIN) throw err;
            want = Math.max(PAGE_MIN, want >> 1);
        }
    }
}

/**
 * Executes a depth=0 list query and returns the JSON envelope bytes.
 *
 * @param {D1Session} db - D1 session.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed filters.
 * @param {QueryOpts} opts - Query options (depth must be 0).
 * @returns {Promise<Uint8Array>} Envelope bytes.
 */
export async function queryJsonList(db, entity, filters, opts) {
    const window = windowOf(opts);
    const baseSkip = Math.max(opts.skip, 0);
    let size = PAGE_ROWS[entity.tag] ?? DEFAULT_PAGE_ROWS;
    /** @type {Uint8Array[]} */
    const pages = [];
    let bytes = 0;
    let rows = 0;
    let offset = 0;

    while (offset < window) {
        const page = await fetchPage(db, entity, filters, opts, baseSkip + offset, Math.min(size, window - offset)); // NOSONAR: pages are sequential by design
        if (page.want < size && page.want < window - offset) size = page.want; // halved
        if (page.n > 0) {
            const b = encoder.encode(/** @type {string} */ (page.frag));
            pages.push(b);
            bytes += b.byteLength;
            rows += page.n;
        }
        if (page.n < page.want) break; // last page
        offset += page.want;
    }

    // PREFIX, pages separated by COMMA, SUFFIX: one allocation, one copy each.
    const out = new Uint8Array(PREFIX.byteLength + bytes + Math.max(pages.length - 1, 0) * COMMA.byteLength + SUFFIX.byteLength);
    let pos = 0;
    out.set(PREFIX, pos); pos += PREFIX.byteLength;
    for (let i = 0; i < pages.length; i++) {
        if (i > 0) { out.set(COMMA, pos); pos += COMMA.byteLength; }
        out.set(pages[i], pos); pos += pages[i].byteLength;
    }
    out.set(SUFFIX, pos);
    return withRowCount(out, rows);
}

/**
 * Streams a depth=0 list page by page (see isStreamedList) as a pull-based
 * byte stream: each pull queries the next page, encodes it and enqueues it,
 * so a page is fetched only once the client has taken the previous one and
 * one page is in memory at a time. Resolves once the first page is in, so a
 * failure before any byte is an ordinary error response; after that, a
 * failing page errors the stream and the client sees a broken response —
 * never a body that ends in valid JSON, since SUFFIX is enqueued only once
 * every page is in. Constant chunks are enqueued as copies: a consumer may
 * take ownership of a chunk's buffer.
 *
 * @param {D1Session} db - D1 session.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed filters (empty for streamed lists).
 * @param {QueryOpts} opts - Query options (depth must be 0).
 * @returns {Promise<ReadableStream<Uint8Array>>} The envelope as a byte stream.
 */
export async function streamJsonList(db, entity, filters, opts) {
    const window = windowOf(opts);
    const baseSkip = Math.max(opts.skip, 0);
    let size = /** @type {number} */ (PAGE_ROWS[entity.tag]);
    const first = await fetchPage(db, entity, filters, opts, baseSkip, Math.min(size, window));
    if (first.want < size) size = first.want;

    let rows = first.n;
    let offset = first.want;
    let more = first.n >= first.want && offset < window;
    /** @type {Uint8Array|null} */
    let firstBytes = first.n > 0 ? encoder.encode(/** @type {string} */ (first.frag)) : null;

    return new ReadableStream({
        start(controller) {
            controller.enqueue(PREFIX.slice());
            if (firstBytes) controller.enqueue(firstBytes);
            firstBytes = null;
            if (!more) {
                controller.enqueue(SUFFIX.slice());
                controller.close();
            }
        },
        async pull(controller) {
            try {
                const page = await fetchPage(db, entity, filters, opts, baseSkip + offset, Math.min(size, window - offset));
                if (page.want < size && page.want < window - offset) size = page.want; // halved
                if (page.n > 0) {
                    if (rows > 0) controller.enqueue(COMMA.slice());
                    controller.enqueue(encoder.encode(/** @type {string} */ (page.frag)));
                    rows += page.n;
                }
                offset += page.want;
                more = page.n >= page.want && offset < window;
                if (!more) {
                    controller.enqueue(SUFFIX.slice());
                    controller.close();
                }
            } catch (err) {
                console.error(`[list] stream of ${entity.tag} failed after ${rows} rows:`, err);
                controller.error(err);
            }
        },
    }, { highWaterMark: 0 });
}
