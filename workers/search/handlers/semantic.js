/**
 * @fileoverview Semantic search resolver using Cloudflare Vectorize and
 * graph-structural embeddings.
 *
 * Replaced the previous BGE-large-en-v1.5 text embedding approach with a
 * graph-structural pipeline. The Vectorize index now stores node2vec
 * embeddings (1024-dim, cosine) rather than text embeddings. Queries are
 * decomposed into typed predicates by query-parser.js and executed against
 * D1 and Vectorize by graph-search.js.
 *
 * Consequence: the Workers AI binding is no longer required. isSemanticEnabled()
 * now returns true if only the Vectorize binding is present.
 *
 * The public API surface (initSemantic, isSemanticEnabled, resolveSemanticIds)
 * is unchanged so query.js requires no structural modification.
 *
 * Vector ID format: "{entityTag}:{entityId}" (e.g. "net:694").
 */

import { executeGraphSearch } from './graph-search.js';

// ---------------------------------------------------------------------------
// Module-level state (one isolate = one cold start)
// ---------------------------------------------------------------------------

/** @type {any|null} D1 database binding. */
let _db = null;

/** @type {any|null} Vectorize index binding. */
let _vectorize = null;

/** @type {boolean} Whether bindings have been probed. */
let _probed = false;

/** @type {boolean} Whether the Vectorize binding is present. */
let _enabled = false;

// ---------------------------------------------------------------------------
// Binding initialisation
// ---------------------------------------------------------------------------

/**
 * Probes the worker environment for the Vectorize binding.
 *
 * Called once per isolate lifetime from the router. Subsequent calls are
 * no-ops — the _probed flag short-circuits evaluation.
 *
 * Workers AI (env.AI) is no longer required: the graph-structural index
 * does not need a text embedding model to generate query vectors.
 *
 * @param {PdbSearchEnv} env - Cloudflare environment bindings.
 */
export function initSemantic(env) {
    if (_probed) return;
    _probed = true;

    if (env.VECTORIZE) {
        _vectorize = env.VECTORIZE;
        _enabled   = true;
    }
}

/**
 * Returns whether semantic (graph-structural) search is available on this
 * isolate. Used by query.js to gate the 'semantic' mode before dispatch.
 *
 * @returns {boolean} True if the Vectorize binding is present.
 */
export function isSemanticEnabled() {
    return _enabled;
}

// ---------------------------------------------------------------------------
// Query resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a semantic search query to a comma-separated string of entity IDs
 * using the graph-structural Vectorize index and D1 edge traversal.
 *
 * Delegates to executeGraphSearch() which applies predicate-routing:
 *   - ASN → D1 exact match
 *   - Country / city / region / info_type → D1 metadata filter
 *   - "similar to X" → Vectorize kNN from anchor vector
 *   - "at Y" / "peers of Y" → D1 edge JOIN traversal
 *   - Fallback → D1 LIKE keyword search
 *
 * The `field` parameter is accepted for API compatibility but not used:
 * the graph-structural approach does not differentiate by field.
 *
 * Requires a D1 binding because several execution paths (metadata filters,
 * traversal, name resolution) issue SQL queries. The binding is passed per
 * call rather than stored at isolate level because D1 sessions are request-
 * scoped (withSession()).
 *
 * @param {string} entityTag - Target entity type (e.g. 'net', 'ix').
 * @param {string} _field - Ignored. Kept for API compatibility with query.js.
 * @param {string} queryStr - Raw user query text.
 * @param {number} [limit=25] - Maximum number of results.
 * @param {D1Database} db - D1 session (withSession already applied).
 * @returns {Promise<string|null>} Comma-separated entity IDs in relevance
 *     order, or null if no results were found.
 */
export async function resolveSemanticIds(entityTag, _field, queryStr, limit = 25, db) {
    return executeGraphSearch(queryStr, entityTag, db, _vectorize, limit);
}
