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
 * Returns column names for an entity. Uses precompiled _columns cache,
 * falls back to deriving from fields (for test mocks).
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @returns {string[]} Ordered column names.
 */
export function getColumns(entity) {
    return /** @type {any} */ (entity)._columns || entity.fields.map(f => f.name);
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
    for (let i = 0; i < requested.length; i++) {
        if (valid.has(requested[i])) result.push(requested[i]);
    }
    return result;
}

/** Valid filter operators. */
const VALID_OPS = new Set(['eq', 'lt', 'gt', 'lte', 'gte', 'contains', 'startswith', 'in']);

/**
 * Maximum number of values allowed in an __in filter list.
 * D1/SQLite has a compiled-in limit of 999 bind parameters
 * (SQLITE_MAX_VARIABLE_NUMBER). We cap at 500 to leave headroom
 * for other bind parameters in the same query (pagination, since,
 * status, cross-entity subqueries).
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
 * @param {string} sort - Sort parameter (e.g. "-updated").
 * @returns {string|null} Error message, or null if query is valid.
 */
export function validateQuery(entity, filters, sort) {
    const fieldNames = getFieldNames(entity);

    for (const f of filters) {
        if (!VALID_OPS.has(f.op)) {
            return `Unknown filter operator '${f.op}'`;
        }

        // Reject __in lists that would exceed D1's bind parameter limit
        if (f.op === 'in') {
            const count = f.value.split(',').length;
            if (count > MAX_IN_VALUES) {
                return `Too many values in __in filter for '${f.field}': ${count} exceeds maximum of ${MAX_IN_VALUES}`;
            }
        }

        if (f.entity) {
            // Cross-entity filter: validate FK chain
            const ref = resolveCrossEntityFilter(entity, f.entity, f.field);
            if (typeof ref === 'string') return ref;
        } else {
            // Regular filter: field must exist and be queryable
            if (!fieldNames.has(f.field)) {
                return `Unknown field '${f.field}' on ${entity.tag}`;
            }
            const fieldType = getFilterType(entity, f.field);
            if (!fieldType) {
                return `Field '${f.field}' is not filterable on ${entity.tag}`;
            }
        }
    }

    if (sort) {
        const col = sort.startsWith('-') ? sort.slice(1) : sort;
        if (!fieldNames.has(col)) {
            return `Unknown sort column '${col}' on ${entity.tag}`;
        }
    }

    return null;
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

    for (let i = 0; i < filters.length; i++) {
        const f = filters[i];
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
