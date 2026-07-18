#!/usr/bin/env bash
# One-shot (or polling) PR health report: GitHub checks + SonarCloud gate
# + open Sonar issues, in one command.
#
# Usage:
#   scripts/dev/pr-status.sh 104           # snapshot now
#   scripts/dev/pr-status.sh 104 --wait    # poll every 15s until checks settle
#
# SonarCloud is queried unauthenticated (public project).

set -u

PR="${1:?usage: pr-status.sh <pr-number> [--wait]}"
WAIT="${2:-}"
PROJECT="remcovanmook_pdbfe"

if [ "$WAIT" = "--wait" ]; then
    for _ in $(seq 1 60); do
        pending=$(gh pr checks "$PR" 2>/dev/null | grep -c "pending")
        [ "$pending" -eq 0 ] && break
        sleep 15
    done
fi

echo "━━━ PR #$PR ━━━"
gh pr view "$PR" --json state,mergeable,mergeStateStatus,headRefOid \
    -q '"state=\(.state)  mergeable=\(.mergeable)  mergeState=\(.mergeStateStatus)  head=\(.headRefOid[0:8])"'

echo ""
echo "━━━ checks ━━━"
gh pr checks "$PR" 2>&1 | awk -F'\t' '{printf "%-8s %s\n", $2, $1}' | sort

echo ""
echo "━━━ sonar gate ━━━"
curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=${PROJECT}&pullRequest=${PR}" \
    | python3 -c "
import sys, json
ps = json.load(sys.stdin).get('projectStatus', {})
print('gate:', ps.get('status'))
for c in ps.get('conditions', []):
    if c['status'] != 'OK':
        print('  FAIL:', c['metricKey'], 'actual=' + c.get('actualValue', '?'), 'threshold=' + c.get('errorThreshold', '?'))
"

echo ""
echo "━━━ sonar open issues ━━━"
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=${PROJECT}&pullRequest=${PR}&resolved=false&ps=30" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('total:', d.get('total'))
for i in d.get('issues', []):
    print(f\"  {i.get('severity','?'):8} {i.get('type','?'):13} {i['component'].split(':')[-1]}:{i.get('line','?')}  {i['message']}\")
"
