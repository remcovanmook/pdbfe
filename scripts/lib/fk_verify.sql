-- fk_verify.sql — Count remaining FK violations after cleanup.
-- Each query runs independently to avoid D1's compound SELECT limit.
-- Expected output: every count should be 0.

SELECT 'campus.org_id → org' AS fk, COUNT(*) AS violations
    FROM peeringdb_campus WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);

SELECT 'fac.org_id → org' AS fk, COUNT(*) AS violations
    FROM peeringdb_facility WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);

SELECT 'fac.campus_id → campus' AS fk, COUNT(*) AS violations
    FROM peeringdb_facility WHERE campus_id IS NOT NULL AND campus_id NOT IN (SELECT id FROM peeringdb_campus);

SELECT 'net.org_id → org' AS fk, COUNT(*) AS violations
    FROM peeringdb_network WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);

SELECT 'ix.org_id → org' AS fk, COUNT(*) AS violations
    FROM peeringdb_ix WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);

SELECT 'carrier.org_id → org' AS fk, COUNT(*) AS violations
    FROM peeringdb_carrier WHERE org_id NOT IN (SELECT id FROM peeringdb_organization);

SELECT 'ixlan.ix_id → ix' AS fk, COUNT(*) AS violations
    FROM peeringdb_ixlan WHERE ix_id NOT IN (SELECT id FROM peeringdb_ix);

SELECT 'ixpfx.ixlan_id → ixlan' AS fk, COUNT(*) AS violations
    FROM peeringdb_ixlan_prefix WHERE ixlan_id NOT IN (SELECT id FROM peeringdb_ixlan);

SELECT 'netfac.net_id → net' AS fk, COUNT(*) AS violations
    FROM peeringdb_network_facility WHERE net_id NOT IN (SELECT id FROM peeringdb_network);

SELECT 'netfac.fac_id → fac' AS fk, COUNT(*) AS violations
    FROM peeringdb_network_facility WHERE fac_id NOT IN (SELECT id FROM peeringdb_facility);

SELECT 'netixlan.net_id → net' AS fk, COUNT(*) AS violations
    FROM peeringdb_network_ixlan WHERE net_id NOT IN (SELECT id FROM peeringdb_network);

SELECT 'netixlan.ixlan_id → ixlan' AS fk, COUNT(*) AS violations
    FROM peeringdb_network_ixlan WHERE ixlan_id NOT IN (SELECT id FROM peeringdb_ixlan);

SELECT 'poc.net_id → net' AS fk, COUNT(*) AS violations
    FROM peeringdb_network_contact WHERE net_id NOT IN (SELECT id FROM peeringdb_network);

SELECT 'ixfac.ix_id → ix' AS fk, COUNT(*) AS violations
    FROM peeringdb_ix_facility WHERE ix_id NOT IN (SELECT id FROM peeringdb_ix);

SELECT 'ixfac.fac_id → fac' AS fk, COUNT(*) AS violations
    FROM peeringdb_ix_facility WHERE fac_id NOT IN (SELECT id FROM peeringdb_facility);

SELECT 'carrierfac.carrier_id → carrier' AS fk, COUNT(*) AS violations
    FROM peeringdb_ix_carrier_facility WHERE carrier_id NOT IN (SELECT id FROM peeringdb_carrier);

SELECT 'carrierfac.fac_id → fac' AS fk, COUNT(*) AS violations
    FROM peeringdb_ix_carrier_facility WHERE fac_id NOT IN (SELECT id FROM peeringdb_facility);
