#!/usr/bin/env python3
"""
Cold-start POC backfill.

The public JSON dumps at public.peeringdb.com only contain POC records with
visible=Public. This script fetches ALL poc records (including visible=Users
and visible=Private) from the authenticated upstream API and writes SQL
INSERT OR REPLACE statements to stdout, which are then applied to D1.

Run this immediately after migrate-to-d1.sh as part of the cold-start
bootstrap sequence. See docs/bootstrap.md for the full procedure.

Usage:
    source .env   # provides PEERINGDB_API_KEY
    python3 scripts/backfill_poc.py | \\
        npx wrangler d1 execute peeringdb --remote --yes --file /dev/stdin

Requires:
    PEERINGDB_API_KEY in environment (read-only key is sufficient)
"""

import json
import os
import sys
import urllib.request

API_KEY = os.environ.get("PEERINGDB_API_KEY", "")
if not API_KEY:
    print("ERROR: PEERINGDB_API_KEY not set", file=sys.stderr)
    sys.exit(1)

TABLE = "peeringdb_network_contact"

# Columns in the poc table, matching the D1 schema
COLUMNS = [
    "id", "status", "created", "updated",
    "role", "visible", "name", "phone", "email", "url", "net_id",
]


def sql_escape(value):
    """Escape a value for SQLite insertion."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    # String: escape single quotes
    s = str(value).replace("'", "''")
    return f"'{s}'"


def main():
    url = "https://www.peeringdb.com/api/poc?depth=0&limit=0"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Api-Key {API_KEY}",
        "Accept": "application/json",
        "User-Agent": "pdbfe-backfill/1.0",
    })

    print("Fetching all POC records from upstream...", file=sys.stderr)
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())

    rows = data.get("data", [])
    print("Fetched %d POC records" % len(rows), file=sys.stderr)

    # Filter to only non-Public records (Public ones already exist)
    missing = [r for r in rows if r.get("visible") != "Public"]
    print("Non-Public records to backfill: %d" % len(missing), file=sys.stderr)

    # Generate SQL
    col_list = ", ".join(f'"{c}"' for c in COLUMNS)
    print("BEGIN TRANSACTION;")
    for row in missing:
        values = []
        for col in COLUMNS:
            values.append(sql_escape(row.get(col)))
        val_list = ", ".join(values)
        print(f'INSERT OR REPLACE INTO "{TABLE}" ({col_list}) VALUES ({val_list});')
    print("COMMIT;")

    # Update _sync_meta row count
    total = len(rows)
    print(f'UPDATE "_sync_meta" SET row_count = {total} WHERE entity = \'poc\';')

    print(f"Generated {len(missing)} INSERT statements", file=sys.stderr)


if __name__ == "__main__":
    main()
