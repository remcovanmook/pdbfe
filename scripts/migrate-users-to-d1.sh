#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# migrate-users-to-d1.sh — One-time migration from USERS KV to USERDB D1.
#
# Reads user records and API key reverse indexes from the pdbfe-users KV
# namespace and inserts them into the pdbfe-users D1 database.
#
# Prerequisites:
#   1. D1 database created:   npx wrangler d1 create pdbfe-users
#   2. Schema bootstrapped:   npx wrangler d1 execute pdbfe-users --file=../database/users/schema.sql --remote
#   3. npx wrangler authenticated, run from repo root
#
# Usage:
#   ./scripts/migrate-users-to-d1.sh [--dry-run]
#
# The --dry-run flag prints SQL statements without executing them.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

KV_NAMESPACE_ID="cfc99bea69eb415584e5b62542c1efd4"  # pdbfe-users KV
D1_DATABASE="pdbfe-users"
DRY_RUN=false

# Resolve repo root relative to this script's location, then cd to workers/
# so that npx wrangler can find wrangler.toml with the D1 binding.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKERS_DIR="$REPO_ROOT/workers"

if [[ ! -f "$WORKERS_DIR/wrangler.toml" ]]; then
    echo "ERROR: wrangler.toml not found at $WORKERS_DIR/wrangler.toml"
    exit 1
fi

cd "$WORKERS_DIR"

if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "=== DRY RUN MODE — no D1 writes will be made ==="
fi

# ── Step 1: List all user:* keys ──────────────────────────────────────────────

echo "Fetching user keys from KV namespace ${KV_NAMESPACE_ID} (remote)..."
USER_KEYS=$(npx wrangler kv key list --namespace-id="$KV_NAMESPACE_ID" --prefix="user:" --remote 2>/dev/null | jq -r '.[].name')

USER_COUNT=0
KEY_COUNT=0

for USER_KEY in $USER_KEYS; do
    USER_ID="${USER_KEY#user:}"
    echo "Processing user ${USER_ID}..."

    # Fetch the user record JSON from KV (remote)
    USER_JSON=$(npx wrangler kv key get --namespace-id="$KV_NAMESPACE_ID" "$USER_KEY" --remote 2>/dev/null)

    # Extract fields
    NAME=$(echo "$USER_JSON" | jq -r '.name // ""')
    EMAIL=$(echo "$USER_JSON" | jq -r '.email // ""')
    CREATED_AT=$(echo "$USER_JSON" | jq -r '.created_at // ""')
    UPDATED_AT=$(echo "$USER_JSON" | jq -r '.updated_at // ""')

    # Build INSERT for users table
    USER_SQL="INSERT OR IGNORE INTO users (id, name, email, created_at, updated_at) VALUES (${USER_ID}, '$(echo "$NAME" | sed "s/'/''/g")', '$(echo "$EMAIL" | sed "s/'/''/g")', '${CREATED_AT}', '${UPDATED_AT}');"

    if $DRY_RUN; then
        echo "  SQL: $USER_SQL"
    else
        npx wrangler d1 execute "$D1_DATABASE" --command="$USER_SQL" --remote 2>/dev/null
    fi
    USER_COUNT=$((USER_COUNT + 1))

    # Extract and migrate API keys from the user record's api_keys array
    API_KEYS_JSON=$(echo "$USER_JSON" | jq -c '.api_keys // []')
    NUM_KEYS=$(echo "$API_KEYS_JSON" | jq 'length')

    for i in $(seq 0 $((NUM_KEYS - 1))); do
        KEY_META=$(echo "$API_KEYS_JSON" | jq -c ".[$i]")
        KEY_ID=$(echo "$KEY_META" | jq -r '.id')
        LABEL=$(echo "$KEY_META" | jq -r '.label // "Unnamed key"')
        PREFIX=$(echo "$KEY_META" | jq -r '.prefix')
        HASH=$(echo "$KEY_META" | jq -r '.hash')
        KEY_CREATED=$(echo "$KEY_META" | jq -r '.created_at')

        KEY_SQL="INSERT OR IGNORE INTO api_keys (key_id, user_id, label, prefix, hash, created_at) VALUES ('${KEY_ID}', ${USER_ID}, '$(echo "$LABEL" | sed "s/'/''/g")', '${PREFIX}', '${HASH}', '${KEY_CREATED}');"

        if $DRY_RUN; then
            echo "  SQL: $KEY_SQL"
        else
            npx wrangler d1 execute "$D1_DATABASE" --command="$KEY_SQL" --remote 2>/dev/null
        fi
        KEY_COUNT=$((KEY_COUNT + 1))
    done
done

echo ""
echo "=== Migration complete ==="
echo "Users migrated:    ${USER_COUNT}"
echo "API keys migrated: ${KEY_COUNT}"

if $DRY_RUN; then
    echo ""
    echo "This was a dry run. Re-run without --dry-run to apply."
else
    echo ""
    echo "Verify with (from workers/ directory):"
    echo "  npx wrangler d1 execute $D1_DATABASE --command=\"SELECT COUNT(*) FROM users;\" --remote"
    echo "  npx wrangler d1 execute $D1_DATABASE --command=\"SELECT COUNT(*) FROM api_keys;\" --remote"
    echo ""
    echo "Once verified, the USERS KV namespace ($KV_NAMESPACE_ID) can be deleted."
fi
