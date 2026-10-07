/**
 * @fileoverview Entity registry for the PeeringDB API worker.
 *
 * Re-exports precompiled entity definitions and cache tier configs from
 * the generated `extracted/entities-worker.js` module. All entity metadata
 * — fields, relationships, joinColumns, and field lookup caches — are
 * computed at generation time by `parse_django_models.py`.
 *
 * Field accessor functions (getColumns, getFilterType, validateQuery, etc.)
 * live here as real JS — they don't change with the schema.
 *
 * Regenerate data with: .venv/bin/python scripts/parse_django_models.py --force
 */

// ── Re-exports from precompiled data ────────────────────────────────────────

export {
    ENTITIES,
    ENTITY_TAGS,
    CACHE_TIERS,
    DEFAULT_TIER,
    VERSIONS,
} from '../../extracted/entities-worker.js';

import { ENTITIES } from '../../extracted/entities-worker.js';

// ── Field accessor helpers ──────────────────────────────────────────────────

/**
 * pdbfe-extension columns the frontend legitimately needs under __pdbfe=1.
 * This is an explicit ALLOWLIST, not "every __ column". __logo_migrated is a
 * harmless hint (whether the logo can be served from our R2 bucket instead of
 * the upstream URL). Internal-only __vector_embedded and the private,
 * never-populated notes_private are deliberately excluded, so they are emitted
 * by no route at all.
 * @type {string[]}
 */
const PDBFE_EXTENSION_COLUMNS = ['__logo_migrated'];

/**
 * Returns column names for an entity. Uses precompiled _columns cache,
 * falls back to deriving from fields (for test mocks).
 *
 * By default, columns with a __ prefix (local pdbfe extension fields) and the
 * private notes_private are excluded, keeping the API surface upstream-
 * compatible for third-party consumers. Pass includePdbfe=true (?__pdbfe=1) to
 * additionally include the allowlisted PDBFE_EXTENSION_COLUMNS.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {boolean} [includePdbfe=false] - Include the pdbfe-extension columns
 *        (the explicit allowlist below), triggered by ?__pdbfe=1.
 * @returns {string[]} Ordered column names.
 */
export function getColumns(entity, includePdbfe = false) {
    const all = /** @type {any} */ (entity)._columns || entity.fields.map(f => f.name);
    // Lazy-cache both projections to avoid re-filtering per request.
    const e = /** @type {any} */ (entity);
    if (!e._columnsPublic) {
        e._columnsPublic = all.filter(/** @type {(c: string) => boolean} */ (c) => !c.startsWith('__') && c !== 'notes_private');
    }
    if (!includePdbfe) return e._columnsPublic;
    if (!e._columnsPdbfe) {
        // Public columns plus ONLY the allowlisted extension columns present on
        // this entity — never __vector_embedded (internal) or notes_private
        // (private, never populated). So those are emitted by no route at all.
        const extras = PDBFE_EXTENSION_COLUMNS.filter(/** @type {(c: string) => boolean} */ (c) => all.includes(c));
        e._columnsPdbfe = e._columnsPublic.concat(extras);
    }
    return e._columnsPdbfe;
}

/**
 * Returns Set of JSON-stored column names. Used by the query builder to
 * wrap these columns in json() for D1 reads. Uses precompiled cache,
 * falls back to deriving from fields.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @returns {Set<string>} Column names with json: true.
 */
export function getJsonColumns(entity) {
    if (/** @type {any} */ (entity)._jsonColumns) return /** @type {any} */ (entity)._jsonColumns;
    const s = new Set();
    for (const field of entity.fields) { if (field.json) s.add(field.name); }
    return s;
}

/**
 * Returns Set of boolean-typed column names. Used by the query builder to
 * emit proper JSON booleans (true/false) instead of SQLite's 0/1 integers.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @returns {Set<string>} Column names with type: 'boolean'.
 */
export function getBoolColumns(entity) {
    if (/** @type {any} */ (entity)._boolColumns) return /** @type {any} */ (entity)._boolColumns;
    const s = new Set();
    for (const field of entity.fields) { if (field.type === 'boolean') s.add(field.name); }
    return s;
}

/**
 * Returns Set of nullable column names. Used by the query builder to
 * emit NULLIF(col, '') so that empty strings stored in D1 are returned
 * as JSON null, matching upstream PeeringDB behaviour.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @returns {Set<string>} Column names with nullable: true.
 */
export function getNullableColumns(entity) {
    if (/** @type {any} */ (entity)._nullableColumns) return /** @type {any} */ (entity)._nullableColumns;
    const s = new Set();
    for (const field of entity.fields) { if (field.nullable) s.add(field.name); }
    return s;
}

/**
 * Returns Set of omitempty column names. Used by the query builder to
 * strip these fields from the JSON output via json_remove() when their
 * value is null, empty string, or the type's zero value — matching
 * upstream PeeringDB's Django serializer behaviour.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @returns {Set<string>} Column names with omitempty: true.
 */
export function getOmitEmptyColumns(entity) {
    if (/** @type {any} */ (entity)._omitEmptyColumns) return /** @type {any} */ (entity)._omitEmptyColumns;
    const s = new Set();
    for (const field of entity.fields) { if (field.omitempty) s.add(field.name); }
    return s;
}

/**
 * Looks up a field's type for filter validation. Uses the precompiled
 * _filterTypes Map when available, falls back to linear scan for test mocks.
 *
 * JSON fields always have queryable: false in the schema, so they return
 * null here (correctly preventing them from being used as filters).
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string} fieldName - The field name to look up.
 * @returns {'string'|'number'|'boolean'|'datetime'|null} Field type, or null if not queryable.
 */
export function getFilterType(entity, fieldName) {
    const cached = /** @type {any} */ (entity)._filterTypes;
    if (cached) {
        return /** @type {'string'|'number'|'boolean'|'datetime'|null} */ (cached.get(fieldName) ?? null);
    }
    for (const field of entity.fields) {
        if (field.name === fieldName) return field.queryable === false ? null : /** @type {'string'|'number'|'boolean'|'datetime'} */ (field.type);
    }
    return null;
}

/**
 * Returns Set of all field names. Uses precompiled cache when available.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @returns {Set<string>} All field names.
 */
function getFieldNames(entity) {
    return /** @type {any} */ (entity)._fieldNames || new Set(entity.fields.map(f => f.name));
}

/**
 * Validates a list of requested field names against an entity's field definitions.
 * Returns only names that exist on the entity. Always includes 'id'.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string[]} requested - Field names from the ?fields= parameter.
 * @returns {string[]} Validated field names.
 */
export function validateFields(entity, requested) {
    const valid = getFieldNames(entity);
    /** @type {string[]} */
    const result = [];
    for (const field of requested) {
        if (valid.has(field)) result.push(field);
    }
    return result;
}

/** Valid filter operators. */
const VALID_OPS = new Set(['eq', 'lt', 'gt', 'lte', 'gte', 'contains', 'startswith', 'in']);

/**
 * Maximum number of values permitted in an 'in' or 'notin' filter (e.g. id__in=1,2,3)
 * @type {number}
 */
export const MAX_IN_VALUES = 500;

/**
 * Validates parsed query filters and sort against the entity schema.
 * Returns a human-readable error string if invalid, or null if valid.
 *
 * Handles both regular filters (field on this entity) and cross-entity
 * filters (field on a FK-related entity, e.g. fac__state on ixfac).
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * Unknown sort columns are not an error either: buildOrderBy falls back to id.
 *
 * @returns {string|null} Error message, or null if query is valid.
 */
export function validateQuery(entity, filters) {
    const fieldNames = getFieldNames(entity);

    for (const f of filters) {

        // Reject __in lists that would exceed D1's bind parameter limit
        if (f.op === 'in') {
            const count = f.value.split(',').length;
            if (count > MAX_IN_VALUES) {
                return `Too many values in __in filter for '${f.field}': ${count} exceeds maximum of ${MAX_IN_VALUES}`;
            }
        }

        // Known but not filterable (e.g. JSON columns): upstream applies these,
        // so ignoring them would silently return unfiltered results — reject.
        // Unknown fields are not an error (see dropUnknownFilters).
        if (!f.entity && fieldNames.has(f.field) && !getFilterType(entity, f.field)) {
            return `Field '${f.field}' is not filterable on ${entity.tag}`;
        }
    }

    return null;
}

/**
 * Removes filters that refer to nothing on this entity, in place: unknown
 * fields (`?zzz=1`, `?pk=26`), unknown operators (`?name__bogus=x`, which
 * parses as a cross-entity ref), and cross-entity filters whose FK chain or
 * field does not resolve. Upstream ignores unknown query parameters rather
 * than failing the request, and clients rely on that (peeringdb-py sends
 * `?pk=`). Known-but-not-filterable fields are kept so validateQuery can
 * reject them.
 *
 * @param {EntityMeta} entity
 * @param {ParsedFilter[]} filters - Mutated in place.
 */
export function dropUnknownFilters(entity, filters) {
    const fieldNames = getFieldNames(entity);
    let w = 0;
    // Compact in place; the write index never passes the read position.
    for (const f of filters) {
        const known = VALID_OPS.has(f.op) && (f.entity
            ? typeof resolveCrossEntityFilter(entity, f.entity, f.field) !== 'string'
            : fieldNames.has(f.field));
        if (known) filters[w++] = f;
    }
    filters.length = w;
}

/**
 * Resolves implicit cross-entity filters by checking FK-related entities.
 *
 * When a filter field doesn't exist on the current entity, iterates through
 * the entity's FK fields and checks if any referenced entity has that field
 * as a queryable column. If found, mutates the filter in-place to set
 * `f.entity` to the target tag, converting it to an explicit cross-entity
 * filter that the query builder already handles.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed filters (mutated in place).
 */
export function resolveImplicitFilters(entity, filters) {
    const fieldNames = getFieldNames(entity);

    for (const f of filters) {
        if (f.entity) continue;          // already explicit cross-entity
        if (fieldNames.has(f.field)) continue; // field exists on this entity

        // Check each FK field's target entity for this field name
        for (const field of entity.fields) {
            if (!field.foreignKey) continue;

            const target = ENTITIES[field.foreignKey];
            if (!target) continue;

            const fieldType = getFilterType(target, f.field);
            if (fieldType) {
                f.entity = field.foreignKey;
                break;
            }
        }
    }
}

/**
 * Resolves a cross-entity filter reference by following FK metadata.
 *
 * Given a filter like `fac__state=NSW` on the `ixfac` entity:
 *   1. Finds the field on ixfac with `foreignKey === 'fac'` → `fac_id`
 *   2. Looks up the `fac` entity → table `peeringdb_facility`
 *   3. Verifies `state` is queryable on `fac`
 *
 * Returns the resolved reference for the query builder, or an error string.
 *
 * @param {EntityMeta} entity - Current entity being queried.
 * @param {string} targetTag - Referenced entity tag (e.g. "fac").
 * @param {string} fieldName - Field name on the target entity (e.g. "state").
 * @returns {{fkField: string, targetTable: string, fieldType: string}|string}
 *   Resolved reference, or error string.
 */
export function resolveCrossEntityFilter(entity, targetTag, fieldName) {
    // Find the FK field on this entity that references the target
    const fkField = entity.fields.find(f => f.foreignKey === targetTag);
    if (!fkField) {
        return `No foreign key to '${targetTag}' on ${entity.tag}`;
    }

    const target = ENTITIES[targetTag];
    if (!target) {
        return `Unknown entity '${targetTag}'`;
    }

    const fieldType = getFilterType(target, fieldName);
    if (!fieldType) {
        return `Field '${fieldName}' is not filterable on ${targetTag}`;
    }

    return {
        fkField: fkField.name,
        targetTable: target.table,
        fieldType,
    };
}
