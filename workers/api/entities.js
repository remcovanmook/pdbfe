/**
 * @fileoverview Entity metadata registry for all PeeringDB API entity types.
 * Maps API endpoint tags to D1 table names, column lists, allowed filter
 * fields, relationship definitions for depth expansion, and JOIN
 * definitions for cross-entity name resolution.
 *
 * This module is the single source of truth for what the API exposes.
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

/**
 * Maps an API endpoint tag to its entity metadata.
 * Keys are the URL path segments (e.g. "net" for /api/net).
 *
 * @type {Record<string, EntityMeta>}
 */
export const ENTITIES = {
    net: {
        tag: "net",
        table: "peeringdb_network",
        columns: [
            "id", "org_id", "name", "aka", "name_long", "website", "social_media",
            "asn", "looking_glass", "route_server", "irr_as_set",
            "info_type", "info_types", "info_prefixes4", "info_prefixes6",
            "info_traffic", "info_ratio", "info_scope",
            "info_unicast", "info_multicast", "info_ipv6",
            "info_never_via_route_servers",
            "ix_count", "fac_count",
            "notes", "netixlan_updated", "netfac_updated", "poc_updated",
            "policy_url", "policy_general", "policy_locations",
            "policy_ratio", "policy_contracts", "allow_ixp_update",
            "status_dashboard", "rir_status", "rir_status_updated",
            "logo",
            "created", "updated", "status"
        ],
        filters: {
            id: "number", org_id: "number", asn: "number",
            name: "string", aka: "string", name_long: "string",
            irr_as_set: "string", info_type: "string",
            info_traffic: "string", info_ratio: "string", info_scope: "string",
            info_prefixes4: "number", info_prefixes6: "number",
            info_unicast: "boolean", info_multicast: "boolean", info_ipv6: "boolean",
            info_never_via_route_servers: "boolean",
            policy_general: "string", policy_locations: "string",
            policy_ratio: "boolean", policy_contracts: "string",
            status: "string", created: "datetime", updated: "datetime"
        },
        /** Resolve organization name for network records. */
        joinColumns: [{
            table: "peeringdb_organization",
            localFk: "org_id",
            columns: { name: "org_name" }
        }],
        relationships: [
            { field: "netfac_set", table: "peeringdb_network_facility", fk: "net_id" },
            { field: "netixlan_set", table: "peeringdb_network_ixlan", fk: "net_id" },
            { field: "poc_set", table: "peeringdb_network_contact", fk: "net_id" }
        ]
    },

    org: {
        tag: "org",
        table: "peeringdb_organization",
        columns: [
            "id", "name", "aka", "name_long", "website", "social_media",
            "notes", "logo", "address1", "address2", "city", "country",
            "state", "zipcode", "floor", "suite",
            "latitude", "longitude",
            "created", "updated", "status"
        ],
        filters: {
            id: "number", name: "string", aka: "string", name_long: "string",
            city: "string", state: "string", country: "string", zipcode: "string",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: [
            { field: "net_set", table: "peeringdb_network", fk: "org_id" },
            { field: "fac_set", table: "peeringdb_facility", fk: "org_id" },
            { field: "ix_set", table: "peeringdb_ix", fk: "org_id" },
            { field: "carrier_set", table: "peeringdb_carrier", fk: "org_id" },
            { field: "campus_set", table: "peeringdb_campus", fk: "org_id" }
        ]
    },

    fac: {
        tag: "fac",
        table: "peeringdb_facility",
        columns: [
            "id", "org_id", "org_name", "campus_id",
            "name", "aka", "name_long", "website", "social_media",
            "clli", "rencode", "npanxx", "notes",
            "net_count", "ix_count", "carrier_count",
            "sales_email", "sales_phone", "tech_email", "tech_phone",
            "available_voltage_services", "diverse_serving_substations",
            "property", "region_continent", "status_dashboard", "logo",
            "created", "updated", "status",
            "address1", "address2", "city", "country", "state", "zipcode",
            "floor", "suite", "latitude", "longitude"
        ],
        filters: {
            id: "number", org_id: "number", campus_id: "number",
            name: "string", aka: "string", name_long: "string",
            city: "string", state: "string", country: "string", zipcode: "string",
            clli: "string", region_continent: "string",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: [
            {
                field: "netfac_set",
                table: "peeringdb_network_facility",
                fk: "fac_id",
                joinColumns: [{
                    table: "peeringdb_network",
                    localFk: "net_id",
                    columns: { name: "net_name", asn: "net_asn" }
                }]
            },
            {
                field: "ixfac_set",
                table: "peeringdb_ix_facility",
                fk: "fac_id",
                joinColumns: [{
                    table: "peeringdb_ix",
                    localFk: "ix_id",
                    columns: { name: "ix_name" }
                }]
            }
        ]
    },

    ix: {
        tag: "ix",
        table: "peeringdb_ix",
        columns: [
            "id", "org_id", "name", "aka", "name_long",
            "city", "country", "region_continent", "media",
            "notes", "proto_unicast", "proto_multicast", "proto_ipv6",
            "website", "social_media",
            "url_stats", "tech_email", "tech_phone",
            "policy_email", "policy_phone",
            "sales_phone", "sales_email",
            "net_count", "fac_count", "ixf_net_count",
            "ixf_last_import", "ixf_import_request", "ixf_import_request_status",
            "service_level", "terms", "status_dashboard", "logo",
            "created", "updated", "status"
        ],
        filters: {
            id: "number", org_id: "number",
            name: "string", aka: "string", name_long: "string",
            city: "string", country: "string", region_continent: "string",
            proto_unicast: "boolean", proto_multicast: "boolean", proto_ipv6: "boolean",
            status: "string", created: "datetime", updated: "datetime"
        },
        /** Resolve organization name for exchange records. */
        joinColumns: [{
            table: "peeringdb_organization",
            localFk: "org_id",
            columns: { name: "org_name" }
        }],
        relationships: [
            { field: "ixlan_set", table: "peeringdb_ixlan", fk: "ix_id" },
            { field: "ixfac_set", table: "peeringdb_ix_facility", fk: "ix_id" }
        ]
    },

    ixlan: {
        tag: "ixlan",
        table: "peeringdb_ixlan",
        columns: [
            "id", "ix_id", "name", "descr", "mtu",
            "dot1q_support", "rs_asn", "arp_sponge",
            "ixf_ixp_member_list_url_visible", "ixf_ixp_import_enabled",
            "created", "updated", "status"
        ],
        filters: {
            id: "number", ix_id: "number", rs_asn: "number", mtu: "number",
            name: "string", descr: "string",
            dot1q_support: "boolean",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: [
            { field: "ixpfx_set", table: "peeringdb_ixlan_prefix", fk: "ixlan_id" },
            { field: "netixlan_set", table: "peeringdb_network_ixlan", fk: "ixlan_id" }
        ]
    },

    ixpfx: {
        tag: "ixpfx",
        table: "peeringdb_ixlan_prefix",
        columns: [
            "id", "ixlan_id", "protocol", "prefix", "notes", "in_dfz",
            "created", "updated", "status"
        ],
        filters: {
            id: "number", ixlan_id: "number",
            protocol: "string", prefix: "string",
            in_dfz: "boolean",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: []
    },

    netfac: {
        tag: "netfac",
        table: "peeringdb_network_facility",
        columns: [
            "id", "name", "city", "country",
            "net_id", "fac_id", "local_asn",
            "created", "updated", "status"
        ],
        /** Resolve network name/ASN for netfac records queried directly. */
        joinColumns: [{
            table: "peeringdb_network",
            localFk: "net_id",
            columns: { name: "net_name", asn: "net_asn" }
        }],
        filters: {
            id: "number", net_id: "number", fac_id: "number",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: []
    },

    netixlan: {
        tag: "netixlan",
        table: "peeringdb_network_ixlan",
        columns: [
            "id", "net_id", "ix_id", "name", "ixlan_id",
            "notes", "speed", "asn",
            "ipaddr4", "ipaddr6", "is_rs_peer",
            "bfd_support", "operational",
            "net_side_id", "ix_side_id",
            "created", "updated", "status"
        ],
        /** Resolve network name for netixlan records queried directly (e.g. IX peer table). */
        joinColumns: [{
            table: "peeringdb_network",
            localFk: "net_id",
            columns: { name: "net_name" }
        }],
        filters: {
            id: "number", net_id: "number", ixlan_id: "number",
            ix_id: "number", asn: "number", speed: "number",
            ipaddr4: "string", ipaddr6: "string",
            is_rs_peer: "boolean", operational: "boolean",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: []
    },

    poc: {
        tag: "poc",
        table: "peeringdb_network_contact",
        columns: [
            "id", "net_id", "role", "visible",
            "name", "phone", "email", "url",
            "created", "updated", "status"
        ],
        filters: {
            id: "number", net_id: "number",
            role: "string", name: "string", email: "string",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: []
    },

    carrier: {
        tag: "carrier",
        table: "peeringdb_carrier",
        columns: [
            "id", "org_id", "org_name", "name", "aka", "name_long",
            "website", "social_media", "notes",
            "fac_count", "logo",
            "created", "updated", "status"
        ],
        filters: {
            id: "number", org_id: "number",
            name: "string", aka: "string", name_long: "string",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: [
            { field: "carrierfac_set", table: "peeringdb_ix_carrier_facility", fk: "carrier_id" }
        ]
    },

    carrierfac: {
        tag: "carrierfac",
        table: "peeringdb_ix_carrier_facility",
        columns: [
            "id", "name", "carrier_id", "fac_id",
            "created", "updated", "status"
        ],
        filters: {
            id: "number", carrier_id: "number", fac_id: "number",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: []
    },

    ixfac: {
        tag: "ixfac",
        table: "peeringdb_ix_facility",
        columns: [
            "id", "name", "city", "country",
            "ix_id", "fac_id",
            "created", "updated", "status"
        ],
        /** Resolve IX name for ixfac records queried directly. */
        joinColumns: [{
            table: "peeringdb_ix",
            localFk: "ix_id",
            columns: { name: "ix_name" }
        }],
        filters: {
            id: "number", ix_id: "number", fac_id: "number",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: []
    },

    campus: {
        tag: "campus",
        table: "peeringdb_campus",
        columns: [
            "id", "org_id", "org_name", "status",
            "created", "updated",
            "name", "name_long", "notes", "aka",
            "website", "social_media",
            "country", "city", "zipcode", "state", "logo"
        ],
        filters: {
            id: "number", org_id: "number",
            name: "string", aka: "string", name_long: "string",
            status: "string", created: "datetime", updated: "datetime"
        },
        relationships: [
            { field: "fac_set", table: "peeringdb_facility", fk: "campus_id" }
        ]
    }
};

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
    "net", "org", "fac", "ix", "ixlan", "ixpfx",
    "netfac", "netixlan", "poc", "carrier", "carrierfac", "ixfac", "campus"
]);

/**
 * Columns that store JSON arrays/objects as TEXT in D1.
 * These need special handling in three places:
 *   - query.js: wrapped in SQLite json() to prevent double-escaping in json_object()
 *   - depth.js: JSON.parse'd when returning full child objects at depth=2
 *   - handlers: JSON.parse'd when building row-level responses at depth>0
 *
 * @type {Set<string>}
 */
export const JSON_STORED_COLUMNS = new Set([
    "social_media", "info_types", "available_voltage_services"
]);
