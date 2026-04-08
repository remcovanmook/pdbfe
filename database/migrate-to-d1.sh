#!/usr/bin/env bash
# migrate-to-d1.sh — Populate a Cloudflare D1 database from PeeringDB JSON dumps.
#
# Reads entity JSON files from database/ (downloaded from public.peeringdb.com),
# converts them to INSERT statements via json_to_sql.py, and bulk-loads into D1.
#
# Prerequisites:
#   - wrangler CLI installed and authenticated
#   - D1 database already created (wrangler d1 create peeringdb)
#   - python3 available
#   - JSON files in database/ (download with --fetch, or manually via curl)
#
# Usage:
#   ./database/migrate-to-d1.sh [--remote] [--fetch]
#
# --remote   Push to production D1 (default: local dev database)
# --fetch    Download fresh JSON dumps from public.peeringdb.com before importing.

set -euo pipefail

# Work around root-owned files in ~/.npm by using a local cache
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$(cd "$(dirname "$0")/.." && pwd)/workers/.npm-cache}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SCHEMA_SQL="$SCRIPT_DIR/schema.sql"
WRANGLER_CONFIG="$REPO_ROOT/workers/wrangler.toml"
PUBLIC_BASE="https://public.peeringdb.com"
JSON_TO_SQL="$SCRIPT_DIR/json_to_sql.py"

# Parse flags
REMOTE_FLAG=""
DO_FETCH=false
for arg in "$@"; do
    case "$arg" in
        --remote) REMOTE_FLAG="--remote" ;;
        --fetch)  DO_FETCH=true ;;
    esac
done

if [[ -n "$REMOTE_FLAG" ]]; then
    echo "==> Operating against PRODUCTION D1 database"
else
    echo "==> Operating against LOCAL D1 dev database"
fi

if [[ ! -f "$WRANGLER_CONFIG" ]]; then
    echo "ERROR: Wrangler config not found at $WRANGLER_CONFIG"
    exit 1
fi

TMPDIR_EXPORT="$REPO_ROOT/.d1-migration-tmp"
mkdir -p "$TMPDIR_EXPORT"
trap 'rm -rf "$TMPDIR_EXPORT"' EXIT



# ── Apply schema ──────────────────────────────────────────────────────────────

echo "==> Applying schema..."
npx wrangler d1 execute peeringdb \
    --config "$WRANGLER_CONFIG" \
    $REMOTE_FLAG \
    --yes \
    --file "$SCHEMA_SQL"

# ── Entity definitions ────────────────────────────────────────────────────────
# tag:table — columns are auto-detected from the JSON file by json_to_sql.py

ENTITIES=(
    "org:peeringdb_organization"
    "campus:peeringdb_campus"
    "fac:peeringdb_facility"
    "carrier:peeringdb_carrier"
    "ix:peeringdb_ix"
    "ixlan:peeringdb_ixlan"
    "ixpfx:peeringdb_ixlan_prefix"
    "net:peeringdb_network"
    "poc:peeringdb_network_contact"
    "netfac:peeringdb_network_facility"
    "netixlan:peeringdb_network_ixlan"
    "ixfac:peeringdb_ix_facility"
    "carrierfac:peeringdb_ix_carrier_facility"
)

# ── Download and import each entity ──────────────────────────────────────────

for ENTITY_DEF in "${ENTITIES[@]}"; do
    IFS=':' read -r TAG TABLE <<< "$ENTITY_DEF"

    JSON_FILE="$SCRIPT_DIR/${TAG}.json"

    # Optionally fetch fresh data from the public PeeringDB dumps
    if $DO_FETCH; then
        echo "==> Fetching $TAG from public.peeringdb.com..."
        curl -sf --retry 3 --retry-delay 5 --max-time 120 \
            "${PUBLIC_BASE}/${TAG}-0.json" -o "$JSON_FILE"
    fi

    if [[ ! -f "$JSON_FILE" ]]; then
        echo "ERROR: $JSON_FILE not found. Run with --fetch or download manually."
        exit 1
    fi

    EXPORT_FILE="$TMPDIR_EXPORT/${TABLE}.sql"

    echo "==> Importing $TAG..."
    python3 "$JSON_TO_SQL" "$JSON_FILE" "$TABLE" > "$EXPORT_FILE"

    ROW_COUNT=$(wc -l < "$EXPORT_FILE" | tr -d ' ')
    echo "    $ROW_COUNT rows"

    if [[ "$ROW_COUNT" -eq 0 ]]; then
        echo "    (empty, skipping)"
        continue
    fi

    # Import directly — wrangler handles internal batching for large files
    npx wrangler d1 execute peeringdb \
        --config "$WRANGLER_CONFIG" \
        $REMOTE_FLAG \
        --yes \
        --file "$EXPORT_FILE"
done

# ── Populate _sync_meta ──────────────────────────────────────────────────────

echo "==> Populating _sync_meta..."
SYNC_FILE="$TMPDIR_EXPORT/sync_meta.sql"
> "$SYNC_FILE"

for ENTITY_DEF in "${ENTITIES[@]}"; do
    IFS=':' read -r TAG TABLE _ <<< "$ENTITY_DEF"
    JSON_FILE="$SCRIPT_DIR/${TAG}.json"
    ROW_COUNT=$(python3 -c "import json; print(len(json.load(open('$JSON_FILE')).get('data',[])))")
    echo "INSERT OR REPLACE INTO _sync_meta (entity, last_sync, row_count, updated_at) VALUES ('${TAG}', strftime('%s','now'), ${ROW_COUNT}, datetime('now'));" >> "$SYNC_FILE"
done

npx wrangler d1 execute peeringdb \
    --config "$WRANGLER_CONFIG" \
    $REMOTE_FLAG \
    --yes \
    --file "$SYNC_FILE"

echo "==> Migration complete."
