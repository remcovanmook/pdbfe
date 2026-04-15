/**
 * @fileoverview API-worker-specific utility functions.
 *
 * Contains PeeringDB-specific parsing logic that doesn't belong in the
 * shared core layer. The core/utils.js module provides generic helpers
 * (parseURL, tokenizeString); this module builds on top with the
 * domain-specific filter parser for the PeeringDB Django-style query syntax.
 */

import { tokenizeString } from '../core/utils.js';
import { FILTER_OPS } from './query.js';

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
 * @returns {{filters: ParsedFilter[], depth: number, limit: number, skip: number, since: number, sort: string, fields: string[], pdbfe: boolean}} Parsed query components.
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
    let pdbfe = false;

    /** @type {Map<string, number>} Track filter index by "field:op" to implement last-value-wins */
    const filterIdx = new Map();

    if (!queryString) return { filters, depth, limit, skip, since, sort, fields, pdbfe };

    const pairs = queryString.indexOf('&') !== -1
        ? tokenizeString(queryString, '&', -1)
        : { p0: queryString };

    for (let i = 0; pairs[`p${i}`] !== undefined; i++) {
        const { p0: rawKeyEnc, p1: rawValueEnc } = tokenizeString(pairs[`p${i}`], '=', 2);
        if (rawValueEnc === undefined) continue;

        const rawKey = decodeURIComponent(rawKeyEnc);
        const rawValue = decodeURIComponent(rawValueEnc);

        // Handle reserved pagination/meta parameters
        if (rawKey === "depth") {
            depth = Number.parseInt(rawValue, 10) || 0;
            if (depth > 2) depth = 2;
            if (depth < 0) depth = 0;
            continue;
        }
        if (rawKey === "limit") {
            const parsed = Number.parseInt(rawValue, 10);
            limit = Number.isNaN(parsed) ? -1 : parsed;
            continue;
        }
        if (rawKey === "skip") {
            skip = Number.parseInt(rawValue, 10) || 0;
            if (skip < 0) skip = 0;
            continue;
        }
        if (rawKey === "since") {
            since = Number.parseInt(rawValue, 10) || 0;
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
        if (rawKey === "__pdbfe") {
            pdbfe = rawValue === '1';
            continue;
        }

        // Parse filter operator from the field name.
        // The last `__` separates the field from the operator suffix
        // (e.g. asn__gte → field=asn, op=gte). If the suffix isn't a
        // known operator, treat the entire key as an exact-match field.
        let field = rawKey;
        let op = "eq";

        const lastDunder = rawKey.lastIndexOf('__');
        if (lastDunder !== -1) {
            const candidate = rawKey.slice(lastDunder + 2);
            if (FILTER_OPS.has(candidate)) {
                field = rawKey.slice(0, lastDunder);
                op = candidate;
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

    return { filters, depth, limit, skip, since, sort, fields, pdbfe };
}
