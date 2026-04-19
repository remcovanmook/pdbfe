# Current State

**Last updated**: 2026-04-19
**Active branch**: `frontend/account-mystuff-mobile`
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
| Worker unit | 693 | 143 | API, auth, core, GraphQL, REST, sync |
| Frontend unit | 79 | 16 | Home, about, i18n, markdown, debug, formatSpeed |
| Compliance | 56 | 5 | Golden files, wire format, filter fuzz (subset of worker unit) |
| **Total** | **772** | **159** | |

- CI runs: lint, typecheck, XSS scan, all unit tests
- Compliance tests: structural diff against upstream JSON, golden file snapshots, filter fuzz
- No E2E browser tests yet

## Statistics

- **Commits**: 479+ on main
- **Merged PRs**: 69
- **Entity types**: 13 (net, ix, fac, org, carrier, campus, poc, ixfac, ixlan, ixpfx, netfac, netixlan, as_set)
- **Frontend JS**: ~15 page modules, ~8 shared modules
- **Workers**: 5 (api, auth, graphql, rest, sync)
- **Test files**: 40 (35 worker, 5 frontend)
- **CI**: GitHub Actions (lint, typecheck, XSS scan, unit tests)

## In-Flight Work

Active branch `frontend/account-mystuff-mobile` adds:

| Category | Item | Status |
|----------|------|--------|
| Frontend | Account page org tree with affiliated entities | ✅ |
| Frontend | "My stuff" homepage section | ✅ |
| Frontend | Compare with locked A-side | ✅ |
| Frontend | Mobile responsive table cards | ✅ |
| Frontend | Account page layout reshuffle | ✅ |
| Auth | Favorites server-side reorder persistence | ✅ |
| Auth | OAuth return-to-origin for preview deployments | ✅ |
| Auth | Dynamic CORS origin for all account endpoints | ✅ |
| Frontend | Mobile card layout for remaining tables | ☐ |
| Frontend | Visual QA pass | ☐ |

## Blockers

- **AUP approval**: Production frontend remains behind Cloudflare Access until AUP is approved. API workers are publicly accessible.
