/**
 * @fileoverview Entity metadata registry for all PeeringDB API entity types.
 *
 * Each entity is built using the {@link Entity} class, which provides a
 * chainable builder API. Fields are the single source of truth — foreign
 * key annotations on fields drive the automatic derivation of:
 *   - joinColumns: LEFT JOINs for direct list/detail queries
 *   - relationships: depth expansion _set fields
 *
 * Every entity automatically receives id, created, updated, and status
 * fields via {@link Entity#done}.
 *
 * @example
 * const net = new Entity('net', 'peeringdb_network')
 *     .number('org_id', { foreignKey: 'org', resolve: { name: 'org_name' } })
 *     .string('name')
 *     .number('asn')
 *     .done();
 */

// ── Entity builder ───────────────────────────────────────────────────────────

/**
 * Builder for entity metadata. Provides typed field methods and handles
 * boilerplate (id + timestamps) automatically.
 *
 * Fields marked with `foreignKey` reference another entity by tag.
 * After all entities are defined, {@link deriveRelationships} scans these
 * annotations to populate `joinColumns` (for query-time JOINs) and
 * `relationships` (for depth expansion).
 *
 * @implements {EntityMeta}
 */
class Entity {
    /**
     * @param {string} tag - API endpoint tag (e.g. "net").
     * @param {string} table - D1 table name (e.g. "peeringdb_network").
     */
    constructor(tag, table) {
        this.tag = tag;
        this.table = table;
        /** @type {FieldDef[]} */
        this.fields = [{ name: 'id', type: 'number' }];
        /** @type {EntityRelationship[]} */
        this.relationships = [];
        /** @type {JoinColumnDef[]|undefined} */
        this.joinColumns = undefined;
        /** @type {boolean} */
        this._restricted = false;
        /** @type {{field: string, value: string}|undefined} */
        this._anonFilter = undefined;
    }

    /**
     * Add a string field (queryable by default).
     * @param {string} name - Column name in D1.
     * @param {FieldOpts} [opts] - Override defaults.
     * @returns {this}
     */
    string(name, opts) { return this._add(name, 'string', opts); }

    /**
     * Add a number field (queryable by default).
     * @param {string} name
     * @param {FieldOpts} [opts]
     * @returns {this}
     */
    number(name, opts) { return this._add(name, 'number', opts); }

    /**
     * Add a boolean field (queryable by default).
     * @param {string} name
     * @param {FieldOpts} [opts]
     * @returns {this}
     */
    boolean(name, opts) { return this._add(name, 'boolean', opts); }

    /**
     * Add a datetime field (queryable by default).
     * @param {string} name
     * @param {FieldOpts} [opts]
     * @returns {this}
     */
    datetime(name, opts) { return this._add(name, 'datetime', opts); }

    /**
     * Add a JSON-stored TEXT column. Non-queryable by definition — D1
     * stores these as serialised JSON strings that need json() wrapping
     * in sql and JSON.parse on the V8 side.
     * @param {string} name - Column name.
     * @returns {this}
     */
    json(name) { return this._add(name, 'string', { queryable: false, json: true }); }

    /**
     * Add the standard mailing address field group (city, country, state,
     * zipcode, plus non-queryable street/geo fields). Used by org and fac.
     * @returns {this}
     */
    address() {
        return this
            .string('address1', { queryable: false })
            .string('address2', { queryable: false })
            .string('city')
            .string('country')
            .string('state')
            .string('zipcode')
            .string('floor', { queryable: false })
            .string('suite', { queryable: false })
            .number('latitude', { queryable: false })
            .number('longitude', { queryable: false });
    }

    /**
     * Marks this entity as requiring authentication for full data access.
     * Anonymous callers will have the anonFilter applied automatically.
     * @returns {this}
     */
    restricted() {
        this._restricted = true;
        return this;
    }

    /**
     * Defines a mandatory filter applied to anonymous (unauthenticated)
     * queries. This filter cannot be overridden by user-supplied query
     * parameters — any user-supplied filter on the same field is stripped
     * and replaced with this value.
     *
     * @param {string} field - Column name to filter on.
     * @param {string} value - Required value for anonymous access.
     * @returns {this}
     */
    anonFilter(field, value) {
        this._anonFilter = { field, value };
        return this;
    }

    /**
     * Seal the entity definition by appending standard timestamp fields
     * (created, updated, status). Call this last in the builder chain.
     * @returns {this}
     */
    done() {
        this.fields.push(
            { name: 'created', type: 'datetime' },
            { name: 'updated', type: 'datetime' },
            { name: 'status', type: 'string' },
        );
        return this;
    }

    /**
     * Internal: push a FieldDef onto the fields array.
     * @param {string} name
     * @param {'string'|'number'|'boolean'|'datetime'} type
     * @param {FieldOpts} [opts]
     * @returns {this}
     * @private
     */
    _add(name, type, opts) {
        /** @type {FieldDef} */
        const def = { name, type };
        if (opts?.queryable === false) def.queryable = false;
        if (opts?.json === true) def.json = true;
        if (opts?.nullable === true) def.nullable = true;
        if (opts?.foreignKey) {
            def.foreignKey = opts.foreignKey;
            if (opts.resolve) def.resolve = opts.resolve;
        }
        this.fields.push(def);
        return this;
    }
}

// ── Entity definitions ───────────────────────────────────────────────────────

import entitySchema from '../../extracted/entities.json' with { type: 'json' };
import entityOverrides from './entity-overrides.json' with { type: 'json' };

/**
 * Type-method lookup: maps the type strings used in entity-schema.json
 * to the corresponding Entity builder method name.
 * @type {Record<string, string>}
 */
const TYPE_METHODS = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    datetime: 'datetime',
    json: 'json',
};

/**
 * Set of field names that are part of the standard address group.
 * When an entity has address: true in its schema, AddressModel fields
 * found in the schema are handled by the .address() builder call instead
 * of individual field calls.
 * @type {Set<string>}
 */
const ADDRESS_FIELDS = new Set([
    'address1', 'address2', 'city', 'country', 'state', 'zipcode',
    'floor', 'suite', 'latitude', 'longitude',
]);

/**
 * Builds the ENTITIES registry from entity-schema.json (auto-generated)
 * and entity-overrides.json (manually maintained resolve specs).
 *
 * For each entity in the schema:
 *   1. Creates a new Entity(tag, table)
 *   2. Applies .restricted() and .anonFilter() if flagged
 *   3. Calls .address() if the entity uses the AddressModel mixin
 *   4. Adds each field via the type-appropriate builder method
 *   5. Merges resolve specs from overrides onto FK fields
 *   6. Calls .done() to seal
 *
 * @returns {Record<string, EntityMeta>}
 */
function buildEntities() {
    /** @type {Record<string, EntityMeta>} */
    const entities = {};

    for (const [tag, schema] of Object.entries(
        /** @type {Record<string, any>} */ (entitySchema.entities)
    )) {
        const entity = new Entity(tag, schema.table);
        const overrides = /** @type {Record<string, any>} */ (entityOverrides)[tag]?.fieldOverrides || {};

        // Apply access control
        if (schema.restricted) {
            entity.restricted();
        }
        if (schema.anonFilter) {
            entity.anonFilter(schema.anonFilter.field, schema.anonFilter.value);
        }

        // Collect address field names to skip when processing individual fields
        const addressFieldsDone = new Set();

        // Add fields from schema
        for (const field of schema.fields) {
            // Skip address fields if address() will handle them
            if (schema.address && ADDRESS_FIELDS.has(field.name)) {
                addressFieldsDone.add(field.name);
                continue;
            }

            const fieldOverride = overrides[field.name] || {};

            if (field.type === 'json') {
                // json() handles queryable:false and json:true internally
                entity.json(field.name);
            } else {
                /** @type {FieldOpts} */
                const opts = {};
                if (field.queryable === false) opts.queryable = false;
                if (field.nullable === true) opts.nullable = true;
                if (field.foreignKey) {
                    opts.foreignKey = field.foreignKey;
                    if (fieldOverride.resolve) {
                        opts.resolve = fieldOverride.resolve;
                    }
                }
                const method = TYPE_METHODS[field.type];
                if (method && typeof /** @type {any} */ (entity)[method] === 'function') {
                    /** @type {any} */ (entity)[method](field.name, opts);
                }
            }
        }

        // Add address group if schema says so
        if (schema.address) {
            entity.address();
        }

        entity.done();
        entities[tag] = entity;
    }

    return entities;
}

/**
 * Maps an API endpoint tag to its entity metadata.
 * Keys are the URL path segments (e.g. "net" for /api/net).
 *
 * @type {Record<string, EntityMeta>}
 */
export const ENTITIES = buildEntities();

// ── Relationship derivation ──────────────────────────────────────────────────

/**
 * Scans all entity definitions for foreignKey annotations and populates
 * two derived properties on each entity:
 *
 *   - joinColumns: for direct list/detail queries. Built from FK fields
 *     that have a `resolve` spec (e.g. org_id → resolve org.name as org_name).
 *
 *   - relationships: for depth expansion (_set fields). For each FK field F
 *     on child entity C that references parent entity P, P gets a relationship
 *     {tag}_set → C. The relationship's own joinColumns come from C's OTHER
 *     FK fields that have resolve specs (sibling FKs).
 *
 * This runs once at module load. The derived properties have the same shape
 * as the old hand-written definitions, so query.js, depth.js, and handlers
 * require no changes.
 *
 * @param {Record<string, EntityMeta>} entities - The full entity registry.
 */
function deriveRelationships(entities) {
    // Pass 1: derive entity-level joinColumns from FK fields with resolve
    for (const entity of Object.values(entities)) {
        /** @type {JoinColumnDef[]} */
        const joins = [];
        for (const field of entity.fields) {
            if (!field.foreignKey || !field.resolve) continue;
            const target = entities[field.foreignKey];
            if (!target) continue;
            joins.push({
                table: target.table,
                localFk: field.name,
                columns: field.resolve,
            });
        }
        entity.joinColumns = joins.length > 0 ? joins : undefined;
    }

    // Pass 2: derive relationships from FK fields pointing at each entity
    for (const entity of Object.values(entities)) {
        entity.relationships = [];
    }

    for (const [childTag, childEntity] of Object.entries(entities)) {
        for (const field of childEntity.fields) {
            if (!field.foreignKey) continue;
            const parent = entities[field.foreignKey];
            if (!parent) continue;

            // Build the relationship: parent gets {childTag}_set
            /** @type {EntityRelationship} */
            const rel = {
                field: `${childTag}_set`,
                table: childEntity.table,
                fk: field.name,
            };

            // Sibling FK fields with resolve specs become joinColumns
            // on this relationship (for depth=2 expansion with cross-entity names)
            /** @type {JoinColumnDef[]} */
            const siblingJoins = [];
            for (const sibling of childEntity.fields) {
                if (sibling === field) continue;
                if (!sibling.foreignKey || !sibling.resolve) continue;
                const siblingTarget = entities[sibling.foreignKey];
                if (!siblingTarget) continue;
                siblingJoins.push({
                    table: siblingTarget.table,
                    localFk: sibling.name,
                    columns: sibling.resolve,
                });
            }
            if (siblingJoins.length > 0) {
                rel.joinColumns = siblingJoins;
            }

            parent.relationships.push(rel);
        }
    }
}

// Run derivation at module load
deriveRelationships(ENTITIES);

// ── Derived lookups ──────────────────────────────────────────────────────────

/**
 * Set of valid entity tags for fast lookup in the router.
 * @type {Set<string>}
 */
export const ENTITY_TAGS = new Set(Object.keys(ENTITIES));



// ── Boot-time caches ─────────────────────────────────────────────────────────

/**
 * Pre-computes derived lookups on each entity so hot-path accessors
 * are zero-alloc property reads instead of per-call map/filter/Set
 * allocations. Runs once at module load after deriveRelationships.
 *
 * Caches:
 *   _columns:        string[]       (ordered column names)
 *   _jsonColumns:     Set<string>    (json: true column names)
 *   _boolColumns:     Set<string>    (boolean-typed column names)
 *   _nullableColumns: Set<string>    (nullable column names)
 *   _fieldNames:      Set<string>    (all column names for validation)
 *   _filterTypes:     Map<string, string>  (queryable field → type)
 *
 * @param {Record<string, EntityMeta>} entities
 */
function cacheFieldLookups(entities) {
    for (const entity of Object.values(entities)) {
        /** @type {string[]} */
        const columns = [];
        /** @type {Set<string>} */
        const jsonColumns = new Set();
        /** @type {Set<string>} */
        const boolColumns = new Set();
        /** @type {Set<string>} */
        const nullableColumns = new Set();
        /** @type {Set<string>} */
        const fieldNames = new Set();
        /** @type {Map<string, string>} */
        const filterTypes = new Map();

        for (const field of entity.fields) {
            columns.push(field.name);
            fieldNames.add(field.name);
            if (field.json) jsonColumns.add(field.name);
            if (field.type === 'boolean') boolColumns.add(field.name);
            if (field.nullable) nullableColumns.add(field.name);
            if (field.queryable !== false) filterTypes.set(field.name, field.type);
        }

        /** @type {any} */ (entity)._columns = columns;
        /** @type {any} */ (entity)._jsonColumns = jsonColumns;
        /** @type {any} */ (entity)._boolColumns = boolColumns;
        /** @type {any} */ (entity)._nullableColumns = nullableColumns;
        /** @type {any} */ (entity)._fieldNames = fieldNames;
        /** @type {any} */ (entity)._filterTypes = filterTypes;
    }
}

cacheFieldLookups(ENTITIES);

// ── Field accessor helpers ───────────────────────────────────────────────────

/**
 * Returns column names for an entity. Uses boot-time cache when available
 * (production), falls back to deriving from fields (test mocks).
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @returns {string[]} Ordered column names.
 */
export function getColumns(entity) {
    return /** @type {any} */ (entity)._columns || entity.fields.map(f => f.name);
}

/**
 * Returns Set of JSON-stored column names. Uses boot-time cache when
 * available, falls back to deriving from fields.
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
 * Looks up a field's type. Uses cached Map when available, falls back
 * to linear scan for test mocks.
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
        if (field.name === fieldName) return field.queryable === false ? null : field.type;
    }
    return null;
}

/**
 * Returns Set of all field names. Uses boot-time cache when available.
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
 * This mirrors Django ORM's implicit related-model filtering:
 *   net?country=NL → net.org_id IN (SELECT id FROM org WHERE country = 'NL')
 *
 * Ambiguity: if multiple FK targets have the same field name, the first
 * match wins (ordered by field definition). In practice this doesn't occur
 * in the PeeringDB schema.
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
