#!/usr/bin/env python3
"""Generate a D1-compatible schema from PeeringDB API JSON dumps.

Reads each entity's JSON file, infers column types from the data, and
prints CREATE TABLE IF NOT EXISTS statements. The output replaces the
hand-maintained schema.sql.

Usage:
    python3 gen_schema.py > schema.sql
"""

import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Entity tag → table name, ordered by dependency (parents first)
ENTITIES = [
    ("org", "peeringdb_organization"),
    ("campus", "peeringdb_campus"),
    ("fac", "peeringdb_facility"),
    ("carrier", "peeringdb_carrier"),
    ("ix", "peeringdb_ix"),
    ("ixlan", "peeringdb_ixlan"),
    ("ixpfx", "peeringdb_ixlan_prefix"),
    ("net", "peeringdb_network"),
    ("poc", "peeringdb_network_contact"),
    ("netfac", "peeringdb_network_facility"),
    ("netixlan", "peeringdb_network_ixlan"),
    ("ixfac", "peeringdb_ix_facility"),
    ("carrierfac", "peeringdb_ix_carrier_facility"),
]

# Columns that should be indexed (foreign keys and common filters)
INDEX_COLS = {"org_id", "net_id", "fac_id", "ix_id", "ixlan_id", "carrier_id", "asn", "net_side_id", "ix_side_id"}


def infer_type(key, values):
    """Infer a SQL column type from a sample of JSON values.

    Inspects up to 100 non-None values to determine whether the column
    should be INTEGER, REAL, BOOL, DATETIME, or TEXT.

    Args:
        key: The JSON field name (used for heuristics like 'created').
        values: An iterable of sample values for this field.

    Returns:
        str: A SQL type string.
    """
    samples = [v for v in values if v is not None][:100]
    if not samples:
        return "TEXT"

    if all(isinstance(v, bool) for v in samples):
        return "BOOL"
    if all(isinstance(v, int) for v in samples):
        return "INTEGER"
    if all(isinstance(v, (int, float)) for v in samples):
        return "REAL"
    if all(isinstance(v, (list, dict)) for v in samples):
        return "TEXT"  # JSON stored as text

    # Datetime heuristic
    if key in ("created", "updated") or key.endswith("_updated"):
        return "DATETIME"

    return "TEXT"


def generate_schema():
    """Read all entity JSON files and print CREATE TABLE statements."""
    print("-- PeeringDB D1 Schema (auto-generated from API JSON)")
    print("-- Foreign key constraints omitted (data snapshots may be inconsistent).")
    print()

    # Sync metadata table
    print('CREATE TABLE IF NOT EXISTS "_sync_meta" (')
    print('    "entity" TEXT NOT NULL PRIMARY KEY,')
    print('    "last_sync" INTEGER NOT NULL DEFAULT 0,')
    print('    "row_count" INTEGER NOT NULL DEFAULT 0,')
    print("    \"updated_at\" TEXT NOT NULL DEFAULT ''")
    print(");")
    print()

    for tag, table in ENTITIES:
        json_path = os.path.join(SCRIPT_DIR, f"{tag}.json")
        if not os.path.exists(json_path):
            print(f"-- SKIPPED {table}: {tag}.json not found", file=sys.stderr)
            continue

        with open(json_path) as f:
            data = json.load(f)

        rows = data.get("data", [])
        if not rows:
            print(f"-- SKIPPED {table}: no data", file=sys.stderr)
            continue

        # Collect all keys in insertion order from first row
        cols = list(rows[0].keys())

        # Infer types
        col_defs = []
        for col in cols:
            samples = [row.get(col) for row in rows[:200]]
            sql_type = infer_type(col, samples)

            if col == "id":
                col_defs.append(f'    "{col}" INTEGER NOT NULL PRIMARY KEY')
            else:
                # Allow NULL with sensible defaults
                nullable = any(row.get(col) is None for row in rows[:200])
                if nullable:
                    col_defs.append(f'    "{col}" {sql_type}')
                else:
                    default = "''" if sql_type in ("TEXT", "DATETIME") else "0"
                    col_defs.append(f'    "{col}" {sql_type} NOT NULL DEFAULT {default}')

        print(f'CREATE TABLE IF NOT EXISTS "{table}" (')
        print(",\n".join(col_defs))
        print(");")

        # Indexes on FK columns
        for col in cols:
            if col in INDEX_COLS:
                idx_name = f"{table}_{col}_idx"
                print(f'CREATE INDEX IF NOT EXISTS "{idx_name}" ON "{table}" ("{col}");')

        print()

    print("-- Schema generation complete.", file=sys.stderr)


if __name__ == "__main__":
    generate_schema()
