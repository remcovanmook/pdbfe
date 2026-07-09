"""
Tests for diff_schema.py — in particular the migration-coverage check
that gates schema changes in CI (a regenerated schema.sql that adds
columns must ship with a migration, or existing databases 500).
"""

import unittest

from diff_schema import (
    parse_migration_additions,
    required_additions,
    uncovered_additions,
)


# Minimal schema.sql fixtures (only the shape parse_schema needs).
BASE_SCHEMA = '''
CREATE TABLE IF NOT EXISTS "peeringdb_network" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "ixp_update_exclude" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "peeringdb_organization" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT ''
);
'''

# Adds three columns to peeringdb_network — mirrors the 2.80.1 refresh
# that caused the production incident.
SCHEMA_WITH_NEW_COLUMNS = '''
CREATE TABLE IF NOT EXISTS "peeringdb_network" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "ixp_update_exclude" TEXT NOT NULL DEFAULT '',
    "ixp_update_exclude_speed" BOOL NOT NULL DEFAULT 0,
    "ixp_update_exclude_is_rs_peer" BOOL NOT NULL DEFAULT 0,
    "ixp_update_exclude_operational" BOOL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "peeringdb_organization" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT ''
);
'''

# Adds a whole new table.
SCHEMA_WITH_NEW_TABLE = BASE_SCHEMA + '''
CREATE TABLE IF NOT EXISTS "peeringdb_campus" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT ''
);
'''

COVERING_MIGRATION = '''
ALTER TABLE "peeringdb_network" ADD COLUMN "ixp_update_exclude_speed" BOOL NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network" ADD COLUMN "ixp_update_exclude_is_rs_peer" BOOL NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network" ADD COLUMN "ixp_update_exclude_operational" BOOL NOT NULL DEFAULT 0;
'''

PARTIAL_MIGRATION = '''
ALTER TABLE "peeringdb_network" ADD COLUMN "ixp_update_exclude_speed" BOOL NOT NULL DEFAULT 0;
'''


class TestParseMigrationAdditions(unittest.TestCase):
    def test_parses_add_column(self):
        tables, cols = parse_migration_additions([COVERING_MIGRATION])
        self.assertEqual(tables, set())
        self.assertIn(("peeringdb_network", "ixp_update_exclude_speed"), cols)
        self.assertEqual(len(cols), 3)

    def test_parses_create_table_with_and_without_if_not_exists(self):
        tables, _ = parse_migration_additions([
            'CREATE TABLE IF NOT EXISTS "a" ("id" INTEGER);',
            'CREATE TABLE "b" ("id" INTEGER);',
        ])
        self.assertEqual(tables, {"a", "b"})


class TestRequiredAdditions(unittest.TestCase):
    def test_new_columns_detected(self):
        tables, cols = required_additions(BASE_SCHEMA, SCHEMA_WITH_NEW_COLUMNS)
        self.assertEqual(tables, set())
        self.assertEqual(cols, {
            ("peeringdb_network", "ixp_update_exclude_speed"),
            ("peeringdb_network", "ixp_update_exclude_is_rs_peer"),
            ("peeringdb_network", "ixp_update_exclude_operational"),
        })

    def test_new_table_detected(self):
        tables, cols = required_additions(BASE_SCHEMA, SCHEMA_WITH_NEW_TABLE)
        self.assertEqual(tables, {"peeringdb_campus"})
        self.assertEqual(cols, set())

    def test_no_change(self):
        tables, cols = required_additions(BASE_SCHEMA, BASE_SCHEMA)
        self.assertEqual(tables, set())
        self.assertEqual(cols, set())


class TestUncoveredAdditions(unittest.TestCase):
    def test_columns_fully_covered(self):
        missing_t, missing_c = uncovered_additions(
            BASE_SCHEMA, SCHEMA_WITH_NEW_COLUMNS, [COVERING_MIGRATION])
        self.assertEqual(missing_t, set())
        self.assertEqual(missing_c, set())

    def test_columns_with_no_migration_are_flagged(self):
        # The exact incident: schema gained columns, no migration.
        missing_t, missing_c = uncovered_additions(
            BASE_SCHEMA, SCHEMA_WITH_NEW_COLUMNS, [])
        self.assertEqual(missing_t, set())
        self.assertEqual(len(missing_c), 3)
        self.assertIn(("peeringdb_network", "ixp_update_exclude_speed"), missing_c)

    def test_partial_migration_flags_the_rest(self):
        missing_t, missing_c = uncovered_additions(
            BASE_SCHEMA, SCHEMA_WITH_NEW_COLUMNS, [PARTIAL_MIGRATION])
        self.assertEqual(missing_t, set())
        self.assertEqual(missing_c, {
            ("peeringdb_network", "ixp_update_exclude_is_rs_peer"),
            ("peeringdb_network", "ixp_update_exclude_operational"),
        })

    def test_new_table_covered_by_create(self):
        migration = 'CREATE TABLE IF NOT EXISTS "peeringdb_campus" ("id" INTEGER, "name" TEXT);'
        missing_t, missing_c = uncovered_additions(
            BASE_SCHEMA, SCHEMA_WITH_NEW_TABLE, [migration])
        self.assertEqual(missing_t, set())
        self.assertEqual(missing_c, set())

    def test_new_table_without_migration_is_flagged(self):
        missing_t, missing_c = uncovered_additions(
            BASE_SCHEMA, SCHEMA_WITH_NEW_TABLE, [])
        self.assertEqual(missing_t, {"peeringdb_campus"})

    def test_no_change_is_clean(self):
        missing_t, missing_c = uncovered_additions(BASE_SCHEMA, BASE_SCHEMA, [])
        self.assertEqual(missing_t, set())
        self.assertEqual(missing_c, set())


if __name__ == "__main__":
    unittest.main()
