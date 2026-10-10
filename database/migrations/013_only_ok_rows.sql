-- Migration: D1 holds only status='ok' rows.
--
-- The mirror serves only what upstream lists (status 'ok'), and the sync now
-- treats any other status as a removal (workers/sync/rows.js isListed).
-- This clears what earlier syncs stored anyway: 22 pending campuses as of
-- 2026-10-10. Every other table holds only 'ok' rows today; the statements
-- are there so the invariant holds for all of them.

DELETE FROM "peeringdb_organization" WHERE "status" != 'ok';
DELETE FROM "peeringdb_campus" WHERE "status" != 'ok';
DELETE FROM "peeringdb_facility" WHERE "status" != 'ok';
DELETE FROM "peeringdb_carrier" WHERE "status" != 'ok';
DELETE FROM "peeringdb_ix" WHERE "status" != 'ok';
DELETE FROM "peeringdb_ixlan" WHERE "status" != 'ok';
DELETE FROM "peeringdb_ixlan_prefix" WHERE "status" != 'ok';
DELETE FROM "peeringdb_network" WHERE "status" != 'ok';
DELETE FROM "peeringdb_network_contact" WHERE "status" != 'ok';
DELETE FROM "peeringdb_network_facility" WHERE "status" != 'ok';
DELETE FROM "peeringdb_network_ixlan" WHERE "status" != 'ok';
DELETE FROM "peeringdb_ix_facility" WHERE "status" != 'ok';
DELETE FROM "peeringdb_ix_carrier_facility" WHERE "status" != 'ok';
