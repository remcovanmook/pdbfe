-- Add COLLATE NOCASE indexes for case-insensitive string equality filters.
--
-- SQLite's COLLATE NOCASE on an = comparison cannot use a default (BINARY)
-- index. These indexes ensure WHERE "name" = ? COLLATE NOCASE can use an
-- index scan instead of a full table scan.
--
-- Covers the most commonly filtered string columns across all entities.
-- Integer FK indexes are unaffected (COLLATE NOCASE is a no-op on integers).

-- ── name columns (most common user-facing filter) ────────────────────────────

CREATE INDEX IF NOT EXISTS "peeringdb_network_name_nocase_idx"
    ON "peeringdb_network" ("name" COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS "peeringdb_organization_name_nocase_idx"
    ON "peeringdb_organization" ("name" COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS "peeringdb_facility_name_nocase_idx"
    ON "peeringdb_facility" ("name" COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS "peeringdb_ix_name_nocase_idx"
    ON "peeringdb_ix" ("name" COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS "peeringdb_carrier_name_nocase_idx"
    ON "peeringdb_carrier" ("name" COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS "peeringdb_campus_name_nocase_idx"
    ON "peeringdb_campus" ("name" COLLATE NOCASE);

-- ── country columns (heavily used in cross-entity filters: net?country=NL) ───

CREATE INDEX IF NOT EXISTS "peeringdb_organization_country_nocase_idx"
    ON "peeringdb_organization" ("country" COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS "peeringdb_facility_country_nocase_idx"
    ON "peeringdb_facility" ("country" COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS "peeringdb_ix_country_nocase_idx"
    ON "peeringdb_ix" ("country" COLLATE NOCASE);

-- ── city columns (cross-entity: net?city=Amsterdam) ──────────────────────────

CREATE INDEX IF NOT EXISTS "peeringdb_organization_city_nocase_idx"
    ON "peeringdb_organization" ("city" COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS "peeringdb_facility_city_nocase_idx"
    ON "peeringdb_facility" ("city" COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS "peeringdb_ix_city_nocase_idx"
    ON "peeringdb_ix" ("city" COLLATE NOCASE);

-- ── irr_as_set (used by /api/as_set endpoint and direct net queries) ─────────

CREATE INDEX IF NOT EXISTS "peeringdb_network_irr_as_set_nocase_idx"
    ON "peeringdb_network" ("irr_as_set" COLLATE NOCASE);
