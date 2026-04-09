/**
 * @fileoverview Shared utility functions for URL parsing, query string
 * handling, and concurrency primitives. Adapted from debthin core/utils.js
 * with added query-filter parsing for the PeeringDB filter syntax.
 *
 * Cache-key normalisation lives in api/cache.js.
 */

/**
 * Parses a Request URL into its components. Avoids constructing a full
 * URL object — splits on the third slash to extract the path, then
 * separates the query string.
 *
 * @param {Request} request - The inbound HTTP request.
 * @returns {{protocol: string, rawPath: string, queryString: string}} Parsed URL parts.
 */
export function parseURL(request) {
    const url = request.url;
    const schemeEnd = url.indexOf("://");
    const protocol = url.slice(0, schemeEnd + 3);
    const rest = url.slice(schemeEnd + 3);
    const pathStart = rest.indexOf("/");
    if (pathStart === -1) return { protocol, rawPath: "", queryString: "" };

    const pathAndQuery = rest.slice(pathStart + 1);
    const qIdx = pathAndQuery.indexOf("?");
    if (qIdx === -1) {
        return { protocol, rawPath: pathAndQuery, queryString: "" };
    }
    return {
        protocol,
        rawPath: pathAndQuery.slice(0, qIdx),
        queryString: pathAndQuery.slice(qIdx + 1)
    };
}

/**
 * Parses a URL query string into PeeringDB-style filter objects.
 * Handles the filter suffix conventions: __lt, __gt, __lte, __gte,
 * __contains, __startswith, __in. Parameters without a suffix are
 * treated as exact-match equality filters.
 *
 * Reserved parameters (depth, limit, skip, since, sort) are separated out
 * and returned in the `pagination` and `meta` objects.
 *
 * @param {string} queryString - Raw query string without the leading '?'.
 * @returns {{filters: ParsedFilter[], depth: number, limit: number, skip: number, since: number, sort: string, fields: string[]}} Parsed query components.
 */
export function parseQueryFilters(queryString) {
    /** @type {ParsedFilter[]} */
    const filters = [];
    let depth = 0;
    let limit = -1;
    let skip = 0;
    let since = 0;
    let sort = '';
    /** @type {string[]} */
    let fields = [];

    /** @type {Map<string, number>} Track filter index by "field:op" to implement last-value-wins */
    const filterIdx = new Map();

    if (!queryString) return { filters, depth, limit, skip, since, sort, fields };

    const pairs = queryString.split("&"); // ap-ok: query string parsing, bounded by URL length
    for (let i = 0; i < pairs.length; i++) {
        const eqIdx = pairs[i].indexOf("=");
        if (eqIdx === -1) continue;

        const rawKey = decodeURIComponent(pairs[i].slice(0, eqIdx));
        const rawValue = decodeURIComponent(pairs[i].slice(eqIdx + 1));

        // Handle reserved pagination/meta parameters
        if (rawKey === "depth") {
            depth = parseInt(rawValue, 10) || 0;
            if (depth > 2) depth = 2;
            if (depth < 0) depth = 0;
            continue;
        }
        if (rawKey === "limit") {
            const parsed = parseInt(rawValue, 10);
            limit = isNaN(parsed) ? -1 : parsed;
            continue;
        }
        if (rawKey === "skip") {
            skip = parseInt(rawValue, 10) || 0;
            if (skip < 0) skip = 0;
            continue;
        }
        if (rawKey === "since") {
            since = parseInt(rawValue, 10) || 0;
            continue;
        }
        if (rawKey === "sort") {
            sort = rawValue;
            continue;
        }
        if (rawKey === "fields") {
            fields = rawValue.split(",").map(s => s.trim()).filter(Boolean); // ap-ok: ?fields= parsing, small input
            continue;
        }

        // Parse filter suffix from the field name
        const suffixes = ["__lte", "__gte", "__lt", "__gt", "__contains", "__startswith", "__in"];
        let field = rawKey;
        let op = "eq";

        for (const suffix of suffixes) {
            if (rawKey.endsWith(suffix)) {
                field = rawKey.slice(0, -suffix.length);
                op = suffix.slice(2); // strip leading __
                break;
            }
        }

        // Cross-entity filter: if the field still contains __, the prefix
        // is a related entity tag (e.g. fac__state → entity=fac, field=state).
        const dunder = field.indexOf('__');

        // Build the filter entry
        /** @type {ParsedFilter} */
        let entry;
        if (dunder !== -1) {
            entry = { field: field.slice(dunder + 2), op, value: rawValue, entity: field.slice(0, dunder) };
        } else {
            entry = { field, op, value: rawValue };
        }

        // Last-value-wins: if the same field+op was seen before, overwrite it
        // This matches Django's QueryDict.get() which returns the last value
        const dedupeKey = `${entry.entity || ''}:${entry.field}:${op}`;
        const existingIdx = filterIdx.get(dedupeKey);
        if (existingIdx !== undefined) {
            filters[existingIdx] = entry;
        } else {
            filterIdx.set(dedupeKey, filters.length);
            filters.push(entry);
        }
    }

    return { filters, depth, limit, skip, since, sort, fields };
}

