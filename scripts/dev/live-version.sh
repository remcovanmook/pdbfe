#!/usr/bin/env bash
# Reports the live X-PDBFE-Version of every production worker and compares
# against the latest git tag — one command to answer "what's actually
# deployed, and does it match the release?"
#
# Usage: scripts/dev/live-version.sh

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOMAIN="${PDBFE_DOMAIN:-pdbfe.dev}"

cd "$ROOT"
git fetch --tags --quiet 2>/dev/null || true
LATEST_TAG="$(git tag --list 'v*' --sort=-v:refname | head -1)"
EXPECT="${LATEST_TAG#v}"

echo "latest tag: ${LATEST_TAG:-<none>}"
echo ""

MISMATCH=0
for host in "api.${DOMAIN}" "rest.${DOMAIN}" "auth.${DOMAIN}"; do
    v=$(curl -s -m 8 -D - "https://${host}/health" -o /dev/null 2>/dev/null \
        | grep -i "^x-pdbfe-version:" | tr -d '\r' | awk '{print $2}')
    if [ -z "$v" ]; then
        v=$(curl -s -m 8 -D - "https://${host}/" -o /dev/null 2>/dev/null \
            | grep -i "^x-pdbfe-version:" | tr -d '\r' | awk '{print $2}')
    fi
    if [ "$v" = "$EXPECT" ]; then
        printf "%-20s %-10s ✓\n" "$host" "${v:-<none>}"
    else
        printf "%-20s %-10s ✗ (expected %s)\n" "$host" "${v:-<none>}" "$EXPECT"
        MISMATCH=1
    fi
done

# Frontend sits behind Cloudflare Access — a 302 to the Access login is the
# healthy signature for an unauthenticated probe.
code=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "https://${DOMAIN}/")
loc=$(curl -s -m 8 -D - "https://${DOMAIN}/" -o /dev/null 2>/dev/null | grep -i "^location:" | grep -c "cloudflareaccess.com")
if [ "$code" = "302" ] && [ "$loc" = "1" ]; then
    printf "%-20s %-10s ✓ (302 → CF Access, expected)\n" "$DOMAIN" "n/a"
else
    printf "%-20s HTTP %-5s ✗ (expected 302 → CF Access)\n" "$DOMAIN" "$code"
    MISMATCH=1
fi

exit $MISMATCH
