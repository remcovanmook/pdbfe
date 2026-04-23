#!/usr/bin/env bash
# bump_version.sh — Increment the VERSION file following semantic versioning.
#
# Usage:
#   ./scripts/bump_version.sh patch    # 0.9.0 → 0.9.1  (bug fixes)
#   ./scripts/bump_version.sh minor    # 0.9.0 → 0.10.0 (new features, no breaking change)
#   ./scripts/bump_version.sh major    # 0.9.0 → 1.0.0  (breaking changes)
#
# Bump rules (aligned with Conventional Commits):
#   patch — fix: commits
#   minor — feat: commits
#   major — feat!: / fix!: commits, or commits with a BREAKING CHANGE: footer
#
# The script writes the new version to VERSION and prints a reminder to
# commit the change. It does NOT commit, tag, or push — those steps are
# performed by the developer (commit) and the deploy workflow (tag).
#
# Exit codes:
#   0 — version bumped successfully
#   1 — invalid usage or VERSION file is malformed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSION_FILE="${REPO_ROOT}/VERSION"

# ── Validate arguments ────────────────────────────────────────────────────────

BUMP_TYPE="${1:-}"

if [[ -z "${BUMP_TYPE}" ]]; then
  echo "Usage: $(basename "$0") <patch|minor|major>" >&2
  exit 1
fi

case "${BUMP_TYPE}" in
  patch|minor|major) ;;
  *)
    echo "Error: bump type must be one of: patch, minor, major" >&2
    echo "Usage: $(basename "$0") <patch|minor|major>" >&2
    exit 1
    ;;
esac

# ── Read and validate current version ────────────────────────────────────────

if [[ ! -f "${VERSION_FILE}" ]]; then
  echo "Error: VERSION file not found at ${VERSION_FILE}" >&2
  exit 1
fi

CURRENT_VERSION="$(cat "${VERSION_FILE}" | tr -d '[:space:]')"

# Validate that the version matches MAJOR.MINOR.PATCH
if ! [[ "${CURRENT_VERSION}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "Error: VERSION file contains an invalid semver string: '${CURRENT_VERSION}'" >&2
  echo "Expected format: MAJOR.MINOR.PATCH (e.g. 0.9.0)" >&2
  exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

# ── Compute new version ───────────────────────────────────────────────────────

case "${BUMP_TYPE}" in
  patch)
    NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
    ;;
  minor)
    NEW_VERSION="${MAJOR}.$((MINOR + 1)).0"
    ;;
  major)
    NEW_VERSION="$((MAJOR + 1)).0.0"
    ;;
esac

# ── Write new version ─────────────────────────────────────────────────────────

echo "${NEW_VERSION}" > "${VERSION_FILE}"

# ── Print summary ─────────────────────────────────────────────────────────────

echo "Version bumped: ${CURRENT_VERSION} → ${NEW_VERSION}"
echo ""
echo "Next steps:"
echo "  git add VERSION"
echo "  git commit -m 'chore: bump version to ${NEW_VERSION}'"
echo ""
echo "The deploy workflow will create and push the git tag v${NEW_VERSION} after merging."
