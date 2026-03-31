#!/usr/bin/env bash
# migrate-to-d1.sh — Populate a Cloudflare D1 database from the local PeeringDB SQLite snapshot.
#
# Prerequisites:
#   - wrangler CLI installed and authenticated
#   - database/peeringdb.sqlite3 present (via peeringdb-py)
#   - D1 database already created (wrangler d1 create peeringdb)
#
# Usage:
#   ./database/migrate-to-d1.sh [--remote]
#
# Without --remote, operates against the local D1 dev database.
# With --remote, pushes to the production D1 database.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SQLITE_DB="$SCRIPT_DIR/peeringdb.sqlite3"
SCHEMA_SQL="$SCRIPT_DIR/schema.sql"
WRANGLER_CONFIG="$REPO_ROOT/workers/wrangler.toml"

REMOTE_FLAG=""
if [[ "${1:-}" == "--remote" ]]; then
    REMOTE_FLAG="--remote"
    echo "==> Operating against PRODUCTION D1 database"
else
    echo "==> Operating against LOCAL D1 dev database"
fi

if [[ ! -f "$SQLITE_DB" ]]; then
    echo "ERROR: SQLite database not found at $SQLITE_DB"
    echo "Run 'peeringdb update' first to create the local snapshot."
    exit 1
fi

if [[ ! -f "$WRANGLER_CONFIG" ]]; then
    echo "ERROR: Wrangler config not found at $WRANGLER_CONFIG"
    exit 1
fi

# Tables to export, ordered by foreign key dependencies (parents first).
TABLES=(
    peeringdb_organization
    peeringdb_campus
    peeringdb_facility
    peeringdb_carrier
    peeringdb_ix
    peeringdb_ixlan
    peeringdb_ixlan_prefix
    peeringdb_network
    peeringdb_network_contact
    peeringdb_network_facility
    peeringdb_network_ixlan
    peeringdb_ix_facility
    peeringdb_ix_carrier_facility
)

echo "==> Applying schema..."
npx wrangler d1 execute peeringdb \
    --config "$WRANGLER_CONFIG" \
    $REMOTE_FLAG \
    --file "$SCHEMA_SQL"

# Export and import each table. sqlite3 .dump produces INSERT statements
# but also includes CREATE TABLE which we skip (schema already applied).
# We use .mode insert to get pure INSERT statements.
TMPDIR_EXPORT="$REPO_ROOT/.d1-migration-tmp"
mkdir -p "$TMPDIR_EXPORT"
trap 'rm -rf "$TMPDIR_EXPORT"' EXIT

for TABLE in "${TABLES[@]}"; do
    echo "==> Exporting $TABLE..."
    EXPORT_FILE="$TMPDIR_EXPORT/${TABLE}.sql"

    # Use sqlite3 to generate INSERT statements.
    # Split into batches of 500 rows to stay within D1 statement limits.
    sqlite3 "$SQLITE_DB" ".mode insert $TABLE" "SELECT * FROM $TABLE;" > "$EXPORT_FILE"

    ROW_COUNT=$(wc -l < "$EXPORT_FILE" | tr -d ' ')
    echo "    $ROW_COUNT rows"

    if [[ "$ROW_COUNT" -eq 0 ]]; then
        echo "    (empty, skipping)"
        continue
    fi

    # Split into batches of 500 lines
    BATCH_DIR="$TMPDIR_EXPORT/${TABLE}_batches"
    mkdir -p "$BATCH_DIR"
    split -l 500 "$EXPORT_FILE" "$BATCH_DIR/batch_"

    BATCH_NUM=0
    for BATCH_FILE in "$BATCH_DIR"/batch_*; do
        BATCH_NUM=$((BATCH_NUM + 1))
        echo "    batch $BATCH_NUM ($(wc -l < "$BATCH_FILE" | tr -d ' ') rows)..."
        npx wrangler d1 execute peeringdb \
            --config "$WRANGLER_CONFIG" \
            $REMOTE_FLAG \
            --file "$BATCH_FILE"
    done
done

# Populate _sync_meta with current timestamps
echo "==> Populating _sync_meta..."
SYNC_TS=$(date +%s)
SYNC_SQL=""
for TABLE in "${TABLES[@]}"; do
    # Map table name to API entity tag
    ENTITY="${TABLE#peeringdb_}"
    ROW_COUNT=$(sqlite3 "$SQLITE_DB" "SELECT COUNT(*) FROM $TABLE;")
    SYNC_SQL="${SYNC_SQL}INSERT OR REPLACE INTO _sync_meta (entity, last_sync, row_count, updated_at) VALUES ('${ENTITY}', ${SYNC_TS}, ${ROW_COUNT}, datetime('now'));
"
done

echo "$SYNC_SQL" > "$TMPDIR_EXPORT/sync_meta.sql"
npx wrangler d1 execute peeringdb \
    --config "$WRANGLER_CONFIG" \
    $REMOTE_FLAG \
    --file "$TMPDIR_EXPORT/sync_meta.sql"

echo "==> Migration complete."
