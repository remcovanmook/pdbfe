#!/bin/bash
#
# Deploy orchestration: validates, generates configs, applies migrations, and deploys
# all components in the correct order.
#
# Usage:
#   ./scripts/deploy.sh [--generate-configs] [--remote] [--apply-migrations] [--force]
#
# Flags:
#   --generate-configs    Generate wrangler toml configs and frontend config.js from
#                         .example templates using env vars. Exits after generation.
#   --remote              Deploy to production (default: local validation only)
#   --apply-migrations    Apply pending database migrations to D1
#   --force               Deploy workers even if unchanged
#
# Deploy order:
#   1. Validate generated artifacts
#   2. Apply D1 migrations (if --apply-migrations)
#   3. Deploy pdbfe-search    (if changed or --force)
#   4. Deploy pdbfe-sync      (if changed or --force)
#   5. Deploy pdbfe-api       (if changed or --force)
#   6. Deploy pdbfe-auth      (if changed or --force)
#   7. Deploy pdbfe-graphql   (if changed or --force)
#   8. Deploy pdbfe-rest      (if changed or --force)
#   9. Deploy frontend        (if --remote)
#
#
# Config generation (--generate-configs) reads from environment:
#   D1_DATABASE_ID         — D1 database ID for the peeringdb database
#   D1_USERDB_ID           — D1 database ID for the users database
#   KV_SESSIONS_ID         — Sessions KV namespace ID
#   API_DOMAIN             — Custom domain (e.g. "pdbfe.dev")
#   VECTORIZE_INDEX_NAME   — Vectorize index name (e.g. "pdbfe-vectors")
#
# For local use, put infra IDs in .env.deploy (gitignored). Format:
#   D1_DATABASE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#   D1_USERDB_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#   KV_SESSIONS_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
#   API_DOMAIN=pdbfe.dev
#   VECTORIZE_INDEX_NAME=pdbfe-vectors
#
# In CI, these come from the step env: block (GitHub secrets).
# .env (runtime secrets) is sourced first, then .env.deploy (infra IDs).

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
GENERATE_CONFIGS=""

for arg in "$@"; do
    case "$arg" in
        --remote)           REMOTE=1 ;;
        --apply-migrations) APPLY_MIGRATIONS=1 ;;
        --force)            FORCE=1 ;;
        --generate-configs) GENERATE_CONFIGS=1 ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
done

# ── Step 0: Generate configs ─────────────────────────────────────────────────
#
# Generates wrangler toml configs and frontend config.js from .example
# templates using environment variables. Called from CI before the deploy
# step. Exits immediately after generation so callers can keep steps separate.

if [[ -n "$GENERATE_CONFIGS" ]]; then
    section "Generate Configs"

    # Source .env from repo root if present (runtime secrets).
    # Then source .env.deploy if present (infra IDs: D1, KV, domain).
    # In CI the values come from the step's env: block instead.
    for envfile in "$REPO_ROOT/.env" "$REPO_ROOT/.env.deploy"; do
        if [[ -f "$envfile" ]]; then
            set -o allexport
            # shellcheck source=/dev/null
            source "$envfile"
            set +o allexport
        fi
    done

    # Allow WORKERS_DOMAIN as an alias for API_DOMAIN (matches local .env convention)
    API_DOMAIN="${API_DOMAIN:-${WORKERS_DOMAIN:-}}"

    # Validate required env vars
    for var in D1_DATABASE_ID D1_USERDB_ID KV_SESSIONS_ID API_DOMAIN; do
        if [[ -z "${!var:-}" ]]; then
            fail "Required env var '$var' is not set for --generate-configs"
        fi
    done

    PDBFE_VERSION="$(cat "$REPO_ROOT/VERSION" | tr -d '[:space:]')"
    VECTORIZE_INDEX_NAME="${VECTORIZE_INDEX_NAME:-pdbfe-vectors}"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler.toml.example" > "$REPO_ROOT/workers/wrangler.toml"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        -e "s|<your-vectorize-index-name>|${VECTORIZE_INDEX_NAME}|g" \
        "$REPO_ROOT/workers/wrangler-sync.toml.example" > "$REPO_ROOT/workers/wrangler-sync.toml"

    sed \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler-auth.toml.example" > "$REPO_ROOT/workers/wrangler-auth.toml"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler-graphql.toml.example" > "$REPO_ROOT/workers/wrangler-graphql.toml"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler-rest.toml.example" > "$REPO_ROOT/workers/wrangler-rest.toml"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        -e "s|<your-vectorize-index-name>|${VECTORIZE_INDEX_NAME}|g" \
        "$REPO_ROOT/workers/wrangler-search.toml.example" > "$REPO_ROOT/workers/wrangler-search.toml"

    # Frontend config — all origins derive from API_DOMAIN
    sed \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        "$REPO_ROOT/frontend/js/config.js.example" > "$REPO_ROOT/frontend/js/config.js"

    pass "Configs generated (version ${PDBFE_VERSION}, domain ${API_DOMAIN})"
    exit 0
fi

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

# Use PYTHON from env, .venv if available, or system python
PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
    if [[ -x "$REPO_ROOT/.venv/bin/python" ]]; then
        PYTHON="$REPO_ROOT/.venv/bin/python"
    else
        PYTHON="python"
    fi
fi

# Check generated artifacts are fresh
"$PYTHON" "$SCRIPT_DIR/parse_django_models.py" 2>&1
"$PYTHON" "$SCRIPT_DIR/gen_graphql_schema.py" 2>&1
"$PYTHON" "$SCRIPT_DIR/gen_openapi_spec.py" 2>&1
pass "Pipeline up to date"
# Run integration tests
"$SCRIPT_DIR/test.sh" 2>&1 || fail "Python scripts tests failed"

# Run downstream frontend and worker validation against newly generated artifacts
if [[ -d "$REPO_ROOT/workers/node_modules" ]]; then
    echo "  Validating workers..."
    (cd "$REPO_ROOT/workers" && npm run typecheck && npm test && npm run test:integration) > /dev/null 2>&1 || fail "Worker validation or integration tests failed"
else
    warn "Skipping worker local validation: no node_modules found. Run 'npm install' in workers/"
fi

if [[ -d "$REPO_ROOT/frontend/node_modules" ]] || [[ -d "$REPO_ROOT/workers/node_modules" ]]; then
    # Frontend logic typecheck (can pull from worker node_modules depending on setup)
    echo "  Validating frontend..."
    (cd "$REPO_ROOT/frontend" && npm run typecheck && npm run test:unit) > /dev/null 2>&1 || fail "Frontend validation failed"
fi

pass "All validation and integration tests passed"



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
            npx wrangler d1 execute peeringdb \
                --config "$WRANGLER_CONFIG" $D1_REMOTE \
                --file "$MIGRATION_FILE" \
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
    "wrangler-search.toml:search"
    "wrangler-sync.toml:sync"
    "wrangler.toml:api"
    "wrangler-auth.toml:auth"
    "wrangler-graphql.toml:graphql"
    "wrangler-rest.toml:rest"
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

    # Compute source hash for change detection and post-deploy recording
    MAIN_FILE=$(grep '^main' "$CONFIG_PATH" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
    WORKER_DIR="$REPO_ROOT/workers/$(dirname "$MAIN_FILE")"

    LOCAL_HASH=$( {
        find "$WORKER_DIR" "$REPO_ROOT/workers/core" -type f -name '*.js' | grep -v node_modules | sort
        echo "$REPO_ROOT/extracted/entities.json"
        echo "$REPO_ROOT/extracted/entities-worker.js"
        echo "$REPO_ROOT/workers/package-lock.json"
    } | xargs cat 2>/dev/null | shasum -a 256 | awk '{print $1}' )

    # Skip deploy if source hasn't changed (unless --force)
    if [[ -z "$FORCE" ]]; then
        HASH_FILE="$REPO_ROOT/.wrangler/.deploy-hash-$LABEL"
        if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" == "$LOCAL_HASH" ]]; then
            pass "pdbfe-$LABEL unchanged, skipping"
            continue
        fi
    fi

    echo "  Deploying pdbfe-$LABEL..."
    npx wrangler deploy --config "$CONFIG_PATH" $WRANGLER_REMOTE 2>&1 || \
        fail "Failed to deploy pdbfe-$LABEL"

    # Store hash for future comparison
    if [[ -n "$REMOTE" ]]; then
        mkdir -p "$REPO_ROOT/.wrangler"
        echo "$LOCAL_HASH" > "$REPO_ROOT/.wrangler/.deploy-hash-$LABEL"
    fi

    pass "Deployed pdbfe-$LABEL"
done

# ── Step 4: Frontend ────────────────────────────────────────────────────────

section "Frontend"

if [[ -n "$REMOTE" ]]; then
    echo "  Deploying frontend to Cloudflare Pages..."
    npx wrangler pages deploy "$REPO_ROOT/frontend/" --project-name=pdbfe-frontend 2>&1 || \
        fail "Frontend deploy failed"
    pass "Frontend deployed"
else
    warn "Skipping frontend deploy (local mode)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

section "Complete"
pass "All steps finished"
exit 0
