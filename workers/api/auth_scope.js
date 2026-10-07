/**
 * @fileoverview Which responses depend on the caller's auth state.
 *
 * Authenticated and anonymous callers get byte-identical responses except
 * where a restricted entity (poc: non-Public contacts are hidden from
 * anonymous callers) can appear. Everything else is "shared": one cached
 * copy serves everyone, including at the Cloudflare edge, where the Worker
 * does not run on a hit and so cannot check credentials. That is why the
 * decision is made from the request shape alone, conservatively:
 *
 *   - the entity itself is restricted (poc lists / lookups), or
 *   - depth>0 on an entity whose child sets include a restricted entity
 *     (net → poc_set), or
 *   - a cross-entity filter into a restricted entity.
 *
 * Tables with visibility-gated columns (api/field_visibility.js, e.g.
 * ixlan.ixf_ixp_member_list_url) count as restricted here too.
 *
 * Unknown entities are treated as sensitive.
 */

import { ENTITIES } from './entities.js';
import { GATED_TABLES } from './field_visibility.js';

/**
 * Whether an entity's rows can differ by auth state: restricted (poc) or
 * carrying a visibility-gated column (ixlan).
 * @param {any} entity
 * @returns {boolean}
 */
function isRestrictedish(entity) {
    return entity._restricted === true || GATED_TABLES.has(entity.table);
}

/** Tags whose depth>0 expansion includes a restricted child set. Built once at isolate start. */
const DEPTH_SENSITIVE = new Set();
{
    const restrictedTables = new Set();
    for (const tag in ENTITIES) {
        if (isRestrictedish(ENTITIES[tag])) restrictedTables.add(ENTITIES[tag].table);
    }
    for (const tag in ENTITIES) {
        for (const rel of ENTITIES[tag].relationships) {
            if (restrictedTables.has(rel.table)) DEPTH_SENSITIVE.add(tag);
        }
    }
}

/**
 * Whether the response for this entity request can differ by auth state.
 *
 * @param {string} entityTag - Entity tag (e.g. "net").
 * @param {number} depth - Requested depth.
 * @param {ParsedFilter[]} filters - Parsed filters (cross-entity filters carry `entity`).
 * @returns {boolean} true when the response must be partitioned by auth state.
 */
export function isAuthSensitive(entityTag, depth, filters) {
    const entity = ENTITIES[entityTag];
    if (!entity || isRestrictedish(entity)) return true;
    if (depth > 0 && DEPTH_SENSITIVE.has(entityTag)) return true;
    for (const f of filters) {
        const fe = f.entity;
        if (fe && (!ENTITIES[fe] || isRestrictedish(ENTITIES[fe]))) return true;
    }
    return false;
}

/**
 * Whether a sub-resource response (source/{id}/relation) can differ by auth
 * state: either end restricted (e.g. /v1/net/1/contacts, /v1/poc/1/networks).
 *
 * @param {string} sourceTag - Source entity tag.
 * @param {string|undefined} targetTag - Target entity tag of the relation.
 * @returns {boolean}
 */
export function isRelationAuthSensitive(sourceTag, targetTag) {
    const s = ENTITIES[sourceTag];
    const t = targetTag ? ENTITIES[targetTag] : undefined;
    return !s || !t || isRestrictedish(s) || isRestrictedish(t);
}
