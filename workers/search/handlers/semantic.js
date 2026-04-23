/**
 * @fileoverview Semantic search resolver using Cloudflare Workers AI and Vectorize.
 * Moved from api/semantic.js to search/handlers/semantic.js — semantic search
 * now lives exclusively in the dedicated pdbfe-search worker.
 *
 * Translates a natural-language query into a set of PeeringDB entity IDs by:
 *   1. Embedding the query with BGE-large-en-v1.5 (via Workers AI)
 *   2. Searching a Vectorize index filtered by entity type
 *   3. Extracting entity IDs from vector match IDs
 *
 * The module is feature-gated: if the AI or VECTORIZE bindings are absent
 * from the worker environment, semantic search is disabled and the
 * `__semantic` filter operator is rejected at validation time.
 *
 * Bindings are captured once per isolate via initSemantic(env). A _probed
 * flag prevents repeated evaluation. Downstream code checks
 * isSemanticEnabled() before calling resolveSemanticIds().
 *
 * Vector ID format: "{entityTag}_{entityId}" (e.g. "net_694").
 * This must match whatever the ingestion pipeline writes to Vectorize.
 */

import { tokenizeString } from '../../core/utils.js';

/** @type {any|null} Workers AI binding, captured from env.AI */
let _ai = null;

/** @type {any|null} Vectorize index binding, captured from env.VECTORIZE */
let _vectorize = null;

/** @type {boolean} Whether bindings have been probed (once per isolate) */
let _probed = false;

/** @type {boolean} Whether both bindings are present and semantic search is available */
let _enabled = false;

/**
 * Probes the worker environment for AI and Vectorize bindings.
 * Called once per isolate lifetime from the router's initWorker().
 * Subsequent calls are no-ops — the _probed flag short-circuits.
 *
 * If either binding is missing, semantic search stays disabled for
 * the lifetime of this isolate. This is intentional: bindings don't
 * appear mid-flight.
 *
 * @param {PdbApiEnv} env - Cloudflare environment bindings.
 */
export function initSemantic(env) {
    if (_probed) return;
    _probed = true;

    if (env.AI && env.VECTORIZE) {
        _ai = env.AI;
        _vectorize = env.VECTORIZE;
        _enabled = true;
    }
}

/**
 * Returns whether semantic search is available on this isolate.
 * Used by validation (entities.js) to gate the `semantic` operator
 * before it reaches the handler.
 *
 * @returns {boolean} True if AI and Vectorize bindings are present.
 */
export function isSemanticEnabled() {
    return _enabled;
}

/**
 * Resolves a semantic search query into a comma-separated string of entity IDs.
 *
 * Prepends entity and field context to the raw query so the BGE embedding
 * model aligns the query vector with the indexed document vectors. Without
 * this context, short queries like "cloud" would match poorly against
 * dense multi-field records.
 *
 * The vector search is filtered by entity type metadata, so a search on
 * "net" won't return "fac" results even if the text is similar.
 *
 * Only call this when isSemanticEnabled() returns true — the function
 * assumes _ai and _vectorize are set.
 *
 * @param {string} entityTag - The entity context (e.g. "net", "ix").
 * @param {string} field - The field being searched (e.g. "notes", "name").
 * @param {string} queryStr - The raw user query text.
 * @param {number} [limit=25] - Maximum number of vector matches to return.
 * @returns {Promise<string|null>} Comma-separated entity IDs ordered by
 *     vector similarity, or null if no matches.
 */
export async function resolveSemanticIds(entityTag, field, queryStr, limit = 25) {
    // Inject entity and field context so the embedding aligns with
    // the indexed documents rather than matching on raw query text alone.
    const contextualQuery = `Find PeeringDB ${entityTag} where ${field} matches: ${queryStr}`;

    // Step 1: generate embedding via Workers AI
    const { data } = await _ai.run('@cf/baai/bge-large-en-v1.5', {
        text: [contextualQuery]
    });

    // Step 2: search Vectorize with entity-scoped metadata filter
    const vecResults = await _vectorize.query(data[0], {
        topK: limit,
        filter: { entity: entityTag }
    });

    if (!vecResults.matches || vecResults.matches.length === 0) {
        return null;
    }

    // Step 3: extract entity IDs from vector match IDs.
    // Format: "{entityTag}:{entityId}" — take p1 from tokenizeString with maxParts=2.
    const parts = [];
    for (const match of vecResults.matches) {
        const tok = tokenizeString(match.id, ':', 2);
        if (tok.p1 !== undefined) parts.push(tok.p1);
    }

    return parts.length > 0 ? parts.join(',') : null;
}
