/**
 * @fileoverview Entity metadata registry for all PeeringDB API entity types.
 * Maps API endpoint tags to D1 table names, field definitions, relationship
 * definitions for depth expansion, and JOIN definitions for cross-entity
 * name resolution.
 *
 * Each field is described by a single FieldDef object: {name, type, queryable?, json?}.
 * - queryable defaults to true — most fields can be filtered on.
 * - json defaults to false — only columns stored as JSON TEXT in D1 need this.
 *
 * Adding a new entity type means adding an entry here — the router,
 * query builder, and depth expander all consume this registry.
 *
 * JOIN columns (joinColumns) mirror the upstream Django ORM's
 * select_related() annotations. They appear in two places:
 *   - On entity definitions: applied by the query builder for direct
 *     list/detail queries (e.g. GET /api/netixlan?ix_id=26).
 *   - On relationship definitions: applied by the depth expander for
 *     child set expansion (e.g. GET /api/fac/1?depth=2 → netfac_set).
 */

// ── Field definition helpers ─────────────────────────────────────────────────

/**
 * Creates a field definition with sensible defaults.
 * queryable defaults to true, json defaults to false.
 *
 * @param {string} name - Column name in D1.
 * @param {'string'|'number'|'boolean'|'datetime'} type - Data type.
 * @param {Object} [opts] - Optional overrides.
 * @param {boolean} [opts.queryable] - Whether this field can be filtered on. Defaults to true.
 * @param {boolean} [opts.json] - Whether D1 stores this as JSON TEXT. Defaults to false.
 * @returns {FieldDef}
 */
function f(name, type, opts) {
    /** @type {FieldDef} */
    const def = { name, type };
    if (opts?.queryable === false) def.queryable = false;
    if (opts?.json === true) def.json = true;
    return def;
}

/** Shorthand for a non-queryable field. */
const nq = (/** @type {string} */ name, /** @type {'string'|'number'|'boolean'|'datetime'} */ type) =>
    f(name, type, { queryable: false });

/** Shorthand for a JSON-stored, non-queryable field. */
const jf = (/** @type {string} */ name) =>
    f(name, 'string', { queryable: false, json: true });

// ── Common field groups ──────────────────────────────────────────────────────

/** Timestamp fields present on every entity. */
const TIMESTAMPS = [
    f('created', 'datetime'),
    f('updated', 'datetime'),
    f('status', 'string'),
];

/** Address fields shared by org and fac. */
const ADDRESS = [
    f('address1', 'string', { queryable: false }),
    f('address2', 'string', { queryable: false }),
    f('city', 'string'),
    f('country', 'string'),
    f('state', 'string'),
    f('zipcode', 'string'),
    f('floor', 'string', { queryable: false }),
    f('suite', 'string', { queryable: false }),
    f('latitude', 'number', { queryable: false }),
    f('longitude', 'number', { queryable: false }),
];

// ── Entity definitions ───────────────────────────────────────────────────────

/**
 * Maps an API endpoint tag to its entity metadata.
 * Keys are the URL path segments (e.g. "net" for /api/net).
 *
 * @type {Record<string, EntityMeta>}
 */
export const ENTITIES = {
    net: {
        tag: 'net',
        table: 'peeringdb_network',
        fields: [
            f('id', 'number'),
            f('org_id', 'number'),
            f('name', 'string'),
            f('aka', 'string'),
            f('name_long', 'string'),
            nq('website', 'string'),
            jf('social_media'),
            f('asn', 'number'),
            nq('looking_glass', 'string'),
            nq('route_server', 'string'),
            f('irr_as_set', 'string'),
            f('info_type', 'string'),
            f('info_types', 'string', { queryable: false, json: true }),
            f('info_prefixes4', 'number'),
            f('info_prefixes6', 'number'),
            f('info_traffic', 'string'),
            f('info_ratio', 'string'),
            f('info_scope', 'string'),
            f('info_unicast', 'boolean'),
            f('info_multicast', 'boolean'),
            f('info_ipv6', 'boolean'),
            f('info_never_via_route_servers', 'boolean'),
            nq('ix_count', 'number'),
            nq('fac_count', 'number'),
            nq('notes', 'string'),
            nq('netixlan_updated', 'datetime'),
            nq('netfac_updated', 'datetime'),
            nq('poc_updated', 'datetime'),
            nq('policy_url', 'string'),
            f('policy_general', 'string'),
            f('policy_locations', 'string'),
            f('policy_ratio', 'boolean'),
            f('policy_contracts', 'string'),
            nq('allow_ixp_update', 'boolean'),
            nq('status_dashboard', 'string'),
            nq('rir_status', 'string'),
            nq('rir_status_updated', 'datetime'),
            nq('logo', 'string'),
            ...TIMESTAMPS,
        ],
        /** Resolve organization name for network records. */
        joinColumns: [{
            table: 'peeringdb_organization',
            localFk: 'org_id',
            columns: { name: 'org_name' }
        }],
        relationships: [
            { field: 'netfac_set', table: 'peeringdb_network_facility', fk: 'net_id' },
            { field: 'netixlan_set', table: 'peeringdb_network_ixlan', fk: 'net_id' },
            { field: 'poc_set', table: 'peeringdb_network_contact', fk: 'net_id' }
        ]
    },

    org: {
        tag: 'org',
        table: 'peeringdb_organization',
        fields: [
            f('id', 'number'),
            f('name', 'string'),
            f('aka', 'string'),
            f('name_long', 'string'),
            nq('website', 'string'),
            jf('social_media'),
            nq('notes', 'string'),
            nq('logo', 'string'),
            ...ADDRESS,
            ...TIMESTAMPS,
        ],
        relationships: [
            { field: 'net_set', table: 'peeringdb_network', fk: 'org_id' },
            { field: 'fac_set', table: 'peeringdb_facility', fk: 'org_id' },
            { field: 'ix_set', table: 'peeringdb_ix', fk: 'org_id' },
            { field: 'carrier_set', table: 'peeringdb_carrier', fk: 'org_id' },
            { field: 'campus_set', table: 'peeringdb_campus', fk: 'org_id' }
        ]
    },

    fac: {
        tag: 'fac',
        table: 'peeringdb_facility',
        fields: [
            f('id', 'number'),
            f('org_id', 'number'),
            nq('org_name', 'string'),
            f('campus_id', 'number'),
            f('name', 'string'),
            f('aka', 'string'),
            f('name_long', 'string'),
            nq('website', 'string'),
            jf('social_media'),
            f('clli', 'string'),
            nq('rencode', 'string'),
            nq('npanxx', 'string'),
            nq('notes', 'string'),
            nq('net_count', 'number'),
            nq('ix_count', 'number'),
            nq('carrier_count', 'number'),
            nq('sales_email', 'string'),
            nq('sales_phone', 'string'),
            nq('tech_email', 'string'),
            nq('tech_phone', 'string'),
            f('available_voltage_services', 'string', { queryable: false, json: true }),
            nq('diverse_serving_substations', 'boolean'),
            nq('property', 'string'),
            f('region_continent', 'string'),
            nq('status_dashboard', 'string'),
            nq('logo', 'string'),
            ...ADDRESS,
            ...TIMESTAMPS,
        ],
        relationships: [
            {
                field: 'netfac_set',
                table: 'peeringdb_network_facility',
                fk: 'fac_id',
                joinColumns: [{
                    table: 'peeringdb_network',
                    localFk: 'net_id',
                    columns: { name: 'net_name', asn: 'net_asn' }
                }]
            },
            {
                field: 'ixfac_set',
                table: 'peeringdb_ix_facility',
                fk: 'fac_id',
                joinColumns: [{
                    table: 'peeringdb_ix',
                    localFk: 'ix_id',
                    columns: { name: 'ix_name' }
                }]
            }
        ]
    },

    ix: {
        tag: 'ix',
        table: 'peeringdb_ix',
        fields: [
            f('id', 'number'),
            f('org_id', 'number'),
            f('name', 'string'),
            f('aka', 'string'),
            f('name_long', 'string'),
            f('city', 'string'),
            f('country', 'string'),
            f('region_continent', 'string'),
            nq('media', 'string'),
            nq('notes', 'string'),
            f('proto_unicast', 'boolean'),
            f('proto_multicast', 'boolean'),
            f('proto_ipv6', 'boolean'),
            nq('website', 'string'),
            jf('social_media'),
            nq('url_stats', 'string'),
            nq('tech_email', 'string'),
            nq('tech_phone', 'string'),
            nq('policy_email', 'string'),
            nq('policy_phone', 'string'),
            nq('sales_phone', 'string'),
            nq('sales_email', 'string'),
            nq('net_count', 'number'),
            nq('fac_count', 'number'),
            nq('ixf_net_count', 'number'),
            nq('ixf_last_import', 'datetime'),
            nq('ixf_import_request', 'string'),
            nq('ixf_import_request_status', 'string'),
            nq('service_level', 'string'),
            nq('terms', 'string'),
            nq('status_dashboard', 'string'),
            nq('logo', 'string'),
            ...TIMESTAMPS,
        ],
        /** Resolve organization name for exchange records. */
        joinColumns: [{
            table: 'peeringdb_organization',
            localFk: 'org_id',
            columns: { name: 'org_name' }
        }],
        relationships: [
            { field: 'ixlan_set', table: 'peeringdb_ixlan', fk: 'ix_id' },
            { field: 'ixfac_set', table: 'peeringdb_ix_facility', fk: 'ix_id' }
        ]
    },

    ixlan: {
        tag: 'ixlan',
        table: 'peeringdb_ixlan',
        fields: [
            f('id', 'number'),
            f('ix_id', 'number'),
            f('name', 'string'),
            f('descr', 'string'),
            f('mtu', 'number'),
            f('dot1q_support', 'boolean'),
            f('rs_asn', 'number'),
            nq('arp_sponge', 'string'),
            nq('ixf_ixp_member_list_url_visible', 'string'),
            nq('ixf_ixp_import_enabled', 'boolean'),
            ...TIMESTAMPS,
        ],
        relationships: [
            { field: 'ixpfx_set', table: 'peeringdb_ixlan_prefix', fk: 'ixlan_id' },
            { field: 'netixlan_set', table: 'peeringdb_network_ixlan', fk: 'ixlan_id' }
        ]
    },

    ixpfx: {
        tag: 'ixpfx',
        table: 'peeringdb_ixlan_prefix',
        fields: [
            f('id', 'number'),
            f('ixlan_id', 'number'),
            f('protocol', 'string'),
            f('prefix', 'string'),
            nq('notes', 'string'),
            f('in_dfz', 'boolean'),
            ...TIMESTAMPS,
        ],
        relationships: []
    },

    netfac: {
        tag: 'netfac',
        table: 'peeringdb_network_facility',
        fields: [
            f('id', 'number'),
            nq('name', 'string'),
            nq('city', 'string'),
            nq('country', 'string'),
            f('net_id', 'number'),
            f('fac_id', 'number'),
            f('local_asn', 'number'),
            ...TIMESTAMPS,
        ],
        /** Resolve network name/ASN for netfac records queried directly. */
        joinColumns: [{
            table: 'peeringdb_network',
            localFk: 'net_id',
            columns: { name: 'net_name', asn: 'net_asn' }
        }],
        relationships: []
    },

    netixlan: {
        tag: 'netixlan',
        table: 'peeringdb_network_ixlan',
        fields: [
            f('id', 'number'),
            f('net_id', 'number'),
            f('ix_id', 'number'),
            nq('name', 'string'),
            f('ixlan_id', 'number'),
            nq('notes', 'string'),
            f('speed', 'number'),
            f('asn', 'number'),
            f('ipaddr4', 'string'),
            f('ipaddr6', 'string'),
            f('is_rs_peer', 'boolean'),
            f('bfd_support', 'boolean'),
            f('operational', 'boolean'),
            nq('net_side_id', 'number'),
            nq('ix_side_id', 'number'),
            ...TIMESTAMPS,
        ],
        /** Resolve network name for netixlan records queried directly. */
        joinColumns: [{
            table: 'peeringdb_network',
            localFk: 'net_id',
            columns: { name: 'net_name' }
        }],
        relationships: []
    },

    poc: {
        tag: 'poc',
        table: 'peeringdb_network_contact',
        fields: [
            f('id', 'number'),
            f('net_id', 'number'),
            f('role', 'string'),
            nq('visible', 'string'),
            f('name', 'string'),
            nq('phone', 'string'),
            f('email', 'string'),
            nq('url', 'string'),
            ...TIMESTAMPS,
        ],
        relationships: []
    },

    carrier: {
        tag: 'carrier',
        table: 'peeringdb_carrier',
        fields: [
            f('id', 'number'),
            f('org_id', 'number'),
            nq('org_name', 'string'),
            f('name', 'string'),
            f('aka', 'string'),
            f('name_long', 'string'),
            nq('website', 'string'),
            jf('social_media'),
            nq('notes', 'string'),
            nq('fac_count', 'number'),
            nq('logo', 'string'),
            ...TIMESTAMPS,
        ],
        relationships: [
            { field: 'carrierfac_set', table: 'peeringdb_ix_carrier_facility', fk: 'carrier_id' }
        ]
    },

    carrierfac: {
        tag: 'carrierfac',
        table: 'peeringdb_ix_carrier_facility',
        fields: [
            f('id', 'number'),
            nq('name', 'string'),
            f('carrier_id', 'number'),
            f('fac_id', 'number'),
            ...TIMESTAMPS,
        ],
        relationships: []
    },

    ixfac: {
        tag: 'ixfac',
        table: 'peeringdb_ix_facility',
        fields: [
            f('id', 'number'),
            nq('name', 'string'),
            nq('city', 'string'),
            nq('country', 'string'),
            f('ix_id', 'number'),
            f('fac_id', 'number'),
            ...TIMESTAMPS,
        ],
        /** Resolve IX name for ixfac records queried directly. */
        joinColumns: [{
            table: 'peeringdb_ix',
            localFk: 'ix_id',
            columns: { name: 'ix_name' }
        }],
        relationships: []
    },

    campus: {
        tag: 'campus',
        table: 'peeringdb_campus',
        fields: [
            f('id', 'number'),
            f('org_id', 'number'),
            nq('org_name', 'string'),
            f('name', 'string'),
            f('name_long', 'string'),
            nq('notes', 'string'),
            f('aka', 'string'),
            nq('website', 'string'),
            jf('social_media'),
            f('country', 'string'),
            f('city', 'string'),
            f('zipcode', 'string'),
            f('state', 'string'),
            nq('logo', 'string'),
            ...TIMESTAMPS,
        ],
        relationships: [
            { field: 'fac_set', table: 'peeringdb_facility', fk: 'campus_id' }
        ]
    }
};

// ── Derived lookups ──────────────────────────────────────────────────────────

/**
 * Set of valid entity tags for fast lookup in the router.
 * @type {Set<string>}
 */
export const ENTITY_TAGS = new Set(Object.keys(ENTITIES));

/**
 * Set of entity tags that support write operations in the upstream
 * PeeringDB API. Used to return 501 Not Implemented for write methods.
 * @type {Set<string>}
 */
export const WRITABLE_TAGS = new Set([
    'net', 'org', 'fac', 'ix', 'ixlan', 'ixpfx',
    'netfac', 'netixlan', 'poc', 'carrier', 'carrierfac', 'ixfac', 'campus'
]);

/**
 * Returns the column names for an entity (replaces the old entity.columns array).
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
