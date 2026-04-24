# Current State

**Last updated**: 2026-04-24
**Active branch**: `feature/async-queue-worker` — PR open, pending merge
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
| Search | api.pdbfe.dev/search* | Cloudflare Worker + D1 + Vectorize | ✅ Live |
| Sync | cron trigger (every 15 min) | Cloudflare Worker + D1 + Queue | ✅ Live |
| Async | pdbfe-tasks Queue consumer | Cloudflare Worker + D1 + Vectorize + R2 | ✅ Live |

## Data Stores

| Store | Type | Purpose | Status |
|-------|------|---------|--------|
| peeringdb | D1 | Mirror of all 13 PeeringDB entity types | ✅ Synced and current |
| pdbfe-users | D1 | User profiles, API keys, favorites, preferences | ✅ Live |
| SESSIONS | KV | OAuth session state (shared between auth + API workers) | ✅ Live |
| pdbfe-logos | R2 | Entity logo assets | ✅ Backfilled and current |
| pdbfe-vectors | Vectorize | Graph-structural node2vec embeddings (1024-dim, 75k vectors) | ✅ Fully embedded |
| pdbfe-tasks | Queue | Async task bus (embed / delete / logo) between sync and async workers | ✅ Live |

## Test Coverage

| Category | Tests | Suites | Scope |
|----------|------:|-------:|-------|
| Worker unit | 1147 | 220 | API, auth, core, GraphQL, REST, sync, async, search (graph-search + query-parser) |
| Frontend unit | 190 | 53 | Home, about, i18n, markdown, debug, formatSpeed, countries, entities, router, theme, timezone, typeahead, pdb-table, pages |
| Compliance | 56 | 5 | Golden files, wire format, filter fuzz (subset of worker unit) |
| **Total** | **1337** | **273** | |

**Worker coverage**: enforced via `--test-coverage-lines=85 --test-coverage-branches=80 --test-coverage-functions=80` in `npm test`.

**Frontend coverage**: 70.7% line / 77.1% branch / 52.2% functions. No threshold enforced — DOM-rendering modules (`render.js`, `pdb-table.js`, `home.js`) are covered by Playwright E2E instead.

- CI runs: lint, typecheck, XSS scan, schema freshness, version-check, all unit tests
- Worker tests blocked below 85/80/80 thresholds
- Playwright E2E: 54 tests across navigation, search, accessibility, theme, typeahead

## Versioning

- **Current version**: `0.10.2` (in `VERSION` file at repo root)
- **Bump tool**: `./scripts/bump_version.sh patch|minor|major`
- **CI gate**: `version-check` job blocks functional PRs without a version bump
- **Auto-tag**: Deploy workflow pushes annotated git tag `v{VERSION}` after each production deploy
- **Header**: `X-PDBFE-Version` on all worker responses

## Statistics

- **Commits**: ~530+ on main (after merge)
- **Merged PRs**: 77 (after merge)
- **Entity types**: 13 (net, ix, fac, org, carrier, campus, poc, ixfac, ixlan, ixpfx, netfac, netixlan, carrierfac)
- **Frontend JS**: ~15 page modules, ~8 shared modules
- **Workers**: 8 (api, auth, graphql, rest, sync, search, async, frontend/pages)
- **Test files**: 51 (41 worker, 10 frontend)
- **CI**: GitHub Actions (lint, typecheck, XSS scan, schema, version-check, unit tests)

## In-Flight Work

`feature/async-queue-worker` — PR #78 open (M11 Part 3), pending merge.

## Blockers

- **AUP approval**: Production frontend remains behind Cloudflare Access until AUP is approved.
