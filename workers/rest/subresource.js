/**
 * @fileoverview Sub-resource endpoint support for the REST worker.
 *
 * Provides handlers for relationship traversal endpoints like
 * `/v1/net/{id}/facilities`. The relationship map is derived from
 * the entity FK definitions in entities.json — forward FKs resolve
 * to parent entities, reverse edges resolve to child collections.
 *
 * @example
 *   GET /v1/net/1/organization     → forward FK: net.org_id → org
 *   GET /v1/org/1/networks         → reverse edge: net WHERE org_id = 1
 *   GET /v1/fac/1/exchanges        → reverse edge: ixfac WHERE fac_id = 1
 */

import { ENTITIES, ENTITY_TAGS } from '../api/entities.js';
import { buildRowQuery } from '../api/query.js';
import { parseQueryFilters } from '../api/utils.js';
import { jsonError } from '../core/http.js';

/**
 * Direction of the sub-resource relationship.
 * @typedef {'forward'|'reverse'} RelDirection
 */

/**
 * A sub-resource relationship descriptor.
 * @typedef {{targetTag: string, fkField: string, direction: RelDirection}} SubResourceDef
 */

/**
 * Maps descriptive relation names to PeeringDB entity tag names.
 * Used for generating human-readable URL slugs.
 * @type {Record<string, string>}
 */
const TAG_TO_RELATION_PLURAL = {
    org: 'organization',
    campus: 'campuses',
    fac: 'facilities',
    net: 'networks',
    ix: 'exchanges',
    carrier: 'carriers',
    carrierfac: 'carrier-facilities',
    ixfac: 'exchange-facilities',
    ixlan: 'exchange-lans',
    ixpfx: 'exchange-prefixes',
    poc: 'contacts',
    netfac: 'network-facilities',
    netixlan: 'network-exchange-lans',
};

/**
 * Builds the sub-resource relationship map from entity FK definitions.
 *
 * For each entity, generates:
 * - Forward relations: one per FK field, returning the single parent entity
 * - Reverse relations: one per child entity that has a FK pointing here
 *
 * @returns {Map<string, Map<string, SubResourceDef>>} entityTag → Map<relationSlug, SubResourceDef>
 */
function buildSubResourceMap() {
    /** @type {Map<string, Map<string, SubResourceDef>>} */
    const map = new Map();

    // Initialize empty maps for all entities
    for (const tag of ENTITY_TAGS) {
        map.set(tag, new Map());
    }

    // Forward FKs: entity → parent
    for (const [tag, entity] of Object.entries(ENTITIES)) {
        const rels = map.get(tag);
        if (!rels) continue;

        for (const field of entity.fields) {
            const fkTarget = field.foreignKey;
            if (!fkTarget || !ENTITY_TAGS.has(fkTarget)) continue;

            // Relation name: "organization" for org_id, "campus" for campus_id, etc.
            const relName = TAG_TO_RELATION_PLURAL[fkTarget] || fkTarget;
            rels.set(relName, {
                targetTag: fkTarget,
                fkField: field.name,
                direction: 'forward',
            });
        }
    }

    // Reverse edges: parent → children
    for (const [childTag, childEntity] of Object.entries(ENTITIES)) {
        for (const field of childEntity.fields) {
            const fkTarget = field.foreignKey;
            if (!fkTarget || !ENTITY_TAGS.has(fkTarget)) continue;

            const parentRels = map.get(fkTarget);
            if (!parentRels) continue;

            // Relation name: use the child entity's descriptive plural
            const relName = TAG_TO_RELATION_PLURAL[childTag] || childTag;

            // Avoid overwriting an existing relation with the same name
            // (e.g. fac has forward FK to org as "organization", don't overwrite)
            if (!parentRels.has(relName)) {
                parentRels.set(relName, {
                    targetTag: childTag,
                    fkField: field.name,
                    direction: 'reverse',
                });
            }
        }
    }

    return map;
}

/**
 * Pre-built sub-resource relationship map used by handleSubResource.
 * @type {Map<string, Map<string, SubResourceDef>>}
 */
export const SUBRESOURCE_MAP = buildSubResourceMap();

/**
 * Handles a sub-resource request for a relationship endpoint.
 *
 * Forward FKs (e.g. /v1/net/1/organization): fetches the parent entity
 * by reading the FK field value from the source entity and looking up
 * the parent by ID.
 *
 * Reverse edges (e.g. /v1/org/1/networks): fetches child entities
 * that have the source entity's ID in their FK field.
 *
 * @param {{db: D1Session}} rc - Request context with D1 session.
 * @param {string} sourceTag - Source entity tag (e.g. "net").
 * @param {number} sourceId - Source entity ID.
 * @param {string} relation - Relation slug (e.g. "organization", "facilities").
 * @param {string} queryString - Raw query string for filter/pagination params.
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @param {Record<string, string>} hResponse - Response headers.
 * @returns {Promise<Response>} JSON response with the related entities.
 */
export async function handleSubResource(rc, sourceTag, sourceId, relation, queryString, authenticated, hResponse) {
    const rels = SUBRESOURCE_MAP.get(sourceTag);
    if (!rels) return jsonError(404, `Unknown entity: ${sourceTag}`);

    const def = rels.get(relation);
    if (!def) {
        const available = [...rels.keys()].join(', ');
        return jsonError(404, `Unknown relation '${relation}' on ${sourceTag}. Available: ${available}`);
    }

    const targetEntity = ENTITIES[def.targetTag];

    // Restricted entities (poc) are empty for anonymous callers
    if (!authenticated && targetEntity._restricted) {
        return new Response('{"data":[],"meta":{}}\n', { status: 200, headers: hResponse });
    }

    const { filters, limit, skip } = parseQueryFilters(queryString);

    if (def.direction === 'forward') {
        return handleForwardFK(rc.db, sourceTag, sourceId, def, hResponse);
    }

    return handleReverseEdge(rc.db, def, sourceId, filters, limit, skip, hResponse);
}

/**
 * Resolves a forward FK relationship by fetching the parent entity.
 *
 * First queries the source entity to get the FK value, then fetches
 * the parent entity by that ID.
 *
 * @param {D1Session} db - D1 session.
 * @param {string} sourceTag - Source entity tag.
 * @param {number} sourceId - Source entity ID.
 * @param {SubResourceDef} def - Relationship definition.
 * @param {Record<string, string>} hResponse - Response headers.
 * @returns {Promise<Response>} JSON response with the parent entity.
 */
async function handleForwardFK(db, sourceTag, sourceId, def, hResponse) {
    const sourceEntity = ENTITIES[sourceTag];

    // Get the FK value from the source entity
    const srcFilters = [{ field: 'id', op: 'eq', value: String(sourceId) }];
    const srcOpts = { depth: 0, limit: 1, skip: 0, since: 0, sort: '', fields: [def.fkField] };
    const { sql: srcSql, params: srcParams } = buildRowQuery(sourceEntity, srcFilters, srcOpts);
    const srcResult = await db.prepare(srcSql).bind(...srcParams).first();

    if (!srcResult) return jsonError(404, `${sourceTag} ${sourceId} not found`);

    const fkValue = srcResult[def.fkField];
    if (!fkValue) return jsonError(404, `No ${def.targetTag} associated`);

    // Fetch the target entity
    const targetEntity = ENTITIES[def.targetTag];
    const tgtFilters = [{ field: 'id', op: 'eq', value: String(fkValue) }];
    const tgtOpts = { depth: 0, limit: 1, skip: 0, since: 0, sort: '' };
    const { sql: tgtSql, params: tgtParams } = buildRowQuery(targetEntity, tgtFilters, tgtOpts);
    const tgtResult = await db.prepare(tgtSql).bind(...tgtParams).all();

    const data = tgtResult.results || [];
    return new Response(JSON.stringify({ data, meta: {} }) + '\n', { status: 200, headers: hResponse });
}

/**
 * Resolves a reverse edge relationship by querying child entities.
 *
 * @param {D1Session} db - D1 session.
 * @param {SubResourceDef} def - Relationship definition.
 * @param {number} parentId - Parent entity ID.
 * @param {ParsedFilter[]} extraFilters - Additional filters from query string.
 * @param {number} limit - Maximum results.
 * @param {number} skip - Number of results to skip.
 * @param {Record<string, string>} hResponse - Response headers.
 * @returns {Promise<Response>} JSON response with child entities.
 */
async function handleReverseEdge(db, def, parentId, extraFilters, limit, skip, hResponse) {
    const targetEntity = ENTITIES[def.targetTag];
    const filters = [
        { field: def.fkField, op: 'eq', value: String(parentId) },
        ...extraFilters,
    ];
    const opts = {
        depth: 0,
        limit: limit > 0 ? Math.min(limit, 250) : 250,
        skip: Math.max(skip, 0),
        since: 0,
        sort: '',
    };

    const { sql, params } = buildRowQuery(targetEntity, filters, opts);
    const result = await db.prepare(sql).bind(...params).all();
    const data = result.results || [];

    return new Response(JSON.stringify({ data, meta: {} }) + '\n', { status: 200, headers: hResponse });
}
