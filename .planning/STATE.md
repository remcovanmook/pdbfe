# Current State

**Last updated**: 2026-04-23
**Active branch**: `feat/versioning`
**Production**: `pdbfe.dev` (Cloudflare Pages + Workers) — gated behind Cloudflare Access pending AUP approval
**Preview**: `*.pdbfe-frontend.pages.dev`

## Deployment Topology

| Service | Domain | Platform | Status |
|---------|--------|----------|--------|
| Frontend SPA | pdbfe.dev, www.pdbfe.dev | Cloudflare Pages | 🔒 CF Access gated |
| API Worker | api.pdbfe.dev | Cloudflare Worker + D1 | ✅ Live |
| Auth Worker | auth.pdbfe.dev | Cloudflare Worker + KV + D1 | ✅ Live |
| GraphQL | graphql.pdbfe.dev | Cloudflare Worker | ✅ Live |
| REST/OpenAPI | rest.pdbfe.dev | Cloudflare Worker | ✅ Live |
| Sync | cron trigger (every 15 min) | Cloudflare Worker + D1 | ✅ Live |

## Data Stores

| Store | Type | Purpose | Status |
|-------|------|---------|--------|
| peeringdb | D1 | Mirror of all 13 PeeringDB entity types | ✅ Synced and current |
| pdbfe-users | D1 | User profiles, API keys, favorites, preferences | ✅ Live |
| SESSIONS | KV | OAuth session state (shared between auth + API workers) | ✅ Live |
| pdbfe-logos | R2 | Entity logo assets | ✅ Backfilled and current |

## Test Coverage

| Category | Tests | Suites | Scope |
|----------|------:|-------:|-------|
| Worker unit | 1008 | 175 | API, auth, core, GraphQL, REST, sync |
| Frontend unit | 190 | 53 | Home, about, i18n, markdown, debug, formatSpeed, countries, entities, router, theme, timezone, typeahead, pdb-table, pages |
| Compliance | 56 | 5 | Golden files, wire format, filter fuzz (subset of worker unit) |
| **Total** | **1198** | **228** | |

**Worker coverage**: 95.9% line / 87.0% branch / 90.3% functions. Enforced via `--test-coverage-lines=85 --test-coverage-branches=80 --test-coverage-functions=80` in `npm test`.

**Frontend coverage**: 70.7% line / 77.1% branch / 52.2% functions. No threshold enforced — DOM-rendering modules (`render.js`, `pdb-table.js`, `home.js`) are covered by Playwright E2E instead. Known gap: `auth.js` at 61% line (OAuth callback / session management branches unreachable by mock-DOM harness).

- CI runs: lint, typecheck, XSS scan, schema freshness, version-check, all unit tests
- Worker tests blocked below 85/80/80 thresholds
- Playwright E2E: 54 tests across navigation, search, accessibility, theme, typeahead

## Versioning

- **Current version**: `0.9.0` (in `VERSION` file at repo root)
- **Bump tool**: `./scripts/bump_version.sh patch|minor|major`
- **CI gate**: `version-check` job blocks functional PRs without a version bump
- **Auto-tag**: Deploy workflow pushes annotated git tag `v{VERSION}` after each production deploy
- **Header**: `X-PDBFE-Version` on all worker responses

## Statistics

- **Commits**: ~510+ on main
- **Merged PRs**: 75 (PR #76 pending)
- **Entity types**: 13 (net, ix, fac, org, carrier, campus, poc, ixfac, ixlan, ixpfx, netfac, netixlan, as_set)
- **Frontend JS**: ~15 page modules, ~8 shared modules
- **Workers**: 5 (api, auth, graphql, rest, sync)
- **Test files**: 47 (37 worker, 10 frontend)
- **CI**: GitHub Actions (lint, typecheck, XSS scan, schema, version-check, unit tests)

## In-Flight Work

Branch `feat/versioning` — **PR #76** (pending merge), 1 commit:

| Category | Item | Status |
|----------|------|--------|
| Infra | `VERSION` file (`0.9.0`), `scripts/bump_version.sh` | ✅ |
| Infra | CI `version-check` job (hard block for functional PRs) | ✅ |
| Infra | Deploy auto-tagging (`v{VERSION}`) | ✅ |
| Infra | `PDBFE_VERSION` wrangler var + `X-PDBFE-Version` header | ✅ |
| Infra | `types.d.ts` env interface updates | ✅ |
| Docs | CONTRIBUTING.md versioning section, PR template checklist item | ✅ |

## Blockers

- **AUP approval**: Production frontend remains behind Cloudflare Access until AUP is approved.
