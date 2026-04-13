/**
 * @fileoverview Shared utility functions for URL parsing and string
 * tokenization. Generic building blocks used across all workers.
 *
 * Domain-specific utilities (query filter parsing, cache-key normalisation)
 * live in their respective layer modules (api/utils.js, api/cache.js).
 */

/**
 * Splits a string into up to `maxParts` segments at a delimiter.
 * Returns an object with keys p0..pN where the last present key
 * receives the remainder of the string. Keys beyond the number of
 * actual delimiter occurrences are absent (undefined), so callers
 * can test `p1 === undefined` to detect single-segment inputs.
 *
 * Pass maxParts=-1 to split on every delimiter occurrence (unlimited).
 *
 * Hardwired indexOf chains for maxParts 2-5 maintain a stable V8 hidden
 * class shape (dictionary properties only for the generic fallback).
 * This avoids array allocations that String.split() would create.
 *
 * @param {string} str - The string to tokenize.
 * @param {string} [delimiter='/'] - Single-character delimiter.
 * @param {number} [maxParts=5] - Maximum segments to extract, or -1 for unlimited.
 * @returns {Record<string, string>} Keys p0..p(N-1) mapped to sequential segments. Absent keys indicate fewer segments than maxParts.
 */
export function tokenizeString(str, delimiter = '/', maxParts = 5) {
    /** @type {Record<string, string>} */
    const parts = {};
    const s1 = str.indexOf(delimiter);
    if (s1 === -1 || maxParts === 0) return parts;

    if (maxParts === 2) {
        parts.p0 = str.slice(0, s1);
        parts.p1 = str.slice(s1 + 1);
        return parts;
    }

    const s2 = str.indexOf(delimiter, s1 + 1);
    if (maxParts === 3) {
        parts.p0 = str.slice(0, s1);
        parts.p1 = str.slice(s1 + 1, s2 !== -1 ? s2 : undefined);
        if (s2 !== -1) parts.p2 = str.slice(s2 + 1);
        return parts;
    }

    const s3 = s2 !== -1 ? str.indexOf(delimiter, s2 + 1) : -1;
    if (maxParts === 4) {
        parts.p0 = str.slice(0, s1);
        parts.p1 = str.slice(s1 + 1, s2 !== -1 ? s2 : undefined);
        if (s2 !== -1) parts.p2 = str.slice(s2 + 1, s3 !== -1 ? s3 : undefined);
        if (s3 !== -1) parts.p3 = str.slice(s3 + 1);
        return parts;
    }

    const s4 = s3 !== -1 ? str.indexOf(delimiter, s3 + 1) : -1;
    if (maxParts === 5) {
        parts.p0 = str.slice(0, s1);
        parts.p1 = str.slice(s1 + 1, s2 !== -1 ? s2 : undefined);
        if (s2 !== -1) parts.p2 = str.slice(s2 + 1, s3 !== -1 ? s3 : undefined);
        if (s3 !== -1) parts.p3 = str.slice(s3 + 1, s4 !== -1 ? s4 : undefined);
        if (s4 !== -1) parts.p4 = str.slice(s4 + 1);
        return parts;
    }

    // Generic fallback for maxParts > 5, maxParts === 1, or maxParts === -1 (unlimited).
    const unlimited = maxParts === -1;
    let currentIdx = -1;
    for (let i = 0; unlimited || i < maxParts; i++) {
        if (!unlimited && i === maxParts - 1) {
            // Last allowed part — remainder goes here
            parts[`p${i}`] = str.slice(currentIdx + 1);
            break;
        }
        const nextIdx = str.indexOf(delimiter, currentIdx + 1);
        if (nextIdx === -1) {
            // No more delimiters — final segment
            parts[`p${i}`] = str.slice(currentIdx + 1);
            break;
        }
        parts[`p${i}`] = str.slice(currentIdx + 1, nextIdx);
        currentIdx = nextIdx;
    }
    return parts;
}

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
