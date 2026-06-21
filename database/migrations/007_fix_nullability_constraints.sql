-- Migration: fix nullability constraints to align DB schema with generated schema.sql
--
-- Adjusts SQLite column constraints for:
--  - peeringdb_facility (available_voltage_services, region_continent) -> NULL
--  - peeringdb_ixlan (rs_asn) -> NULL
--  - peeringdb_network (rir_status_updated) -> NULL
--  - peeringdb_network_ixlan (ipaddr4) -> NULL
--
-- Since SQLite does not support modifying column constraints via ALTER TABLE,
-- we perform table re-creation for each affected table.

PRAGMA foreign_keys = OFF;

-- 1. peeringdb_facility
CREATE TABLE "peeringdb_facility_new" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "social_media" TEXT NOT NULL DEFAULT '',
    "aka" TEXT NOT NULL DEFAULT '',
    "name_long" TEXT NOT NULL DEFAULT '',
    "clli" TEXT NOT NULL DEFAULT '',
    "rencode" TEXT NOT NULL DEFAULT '',
    "npanxx" TEXT NOT NULL DEFAULT '',
    "tech_email" TEXT NOT NULL DEFAULT '',
    "tech_phone" TEXT NOT NULL DEFAULT '',
    "sales_email" TEXT NOT NULL DEFAULT '',
    "sales_phone" TEXT NOT NULL DEFAULT '',
    "property" TEXT,
    "diverse_serving_substations" BOOL,
    "available_voltage_services" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "region_continent" TEXT,
    "status_dashboard" TEXT,
    "org_id" INTEGER NOT NULL DEFAULT 0,
    "campus_id" INTEGER,
    "org_name" TEXT NOT NULL DEFAULT '',
    "net_count" INTEGER NOT NULL DEFAULT 0,
    "ix_count" INTEGER NOT NULL DEFAULT 0,
    "carrier_count" INTEGER NOT NULL DEFAULT 0,
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
    "status" TEXT NOT NULL DEFAULT '',
    "__logo_migrated" BOOL NOT NULL DEFAULT 0,
    "__vector_embedded" BOOL NOT NULL DEFAULT 0
);

INSERT INTO "peeringdb_facility_new" (
    "id", "name", "website", "social_media", "aka", "name_long", "clli", "rencode",
    "npanxx", "tech_email", "tech_phone", "sales_email", "sales_phone", "property",
    "diverse_serving_substations", "available_voltage_services", "notes", "region_continent",
    "status_dashboard", "org_id", "campus_id", "org_name", "net_count", "ix_count",
    "carrier_count", "logo", "address1", "address2", "city", "country", "state",
    "zipcode", "floor", "suite", "latitude", "longitude", "created", "updated",
    "status", "__logo_migrated", "__vector_embedded"
)
SELECT 
    "id", "name", "website", "social_media", "aka", "name_long", "clli", "rencode",
    "npanxx", "tech_email", "tech_phone", "sales_email", "sales_phone", "property",
    "diverse_serving_substations", "available_voltage_services", "notes", "region_continent",
    "status_dashboard", "org_id", "campus_id", "org_name", "net_count", "ix_count",
    "carrier_count", "logo", "address1", "address2", "city", "country", "state",
    "zipcode", "floor", "suite", "latitude", "longitude", "created", "updated",
    "status", "__logo_migrated", "__vector_embedded"
FROM "peeringdb_facility";

DROP TABLE "peeringdb_facility";
ALTER TABLE "peeringdb_facility_new" RENAME TO "peeringdb_facility";

CREATE INDEX IF NOT EXISTS "peeringdb_facility_name_nocase_idx" ON "peeringdb_facility" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_facility_org_id_idx" ON "peeringdb_facility" ("org_id");
CREATE INDEX IF NOT EXISTS "peeringdb_facility_campus_id_idx" ON "peeringdb_facility" ("campus_id");
CREATE INDEX IF NOT EXISTS "peeringdb_facility_city_nocase_idx" ON "peeringdb_facility" ("city" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_facility_country_nocase_idx" ON "peeringdb_facility" ("country" COLLATE NOCASE);


-- 2. peeringdb_ixlan
CREATE TABLE "peeringdb_ixlan_new" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "descr" TEXT NOT NULL DEFAULT '',
    "mtu" INTEGER NOT NULL DEFAULT 0,
    "vlan" INTEGER,
    "dot1q_support" BOOL NOT NULL DEFAULT 0,
    "rs_asn" INTEGER,
    "arp_sponge" TEXT,
    "ixf_ixp_member_list_url" TEXT,
    "ixf_ixp_member_list_url_visible" TEXT NOT NULL DEFAULT '',
    "ix_id" INTEGER NOT NULL DEFAULT 0,
    "ixf_ixp_import_enabled" BOOL NOT NULL DEFAULT 0,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);

INSERT INTO "peeringdb_ixlan_new" (
    "id", "name", "descr", "mtu", "vlan", "dot1q_support", "rs_asn", "arp_sponge",
    "ixf_ixp_member_list_url", "ixf_ixp_member_list_url_visible", "ix_id",
    "ixf_ixp_import_enabled", "created", "updated", "status"
)
SELECT 
    "id", "name", "descr", "mtu", "vlan", "dot1q_support", "rs_asn", "arp_sponge",
    "ixf_ixp_member_list_url", "ixf_ixp_member_list_url_visible", "ix_id",
    "ixf_ixp_import_enabled", "created", "updated", "status"
FROM "peeringdb_ixlan";

DROP TABLE "peeringdb_ixlan";
ALTER TABLE "peeringdb_ixlan_new" RENAME TO "peeringdb_ixlan";

CREATE INDEX IF NOT EXISTS "peeringdb_ixlan_name_nocase_idx" ON "peeringdb_ixlan" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_ixlan_ix_id_idx" ON "peeringdb_ixlan" ("ix_id");


-- 3. peeringdb_network
CREATE TABLE "peeringdb_network_new" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "asn" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL DEFAULT '',
    "aka" TEXT NOT NULL DEFAULT '',
    "name_long" TEXT NOT NULL DEFAULT '',
    "irr_as_set" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "social_media" TEXT NOT NULL DEFAULT '',
    "looking_glass" TEXT NOT NULL DEFAULT '',
    "route_server" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "notes_private" TEXT NOT NULL DEFAULT '',
    "info_traffic" TEXT NOT NULL DEFAULT '',
    "info_ratio" TEXT NOT NULL DEFAULT '',
    "info_scope" TEXT NOT NULL DEFAULT '',
    "info_types" TEXT NOT NULL DEFAULT '',
    "info_prefixes4" INTEGER,
    "info_prefixes6" INTEGER,
    "info_unicast" BOOL NOT NULL DEFAULT 0,
    "info_multicast" BOOL NOT NULL DEFAULT 0,
    "info_ipv6" BOOL NOT NULL DEFAULT 0,
    "info_never_via_route_servers" BOOL NOT NULL DEFAULT 0,
    "policy_url" TEXT NOT NULL DEFAULT '',
    "policy_general" TEXT NOT NULL DEFAULT '',
    "policy_locations" TEXT NOT NULL DEFAULT '',
    "policy_ratio" BOOL NOT NULL DEFAULT 0,
    "policy_contracts" TEXT NOT NULL DEFAULT '',
    "status_dashboard" TEXT,
    "rir_status" TEXT,
    "rir_status_updated" DATETIME,
    "org_id" INTEGER NOT NULL DEFAULT 0,
    "info_type" TEXT NOT NULL DEFAULT '',
    "ix_count" INTEGER NOT NULL DEFAULT 0,
    "fac_count" INTEGER NOT NULL DEFAULT 0,
    "netixlan_updated" DATETIME NOT NULL DEFAULT '',
    "netfac_updated" DATETIME NOT NULL DEFAULT '',
    "poc_updated" DATETIME NOT NULL DEFAULT '',
    "allow_ixp_update" BOOL NOT NULL DEFAULT 0,
    "logo" TEXT,
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT '',
    "__logo_migrated" BOOL NOT NULL DEFAULT 0,
    "__vector_embedded" BOOL NOT NULL DEFAULT 0
);

INSERT INTO "peeringdb_network_new" (
    "id", "asn", "name", "aka", "name_long", "irr_as_set", "website", "social_media",
    "looking_glass", "route_server", "notes", "notes_private", "info_traffic",
    "info_ratio", "info_scope", "info_types", "info_prefixes4", "info_prefixes6",
    "info_unicast", "info_multicast", "info_ipv6", "info_never_via_route_servers",
    "policy_url", "policy_general", "policy_locations", "policy_ratio", "policy_contracts",
    "status_dashboard", "rir_status", "rir_status_updated", "org_id", "info_type",
    "ix_count", "fac_count", "netixlan_updated", "netfac_updated", "poc_updated",
    "allow_ixp_update", "logo", "created", "updated", "status", "__logo_migrated",
    "__vector_embedded"
)
SELECT 
    "id", "asn", "name", "aka", "name_long", "irr_as_set", "website", "social_media",
    "looking_glass", "route_server", "notes", "notes_private", "info_traffic",
    "info_ratio", "info_scope", "info_types", "info_prefixes4", "info_prefixes6",
    "info_unicast", "info_multicast", "info_ipv6", "info_never_via_route_servers",
    "policy_url", "policy_general", "policy_locations", "policy_ratio", "policy_contracts",
    "status_dashboard", "rir_status", "rir_status_updated", "org_id", "info_type",
    "ix_count", "fac_count", COALESCE("netixlan_updated", ''), COALESCE("netfac_updated", ''), COALESCE("poc_updated", ''),
    "allow_ixp_update", "logo", "created", "updated", "status", "__logo_migrated",
    "__vector_embedded"
FROM "peeringdb_network";

DROP TABLE "peeringdb_network";
ALTER TABLE "peeringdb_network_new" RENAME TO "peeringdb_network";

CREATE INDEX IF NOT EXISTS "peeringdb_network_asn_idx" ON "peeringdb_network" ("asn");
CREATE INDEX IF NOT EXISTS "peeringdb_network_name_nocase_idx" ON "peeringdb_network" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_network_irr_as_set_nocase_idx" ON "peeringdb_network" ("irr_as_set" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_network_org_id_idx" ON "peeringdb_network" ("org_id");


-- 4. peeringdb_network_ixlan
CREATE TABLE "peeringdb_network_ixlan_new" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "asn" INTEGER NOT NULL DEFAULT 0,
    "ipaddr4" TEXT,
    "ipaddr6" TEXT,
    "is_rs_peer" BOOL NOT NULL DEFAULT 0,
    "bfd_support" BOOL NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "speed" INTEGER NOT NULL DEFAULT 0,
    "operational" BOOL NOT NULL DEFAULT 0,
    "net_id" INTEGER NOT NULL DEFAULT 0,
    "ixlan_id" INTEGER NOT NULL DEFAULT 0,
    "net_side_id" INTEGER,
    "ix_side_id" INTEGER,
    "ix_id" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL DEFAULT '',
    "created" DATETIME NOT NULL DEFAULT '',
    "updated" DATETIME NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT ''
);

INSERT INTO "peeringdb_network_ixlan_new" (
    "id", "asn", "ipaddr4", "ipaddr6", "is_rs_peer", "bfd_support", "notes", "speed",
    "operational", "net_id", "ixlan_id", "net_side_id", "ix_side_id", "ix_id", "name",
    "created", "updated", "status"
)
SELECT 
    "id", "asn", "ipaddr4", "ipaddr6", "is_rs_peer", "bfd_support", "notes", "speed",
    "operational", "net_id", "ixlan_id", "net_side_id", "ix_side_id", "ix_id", "name",
    "created", "updated", "status"
FROM "peeringdb_network_ixlan";

DROP TABLE "peeringdb_network_ixlan";
ALTER TABLE "peeringdb_network_ixlan_new" RENAME TO "peeringdb_network_ixlan";

CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_asn_idx" ON "peeringdb_network_ixlan" ("asn");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_net_id_idx" ON "peeringdb_network_ixlan" ("net_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_ixlan_id_idx" ON "peeringdb_network_ixlan" ("ixlan_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_net_side_id_idx" ON "peeringdb_network_ixlan" ("net_side_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_ix_side_id_idx" ON "peeringdb_network_ixlan" ("ix_side_id");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_name_nocase_idx" ON "peeringdb_network_ixlan" ("name" COLLATE NOCASE);

PRAGMA foreign_keys = ON;
