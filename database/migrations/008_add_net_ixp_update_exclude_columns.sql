-- Migration: add the ixp_update_exclude_* boolean sub-flags to peeringdb_network.
-- These fields were introduced upstream in django-peeringdb / api-schema
-- 2.80.1 (net gained ixp_update_exclude_speed, ixp_update_exclude_is_rs_peer,
-- ixp_update_exclude_operational alongside the pre-existing ixp_update_exclude).
-- The schema artifacts were regenerated to 2.80.1, so the query builder now
-- SELECTs these columns — but the D1 table predates them, causing
-- "no such column: t.ixp_update_exclude_speed" (SQLITE_ERROR) on every net
-- query. Add them with the same types/defaults as extracted/schema.sql so
-- reads succeed immediately and the sync worker can populate them.
--
-- Note: ixp_update_exclude (TEXT) already exists on the table and is
-- intentionally omitted here.

ALTER TABLE "peeringdb_network" ADD COLUMN "ixp_update_exclude_speed" BOOL NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network" ADD COLUMN "ixp_update_exclude_is_rs_peer" BOOL NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network" ADD COLUMN "ixp_update_exclude_operational" BOOL NOT NULL DEFAULT 0;
