/**
 * @fileoverview Shared utilities used across multiple handler modules.
 *
 * Contains the 501 handler for write endpoints and the field-parsing
 * helper used in the depth>0 cold path.
 */

import { getJsonColumns, getBoolColumns, getNullableColumns } from '../entities.js';
import { jsonError } from '../http.js';

/**
 * Returns a 501 Not Implemented response for write endpoints.
 *
 * @param {string} method - The HTTP method (POST, PUT, DELETE).
 * @param {string} path - The URL path.
 * @returns {Response} 501 JSON response.
 */
export function handleNotImplemented(method, path) {
    return jsonError(501, `${method} ${path} is not available on this read-only mirror. See peeringdb.com for write access.`);
}

/**
 * Parses JSON-stored TEXT columns back to native arrays/objects and
 * coerces boolean fields from SQLite's 0/1 integers to JS booleans.
 * Only used in the depth>0 cold path where we need individual row objects
 * for V8-side relationship expansion. Column names are derived from the
 * entity's field definitions.
 *
 * @param {EntityMeta} entity - Entity metadata for column lookup.
 * @param {Record<string, any>} row - A result row to mutate in-place.
 */
export function parseJsonFields(entity, row) {
    for (const col of getJsonColumns(entity)) {
        if (typeof row[col] === "string" && row[col]) {
            try { row[col] = JSON.parse(row[col]); } catch { /* keep as string */ } // ap-ok: depth>0 cold path only
        }
    }
    for (const col of getBoolColumns(entity)) {
        if (col in row) row[col] = !!row[col];
    }
    // Convert empty strings to null for nullable columns.
    // D1 may store '' for fields that upstream sends as null.
    for (const col of getNullableColumns(entity)) {
        if (row[col] === '') row[col] = null;
    }
}

/**
 * Estimates the number of rows in a JSON array payload without parsing it.
 * Counts occurrences of '},{' which separate objects in json_group_array
 * output. Returns 0 for empty arrays, 1 for single-object payloads.
 *
 * @param {string} payload - The raw JSON string from D1.
 * @returns {number} Estimated row count.
 */
export function countRows(payload) {
    const start = payload.indexOf('[');
    const end = payload.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start + 1) return 0;

    let count = 1;
    let i = start + 1;
    while (i < end) {
        i = payload.indexOf('},{', i);
        if (i === -1 || i >= end) break;
        count++;
        i += 3;
    }
    return count;
}
