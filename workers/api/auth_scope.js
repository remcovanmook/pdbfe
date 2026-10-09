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
 *   - depth>0 on a detail view whose expanded parent objects (api/depth.js:
 *     every `<tag>_id` → `<tag>`, one level deeper at depth=2) reach a
 *     restricted entity: netixlan/1?depth=1 → ixlan (gated column),
 *     netfac/1?depth=2 → net.poc_set, or
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
 * Whether a detail view of `tag` at `depth` can contain restricted data,
 * following api/depth.js: the entity itself, its child sets (depth≥1), and
 * each expanded parent (`<parent>_id` → `<parent>`), which is serialised at
 * depth-1 — so at depth=2 the parent's own sets and parents count too.
 *
 * @param {string} tag @param {number} depth @returns {boolean}
 */
function detailReachesRestricted(tag, depth) {
    const entity = ENTITIES[tag];
    if (!entity || isRestrictedish(entity)) return true;
    if (depth <= 0) return false;
    if (DEPTH_SENSITIVE.has(tag)) return true;
    for (const f of entity.fields) {
        const parentTag = f.foreignKey;
        if (!parentTag || !ENTITIES[parentTag] || f.name !== `${parentTag}_id`) continue;
        if (detailReachesRestricted(parentTag, depth - 1)) return true;
    }
    return false;
}

/** Detail views that can contain restricted data, per depth (1, 2; depth is capped at 2). */
const DETAIL_SENSITIVE = [new Set(), new Set(), new Set()];
for (const tag in ENTITIES) {
    for (const d of [1, 2]) if (detailReachesRestricted(tag, d)) DETAIL_SENSITIVE[d].add(tag);
}

/**
 * Whether the response for this entity request can differ by auth state.
 *
 * @param {string} entityTag - Entity tag (e.g. "net").
 * @param {number} depth - Requested depth.
 * @param {ParsedFilter[]} filters - Parsed filters (cross-entity filters carry `entity`).
 * @param {boolean} [detail=false] - Detail view (GET /api/{tag}/{id}), which
 *        expands every parent FK (api/depth.js); lists expand org only.
 * @returns {boolean} true when the response must be partitioned by auth state.
 */
export function isAuthSensitive(entityTag, depth, filters, detail = false) {
    const entity = ENTITIES[entityTag];
    if (!entity || isRestrictedish(entity)) return true;
    if (depth > 0 && DEPTH_SENSITIVE.has(entityTag)) return true;
    if (detail && depth > 0 && DETAIL_SENSITIVE[Math.min(depth, 2)].has(entityTag)) return true;
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
