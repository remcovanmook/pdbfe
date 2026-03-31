-- PeeringDB D1 Schema
-- Derived from the upstream peeringdb-py SQLite schema.
-- Django-specific tables (django_migrations, sqlite_sequence) are omitted.
-- DEFERRABLE INITIALLY DEFERRED is stripped (unsupported by D1).

-- Sync metadata: tracks last sync timestamp per entity type
CREATE TABLE IF NOT EXISTS "_sync_meta" (
    "entity" TEXT NOT NULL PRIMARY KEY,
    "last_sync" INTEGER NOT NULL DEFAULT 0,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "peeringdb_organization" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "address1" VARCHAR(255) NOT NULL,
    "address2" VARCHAR(255) NOT NULL,
    "city" VARCHAR(255) NOT NULL,
    "state" VARCHAR(255) NOT NULL,
    "zipcode" VARCHAR(48) NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "latitude" DECIMAL NULL,
    "longitude" DECIMAL NULL,
    "name" VARCHAR(255) NOT NULL UNIQUE,
    "notes" TEXT NOT NULL,
    "floor" VARCHAR(255) NOT NULL,
    "suite" VARCHAR(255) NOT NULL,
    "aka" VARCHAR(255) NOT NULL,
    "name_long" VARCHAR(255) NOT NULL,
    "social_media" TEXT NOT NULL,
    "website" VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS "peeringdb_campus" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL UNIQUE,
    "name_long" VARCHAR(255) NULL,
    "aka" VARCHAR(255) NULL,
    "notes" TEXT NOT NULL,
    "org_id" INTEGER NOT NULL REFERENCES "peeringdb_organization" ("id"),
    "social_media" TEXT NOT NULL,
    "website" VARCHAR(255) NOT NULL
);
CREATE INDEX "peeringdb_campus_org_id_10f58fda" ON "peeringdb_campus" ("org_id");

CREATE TABLE IF NOT EXISTS "peeringdb_facility" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "address1" VARCHAR(255) NOT NULL,
    "address2" VARCHAR(255) NOT NULL,
    "city" VARCHAR(255) NOT NULL,
    "state" VARCHAR(255) NOT NULL,
    "zipcode" VARCHAR(48) NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "latitude" DECIMAL NULL,
    "longitude" DECIMAL NULL,
    "name" VARCHAR(255) NOT NULL UNIQUE,
    "website" VARCHAR(255) NOT NULL,
    "clli" VARCHAR(18) NOT NULL,
    "rencode" VARCHAR(18) NOT NULL,
    "npanxx" VARCHAR(21) NOT NULL,
    "notes" TEXT NOT NULL,
    "org_id" INTEGER NOT NULL REFERENCES "peeringdb_organization" ("id"),
    "sales_email" VARCHAR(254) NOT NULL,
    "sales_phone" VARCHAR(192) NOT NULL,
    "tech_email" VARCHAR(254) NOT NULL,
    "tech_phone" VARCHAR(192) NOT NULL,
    "floor" VARCHAR(255) NOT NULL,
    "suite" VARCHAR(255) NOT NULL,
    "aka" VARCHAR(255) NOT NULL,
    "name_long" VARCHAR(255) NOT NULL,
    "available_voltage_services" VARCHAR(255) NULL,
    "diverse_serving_substations" BOOL NULL,
    "property" VARCHAR(27) NULL,
    "region_continent" VARCHAR(255) NULL,
    "status_dashboard" VARCHAR(255) NULL,
    "campus_id" INTEGER NULL REFERENCES "peeringdb_campus" ("id"),
    "social_media" TEXT NOT NULL
);
CREATE INDEX "peeringdb_facility_org_id_3420d8f7" ON "peeringdb_facility" ("org_id");
CREATE INDEX "peeringdb_facility_campus_id_30e07dbd" ON "peeringdb_facility" ("campus_id");

CREATE TABLE IF NOT EXISTS "peeringdb_carrier" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL UNIQUE,
    "aka" VARCHAR(255) NOT NULL,
    "name_long" VARCHAR(255) NOT NULL,
    "notes" TEXT NOT NULL,
    "org_id" INTEGER NOT NULL REFERENCES "peeringdb_organization" ("id"),
    "social_media" TEXT NOT NULL,
    "website" VARCHAR(255) NOT NULL
);
CREATE INDEX "peeringdb_carrier_org_id_d3ea36d7" ON "peeringdb_carrier" ("org_id");

CREATE TABLE IF NOT EXISTS "peeringdb_ix" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(64) NOT NULL UNIQUE,
    "name_long" VARCHAR(255) NOT NULL,
    "city" VARCHAR(192) NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "notes" TEXT NOT NULL,
    "region_continent" VARCHAR(255) NOT NULL,
    "proto_unicast" BOOL NOT NULL,
    "proto_multicast" BOOL NOT NULL,
    "proto_ipv6" BOOL NOT NULL,
    "website" VARCHAR(255) NOT NULL,
    "url_stats" VARCHAR(255) NOT NULL,
    "tech_email" VARCHAR(254) NOT NULL,
    "tech_phone" VARCHAR(192) NOT NULL,
    "policy_email" VARCHAR(254) NOT NULL,
    "policy_phone" VARCHAR(192) NOT NULL,
    "org_id" INTEGER NOT NULL REFERENCES "peeringdb_organization" ("id"),
    "ixf_last_import" DATETIME NULL,
    "ixf_net_count" INTEGER NOT NULL,
    "aka" VARCHAR(255) NOT NULL,
    "service_level" VARCHAR(60) NOT NULL,
    "terms" VARCHAR(60) NOT NULL,
    "sales_email" VARCHAR(254) NOT NULL,
    "sales_phone" VARCHAR(192) NOT NULL,
    "status_dashboard" VARCHAR(255) NULL,
    "social_media" TEXT NOT NULL,
    "media" VARCHAR(128) NOT NULL
);
CREATE INDEX "peeringdb_ix_org_id_7c888cd3" ON "peeringdb_ix" ("org_id");

CREATE TABLE IF NOT EXISTS "peeringdb_ixlan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "descr" TEXT NOT NULL,
    "vlan" INTEGER UNSIGNED NULL,
    "dot1q_support" BOOL NOT NULL,
    "rs_asn" INTEGER UNSIGNED NULL,
    "arp_sponge" VARCHAR(17) NULL UNIQUE,
    "ix_id" INTEGER NOT NULL REFERENCES "peeringdb_ix" ("id"),
    "ixf_ixp_member_list_url" VARCHAR(200) NULL,
    "ixf_ixp_member_list_url_visible" VARCHAR(64) NOT NULL,
    "mtu" INTEGER UNSIGNED NOT NULL
);
CREATE INDEX "peeringdb_ixlan_ix_id_3ba4157a" ON "peeringdb_ixlan" ("ix_id");

CREATE TABLE IF NOT EXISTS "peeringdb_ixlan_prefix" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "notes" VARCHAR(255) NOT NULL,
    "protocol" VARCHAR(64) NOT NULL,
    "prefix" VARCHAR(43) NOT NULL UNIQUE,
    "ixlan_id" INTEGER NOT NULL REFERENCES "peeringdb_ixlan" ("id"),
    "in_dfz" BOOL NOT NULL
);
CREATE INDEX "peeringdb_ixlan_prefix_ixlan_id_d8e99297" ON "peeringdb_ixlan_prefix" ("ixlan_id");

CREATE TABLE IF NOT EXISTS "peeringdb_network" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "asn" INTEGER UNSIGNED NOT NULL UNIQUE,
    "name" VARCHAR(255) NOT NULL UNIQUE,
    "aka" VARCHAR(255) NOT NULL,
    "irr_as_set" VARCHAR(255) NOT NULL,
    "website" VARCHAR(255) NOT NULL,
    "looking_glass" VARCHAR(255) NOT NULL,
    "route_server" VARCHAR(255) NOT NULL,
    "notes" TEXT NOT NULL,
    "notes_private" TEXT NOT NULL,
    "info_traffic" VARCHAR(39) NOT NULL,
    "info_ratio" VARCHAR(45) NOT NULL,
    "info_scope" VARCHAR(39) NOT NULL,
    "info_type" VARCHAR(60) NOT NULL,
    "info_prefixes4" INTEGER UNSIGNED NULL,
    "info_prefixes6" INTEGER UNSIGNED NULL,
    "info_unicast" BOOL NOT NULL,
    "info_multicast" BOOL NOT NULL,
    "info_ipv6" BOOL NOT NULL,
    "policy_url" VARCHAR(255) NOT NULL,
    "policy_general" VARCHAR(72) NOT NULL,
    "policy_locations" VARCHAR(72) NOT NULL,
    "policy_ratio" BOOL NOT NULL,
    "policy_contracts" VARCHAR(36) NOT NULL,
    "org_id" INTEGER NOT NULL REFERENCES "peeringdb_organization" ("id"),
    "info_never_via_route_servers" BOOL NOT NULL,
    "name_long" VARCHAR(255) NOT NULL,
    "status_dashboard" VARCHAR(255) NULL,
    "rir_status" VARCHAR(255) NULL,
    "rir_status_updated" DATETIME NULL,
    "social_media" TEXT NOT NULL,
    "info_types" VARCHAR(255) NOT NULL
);
CREATE INDEX "peeringdb_network_org_id_404d6106" ON "peeringdb_network" ("org_id");

CREATE TABLE IF NOT EXISTS "peeringdb_network_contact" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "role" VARCHAR(27) NOT NULL,
    "visible" VARCHAR(64) NOT NULL,
    "name" VARCHAR(254) NOT NULL,
    "phone" VARCHAR(100) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "url" VARCHAR(255) NOT NULL,
    "net_id" INTEGER NOT NULL REFERENCES "peeringdb_network" ("id")
);
CREATE INDEX "peeringdb_network_contact_net_id_8a6841df" ON "peeringdb_network_contact" ("net_id");

CREATE TABLE IF NOT EXISTS "peeringdb_network_facility" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "avail_sonet" BOOL NOT NULL,
    "avail_ethernet" BOOL NOT NULL,
    "avail_atm" BOOL NOT NULL,
    "fac_id" INTEGER NOT NULL REFERENCES "peeringdb_facility" ("id"),
    "net_id" INTEGER NOT NULL REFERENCES "peeringdb_network" ("id")
);
CREATE INDEX "peeringdb_network_facility_fac_id_30c45aca" ON "peeringdb_network_facility" ("fac_id");
CREATE INDEX "peeringdb_network_facility_net_id_ca57491b" ON "peeringdb_network_facility" ("net_id");
CREATE UNIQUE INDEX "peeringdb_network_facility_net_id_fac_id_97ea9755_uniq" ON "peeringdb_network_facility" ("net_id", "fac_id");

CREATE TABLE IF NOT EXISTS "peeringdb_network_ixlan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "asn" INTEGER UNSIGNED NOT NULL,
    "ipaddr4" VARCHAR(39) NULL,
    "ipaddr6" VARCHAR(39) NULL,
    "is_rs_peer" BOOL NOT NULL,
    "notes" VARCHAR(255) NOT NULL,
    "speed" INTEGER UNSIGNED NOT NULL,
    "ixlan_id" INTEGER NOT NULL REFERENCES "peeringdb_ixlan" ("id"),
    "net_id" INTEGER NOT NULL REFERENCES "peeringdb_network" ("id"),
    "operational" BOOL NOT NULL,
    "bfd_support" BOOL NOT NULL,
    "net_side_id" INTEGER NULL REFERENCES "peeringdb_facility" ("id"),
    "ix_side_id" INTEGER NULL REFERENCES "peeringdb_facility" ("id")
);
CREATE INDEX "peeringdb_network_ixlan_ixlan_id_521451ed" ON "peeringdb_network_ixlan" ("ixlan_id");
CREATE INDEX "peeringdb_network_ixlan_net_id_9178e45e" ON "peeringdb_network_ixlan" ("net_id");
CREATE INDEX "peeringdb_network_ixlan_net_side_id_f05943c6" ON "peeringdb_network_ixlan" ("net_side_id");
CREATE INDEX "peeringdb_network_ixlan_ix_side_id_ce15bf96" ON "peeringdb_network_ixlan" ("ix_side_id");

CREATE TABLE IF NOT EXISTS "peeringdb_ix_facility" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "fac_id" INTEGER NOT NULL REFERENCES "peeringdb_facility" ("id"),
    "ix_id" INTEGER NOT NULL REFERENCES "peeringdb_ix" ("id")
);
CREATE INDEX "peeringdb_ix_facility_fac_id_4402e456" ON "peeringdb_ix_facility" ("fac_id");
CREATE INDEX "peeringdb_ix_facility_ix_id_59b7a91d" ON "peeringdb_ix_facility" ("ix_id");
CREATE UNIQUE INDEX "peeringdb_ix_facility_ix_id_fac_id_fd6e394f_uniq" ON "peeringdb_ix_facility" ("ix_id", "fac_id");

CREATE TABLE IF NOT EXISTS "peeringdb_ix_carrier_facility" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" VARCHAR(255) NOT NULL,
    "created" DATETIME NOT NULL,
    "updated" DATETIME NOT NULL,
    "version" INTEGER NOT NULL,
    "carrier_id" INTEGER NOT NULL REFERENCES "peeringdb_carrier" ("id"),
    "fac_id" INTEGER NOT NULL REFERENCES "peeringdb_facility" ("id")
);
CREATE UNIQUE INDEX "peeringdb_ix_carrier_facility_carrier_id_fac_id_6e54dd99_uniq" ON "peeringdb_ix_carrier_facility" ("carrier_id", "fac_id");
CREATE INDEX "peeringdb_ix_carrier_facility_carrier_id_8b32a0c0" ON "peeringdb_ix_carrier_facility" ("carrier_id");
CREATE INDEX "peeringdb_ix_carrier_facility_fac_id_88f7cb0a" ON "peeringdb_ix_carrier_facility" ("fac_id");
