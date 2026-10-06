/**
 * @fileoverview Upstream-compatible page-number pagination for list
 * endpoints: `?page=N&per_page=M` (PeeringDB's Django REST Framework
 * pagination), returning `meta.pagination`.
 *
 * Semantics, matched against www.peeringdb.com:
 *   - only active when `page` is present; `per_page` alone is ignored;
 *   - `per_page` outside 1..250 (or not a number) falls back to 250;
 *   - `page` must be an integer >= 1 and <= total_pages, else 404
 *     "Invalid page." (page 1 of an empty result is valid);
 *   - `limit` / `skip` first define the result set, pages are cut from it,
 *     and `count` is that set's size;
 *   - `next` / `previous` keep every other query parameter as sent, sorted by
 *     key; `previous` for page 2 drops `page` altogether.
 */

import { buildCountQuery } from '../query.js';
import { encoder } from '../http.js';

const PER_PAGE_DEFAULT = 250;
const PER_PAGE_MAX = 250;
const META_SUFFIX = '"meta":{}}';
const decoder = new TextDecoder();

/**
 * Parses the raw `page` value; null when it is not an integer >= 1.
 * @param {string} raw
 * @returns {number|null}
 */
export function parsePageNumber(raw) {
    const n = Number(raw);
    return raw !== '' && Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Parses the raw `per_page` value; anything outside 1..250 becomes 250.
 * @param {string|null} raw
 * @returns {number}
 */
export function parsePerPage(raw) {
    if (raw === null || raw === '') return PER_PAGE_DEFAULT;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= PER_PAGE_MAX ? n : PER_PAGE_DEFAULT;
}

/**
 * Builds a next/previous link: the request URL without its query, then
 * every original parameter except `page`, plus `page=<n>` when n > 1,
 * sorted by key.
 *
 * @param {string} base - Request URL without the query string.
 * @param {string} queryString - Raw query string (no leading '?').
 * @param {number} n - Target page.
 * @returns {string}
 */
export function pageLink(base, queryString, n) {
    /** @type {string[]} */
    const parts = [];
    for (const part of queryString.split('&')) { // ap-ok: pagination link building, cold path
        if (part === '') continue;
        const eq = part.indexOf('=');
        const key = eq === -1 ? part : part.slice(0, eq);
        if (key !== 'page') parts.push(part);
    }
    if (n > 1) parts.push(`page=${n}`);
    if (parts.length === 0) return base;
    parts.sort((a, b) => {
        const ka = a.slice(0, a.indexOf('=') >>> 0);
        const kb = b.slice(0, b.indexOf('=') >>> 0);
        return ka < kb ? -1 : (ka > kb ? 1 : 0);
    });
    return `${base}?${parts.join('&')}`;
}

/**
 * Computes one page and returns the full envelope with meta.pagination,
 * or null when the page is past the end (caller answers 404).
 *
 * @param {D1Session} db - D1 session.
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed filters.
 * @param {QueryOpts} opts - Query options (limit/skip define the result set).
 * @param {number} page - Validated page number (>= 1).
 * @param {number} perPage - Validated page size.
 * @param {string} base - Request URL without query, for links.
 * @param {string} queryString - Raw query string, for links.
 * @param {(pageOpts: QueryOpts) => Promise<Uint8Array>} runPage - Executes the list query for a window.
 * @returns {Promise<Uint8Array|null>}
 */
export async function buildPagedEnvelope(db, entity, filters, opts, page, perPage, base, queryString, runPage) {
    const { sql, params } = buildCountQuery(entity, filters, opts);
    const row = await db.prepare(sql).bind(...params).first();
    const total = row && typeof row.cnt === 'number' ? row.cnt : 0;

    const afterSkip = Math.max(total - Math.max(opts.skip, 0), 0);
    const count = opts.limit > 0 ? Math.min(afterSkip, opts.limit) : afterSkip;
    const totalPages = Math.max(1, Math.ceil(count / perPage));
    if (page > totalPages) return null;

    const offset = (page - 1) * perPage;
    const rows = Math.min(perPage, count - offset);

    let body = '{"data":[],"meta":{}}';
    if (rows > 0) {
        /** @type {QueryOpts} */
        const pageOpts = {
            depth: opts.depth, limit: rows, skip: Math.max(opts.skip, 0) + offset, since: opts.since,
            sort: opts.sort, fields: opts.fields, pdbfe: opts.pdbfe, authenticated: opts.authenticated,
        };
        body = decoder.decode(await runPage(pageOpts));
    }
    if (!body.endsWith(META_SUFFIX)) {
        throw new Error('buildPagedEnvelope: unexpected envelope');
    }

    const hasNext = page < totalPages;
    const hasPrevious = page > 1;
    const pagination = {
        count,
        has_next: hasNext,
        has_previous: hasPrevious,
        next: hasNext ? pageLink(base, queryString, page + 1) : null,
        previous: hasPrevious ? pageLink(base, queryString, page - 1) : null,
        page,
        per_page: perPage,
        total_pages: totalPages,
    };
    return encoder.encode(`${body.slice(0, -2)}"pagination":${JSON.stringify(pagination)}}}`);
}
