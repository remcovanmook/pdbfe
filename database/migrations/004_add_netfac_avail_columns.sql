-- Migration: add deprecated avail_* columns to peeringdb_network_facility.
-- These fields exist in the upstream Django model (NetworkFacility) and are
-- included in the API serializer, but were never added to the D1 schema.
-- All three are boolean flags defaulting to false. Upstream omits them from
-- the API response when false (omitempty), which our query builder now
-- replicates via json_remove().

ALTER TABLE "peeringdb_network_facility" ADD COLUMN "avail_sonet" BOOL NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network_facility" ADD COLUMN "avail_ethernet" BOOL NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network_facility" ADD COLUMN "avail_atm" BOOL NOT NULL DEFAULT 0;