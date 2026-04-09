-- PeeringDB D1 Schema (auto-generated from API JSON)
-- Foreign key constraints omitted (data snapshots may be inconsistent).

CREATE TABLE IF NOT EXISTS "_sync_meta" (
    "entity" TEXT NOT NULL PRIMARY KEY,
    "last_sync" INTEGER NOT NULL DEFAULT 0,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TEXT NOT NULL DEFAULT '',
    "last_modified_at" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "peeringdb_organization" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "aka" TEXT NOT NULL DEFAULT '',
    "name_long" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "social_media" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "logo" TEXT,
    "address1" TEXT NOT NULL DEFAULT '',
    "address2" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "zipcode" TEXT NOT NULL DEFAULT '',
    "floor" TEXT NOT NULL DEFAULT '',
    "suite" TEXT NOT NULL DEFAULT '',
    "latitude" REAL,
    "longitude" REAL,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS "peeringdb_organization_name_nocase_idx" ON "peeringdb_organization" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_organization_country_nocase_idx" ON "peeringdb_organization" ("country" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_organization_city_nocase_idx" ON "peeringdb_organization" ("city" COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS "peeringdb_campus" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "org_id" INTEGER NOT NULL DEFAULT 0,
    "org_name" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT '',
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "name_long" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "aka" TEXT,
    "website" TEXT NOT NULL DEFAULT '',
    "social_media" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "zipcode" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "logo" TEXT
);
CREATE INDEX IF NOT EXISTS "peeringdb_campus_org_id_idx" ON "peeringdb_campus" ("org_id");
CREATE INDEX IF NOT EXISTS "peeringdb_campus_name_nocase_idx" ON "peeringdb_campus" ("name" COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS "peeringdb_facility" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "org_id" INTEGER NOT NULL DEFAULT 0,
    "org_name" TEXT NOT NULL DEFAULT '',
    "campus_id" INTEGER,
    "name" TEXT NOT NULL DEFAULT '',
    "aka" TEXT NOT NULL DEFAULT '',
    "name_long" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "social_media" TEXT NOT NULL DEFAULT '',
    "clli" TEXT NOT NULL DEFAULT '',
    "rencode" TEXT NOT NULL DEFAULT '',
    "npanxx" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "net_count" INTEGER NOT NULL DEFAULT 0,
    "ix_count" INTEGER NOT NULL DEFAULT 0,
    "carrier_count" INTEGER NOT NULL DEFAULT 0,
    "sales_email" TEXT NOT NULL DEFAULT '',
    "sales_phone" TEXT NOT NULL DEFAULT '',
    "tech_email" TEXT NOT NULL DEFAULT '',
    "tech_phone" TEXT NOT NULL DEFAULT '',
    "available_voltage_services" TEXT NOT NULL DEFAULT '',
    "diverse_serving_substations" BOOL,
    "property" TEXT,
    "region_continent" TEXT NOT NULL DEFAULT '',
    "status_dashboard" TEXT,
    "logo" TEXT,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT '',
    "address1" TEXT NOT NULL DEFAULT '',
    "address2" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "zipcode" TEXT NOT NULL DEFAULT '',
    "floor" TEXT NOT NULL DEFAULT '',
    "suite" TEXT NOT NULL DEFAULT '',
    "latitude" REAL,
    "longitude" REAL
);
CREATE INDEX IF NOT EXISTS "peeringdb_facility_org_id_idx" ON "peeringdb_facility" ("org_id");
CREATE INDEX IF NOT EXISTS "peeringdb_facility_name_nocase_idx" ON "peeringdb_facility" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_facility_country_nocase_idx" ON "peeringdb_facility" ("country" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_facility_city_nocase_idx" ON "peeringdb_facility" ("city" COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS "peeringdb_carrier" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "org_id" INTEGER NOT NULL DEFAULT 0,
    "org_name" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "aka" TEXT NOT NULL DEFAULT '',
    "name_long" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "social_media" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "fac_count" INTEGER NOT NULL DEFAULT 0,
    "logo" TEXT,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_carrier_org_id_idx" ON "peeringdb_carrier" ("org_id");
CREATE INDEX IF NOT EXISTS "peeringdb_carrier_name_nocase_idx" ON "peeringdb_carrier" ("name" COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS "peeringdb_ix" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "org_id" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL DEFAULT '',
    "aka" TEXT NOT NULL DEFAULT '',
    "name_long" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "region_continent" TEXT NOT NULL DEFAULT '',
    "media" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "proto_unicast" BOOL NOT NULL DEFAULT 0,
    "proto_multicast" BOOL NOT NULL DEFAULT 0,
    "proto_ipv6" BOOL NOT NULL DEFAULT 0,
    "website" TEXT NOT NULL DEFAULT '',
    "social_media" TEXT NOT NULL DEFAULT '',
    "url_stats" TEXT NOT NULL DEFAULT '',
    "tech_email" TEXT NOT NULL DEFAULT '',
    "tech_phone" TEXT NOT NULL DEFAULT '',
    "policy_email" TEXT NOT NULL DEFAULT '',
    "policy_phone" TEXT NOT NULL DEFAULT '',
    "sales_phone" TEXT NOT NULL DEFAULT '',
    "sales_email" TEXT NOT NULL DEFAULT '',
    "net_count" INTEGER NOT NULL DEFAULT 0,
    "fac_count" INTEGER NOT NULL DEFAULT 0,
    "ixf_net_count" INTEGER NOT NULL DEFAULT 0,
    "ixf_last_import" TEXT,
    "ixf_import_request" TEXT,
    "ixf_import_request_status" TEXT NOT NULL DEFAULT '',
    "service_level" TEXT NOT NULL DEFAULT '',
    "terms" TEXT NOT NULL DEFAULT '',
    "status_dashboard" TEXT,
    "logo" TEXT,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_ix_org_id_idx" ON "peeringdb_ix" ("org_id");
CREATE INDEX IF NOT EXISTS "peeringdb_ix_name_nocase_idx" ON "peeringdb_ix" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_ix_country_nocase_idx" ON "peeringdb_ix" ("country" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_ix_city_nocase_idx" ON "peeringdb_ix" ("city" COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS "peeringdb_ixlan" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "ix_id" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL DEFAULT '',
    "descr" TEXT NOT NULL DEFAULT '',
    "mtu" INTEGER NOT NULL DEFAULT 0,
    "dot1q_support" BOOL NOT NULL DEFAULT 0,
    "rs_asn" INTEGER NOT NULL DEFAULT 0,
    "arp_sponge" TEXT,
    "ixf_ixp_member_list_url" TEXT,
    "ixf_ixp_member_list_url_visible" TEXT NOT NULL DEFAULT '',
    "ixf_ixp_import_enabled" BOOL NOT NULL DEFAULT 0,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_ixlan_ix_id_idx" ON "peeringdb_ixlan" ("ix_id");

CREATE TABLE IF NOT EXISTS "peeringdb_ixlan_prefix" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "ixlan_id" INTEGER NOT NULL DEFAULT 0,
    "protocol" TEXT NOT NULL DEFAULT '',
    "prefix" TEXT NOT NULL DEFAULT '',
    "in_dfz" BOOL NOT NULL DEFAULT 0,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_ixlan_prefix_ixlan_id_idx" ON "peeringdb_ixlan_prefix" ("ixlan_id");

CREATE TABLE IF NOT EXISTS "peeringdb_network" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "org_id" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL DEFAULT '',
    "aka" TEXT NOT NULL DEFAULT '',
    "name_long" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "social_media" TEXT NOT NULL DEFAULT '',
    "asn" INTEGER NOT NULL DEFAULT 0,
    "looking_glass" TEXT NOT NULL DEFAULT '',
    "route_server" TEXT NOT NULL DEFAULT '',
    "irr_as_set" TEXT NOT NULL DEFAULT '',
    "info_type" TEXT NOT NULL DEFAULT '',
    "info_types" TEXT NOT NULL DEFAULT '',
    "info_prefixes4" INTEGER,
    "info_prefixes6" INTEGER,
    "info_traffic" TEXT NOT NULL DEFAULT '',
    "info_ratio" TEXT NOT NULL DEFAULT '',
    "info_scope" TEXT NOT NULL DEFAULT '',
    "info_unicast" BOOL NOT NULL DEFAULT 0,
    "info_multicast" BOOL NOT NULL DEFAULT 0,
    "info_ipv6" BOOL NOT NULL DEFAULT 0,
    "info_never_via_route_servers" BOOL NOT NULL DEFAULT 0,
    "ix_count" INTEGER NOT NULL DEFAULT 0,
    "fac_count" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "netixlan_updated" DATETIME,
    "netfac_updated" DATETIME,
    "poc_updated" DATETIME,
    "policy_url" TEXT NOT NULL DEFAULT '',
    "policy_general" TEXT NOT NULL DEFAULT '',
    "policy_locations" TEXT NOT NULL DEFAULT '',
    "policy_ratio" BOOL NOT NULL DEFAULT 0,
    "policy_contracts" TEXT NOT NULL DEFAULT '',
    "allow_ixp_update" BOOL NOT NULL DEFAULT 0,
    "status_dashboard" TEXT,
    "rir_status" TEXT,
    "rir_status_updated" DATETIME NOT NULL DEFAULT '',
    "logo" TEXT,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_network_org_id_idx" ON "peeringdb_network" ("org_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_asn_idx" ON "peeringdb_network" ("asn");
CREATE INDEX IF NOT EXISTS "peeringdb_network_name_nocase_idx" ON "peeringdb_network" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_network_irr_as_set_nocase_idx" ON "peeringdb_network" ("irr_as_set" COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS "peeringdb_network_contact" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "net_id" INTEGER NOT NULL DEFAULT 0,
    "role" TEXT NOT NULL DEFAULT '',
    "visible" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_network_contact_net_id_idx" ON "peeringdb_network_contact" ("net_id");

CREATE TABLE IF NOT EXISTS "peeringdb_network_facility" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "net_id" INTEGER NOT NULL DEFAULT 0,
    "fac_id" INTEGER NOT NULL DEFAULT 0,
    "local_asn" INTEGER NOT NULL DEFAULT 0,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_network_facility_net_id_idx" ON "peeringdb_network_facility" ("net_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_facility_fac_id_idx" ON "peeringdb_network_facility" ("fac_id");

CREATE TABLE IF NOT EXISTS "peeringdb_network_ixlan" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "net_id" INTEGER NOT NULL DEFAULT 0,
    "ix_id" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL DEFAULT '',
    "ixlan_id" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "speed" INTEGER NOT NULL DEFAULT 0,
    "asn" INTEGER NOT NULL DEFAULT 0,
    "ipaddr4" TEXT NOT NULL DEFAULT '',
    "ipaddr6" TEXT,
    "is_rs_peer" BOOL NOT NULL DEFAULT 0,
    "bfd_support" BOOL NOT NULL DEFAULT 0,
    "operational" BOOL NOT NULL DEFAULT 0,
    "net_side_id" INTEGER,
    "ix_side_id" INTEGER,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_net_id_idx" ON "peeringdb_network_ixlan" ("net_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_ix_id_idx" ON "peeringdb_network_ixlan" ("ix_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_ixlan_id_idx" ON "peeringdb_network_ixlan" ("ixlan_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_asn_idx" ON "peeringdb_network_ixlan" ("asn");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_net_side_id_idx" ON "peeringdb_network_ixlan" ("net_side_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_ix_side_id_idx" ON "peeringdb_network_ixlan" ("ix_side_id");

CREATE TABLE IF NOT EXISTS "peeringdb_ix_facility" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "ix_id" INTEGER NOT NULL DEFAULT 0,
    "fac_id" INTEGER NOT NULL DEFAULT 0,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_ix_facility_ix_id_idx" ON "peeringdb_ix_facility" ("ix_id");
CREATE INDEX IF NOT EXISTS "peeringdb_ix_facility_fac_id_idx" ON "peeringdb_ix_facility" ("fac_id");

CREATE TABLE IF NOT EXISTS "peeringdb_ix_carrier_facility" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "carrier_id" INTEGER NOT NULL DEFAULT 0,
    "fac_id" INTEGER NOT NULL DEFAULT 0,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "peeringdb_ix_carrier_facility_carrier_id_idx" ON "peeringdb_ix_carrier_facility" ("carrier_id");
CREATE INDEX IF NOT EXISTS "peeringdb_ix_carrier_facility_fac_id_idx" ON "peeringdb_ix_carrier_facility" ("fac_id");

