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
        if (opts?.foreignKey) {
            def.foreignKey = opts.foreignKey;
            if (opts.resolve) def.resolve = opts.resolve;
        }
        this.fields.push(def);
        return this;
    }
}

// ── Entity definitions ───────────────────────────────────────────────────────

/**
 * Maps an API endpoint tag to its entity metadata.
 * Keys are the URL path segments (e.g. "net" for /api/net).
 *
 * @type {Record<string, EntityMeta>}
 */
export const ENTITIES = {

    net: new Entity('net', 'peeringdb_network')
        .number('org_id', { foreignKey: 'org', resolve: { name: 'org_name' } })
        .string('name')
        .string('aka')
        .string('name_long')
        .string('website', { queryable: false })
        .json('social_media')
        .number('asn')
        .string('looking_glass', { queryable: false })
        .string('route_server', { queryable: false })
        .string('irr_as_set')
        .string('info_type')
        .json('info_types')
        .number('info_prefixes4')
        .number('info_prefixes6')
        .string('info_traffic')
        .string('info_ratio')
        .string('info_scope')
        .boolean('info_unicast')
        .boolean('info_multicast')
        .boolean('info_ipv6')
        .boolean('info_never_via_route_servers')
        .number('ix_count', { queryable: false })
        .number('fac_count', { queryable: false })
        .string('notes', { queryable: false })
        .datetime('netixlan_updated', { queryable: false })
        .datetime('netfac_updated', { queryable: false })
        .datetime('poc_updated', { queryable: false })
        .string('policy_url', { queryable: false })
        .string('policy_general')
        .string('policy_locations')
        .boolean('policy_ratio')
        .string('policy_contracts')
        .boolean('allow_ixp_update', { queryable: false })
        .string('status_dashboard', { queryable: false })
        .string('rir_status', { queryable: false })
        .datetime('rir_status_updated', { queryable: false })
        .string('logo', { queryable: false })
        .done(),

    org: new Entity('org', 'peeringdb_organization')
        .string('name')
        .string('aka')
        .string('name_long')
        .string('website', { queryable: false })
        .json('social_media')
        .string('notes', { queryable: false })
        .string('logo', { queryable: false })
        .address()
        .done(),

    fac: new Entity('fac', 'peeringdb_facility')
        .number('org_id', { foreignKey: 'org' })
        .string('org_name', { queryable: false })
        .number('campus_id', { foreignKey: 'campus' })
        .string('name')
        .string('aka')
        .string('name_long')
        .string('website', { queryable: false })
        .json('social_media')
        .string('clli')
        .string('rencode', { queryable: false })
        .string('npanxx', { queryable: false })
        .string('notes', { queryable: false })
        .number('net_count', { queryable: false })
        .number('ix_count', { queryable: false })
        .number('carrier_count', { queryable: false })
        .string('sales_email', { queryable: false })
        .string('sales_phone', { queryable: false })
        .string('tech_email', { queryable: false })
        .string('tech_phone', { queryable: false })
        .json('available_voltage_services')
        .boolean('diverse_serving_substations', { queryable: false })
        .string('property', { queryable: false })
        .string('region_continent')
        .string('status_dashboard', { queryable: false })
        .string('logo', { queryable: false })
        .address()
        .done(),

    ix: new Entity('ix', 'peeringdb_ix')
        .number('org_id', { foreignKey: 'org', resolve: { name: 'org_name' } })
        .string('name')
        .string('aka')
        .string('name_long')
        .string('city')
        .string('country')
        .string('region_continent')
        .string('media', { queryable: false })
        .string('notes', { queryable: false })
        .boolean('proto_unicast')
        .boolean('proto_multicast')
        .boolean('proto_ipv6')
        .string('website', { queryable: false })
        .json('social_media')
        .string('url_stats', { queryable: false })
        .string('tech_email', { queryable: false })
        .string('tech_phone', { queryable: false })
        .string('policy_email', { queryable: false })
        .string('policy_phone', { queryable: false })
        .string('sales_phone', { queryable: false })
        .string('sales_email', { queryable: false })
        .number('net_count', { queryable: false })
        .number('fac_count', { queryable: false })
        .number('ixf_net_count', { queryable: false })
        .datetime('ixf_last_import', { queryable: false })
        .string('ixf_import_request', { queryable: false })
        .string('ixf_import_request_status', { queryable: false })
        .string('service_level', { queryable: false })
        .string('terms', { queryable: false })
        .string('status_dashboard', { queryable: false })
        .string('logo', { queryable: false })
        .done(),

    ixlan: new Entity('ixlan', 'peeringdb_ixlan')
        .number('ix_id', { foreignKey: 'ix' })
        .string('name')
        .string('descr')
        .number('mtu')
        .boolean('dot1q_support')
        .number('rs_asn')
        .string('arp_sponge', { queryable: false })
        .string('ixf_ixp_member_list_url_visible', { queryable: false })
        .boolean('ixf_ixp_import_enabled', { queryable: false })
        .done(),

    ixpfx: new Entity('ixpfx', 'peeringdb_ixlan_prefix')
        .number('ixlan_id', { foreignKey: 'ixlan' })
        .string('protocol')
        .string('prefix')
        .string('notes', { queryable: false })
        .boolean('in_dfz')
        .done(),

    netfac: new Entity('netfac', 'peeringdb_network_facility')
        .string('name', { queryable: false })
        .string('city', { queryable: false })
        .string('country', { queryable: false })
        .number('net_id', { foreignKey: 'net', resolve: { name: 'net_name', asn: 'net_asn' } })
        .number('fac_id', { foreignKey: 'fac' })
        .number('local_asn')
        .done(),

    netixlan: new Entity('netixlan', 'peeringdb_network_ixlan')
        .number('net_id', { foreignKey: 'net', resolve: { name: 'net_name' } })
        .number('ix_id')
        .string('name', { queryable: false })
        .number('ixlan_id', { foreignKey: 'ixlan' })
        .string('notes', { queryable: false })
        .number('speed')
        .number('asn')
        .string('ipaddr4')
        .string('ipaddr6')
        .boolean('is_rs_peer')
        .boolean('bfd_support')
        .boolean('operational')
        .number('net_side_id', { queryable: false })
        .number('ix_side_id', { queryable: false })
        .done(),

    poc: new Entity('poc', 'peeringdb_network_contact')
        .number('net_id', { foreignKey: 'net' })
        .string('role')
        .string('visible', { queryable: false })
        .string('name')
        .string('phone', { queryable: false })
        .string('email')
        .string('url', { queryable: false })
        .done(),

    carrier: new Entity('carrier', 'peeringdb_carrier')
        .number('org_id', { foreignKey: 'org' })
        .string('org_name', { queryable: false })
        .string('name')
        .string('aka')
        .string('name_long')
        .string('website', { queryable: false })
        .json('social_media')
        .string('notes', { queryable: false })
        .number('fac_count', { queryable: false })
        .string('logo', { queryable: false })
        .done(),

    carrierfac: new Entity('carrierfac', 'peeringdb_ix_carrier_facility')
        .string('name', { queryable: false })
        .number('carrier_id', { foreignKey: 'carrier' })
        .number('fac_id', { foreignKey: 'fac' })
        .done(),

    ixfac: new Entity('ixfac', 'peeringdb_ix_facility')
        .string('name', { queryable: false })
        .string('city', { queryable: false })
        .string('country', { queryable: false })
        .number('ix_id', { foreignKey: 'ix', resolve: { name: 'ix_name' } })
        .number('fac_id', { foreignKey: 'fac' })
        .done(),

    campus: new Entity('campus', 'peeringdb_campus')
        .number('org_id', { foreignKey: 'org' })
        .string('org_name', { queryable: false })
        .string('name')
        .string('name_long')
        .string('notes', { queryable: false })
        .string('aka')
        .string('website', { queryable: false })
        .json('social_media')
        .string('country')
        .string('city')
        .string('zipcode')
        .string('state')
        .string('logo', { queryable: false })
        .done(),
};

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


// ── Field accessor helpers ───────────────────────────────────────────────────

/**
 * Returns the column names for an entity, derived from its fields array.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @returns {string[]} Ordered column names.
 */
export function getColumns(entity) {
    return entity.fields.map(f => f.name);
}

/**
 * Returns a Set of column names that store JSON arrays/objects as TEXT in D1.
 * These need json() wrapping in json_object() and JSON.parse in the cold path.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @returns {Set<string>} Column names with json: true.
 */
export function getJsonColumns(entity) {
    const s = new Set();
    for (const field of entity.fields) {
        if (field.json) s.add(field.name);
    }
    return s;
}

/**
 * Looks up a field definition by name and checks filterability.
 * Returns the field's type if it exists and is queryable, null otherwise.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {string} fieldName - The field name to look up.
 * @returns {'string'|'number'|'boolean'|'datetime'|null} Field type, or null if not queryable.
 */
export function getFilterType(entity, fieldName) {
    for (const field of entity.fields) {
        if (field.name === fieldName) {
            return field.queryable === false ? null : field.type;
        }
    }
    return null;
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
    const valid = new Set(entity.fields.map(f => f.name));
    const result = requested.filter(name => valid.has(name));
    if (!result.includes('id')) result.unshift('id');
    return result;
}

/** Valid filter operators. */
const VALID_OPS = new Set(['eq', 'lt', 'gt', 'lte', 'gte', 'contains', 'startswith', 'in']);

/**
 * Validates parsed query filters and sort against the entity schema.
 * Returns a human-readable error string if invalid, or null if valid.
 *
 * Checks:
 *   - Filter field exists on the entity
 *   - Filter field is queryable (not output-only)
 *   - Filter operator is recognised
 *   - Sort column exists on the entity
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {string} sort - Sort parameter (e.g. "-updated").
 * @returns {string|null} Error message, or null if query is valid.
 */
export function validateQuery(entity, filters, sort) {
    const fieldNames = new Set(entity.fields.map(f => f.name));

    for (const f of filters) {
        if (!fieldNames.has(f.field)) {
            return `Unknown field '${f.field}' on ${entity.tag}`;
        }

        const fieldType = getFilterType(entity, f.field);
        if (!fieldType) {
            return `Field '${f.field}' is not filterable on ${entity.tag}`;
        }

        if (!VALID_OPS.has(f.op)) {
            return `Unknown filter operator '${f.op}' on ${entity.tag}.${f.field}`;
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
