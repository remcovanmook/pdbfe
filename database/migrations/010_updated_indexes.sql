-- Migration: index "updated" on every synced table.
--
-- Every ?since= request (peeringdb-py and Peering Manager incremental syncs
-- issue one per table per run) filters on "updated". Without an index each
-- one was a full table scan: net?since= read all ~35.6k rows (25.6 ms of D1
-- time) and netixlan?since= all ~66.6k (30 ms) to return a handful of rows,
-- which was most of the ~46M rows read per day. Matches the
-- "<table>_updated_idx" indexes now emitted into extracted/schema.sql by
-- scripts/parse_django_models.py. Indexes only; no data or column changes.

CREATE INDEX IF NOT EXISTS "peeringdb_campus_updated_idx" ON "peeringdb_campus" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_carrier_updated_idx" ON "peeringdb_carrier" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_ix_carrier_facility_updated_idx" ON "peeringdb_ix_carrier_facility" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_facility_updated_idx" ON "peeringdb_facility" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_ix_updated_idx" ON "peeringdb_ix" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_ix_facility_updated_idx" ON "peeringdb_ix_facility" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_ixlan_updated_idx" ON "peeringdb_ixlan" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_ixlan_prefix_updated_idx" ON "peeringdb_ixlan_prefix" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_network_updated_idx" ON "peeringdb_network" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_network_facility_updated_idx" ON "peeringdb_network_facility" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_network_ixlan_updated_idx" ON "peeringdb_network_ixlan" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_organization_updated_idx" ON "peeringdb_organization" ("updated");
CREATE INDEX IF NOT EXISTS "peeringdb_network_contact_updated_idx" ON "peeringdb_network_contact" ("updated");
