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
| Frontend unit | 123 | 28 | Home, about, i18n, markdown, debug, formatSpeed, countries, entities, router, theme, timezone |
| Compliance | 56 | 5 | Golden files, wire format, filter fuzz (subset of worker unit) |
| **Total** | **816** | **171** | |

- CI runs: lint, typecheck, XSS scan, all unit tests
- Compliance tests: structural diff against upstream JSON, golden file snapshots, filter fuzz
- Frontend coverage: 10 of 33 modules tested (up from 5)
- No E2E browser tests yet

## Statistics

- **Commits**: 479+ on main
- **Merged PRs**: 69
- **Entity types**: 13 (net, ix, fac, org, carrier, campus, poc, ixfac, ixlan, ixpfx, netfac, netixlan, as_set)
- **Frontend JS**: ~15 page modules, ~8 shared modules
- **Workers**: 5 (api, auth, graphql, rest, sync)
- **Test files**: 45 (35 worker, 10 frontend)
- **CI**: GitHub Actions (lint, typecheck, XSS scan, unit tests)

## In-Flight Work

Branch `frontend/account-mystuff-mobile` — **PR #70**, 13 commits:

| Category | Item | Status |
|----------|------|--------|
| Frontend | Account page reshuffle (profile left, right column) | ✅ |
| Frontend | Org affiliation tree with grouped child entities | ✅ |
| Frontend | "My stuff" homepage section | ✅ |
| Frontend | Compare with locked A-side | ✅ |
| Frontend | Mobile table card layout (≤640px, data-label, card borders) | ✅ |
| Frontend | Mobile CSS (IP stack wrap, scroll-hint removal, card striping) | ✅ |
| Frontend | PeeringDB profile link on account page | ✅ |
| Frontend | Unit tests: countries, entities, router, theme, timezone | ✅ |
| Auth | Favorites server-side reorder persistence (PUT) | ✅ |
| Auth | OAuth return-to-origin for preview deployments | ✅ |
| Auth | Dynamic CORS origin for all account endpoints | ✅ |
| Infra | .planning docs (PROJECT, MILESTONES, ROADMAP, STATE) | ✅ |

## Blockers

- **AUP approval**: Production frontend remains behind Cloudflare Access until AUP is approved.
