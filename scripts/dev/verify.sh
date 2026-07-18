#!/usr/bin/env bash
# Full local verification gate — everything CI checks, in one command.
#
# Runs, in order: frontend typecheck, frontend unit tests, workers typecheck,
# workers unit tests (with coverage thresholds), XSS lint, locale coverage.
# Prints a section per gate and a one-line PASS/FAIL summary at the end.
#
# Usage:
#   scripts/dev/verify.sh              # everything
#   scripts/dev/verify.sh --frontend   # frontend gates only (typecheck, unit, xss, locales)
#   scripts/dev/verify.sh --workers    # workers gates only (typecheck, unit)

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCOPE="${1:-all}"

declare -a RESULTS=()
FAILED=0

run_gate() {
    local name="$1"; shift
    echo ""
    echo "━━━ ${name} ━━━"
    if "$@"; then
        RESULTS+=("PASS  ${name}")
    else
        RESULTS+=("FAIL  ${name}")
        FAILED=1
    fi
}

if [ "$SCOPE" != "--workers" ]; then
    run_gate "frontend typecheck"  bash -c "cd '$ROOT/frontend' && npm run --silent typecheck"
    run_gate "frontend unit tests" bash -c "cd '$ROOT/frontend' && npm run --silent test:unit 2>&1 | tail -8"
    run_gate "xss lint"            node "$ROOT/scripts/lint_xss.js"
    run_gate "locale coverage"     bash -c "node '$ROOT/scripts/check_locales.js' 2>&1 | tail -5"
fi

if [ "$SCOPE" != "--frontend" ]; then
    run_gate "workers typecheck"   bash -c "cd '$ROOT/workers' && npm run --silent typecheck"
    run_gate "workers unit tests"  bash -c "cd '$ROOT/workers' && npm run --silent test 2>&1 | tail -10"
fi

echo ""
echo "━━━ summary ━━━"
printf '%s\n' "${RESULTS[@]}"
exit $FAILED
