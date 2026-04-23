/**
 * @fileoverview HTTP response helpers for the search worker.
 *
 * Barrel re-export of core/http.js plus search-specific response
 * construction helpers. All search worker modules import HTTP
 * utilities from here — never directly from core/http.js — to
 * keep the dependency path consistent and avoid cross-worker imports.
 *
 * Search-specific additions:
 *   - serveSearch(buf, tier, hits) — standard search result response
 *     with Content-Type, CORS, X-Cache, and X-Cache-Hits headers.
 */

export {
    encoder,
    H_CORS,
    H_NOCACHE,
    handlePreflight,
    jsonError,
    encodeJSON,
    generateETag,
    isNotModified,
    lastModifiedHeader,
    isNotModifiedSince,
} from '../core/http.js';

// ── Search-specific helpers ───────────────────────────────────────────────────

/**
 * Returns a 200 JSON response for a search result buffer.
 *
 * Used for both cache hits (tier='L1'/'L2') and cache misses (tier='MISS').
 * The same function handles the empty sentinel case — callers pass the
 * SEARCH_EMPTY_SENTINEL Uint8Array directly when the result set is empty.
 *
 * Headers are constructed inline (no frozen-object spread on hot path).
 *
 * @param {Uint8Array} buf - Serialised search envelope (may be the empty sentinel).
 * @param {string} tier - Cache tier label: 'L1', 'L2', or 'MISS'.
 * @param {number} hits - L1 hit counter from the SWR pipeline.
 * @returns {Response} HTTP 200 response with search headers.
 */
export function serveSearch(buf, tier, hits) {
    return new Response(/** @type {BodyInit} */(/** @type {unknown} */(buf)), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'X-Cache': tier,
            'X-Cache-Hits': String(hits),
        },
    });
}
