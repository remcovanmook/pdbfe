#!/bin/bash
#
# Deploy orchestration: validates, applies migrations, and deploys
# all components in the correct order.
#
# Usage:
#   ./scripts/deploy.sh [--remote] [--apply-migrations] [--force]
#
# Flags:
#   --remote              Deploy to production (default: local validation only)
#   --apply-migrations    Apply pending database migrations to D1
#   --force               Deploy workers even if unchanged
#
# Deploy order:
#   1. Validate generated artifacts
#   2. Apply D1 migrations (if --apply-migrations)
#   3. Deploy pdbfe-sync  (if changed or --force)
#   4. Deploy pdbfe-api   (if changed or --force)
#   5. Deploy pdbfe-auth  (if changed or --force)
#   6. Deploy frontend    (if --remote)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass()    { echo -e "${GREEN}✔${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
fail()    { echo -e "${RED}✖ $1${NC}"; exit 1; }
section() { echo -e "\n── $1 ──────────────────────────────────────"; }

# ── Parse flags ──────────────────────────────────────────────────────────────

REMOTE=""
APPLY_MIGRATIONS=""
FORCE=""

for arg in "$@"; do
    case "$arg" in
        --remote)           REMOTE=1 ;;
        --apply-migrations) APPLY_MIGRATIONS=1 ;;
        --force)            FORCE=1 ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
done

if [[ -n "$REMOTE" ]]; then
    WRANGLER_REMOTE=""
    D1_REMOTE="--remote"
    echo "Mode: PRODUCTION"
else
    WRANGLER_REMOTE="--dry-run"
    D1_REMOTE="--local"
    echo "Mode: LOCAL (use --remote for production)"
fi

# ── Step 1: Validate ────────────────────────────────────────────────────────

section "Validation"

# Check generated artifacts are fresh
"$REPO_ROOT/.venv/bin/python" "$SCRIPT_DIR/parse_django_models.py" 2>&1
pass "Pipeline up to date"

# Cross-check schema ↔ entities
node "$SCRIPT_DIR/check_schema_sync.js" 2>&1 || fail "Schema sync check failed"
pass "Schema ↔ entities consistent"

# Check for uncommitted drift in generated files
if ! git -C "$REPO_ROOT" diff --quiet extracted/ frontend/js/entities.js 2>/dev/null; then
    warn "Generated files have uncommitted changes"
fi

# ── Step 2: Migrations ──────────────────────────────────────────────────────

section "Migrations"

MIGRATIONS_DIR="$REPO_ROOT/database/migrations"
WRANGLER_CONFIG="$REPO_ROOT/workers/wrangler.toml"

if [[ -n "$APPLY_MIGRATIONS" ]]; then
    if [[ ! -d "$MIGRATIONS_DIR" ]] || [[ -z "$(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null)" ]]; then
        pass "No migration files found"
    else
        # Ensure _migrations table exists
        npx wrangler d1 execute peeringdb \
            --config "$WRANGLER_CONFIG" $D1_REMOTE \
            --command 'CREATE TABLE IF NOT EXISTS "_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "applied_at" TEXT NOT NULL DEFAULT (datetime('"'"'now'"'"')));' \
            2>&1 | grep -v "^$" || true

        for MIGRATION_FILE in "$MIGRATIONS_DIR"/*.sql; do
            MIGRATION_NAME="$(basename "$MIGRATION_FILE")"

            # Check if already applied
            APPLIED=$(npx wrangler d1 execute peeringdb \
                --config "$WRANGLER_CONFIG" $D1_REMOTE \
                --command "SELECT name FROM \"_migrations\" WHERE name = '${MIGRATION_NAME}';" \
                2>&1 | grep -c "$MIGRATION_NAME" || true)

            if [[ "$APPLIED" -gt 0 ]]; then
                pass "Already applied: $MIGRATION_NAME"
                continue
            fi

            echo "  Applying: $MIGRATION_NAME"
            MIGRATION_SQL="$(cat "$MIGRATION_FILE")"
            npx wrangler d1 execute peeringdb \
                --config "$WRANGLER_CONFIG" $D1_REMOTE \
                --command "$MIGRATION_SQL" \
                2>&1 || fail "Migration failed: $MIGRATION_NAME"

            # Record as applied
            npx wrangler d1 execute peeringdb \
                --config "$WRANGLER_CONFIG" $D1_REMOTE \
                --command "INSERT INTO \"_migrations\" (name) VALUES ('${MIGRATION_NAME}');" \
                2>&1 || true

            pass "Applied: $MIGRATION_NAME"
        done
    fi
else
    warn "Skipping migrations (use --apply-migrations to apply)"
fi

# ── Step 3: Deploy workers ──────────────────────────────────────────────────

section "Workers"

# Worker configs and their source directories
declare -a WORKERS=(
    "wrangler-sync.toml:sync"
    "wrangler.toml:api"
    "wrangler-auth.toml:auth"
)

for WORKER_DEF in "${WORKERS[@]}"; do
    IFS=':' read -r CONFIG LABEL <<< "$WORKER_DEF"
    CONFIG_PATH="$REPO_ROOT/workers/$CONFIG"

    if [[ ! -f "$CONFIG_PATH" ]]; then
        warn "Skipping pdbfe-$LABEL (no $CONFIG)"
        continue
    fi

    if [[ -z "$REMOTE" ]]; then
        warn "Skipping pdbfe-$LABEL deploy (local mode)"
        continue
    fi

    # Check if source has changed vs last deploy.
    # Uses git to detect changes since last tag or deploy marker.
    if [[ -z "$FORCE" ]]; then
        # Hash the worker source files to compare with deployed version
        WORKER_NAME=$(grep '^name' "$CONFIG_PATH" | head -1 | sed 's/.*= *"\(.*\)"/\1/')

        # Get the last deployed version ID from wrangler
        DEPLOYED_ID=$(npx wrangler deployments list \
            --config "$CONFIG_PATH" 2>/dev/null | \
            grep -m1 "Version ID:" | awk '{print $3}' || echo "")

        if [[ -n "$DEPLOYED_ID" ]]; then
            # Compute a hash of local source files for this worker
            MAIN_FILE=$(grep '^main' "$CONFIG_PATH" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
            WORKER_DIR="$REPO_ROOT/workers/$(dirname "$MAIN_FILE")"

            LOCAL_HASH=$(find "$WORKER_DIR" -name '*.js' -not -path '*/node_modules/*' | \
                sort | xargs cat | shasum -a 256 | awk '{print $1}')

            # Store/check hash (we use a simple marker file)
            HASH_FILE="$REPO_ROOT/.wrangler/.deploy-hash-$LABEL"
            if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$LOCAL_HASH" ]]; then
                pass "pdbfe-$LABEL unchanged, skipping"
                continue
            fi
        fi
    fi

    echo "  Deploying pdbfe-$LABEL..."
    npx wrangler deploy --config "$CONFIG_PATH" $WRANGLER_REMOTE 2>&1 || \
        fail "Failed to deploy pdbfe-$LABEL"

    # Store hash for future comparison
    if [[ -n "$REMOTE" ]]; then
        MAIN_FILE=$(grep '^main' "$CONFIG_PATH" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
        WORKER_DIR="$REPO_ROOT/workers/$(dirname "$MAIN_FILE")"
        LOCAL_HASH=$(find "$WORKER_DIR" -name '*.js' -not -path '*/node_modules/*' | \
            sort | xargs cat | shasum -a 256 | awk '{print $1}')
        mkdir -p "$REPO_ROOT/.wrangler"
        echo "$LOCAL_HASH" > "$REPO_ROOT/.wrangler/.deploy-hash-$LABEL"
    fi

    pass "Deployed pdbfe-$LABEL"
done

# ── Step 4: Frontend ────────────────────────────────────────────────────────

section "Frontend"

if [[ -n "$REMOTE" ]]; then
    echo "  Deploying frontend to Cloudflare Pages..."
    npx wrangler pages deploy "$REPO_ROOT/frontend/" --project-name=pdbfe 2>&1 || \
        fail "Frontend deploy failed"
    pass "Frontend deployed"
else
    warn "Skipping frontend deploy (local mode)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

section "Complete"
pass "All steps finished"
