# Current State

**Last updated**: 2026-04-19
**Active branch**: `frontend/account-mystuff-mobile`
**Production**: `pdbfe.dev` (Cloudflare Pages + Workers)
**Preview**: `*.pdbfe-frontend.pages.dev`

## Deployment Topology

| Service | Domain | Platform |
|---------|--------|----------|
| Frontend SPA | pdbfe.dev, www.pdbfe.dev | Cloudflare Pages |
| API Worker | api.pdbfe.dev | Cloudflare Worker + D1 |
| Auth Worker | auth.pdbfe.dev | Cloudflare Worker + KV + D1 |
| GraphQL | graphql.pdbfe.dev | Cloudflare Worker |
| REST/OpenAPI | rest.pdbfe.dev | Cloudflare Worker |
| Sync | cron trigger (hourly) | Cloudflare Worker + D1 |

## Data Stores

| Store | Type | Purpose |
|-------|------|---------|
| peeringdb | D1 | Mirror of all 13 PeeringDB entity types |
| pdbfe-users | D1 | User profiles, API keys, favorites, preferences |
| SESSIONS | KV | OAuth session state (shared between auth + API workers) |
| pdbfe-logos | R2 | Entity logo assets (infrastructure exists, bulk backfill pending) |

## Statistics

- **Commits**: 479+ on main
- **Merged PRs**: 69
- **Entity types**: 13 (net, ix, fac, org, carrier, campus, poc, ixfac, ixlan, ixpfx, netfac, netixlan, as_set)
- **Frontend JS**: ~15 page modules, ~8 shared modules
- **Workers**: 5 (api, auth, graphql, rest, sync)
- **Tests**: Unit tests (Node.js test runner), structural diff, golden files, fuzz tests
- **CI**: GitHub Actions (lint, typecheck, XSS scan, unit tests)

## In-Flight Work

Active branch `frontend/account-mystuff-mobile` adds:
- Account page org tree with affiliated entities
- "My stuff" homepage section
- Compare with locked A-side
- Mobile responsive table cards
- Account page layout reshuffle
- Favorites server-side reorder persistence
- OAuth return-to-origin for preview deployments
- Dynamic CORS origin for all account endpoints
