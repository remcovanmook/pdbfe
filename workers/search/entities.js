/**
 * @fileoverview Entity field map for the search worker.
 *
 * Derives keyword search fields from the precompiled entity definitions in
 * extracted/entities-worker.js. No hardcoded field lists — the set of
 * searchable fields is always consistent with the generated schema.
 *
 * Searchable fields are string-type columns that are not foreign keys
 * (_id suffix), not internal (_), and not likely to contain only codes
 * (status, rir_status, info_type, logo, etc. are excluded).
 *
 * The first field for each entity is used as the display `name` in
 * search results. `name` is always first if present.
 */

import { ENTITIES, ENTITY_TAGS } from '../api/entities.js';

/**
 * Column names excluded from keyword search even if string-typed.
 * These fields contain status codes, URLs, or other non-searchable values.
 *
 * @type {Set<string>}
 */
const EXCLUDED_FIELDS = new Set([
    'status', 'rir_status', 'logo', 'info_type', 'policy_general',
    'policy_locations', 'policy_contracts', 'info_traffic', 'info_ratio',
    'info_scope', 'status_dashboard', 'notes_private',
    // PII — excluded as defence-in-depth even though poc is not in SEARCH_ENTITY_TAGS.
    'email', 'phone',
]);

/**
 * Maximum number of string fields to search per entity.
 * Limits SQL WHERE clause growth on entities with many string columns.
 *
 * @type {number}
 */
const MAX_SEARCH_FIELDS = 4;

/**
 * Derives the list of searchable string-type column names for a single entity.
 *
 * Selection rules:
 *   1. Must be type === 'string'
 *   2. Must not end in '_id' (foreign key)
 *   3. Must not start with '_' (internal)
 *   4. Must not be in EXCLUDED_FIELDS
 *   5. 'name' is always first if present; remaining fields in schema order
 *   6. Capped at MAX_SEARCH_FIELDS entries
 *
 * @param {EntityMeta} entity - Entity definition from ENTITIES.
 * @returns {string[]} Ordered list of column names to LIKE-search.
 */
function deriveSearchFields(entity) {
    /** @type {string[]} */
    const named = [];
    /** @type {string[]} */
    const rest = [];

    for (const field of entity.fields) {
        if (field.type !== 'string') continue;
        if (field.name.endsWith('_id')) continue;
        if (field.name.startsWith('_')) continue;
        if (EXCLUDED_FIELDS.has(field.name)) continue;
        if (field.name === 'name') named.push(field.name);
        else rest.push(field.name);
    }

    // Combine: name first, then rest, capped at MAX_SEARCH_FIELDS.
    const combined = named.concat(rest);
    return combined.length > MAX_SEARCH_FIELDS
        ? combined.slice(0, MAX_SEARCH_FIELDS)
        : combined;
}

/** @type {Record<string, string[]>} */
const _searchFields = {};
for (const tag of ENTITY_TAGS) {
    _searchFields[tag] = deriveSearchFields(ENTITIES[tag]);
}

/**
 * Maps each entity tag to the ordered list of D1 columns to LIKE-search.
 * Derived at module load time (cold boot) from the generated ENTITIES map.
 * Keys match ENTITY_TAGS.
 *
 * @type {Record<string, string[]>}
 */
export const SEARCH_FIELDS = _searchFields;

/**
 * Re-exported for consumers that need the full entity registry.
 * Avoids coupling handlers directly to api/entities.js.
 *
 * @type {typeof import('../../api/entities.js').ENTITIES}
 */
export { ENTITIES };

/**
 * The six primary navigational entity types exposed through search.
 *
 * Deliberately restricted — does NOT include:
 *   - poc  (peeringdb_network_contact): contains phone, email, and name fields
 *     subject to a visibility gate (_anonFilter) that the search worker does
 *     not apply. Exposing poc through search would leak non-Public contacts to
 *     anonymous callers.
 *   - Junction / relation tables (netfac, netixlan, carrierfac, ixfac, ixlan,
 *     ixpfx, carrierfac): no meaningful name field; not useful for discovery.
 *
 * @type {Set<string>}
 */
export const SEARCH_ENTITY_TAGS = new Set(['net', 'ix', 'fac', 'org', 'carrier', 'campus']);

/**
 * Returns the primary display field name for a given entity type.
 * Used to populate the `name` key in search result rows.
 * Falls back to 'name' if the entity has no searchable fields.
 *
 * @param {string} entityTag - A key from SEARCH_FIELDS.
 * @returns {string} The first field in the SEARCH_FIELDS entry for this tag.
 */
export function getPrimaryField(entityTag) {
    const fields = SEARCH_FIELDS[entityTag];
    return (fields && fields.length > 0) ? fields[0] : 'name';
}

/**
 * Extra columns to SELECT per entity type for search result rows.
 *
 * These are not search fields (not used in WHERE LIKE predicates) but
 * supplementary display fields the frontend subtitle formatters require.
 * Kept separate from SEARCH_FIELDS so the LIKE clause stays narrow.
 *
 * - net: asn — displayed as "AS{asn}" below the network name
 * - ix:  city — location hint below the exchange name
 * - fac: city, country — location below the facility name
 * - campus: city, country — location below the campus name
 *
 * @type {Record<string, string[]>}
 */
export const EXTRA_FIELDS = {
    net:     ['asn'],
    ix:      ['city'],
    fac:     ['city', 'country'],
    org:     [],
    carrier: [],
    campus:  ['city', 'country'],
};

/**
 * Returns the list of extra display columns for a given entity type.
 * Returns an empty array for entity types not present in EXTRA_FIELDS.
 *
 * @param {string} entityTag - Entity type tag (e.g. "net", "ix").
 * @returns {string[]} Column names to include in the SELECT beyond id/name/status.
 */
export function getExtraFields(entityTag) {
    return EXTRA_FIELDS[entityTag] || [];
}
