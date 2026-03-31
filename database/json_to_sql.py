#!/usr/bin/env python3
"""Convert a PeeringDB JSON dump into INSERT statements for D1.

Reads a JSON file with the standard PeeringDB API envelope {data: [...]},
and writes one INSERT OR REPLACE statement per row to stdout. Each INSERT
is guaranteed to be a single line — embedded newlines in string values are
replaced with placeholder tokens and wrapped in SQL replace() calls.

Usage:
    python3 json_to_sql.py <json_file> <table_name> <col1,col2,...>
"""

import json
import sys


def to_sql_value(v):
    """Convert a Python value to a SQL literal string.

    Handles None, bool, int/float, list/dict (JSON text columns),
    and strings. Embedded CR/LF in strings are replaced with
    placeholder tokens so each INSERT stays on one line.

    Returns:
        str: A SQL literal ready for insertion into a VALUES clause.
    """
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (list, dict)):
        s = json.dumps(v, ensure_ascii=False).replace("'", "''")
        return "'" + s + "'"

    s = str(v).replace("'", "''")
    has_nl = "\n" in s or "\r" in s
    if has_nl:
        s = s.replace("\r\n", "{{CRLF}}").replace("\n", "{{LF}}").replace("\r", "{{CR}}")
    val = "'" + s + "'"
    if has_nl:
        val = f"replace(replace(replace({val},'{{{{CRLF}}}}',char(13,10)),'{{{{LF}}}}',char(10)),'{{{{CR}}}}',char(13))"
    return val


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <json_file> <table_name> [columns]", file=sys.stderr)
        sys.exit(1)

    json_file = sys.argv[1]
    table = sys.argv[2]

    with open(json_file) as f:
        data = json.load(f)

    rows = data.get("data", [])
    if not rows:
        print("    0 rows", file=sys.stderr)
        return

    # Auto-detect columns from the first row if not provided
    if len(sys.argv) >= 4:
        cols = sys.argv[3].split(",")
    else:
        cols = list(rows[0].keys())

    # D1 max SQL statement size is ~100KB. If a row generates a
    # statement exceeding 90KB, truncate the longest text column.
    MAX_STMT = 90_000
    skipped = 0

    for row in rows:
        vals = [to_sql_value(row.get(col)) for col in cols]
        stmt = f"INSERT OR REPLACE INTO {table} ({','.join(cols)}) VALUES ({','.join(vals)});"

        if len(stmt) > MAX_STMT:
            # Find the longest string column and truncate it
            longest_idx = max(range(len(cols)), key=lambda i: len(vals[i]))
            excess = len(stmt) - MAX_STMT + 100  # 100 bytes margin
            original = row.get(cols[longest_idx], "")
            if isinstance(original, str) and len(original) > excess:
                truncated = original[: len(original) - excess] + "...[truncated]"
                row[cols[longest_idx]] = truncated
                vals[longest_idx] = to_sql_value(truncated)
                stmt = f"INSERT OR REPLACE INTO {table} ({','.join(cols)}) VALUES ({','.join(vals)});"
                print(
                    f"    WARNING: truncated {cols[longest_idx]} for id={row.get('id')} ({len(original)}→{len(truncated)} chars)",
                    file=sys.stderr,
                )
            else:
                skipped += 1
                print(f"    WARNING: skipped id={row.get('id')} (statement {len(stmt)} bytes)", file=sys.stderr)
                continue

        print(stmt)

    print(f"    {len(rows)} rows", file=sys.stderr)


if __name__ == "__main__":
    main()
