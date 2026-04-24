/**
 * @fileoverview Graph-structural search resolver.
 *
 * Wraps executeGraphSearch() behind the public interface used by query.js.
 * The search worker exposes `mode=semantic` on its external API; internally
 * this module always runs graph-structural search — the mode name is kept for
 * API backwards-compatibility.
 *
 * ## Why BGE was dropped
 *
 * The original implementation (PR #77) used Cloudflare Workers AI to embed
 * each query with bge-large-en-v1.5, then queried Vectorize for the nearest
 * text-embedded entity vectors. It was replaced for the following reasons:
 *
 * 1. **Cold-start cost**: every search request incurred a Workers AI embed
 *    round-trip (~200–400 ms), making the 10 req/min anonymous rate limit
 *    effectively the only thing keeping the worker stable.
 *
 * 2. **Semantic mismatch**: BGE text embeddings encode surface-level
 *    linguistic similarity, not PeeringDB topology. Two networks that peer
 *    heavily share no lexical features, so "similar to AS3356" against text
 *    embeddings returned random results.
 *
 * 3. **Embedding drift**: the sync worker was embedding 100 entities per run
 *    via Workers AI, meaning the Vectorize index was perpetually stale and
 *    coverage was unpredictable.
 *
 * ## What replaced it
 *
 * A node2vec graph embedding pipeline (scripts/compute-graph-embeddings.py)
 * trains a 1024-dim embedding matrix over the full PeeringDB graph
 * (75k nodes, 175k edges) offline and uploads all vectors to Vectorize in
 * one batch. The async worker (pdbfe-async) keeps vectors current by
 * recomputing neighbour averages after each sync delta.
 *
 * Queries are decomposed by query-parser.js into typed predicates (ASN,
 * infoType, region, country, city, similarity, traversal) and executed by
 * graph-search.js against D1 and Vectorize without any AI binding.
 *
 * Vector ID format: "{entityTag}:{entityId}" (e.g. "net:694").
 */

import { executeGraphSearch } from './graph-search.js';

// ---------------------------------------------------------------------------
// Module-level state (one isolate = one cold start)
// ---------------------------------------------------------------------------

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
 * Workers AI is not required: the graph-structural index does not need a
 * text embedding model to generate query vectors.
 *
 * @param {PdbSearchEnv} env - Cloudflare environment bindings.
 */
export function initGraphSearch(env) {
    if (_probed) return;
    _probed = true;

    if (env.VECTORIZE) {
        _vectorize = env.VECTORIZE;
        _enabled   = true;
    }
}

/**
 * Returns whether graph-structural search is available on this isolate.
 * Used by query.js to gate the 'semantic' mode before dispatch.
 *
 * @returns {boolean} True if the Vectorize binding is present.
 */
export function isGraphSearchEnabled() {
    return _enabled;
}

// ---------------------------------------------------------------------------
// Query resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a search query to a comma-separated string of entity IDs using
 * the graph-structural Vectorize index and D1 edge traversal.
 *
 * Delegates to executeGraphSearch() which applies predicate routing:
 *   - ASN             → D1 exact match
 *   - Country / city / region / info_type → D1 metadata filter
 *   - "similar to X" → Vectorize kNN from anchor vector
 *   - "at Y" / "peers of Y" → D1 edge JOIN traversal
 *   - Fallback        → D1 LIKE keyword search
 *
 * The `field` parameter is accepted for API compatibility but not used:
 * the graph-structural approach does not differentiate by field.
 *
 * Requires a D1 binding because metadata filters, traversal, and name
 * resolution all issue SQL queries. The binding is passed per call because
 * D1 sessions are request-scoped (withSession()).
 *
 * @param {string} entityTag - Target entity type (e.g. 'net', 'ix').
 * @param {string} _field - Ignored. Kept for API compatibility with query.js.
 * @param {string} queryStr - Raw user query text.
 * @param {number} [limit=25] - Maximum number of results.
 * @param {D1Database} db - D1 session (withSession already applied).
 * @returns {Promise<string|null>} Comma-separated entity IDs in relevance
 *     order, or null if no results were found.
 */
export async function resolveGraphIds(entityTag, _field, queryStr, limit = 25, db) {
    return executeGraphSearch(queryStr, entityTag, db, _vectorize, limit);
}
