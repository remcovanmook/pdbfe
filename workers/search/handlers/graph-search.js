/**
 * @fileoverview Graph-structural search execution engine.
 *
 * Translates a ParsedQuery (from query-parser.js) into entity IDs by routing
 * each predicate type to the most appropriate backend:
 *
 *   Predicate          Backend    Method
 *   ─────────────────  ─────────  ─────────────────────────────────────────
 *   asn                D1         Exact WHERE asn = ?
 *   country / city /   D1         WHERE country=? / city LIKE? / info_type=?
 *     infoType
 *   regionContinent    D1         WHERE region_continent = ?
 *   similarToName      D1 + Vec   Name lookup → getByIds → kNN query
 *   anchorName +       D1         Name lookup → edge JOIN traversal
 *     traversalIntent
 *   (none / fallback)  D1         LIKE keyword search across name / aka
 *
 * Structural similarity (similarToName) is the only path that touches
 * Vectorize. All other paths are pure D1 SQL. This keeps GIS/metadata
 * queries fast and avoids needing a query-space vector for metadata filters.
 *
 * Result: a comma-separated string of numeric entity IDs in relevance order,
 * compatible with the existing hydrateSemanticIds() caller in query.js.
 * Returns null when no results are found.
 *
 * @see query-parser.js for predicate structure.
 * @see handlers/semantic.js for the public resolveSemanticIds() wrapper.
 */

import { ENTITIES } from '../entities.js';
import { parseQuery } from './query-parser.js';

// ---------------------------------------------------------------------------
// D1 table name helpers
// ---------------------------------------------------------------------------

/**
 * Returns the D1 table name for a given entity tag.
 * Wraps the ENTITIES registry from entities.js.
 *
 * @param {string} tag - Entity tag (e.g. 'net', 'fac').
 * @returns {string} Table name (e.g. 'peeringdb_network').
 */
function tableFor(tag) {
    return ENTITIES[tag]?.table || `peeringdb_${tag}`;
}

// ---------------------------------------------------------------------------
// D1 execution helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a comma-separated ID string from a D1 result set.
 *
 * @param {D1Result} result - D1 query result.
 * @returns {string|null} CSV ID string, or null if empty.
 */
function idsFromResult(result) {
    if (!result.success || !result.results.length) return null;
    const ids = [];
    for (let i = 0; i < result.results.length; i++) {
        ids.push(result.results[i].id);
    }
    return ids.join(',');
}

/**
 * Looks up a single entity by exact ASN.
 *
 * @param {D1Database} db - D1 session.
 * @param {number} asn - AS number.
 * @param {string} entityTag - Entity type to constrain the lookup ('net').
 * @param {number} limit - Result cap.
 * @returns {Promise<string|null>} CSV IDs or null.
 */
async function lookupByAsn(db, asn, entityTag, limit) {
    if (entityTag !== 'net') return null;
    const result = await db.prepare(
        `SELECT id FROM peeringdb_network WHERE asn = ? AND status = 'ok' LIMIT ?`
    ).bind(asn, limit).all();
    return idsFromResult(result);
}

/**
 * Filters entities by metadata columns (country, city, info_type, region).
 *
 * Builds a WHERE clause from the non-null predicates. City is matched with
 * LIKE for partial/case-insensitive tolerance; the other fields are exact.
 *
 * @param {D1Database} db - D1 session.
 * @param {string} entityTag - Target entity type.
 * @param {{
 *   country: string|null,
 *   city: string|null,
 *   infoType: string|null,
 *   regionContinent: string|null,
 * }} predicates - Active filter predicates.
 * @param {number} limit - Result cap.
 * @returns {Promise<string|null>} CSV IDs or null.
 */
async function filterByMetadata(db, entityTag, predicates, limit) {
    const table = tableFor(entityTag);
    const conditions = [`status = 'ok'`];
    const bindings = [];

    if (predicates.country) {
        conditions.push('country = ?');
        bindings.push(predicates.country);
    }
    if (predicates.city) {
        conditions.push('city LIKE ?');
        bindings.push(`%${predicates.city}%`);
    }
    if (predicates.infoType && entityTag === 'net') {
        conditions.push('info_type = ?');
        bindings.push(predicates.infoType);
    }
    if (predicates.regionContinent) {
        conditions.push('region_continent = ?');
        bindings.push(predicates.regionContinent);
    }

    bindings.push(limit);
    const sql = `SELECT id FROM "${table}" WHERE ${conditions.join(' AND ')} LIMIT ?`;
    const result = await db.prepare(sql).bind(...bindings).all();
    return idsFromResult(result);
}

/**
 * Resolves a named entity to a numeric ID via a name LIKE search.
 *
 * Tries an exact case-insensitive match first (LIKE without wildcards),
 * then a prefix match, to minimise false positives when the anchor is
 * used for graph traversal.
 *
 * @param {D1Database} db - D1 session.
 * @param {string} name - Entity name to resolve.
 * @param {string|null} preferTag - Preferred entity type; null searches all types.
 * @returns {Promise<{id: number, tag: string}|null>} Resolved entity or null.
 */
async function resolveNameToId(db, name, preferTag) {
    const tags = preferTag ? [preferTag] : ['ix', 'fac', 'net', 'org', 'campus', 'carrier'];

    for (const tag of tags) {
        const table = tableFor(tag);
        // Exact match first.
        let result = await db.prepare(
            `SELECT id FROM "${table}" WHERE name = ? AND status = 'ok' LIMIT 1`
        ).bind(name).all();
        if (result.success && result.results.length > 0) {
            return { id: result.results[0].id, tag };
        }
        // Prefix / substring match.
        result = await db.prepare(
            `SELECT id FROM "${table}" WHERE name LIKE ? AND status = 'ok' LIMIT 1`
        ).bind(`%${name}%`).all();
        if (result.success && result.results.length > 0) {
            return { id: result.results[0].id, tag };
        }
    }
    return null;
}

/**
 * Traverses the graph from an anchor entity and returns connected entity IDs.
 *
 * Each traversalIntent maps to a D1 JOIN query via the appropriate join
 * table. The D1 join tables encode all PeeringDB edge relationships:
 *
 *   networks_at  (anchor=ix)    → peeringdb_network_ixlan
 *   networks_at  (anchor=fac)   → peeringdb_network_facility
 *   facilities_at(anchor=ix)    → peeringdb_ix_facility
 *   exchanges_at (anchor=fac)   → peeringdb_ix_facility
 *   members_of   (anchor=ix)    → peeringdb_network_ixlan
 *
 * @param {D1Database} db - D1 session.
 * @param {number} anchorId - ID of the resolved anchor entity.
 * @param {string} anchorTag - Entity type of the anchor.
 * @param {string} entityTag - Target entity type to return.
 * @param {string} traversalIntent - Traversal direction string.
 * @param {number} limit - Result cap.
 * @returns {Promise<string|null>} CSV IDs in database order, or null.
 */
async function traverseFromAnchor(db, anchorId, anchorTag, entityTag, traversalIntent, limit) {
    /** @type {string|null} */
    let sql = null;

    if (anchorTag === 'ix' && entityTag === 'net') {
        // Networks at/members of an IX — via netixlan.
        sql = `SELECT DISTINCT net_id AS id FROM peeringdb_network_ixlan
               WHERE ix_id = ? AND status = 'ok' LIMIT ?`;
    } else if (anchorTag === 'fac' && entityTag === 'net') {
        // Networks present at a facility.
        sql = `SELECT DISTINCT net_id AS id FROM peeringdb_network_facility
               WHERE fac_id = ? LIMIT ?`;
    } else if (anchorTag === 'ix' && entityTag === 'fac') {
        // Facilities hosting an IX.
        sql = `SELECT DISTINCT fac_id AS id FROM peeringdb_ix_facility
               WHERE ix_id = ? LIMIT ?`;
    } else if (anchorTag === 'fac' && entityTag === 'ix') {
        // IXes at a facility.
        sql = `SELECT DISTINCT ix_id AS id FROM peeringdb_ix_facility
               WHERE fac_id = ? LIMIT ?`;
    } else if (anchorTag === 'net' && entityTag === 'ix') {
        // IXes a network is present at.
        sql = `SELECT DISTINCT ix_id AS id FROM peeringdb_network_ixlan
               WHERE net_id = ? AND status = 'ok' LIMIT ?`;
    } else if (anchorTag === 'net' && entityTag === 'fac') {
        // Facilities a network is present at.
        sql = `SELECT DISTINCT fac_id AS id FROM peeringdb_network_facility
               WHERE net_id = ? LIMIT ?`;
    } else if (anchorTag === 'campus' && entityTag === 'fac') {
        // Facilities in a campus.
        sql = `SELECT DISTINCT id FROM peeringdb_facility
               WHERE campus_id = ? AND status = 'ok' LIMIT ?`;
    }

    if (!sql) return null;
    const result = await db.prepare(sql).bind(anchorId, limit).all();
    return idsFromResult(result);
}

/**
 * Fetches an entity's stored graph embedding from Vectorize and performs
 * a kNN query to find structurally similar entities of the target type.
 *
 * Flow:
 *   1. Resolve anchor name → D1 ID + tag.
 *   2. Retrieve anchor's vector: vectorize.getByIds(['{tag}:{id}']).
 *   3. Query Vectorize with that vector, filtered by entityTag metadata.
 *   4. Strip anchor from results. Return IDs in cosine-similarity order.
 *
 * @param {D1Database} db - D1 session (for name resolution).
 * @param {any} vectorize - Cloudflare Vectorize binding.
 * @param {string} anchorName - Entity name to resolve as the similarity anchor.
 * @param {string} entityTag - Target entity type for kNN results.
 * @param {number} limit - Number of similar entities to return.
 * @returns {Promise<string|null>} CSV IDs in similarity order, or null.
 */
async function similaritySearch(db, vectorize, anchorName, entityTag, limit) {
    // Step 1: resolve the anchor name to a numeric ID.
    const anchor = await resolveNameToId(db, anchorName, null);
    if (!anchor) return null;

    const vectorId = `${anchor.tag}:${anchor.id}`;

    // Step 2: retrieve the anchor's stored graph embedding.
    const stored = await vectorize.getByIds([vectorId]);
    if (!stored || !stored.length || !stored[0].values) return null;

    // Step 3: kNN query filtered by target entity type.
    // Fetch extra candidates to account for any post-filter dropping.
    const topK = Math.min(limit * 2, 100);
    const vecResult = await vectorize.query(stored[0].values, {
        topK,
        filter: { entity: entityTag },
        returnMetadata: false,
    });

    if (!vecResult.matches || vecResult.matches.length === 0) return null;

    // Step 4: extract entity IDs, excluding the anchor itself.
    const ids = [];
    const prefix = `${entityTag}:`;
    for (const match of vecResult.matches) {
        if (!match.id.startsWith(prefix)) continue;
        const entityId = match.id.slice(prefix.length);
        if (entityId === String(anchor.id)) continue; // exclude anchor
        ids.push(entityId);
        if (ids.length >= limit) break;
    }

    return ids.length > 0 ? ids.join(',') : null;
}

/**
 * Keyword fallback: D1 LIKE search over name and aka fields.
 *
 * @param {D1Database} db - D1 session.
 * @param {string} entityTag - Entity type to search.
 * @param {string} raw - Raw query string.
 * @param {number} limit - Result cap.
 * @returns {Promise<string|null>} CSV IDs or null.
 */
async function keywordFallback(db, entityTag, raw, limit) {
    const table = tableFor(entityTag);
    const term = `%${raw}%`;
    const result = await db.prepare(
        `SELECT id FROM "${table}"
         WHERE status = 'ok' AND (name LIKE ? OR aka LIKE ?)
         LIMIT ?`
    ).bind(term, term, limit).all();
    return idsFromResult(result);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes a parsed PeeringDB graph search query and returns entity IDs.
 *
 * Routes each predicate to the optimal backend (D1 or Vectorize) in
 * priority order. Returns early as soon as a path yields results.
 *
 * @param {string} rawQuery - Original user query string.
 * @param {string} entityTag - Target entity type ('net', 'fac', 'ix', etc.).
 * @param {D1Database} db - D1 session (withSession already applied).
 * @param {any|null} vectorize - Cloudflare Vectorize binding, or null.
 * @param {number} [limit=25] - Maximum number of entity IDs to return.
 * @returns {Promise<string|null>} Comma-separated entity IDs, or null if no results.
 */
export async function executeGraphSearch(rawQuery, entityTag, db, vectorize, limit = 25) {
    const parsed = parseQuery(rawQuery);

    // 1. ASN exact lookup.
    if (parsed.asn !== null) {
        const ids = await lookupByAsn(db, parsed.asn, entityTag, limit);
        if (ids) return ids;
    }

    // 2. Structural similarity from a named anchor.
    if (parsed.similarToName && vectorize) {
        const ids = await similaritySearch(db, vectorize, parsed.similarToName, entityTag, limit);
        if (ids) return ids;
    }

    // 3. Named anchor + traversal — resolve anchor, then JOIN.
    if (parsed.anchorName && parsed.traversalIntent) {
        // Resolve anchor: prefer IX/fac for "at" queries, net for "peers of" queries.
        const preferTag = parsed.traversalIntent === 'networks_at' || parsed.traversalIntent === 'members_of'
            ? null
            : null; // let resolveNameToId try all types in priority order
        const anchor = await resolveNameToId(db, parsed.anchorName, preferTag);
        if (anchor) {
            const ids = await traverseFromAnchor(db, anchor.id, anchor.tag, entityTag, parsed.traversalIntent, limit);
            if (ids) return ids;
        }
    }

    // 4. Metadata-only predicates → D1 filter.
    const hasMetadata = parsed.country || parsed.city || parsed.infoType || parsed.regionContinent;
    if (hasMetadata) {
        const ids = await filterByMetadata(db, entityTag, {
            country: parsed.country,
            city: parsed.city,
            infoType: parsed.infoType,
            regionContinent: parsed.regionContinent,
        }, limit);
        if (ids) return ids;
    }

    // 5. Keyword fallback — LIKE search on name / aka.
    return keywordFallback(db, entityTag, parsed.raw, limit);
}
