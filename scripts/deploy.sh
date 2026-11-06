#!/bin/bash
#
# Deploy orchestration: validates, generates configs, applies migrations, and deploys
# all components in the correct order.
#
# Usage:
#   ./scripts/deploy.sh [--generate-configs] [--remote] [--apply-migrations] [--force] [--skip-validation]
#
# Flags:
#   --generate-configs    Generate wrangler toml configs and frontend config.js from
#                         .example templates using env vars. Exits after generation.
#   --remote              Deploy to production (default: local validation only)
#   --apply-migrations    Apply pending database migrations to D1
#   --force               Deploy every component even if its build is unchanged
#   --skip-validation     Skip the pipeline and test run. For the Release workflow:
#                         main only takes PRs whose required checks passed on a
#                         tree up to date with main, so it was already validated,
#                         and re-running parse_django_models.py at release time
#                         would regenerate the schema from whatever upstream has
#                         published since — an unreviewed schema, with no migration.
#
# Deploy order:
#   1. Validate generated artifacts (unless --skip-validation)
#   2. Apply D1 migrations (if --apply-migrations)
#   3. Deploy pdbfe-async    (if changed or --force)  — consumer before producer
#   4. Deploy pdbfe-search    (if changed or --force)
#   5. Deploy pdbfe-sync      (if changed or --force)
#   6. Deploy pdbfe-api       (if changed or --force)
#   7. Deploy pdbfe-auth      (if changed or --force)
#   8. Deploy pdbfe-graphql   (if changed or --force)
#   9. Deploy pdbfe-rest      (if changed or --force)
#  10. Deploy frontend        (if changed or --force)
#
# "Changed" compares a hash of what would be uploaded with the hash recorded on
# the live deployment: the bundle wrangler builds plus the generated config
# minus its PDBFE_VERSION line for a worker (stored as the version's --tag),
# the built frontend for Pages (stored in the deployment's commit message).
# The record lives in Cloudflare, so a fresh CI runner, a local deploy and a
# release that failed halfway all compare against what is actually running.
# Skipping an unchanged worker keeps its version, so its edge cache entries
# (per version, cross_version_cache off) stay warm. A failed lookup deploys.
#
# Config generation (--generate-configs) reads from environment:
#   D1_DATABASE_ID         — D1 database ID for the peeringdb database
#   D1_USERDB_ID           — D1 database ID for the users database
#   KV_SESSIONS_ID         — Sessions KV namespace ID
#   API_DOMAIN             — Custom domain (e.g. "pdbfe.dev")
#   VECTORIZE_INDEX_NAME   — Vectorize index name (e.g. "pdbfe-vectors")
#   API_DOMAIN_ALIASES     — Optional: other domains (zones in the same account)
#                            the API workers also answer on, comma-separated
#                            (e.g. "pdbedge.com"): api./rest./graphql. routes
#                            are added for each. Not auth (OAuth redirect URI).
#   FRONTEND_ALIASES       — Optional: other domains the frontend is published
#                            on, comma-separated origins (e.g.
#                            "https://pdbedge.com"); auth trusts them like
#                            the main frontend origin
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

# The wrangler pinned in workers/package-lock.json (npm ci), never one npx
# would fetch on demand.
WRANGLER="$REPO_ROOT/workers/node_modules/.bin/wrangler"

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
SKIP_VALIDATION=""

for arg in "$@"; do
    case "$arg" in
        --remote)           REMOTE=1 ;;
        --apply-migrations) APPLY_MIGRATIONS=1 ;;
        --force)            FORCE=1 ;;
        --generate-configs) GENERATE_CONFIGS=1 ;;
        --skip-validation)  SKIP_VALIDATION=1 ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
done

# ── Step 0: Generate configs ─────────────────────────────────────────────────
#
# Generates wrangler toml configs, frontend config.js and frontend _headers from .example
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

    # Adds a copy of every route on API_DOMAIN's zone for each domain in
    # API_DOMAIN_ALIASES (comma-separated, e.g. "pdbedge.com"), so the same
    # workers also answer on api./rest./graphql.<alias>. Rewrites the routes
    # array of a generated wrangler toml in place; no aliases, no change.
    add_alias_routes() {
        local toml="$1"
        [[ -n "${API_DOMAIN_ALIASES:-}" ]] || return 0
        awk -v main="$API_DOMAIN" -v aliases="$API_DOMAIN_ALIASES" '
            BEGIN { n_alias = split(aliases, alias, ","); gsub(/\./, "\\.", main) }
            /^routes = \[/ { in_routes = 1; n = 0; print; next }
            in_routes && /^\]/ {
                for (i = 1; i <= n; i++) printf "%s%s\n", entry[i], (i < n ? "," : "")
                in_routes = 0; print; next
            }
            in_routes {
                line = $0; sub(/,[ \t]*$/, "", line)
                if (line ~ /^[ \t]*$/) next
                entry[++n] = line
                for (a = 1; a <= n_alias; a++) {
                    d = alias[a]; gsub(/[ \t]/, "", d)
                    if (d == "") continue
                    copy = line; gsub(main, d, copy); entry[++n] = copy
                }
                next
            }
            { print }
        ' "$toml" > "$toml.tmp" && mv "$toml.tmp" "$toml"
    }

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler.toml.example" > "$REPO_ROOT/workers/wrangler.toml"
    add_alias_routes "$REPO_ROOT/workers/wrangler.toml"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler-sync.toml.example" > "$REPO_ROOT/workers/wrangler-sync.toml"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-vectorize-index-name>|${VECTORIZE_INDEX_NAME}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler-async.toml.example" > "$REPO_ROOT/workers/wrangler-async.toml"

    sed \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-frontend-aliases>|${FRONTEND_ALIASES:-}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler-auth.toml.example" > "$REPO_ROOT/workers/wrangler-auth.toml"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler-graphql.toml.example" > "$REPO_ROOT/workers/wrangler-graphql.toml"
    add_alias_routes "$REPO_ROOT/workers/wrangler-graphql.toml"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        "$REPO_ROOT/workers/wrangler-rest.toml.example" > "$REPO_ROOT/workers/wrangler-rest.toml"
    add_alias_routes "$REPO_ROOT/workers/wrangler-rest.toml"

    sed \
        -e "s|<your-d1-database-id>|${D1_DATABASE_ID}|" \
        -e "s|<your-sessions-kv-namespace-id>|${KV_SESSIONS_ID}|" \
        -e "s|<your-users-d1-database-id>|${D1_USERDB_ID}|" \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        -e "s|<your-version>|${PDBFE_VERSION}|g" \
        -e "s|<your-vectorize-index-name>|${VECTORIZE_INDEX_NAME}|g" \
        "$REPO_ROOT/workers/wrangler-search.toml.example" > "$REPO_ROOT/workers/wrangler-search.toml"
    add_alias_routes "$REPO_ROOT/workers/wrangler-search.toml"

    # Frontend config — all origins derive from API_DOMAIN
    sed \
        -e "s|<your-domain>|${API_DOMAIN}|g" \
        "$REPO_ROOT/frontend/js/config.js.example" > "$REPO_ROOT/frontend/js/config.js"

    # Pages response headers (no placeholders; generated so the deployed file
    # stays gitignored like the other configs)
    cp "$REPO_ROOT/frontend/_headers.example" "$REPO_ROOT/frontend/_headers"

    pass "Configs generated (version ${PDBFE_VERSION}, domain ${API_DOMAIN})"
    exit 0
fi

if [[ -n "$REMOTE" ]]; then
    D1_REMOTE="--remote"
    echo "Mode: PRODUCTION"
else
    D1_REMOTE="--local"
    echo "Mode: LOCAL (use --remote for production)"
fi

# ── Step 1: Validate ────────────────────────────────────────────────────────

section "Validation"

if [[ -n "$SKIP_VALIDATION" ]]; then
    warn "Skipping validation (--skip-validation)"
else
    # Use PYTHON from env, scripts/.venv if available, repo-root .venv, or system python
    PYTHON="${PYTHON:-}"
    if [[ -z "$PYTHON" ]]; then
        if [[ -x "$SCRIPT_DIR/.venv/bin/python" ]]; then
            PYTHON="$SCRIPT_DIR/.venv/bin/python"
        elif [[ -x "$REPO_ROOT/.venv/bin/python" ]]; then
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
fi

# ── Step 2: Migrations ──────────────────────────────────────────────────────

section "Migrations"

MIGRATIONS_DIR="$REPO_ROOT/database/migrations"
WRANGLER_CONFIG="$REPO_ROOT/workers/wrangler.toml"

if [[ -n "$APPLY_MIGRATIONS" ]]; then
    if [[ ! -d "$MIGRATIONS_DIR" ]] || [[ -z "$(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null)" ]]; then
        pass "No migration files found"
    else
        # Ensure _migrations table exists and list what is applied, in one call
        # rather than one round trip per migration file.
        APPLIED_LIST=$("$WRANGLER" d1 execute peeringdb \
            --config "$WRANGLER_CONFIG" $D1_REMOTE --json \
            --command 'CREATE TABLE IF NOT EXISTS "_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "applied_at" TEXT NOT NULL DEFAULT (datetime('"'"'now'"'"'))); SELECT name FROM "_migrations";' \
            2>/dev/null | node -e '
                let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
                    const r = JSON.parse(s);
                    for (const row of r[r.length - 1].results) console.log(row.name);
                });') || fail "Could not list applied migrations"

        for MIGRATION_FILE in "$MIGRATIONS_DIR"/*.sql; do
            MIGRATION_NAME="$(basename "$MIGRATION_FILE")"

            if grep -qxF "$MIGRATION_NAME" <<< "$APPLIED_LIST"; then
                pass "Already applied: $MIGRATION_NAME"
                continue
            fi

            echo "  Applying: $MIGRATION_NAME"
            "$WRANGLER" d1 execute peeringdb \
                --config "$WRANGLER_CONFIG" $D1_REMOTE \
                --file "$MIGRATION_FILE" \
                2>&1 || fail "Migration failed: $MIGRATION_NAME"

            # Record as applied
            "$WRANGLER" d1 execute peeringdb \
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

# Cloudflare API access for the build-hash lookups. The account id comes from
# the env (CI secret) or, locally, from wrangler's login.
CF_API="https://api.cloudflare.com/client/v4/accounts"
if [[ -n "$REMOTE" ]] && [[ -z "$FORCE" ]] && [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    CLOUDFLARE_ACCOUNT_ID=$("$WRANGLER" whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)
fi

# GET a Cloudflare API path and print the value at a key path in its `result`
# (cf_get <path> <key>...); prints nothing on any failure, which callers treat
# as "deploy".
cf_get() {
    [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || return 0
    local path="$1"; shift
    curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$CF_API/$CLOUDFLARE_ACCOUNT_ID/$path" 2>/dev/null |
        node -e '
            let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
                try {
                    let v = JSON.parse(s).result;
                    for (const k of process.argv.slice(1)) v = v?.[k];
                    console.log(v ?? "");
                } catch {}
            });' "$@" || true
}

# Build hash recorded on a worker's live version (its --tag), or empty.
deployed_worker_tag() {
    local script="$1" version
    version=$(cf_get "workers/scripts/$script/deployments" deployments 0 versions 0 version_id)
    [[ -n "$version" ]] || return 0
    cf_get "workers/scripts/$script/versions/$version" annotations workers/tag
}

# sha256 of every file under a directory, except wrangler's README (build
# timestamp) and source maps (absolute sourceRoot), in path order.
hash_build() {
    local dir="$1"
    (cd "$dir" && find . -type f ! -name README.md ! -name '*.map' | LC_ALL=C sort | xargs shasum -a 256) |
        shasum -a 256 | awk '{print $1}'
}

# Worker configs and their source directories
declare -a WORKERS=(
    "wrangler-async.toml:async"
    "wrangler-search.toml:search"
    "wrangler-sync.toml:sync"
    "wrangler.toml:api"
    "wrangler-auth.toml:auth"
    "wrangler-graphql.toml:graphql"
    "wrangler-rest.toml:rest"
)

BUILD_ROOT="$REPO_ROOT/.wrangler/build"

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

    # Hash what would be uploaded: the bundle (wrangler resolves every import,
    # including ../api/ and ../core/ and npm deps) plus the config without its
    # PDBFE_VERSION line, which changes every release.
    OUT="$BUILD_ROOT/$LABEL"
    rm -rf "${BUILD_ROOT:?}/${LABEL:?}"
    (cd "$REPO_ROOT/workers" && "$WRANGLER" deploy --config "$CONFIG_PATH" --dry-run --outdir "$OUT" > /dev/null 2>&1) || \
        fail "Failed to build pdbfe-$LABEL"
    grep -v '^PDBFE_VERSION' "$CONFIG_PATH" > "$OUT/config.toml"
    BUILD_HASH="$(hash_build "$OUT" | cut -c1-16)"

    if [[ -z "$FORCE" ]] && [[ "$(deployed_worker_tag "pdbfe-$LABEL")" == "$BUILD_HASH" ]]; then
        pass "pdbfe-$LABEL unchanged ($BUILD_HASH), skipping"
        continue
    fi

    echo "  Deploying pdbfe-$LABEL ($BUILD_HASH)..."
    (cd "$REPO_ROOT/workers" && "$WRANGLER" deploy --config "$CONFIG_PATH" --tag "$BUILD_HASH" 2>&1) || \
        fail "Failed to deploy pdbfe-$LABEL"

    pass "Deployed pdbfe-$LABEL"
done

# ── Step 4: Frontend ────────────────────────────────────────────────────────

section "Frontend"

if [[ -n "$REMOTE" ]]; then
    # Deploy a copy with ?v=<version> on every /js and /css URL, so those can
    # be served immutable (see scripts/version_frontend.js). The working tree
    # keeps plain URLs for local dev and e2e.
    FRONTEND_DIST="$REPO_ROOT/.wrangler/frontend-dist"
    PDBFE_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"

    # The change check builds once more with a fixed version, as every URL
    # carries the version and would differ each release.
    node "$REPO_ROOT/scripts/version_frontend.js" "$BUILD_ROOT/frontend" 0 > /dev/null || \
        fail "Frontend versioning failed"
    BUILD_HASH="$(hash_build "$BUILD_ROOT/frontend" | cut -c1-16)"
    DEPLOYED_MESSAGE="$(cf_get pages/projects/pdbfe-frontend canonical_deployment deployment_trigger metadata commit_message)"

    if [[ -z "$FORCE" ]] && [[ "$DEPLOYED_MESSAGE" == "build:$BUILD_HASH "* ]]; then
        pass "Frontend unchanged ($BUILD_HASH), skipping"
    else
        node "$REPO_ROOT/scripts/version_frontend.js" "$FRONTEND_DIST" "$PDBFE_VERSION" || \
            fail "Frontend versioning failed"

        echo "  Deploying frontend to Cloudflare Pages ($BUILD_HASH)..."
        (cd "$REPO_ROOT/workers" && "$WRANGLER" pages deploy "$FRONTEND_DIST/" --project-name=pdbfe-frontend \
            --commit-message "build:$BUILD_HASH v$PDBFE_VERSION $(git -C "$REPO_ROOT" log -1 --format=%s)" 2>&1) || \
            fail "Frontend deploy failed"
        pass "Frontend deployed"
    fi
else
    warn "Skipping frontend deploy (local mode)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

section "Complete"
pass "All steps finished"
exit 0
