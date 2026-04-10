-- Migration: add missing columns from pipeline schema generation
-- Changes: peeringdb_ixlan.vlan, peeringdb_ixlan_prefix.notes,
--          peeringdb_network.notes_private, peeringdb_network_facility.avail_sonet,
--          peeringdb_network_facility.avail_ethernet, peeringdb_network_facility.avail_atm
--
-- These columns exist in the upstream Django model but were not in the
-- original hand-written schema. The pipeline correctly added them.

ALTER TABLE "peeringdb_ixlan" ADD COLUMN "vlan" INTEGER;
ALTER TABLE "peeringdb_ixlan_prefix" ADD COLUMN "notes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "peeringdb_network" ADD COLUMN "notes_private" TEXT NOT NULL DEFAULT '';
ALTER TABLE "peeringdb_network_facility" ADD COLUMN "avail_sonet" BOOL NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network_facility" ADD COLUMN "avail_ethernet" BOOL NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network_facility" ADD COLUMN "avail_atm" BOOL NOT NULL DEFAULT 0;
