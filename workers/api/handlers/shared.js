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

// Byte values for the countRowsBytes scan. '[' ']' '}' ',' '{' are all
// single-byte ASCII (< 0x80), so they can never occur as a UTF-8 continuation
// byte — a raw byte scan for the '},{' object separator is exactly equivalent
// to scanning the decoded string, without allocating the (potentially
// multi-MB) string just to count.
const B_LBRACKET = 0x5b; // [
const B_RBRACKET = 0x5d; // ]
const B_RBRACE = 0x7d;   // }
const B_COMMA = 0x2c;    // ,
const B_LBRACE = 0x7b;   // {

/**
 * Estimates the number of rows in a JSON array payload without parsing it, by
 * scanning the raw UTF-8 bytes for the '},{' separator between objects in
 * json_group_array output. Returns 0 for empty arrays, 1 for single-object
 * payloads. Operates on bytes to avoid decoding the (potentially multi-MB)
 * buffer to a string on the list hot path.
 *
 * @param {Uint8Array} buf - The raw JSON payload bytes from D1 / the cache.
 * @returns {number} Estimated row count.
 */
export function countRowsBytes(buf) {
    const len = buf.byteLength;
    let start = -1;
    for (let i = 0; i < len; i++) {
        if (buf[i] === B_LBRACKET) { start = i; break; }
    }
    if (start === -1) return 0;
    let end = -1;
    for (let i = len - 1; i > start; i--) {
        if (buf[i] === B_RBRACKET) { end = i; break; }
    }
    if (end === -1 || end <= start + 1) return 0;

    let count = 1;
    for (let i = start + 1; i + 2 < end; i++) {
        if (buf[i] === B_RBRACE && buf[i + 1] === B_COMMA && buf[i + 2] === B_LBRACE) {
            count++;
            i += 2;
        }
    }
    return count;
}
