# Current State

**Last updated**: 2026-04-20
**Active branch**: `chore/core-internal-tags`
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
| Worker unit | 934 | 161 | API, auth, core, GraphQL, REST, sync |
| Frontend unit | 123 | 28 | Home, about, i18n, markdown, debug, formatSpeed, countries, entities, router, theme, timezone |
| Compliance | 56 | 5 | Golden files, wire format, filter fuzz (subset of worker unit) |
| **Total** | **1057** | **189** | |

- CI runs: lint, typecheck, XSS scan, all unit tests
- Compliance tests: structural diff against upstream JSON, golden file snapshots, filter fuzz
- Frontend coverage: 10 of 33 modules tested (up from 5)
- No E2E browser tests yet

## Statistics

- **Commits**: 496+ on main
- **Merged PRs**: 72 (PR #73 pending)
- **Entity types**: 13 (net, ix, fac, org, carrier, campus, poc, ixfac, ixlan, ixpfx, netfac, netixlan, as_set)
- **Frontend JS**: ~15 page modules, ~8 shared modules
- **Workers**: 5 (api, auth, graphql, rest, sync)
- **Test files**: 47 (37 worker, 10 frontend)
- **CI**: GitHub Actions (lint, typecheck, XSS scan, unit tests)

## In-Flight Work

Branch `chore/core-internal-tags` — **PR #73** (pending merge), 3 commits:

| Category | Item | Status |
|----------|------|--------|
| Infra | Tag test-only core exports as @internal | ✅ |
| Backend | Move l2cache/pipeline/swr into `core/pipeline/` with barrel export | ✅ |
| Auth | Extract generic OAuth2 factory into `core/oauth.js`; refactor auth handler to PDB-specific config + thin router; add OAuth unit tests | ✅ |

## Blockers

- **AUP approval**: Production frontend remains behind Cloudflare Access until AUP is approved.
