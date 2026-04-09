-- fk_cleanup.sql — Fix referential integrity violations from PeeringDB JSON dumps.
--
-- The public.peeringdb.com JSON dumps contain active child records that
-- reference deleted parent records (dangling foreign keys). This script
-- removes or nullifies those references after a bulk import.
--
-- Strategy:
--   - NOT NULL FK columns (org_id, net_id, etc.): DELETE the orphaned child row.
--     A child without its parent is useless and would cause peeringdb-py errors.
--   - Nullable FK columns (campus_id): SET to NULL.
--     The child is valid on its own; it just loses an optional association.
--
-- Also removes records with non-ok status, since the upstream API only
-- serves status='ok' in default queries. Non-ok records in the dumps
-- cause FK resolution failures in downstream clients.

-- ── Remove non-ok status records ─────────────────────────────────────────────
-- Order: children first, then parents.

DELETE FROM peeringdb_ix_carrier_facility WHERE status != 'ok';
DELETE FROM peeringdb_ix_facility WHERE status != 'ok';
DELETE FROM peeringdb_network_ixlan WHERE status != 'ok';
DELETE FROM peeringdb_network_facility WHERE status != 'ok';
DELETE FROM peeringdb_network_contact WHERE status != 'ok';
DELETE FROM peeringdb_ixlan_prefix WHERE status != 'ok';
DELETE FROM peeringdb_ixlan WHERE status != 'ok';
DELETE FROM peeringdb_carrier WHERE status != 'ok';
DELETE FROM peeringdb_ix WHERE status != 'ok';
DELETE FROM peeringdb_network WHERE status != 'ok';
DELETE FROM peeringdb_facility WHERE status != 'ok';
DELETE FROM peeringdb_campus WHERE status != 'ok';
DELETE FROM peeringdb_organization WHERE status != 'ok';

-- ── Nullable FK columns: set to NULL ─────────────────────────────────────────

UPDATE peeringdb_facility SET campus_id = NULL
    WHERE campus_id IS NOT NULL
    AND campus_id NOT IN (SELECT id FROM peeringdb_campus);

-- ── NOT NULL FK columns: delete orphaned children ────────────────────────────

-- org_id references
DELETE FROM peeringdb_campus
    WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);
DELETE FROM peeringdb_facility
    WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);
DELETE FROM peeringdb_network
    WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);
DELETE FROM peeringdb_ix
    WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);
DELETE FROM peeringdb_carrier
    WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);

-- ix_id references
DELETE FROM peeringdb_ixlan
    WHERE ix_id NOT IN (SELECT id FROM peeringdb_ix);
DELETE FROM peeringdb_ix_facility
    WHERE ix_id NOT IN (SELECT id FROM peeringdb_ix);

-- ixlan_id references
DELETE FROM peeringdb_ixlan_prefix
    WHERE ixlan_id NOT IN (SELECT id FROM peeringdb_ixlan);
DELETE FROM peeringdb_network_ixlan
    WHERE ixlan_id NOT IN (SELECT id FROM peeringdb_ixlan);

-- net_id references
DELETE FROM peeringdb_network_facility
    WHERE net_id NOT IN (SELECT id FROM peeringdb_network);
DELETE FROM peeringdb_network_ixlan
    WHERE net_id NOT IN (SELECT id FROM peeringdb_network);
DELETE FROM peeringdb_network_contact
    WHERE net_id NOT IN (SELECT id FROM peeringdb_network);

-- fac_id references
DELETE FROM peeringdb_network_facility
    WHERE fac_id NOT IN (SELECT id FROM peeringdb_facility);
DELETE FROM peeringdb_ix_facility
    WHERE fac_id NOT IN (SELECT id FROM peeringdb_facility);
DELETE FROM peeringdb_ix_carrier_facility
    WHERE fac_id NOT IN (SELECT id FROM peeringdb_facility);

-- carrier_id references
DELETE FROM peeringdb_ix_carrier_facility
    WHERE carrier_id NOT IN (SELECT id FROM peeringdb_carrier);
