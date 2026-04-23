/**
 * @fileoverview Entity field map for the search worker.
 *
 * Defines which D1 columns are searched by the keyword handler for each
 * entity type. Kept separate from the full api/entities.js schema to avoid
 * pulling in the entire entity registry (which includes filter operators,
 * join metadata, and generated lookup Sets that are irrelevant to search).
 *
 * Fields are ordered by relevance: the first field is the primary display
 * name and is used for the `name` property in search results.
 */

/**
 * Maps each entity tag to the list of D1 column names to include in a
 * LIKE keyword search. The first entry in each array is used as the
 * display `name` field in search results.
 *
 * @type {Record<string, string[]>}
 */
export const SEARCH_FIELDS = {
    net:     ['name', 'aka', 'website', 'notes'],
    ix:      ['name', 'aka', 'notes', 'website'],
    fac:     ['name', 'aka', 'website', 'notes'],
    org:     ['name', 'aka', 'website'],
    carrier: ['name', 'aka', 'website'],
    campus:  ['name', 'aka', 'website'],
    poc:     ['name', 'email'],
    ixfac:   ['name'],
    ixlan:   ['name', 'description'],
    ixpfx:   ['prefix'],
    netfac:  ['name'],
    netixlan:['name'],
    as_set:  ['name'],
};

/**
 * Set of valid entity tags for O(1) membership checks.
 * Derived from SEARCH_FIELDS keys at module load time (cold boot, not hot path).
 *
 * @type {Set<string>}
 */
export const SEARCH_ENTITY_TAGS = new Set(Object.keys(SEARCH_FIELDS));

/**
 * Returns the primary display field name for a given entity type.
 * Used to populate the `name` key in search result rows.
 *
 * @param {string} entityTag - A key from SEARCH_FIELDS.
 * @returns {string} The first field in the SEARCH_FIELDS entry for this tag.
 */
export function getPrimaryField(entityTag) {
    const fields = SEARCH_FIELDS[entityTag];
    return fields ? fields[0] : 'name';
}
