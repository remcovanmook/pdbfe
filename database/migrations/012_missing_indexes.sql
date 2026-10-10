-- Migration: indexes that extracted/schema.sql declares but production never got.
--
-- Production D1 was bootstrapped from the 2026-04-08 schema. Indexes the
-- generator added to schema.sql afterwards only reach an existing database
-- through a migration, and these ten case-insensitive name/city/country
-- indexes never had one (found by replaying bootstrap schema + migrations
-- 004–011 against the current schema). Without them, ?name= / ?city= /
-- ?country= (and __contains / __startswith) filters on these tables scan.
--
-- Plus netixlan.ix_id: a denormalised id that netixlan?ix_id=N (the IX
-- member list) filters on, which had no index at all because it carries no
-- foreignKey; scripts/parse_django_models.py now indexes every *_id column.
-- All foreign-key indexes were already present. Indexes only; no data or
-- column changes.

CREATE INDEX IF NOT EXISTS "peeringdb_campus_city_nocase_idx" ON "peeringdb_campus" ("city" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_campus_country_nocase_idx" ON "peeringdb_campus" ("country" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_ix_carrier_facility_name_nocase_idx" ON "peeringdb_ix_carrier_facility" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_ix_facility_city_nocase_idx" ON "peeringdb_ix_facility" ("city" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_ix_facility_country_nocase_idx" ON "peeringdb_ix_facility" ("country" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_ix_facility_name_nocase_idx" ON "peeringdb_ix_facility" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_network_contact_name_nocase_idx" ON "peeringdb_network_contact" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_network_facility_city_nocase_idx" ON "peeringdb_network_facility" ("city" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_network_facility_country_nocase_idx" ON "peeringdb_network_facility" ("country" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_network_facility_name_nocase_idx" ON "peeringdb_network_facility" ("name" COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_ix_id_idx" ON "peeringdb_network_ixlan" ("ix_id");
