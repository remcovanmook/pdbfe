# PDBFE — PeeringDB Frontend & Edge Mirror

## What This Is

A Cloudflare-native, globally distributed PeeringDB mirror and modern frontend. Syncs all 13 PeeringDB entity types from upstream's REST API into D1 (Cloudflare's edge SQLite), and serves them through four surfaces: a full SPA frontend with entity detail pages, search, comparison, and favorites; a PeeringDB-compatible REST API (drop-in replacement); a GraphQL API (via Yoga/Envelop); and an OpenAPI/Scalar reference. Authentication via PeeringDB OAuth2 with session management, user profiles, API keys, and favorites stored in a separate D1 user database. Deployed on Cloudflare Pages (frontend) + Workers (API, auth, sync, GraphQL, REST).

## Core Value

Fast, modern, alternative PeeringDB interface with infrastructure comparison tools, deployed at the edge on Cloudflare's global network — no single point of failure, no origin server.

## Architecture

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Frontend SPA | Vanilla JS, CSS, Cloudflare Pages | Entity browsing, search, compare, account |
| API Worker | Cloudflare Worker + D1 | PeeringDB-compatible REST API |
| GraphQL Worker | Cloudflare Worker + Yoga | GraphQL API endpoint |
| REST Worker | Cloudflare Worker + Scalar | OpenAPI reference + REST pass-through |
| Auth Worker | Cloudflare Worker + KV + D1 | OAuth2, sessions, user profiles, API keys |
| Sync Worker | Cloudflare Cron Trigger + D1 | Hourly incremental PeeringDB sync |
| Pipeline | Node.js scripts | Schema extraction, entity codegen, D1 migrations |

## Constraints

- **Platform**: Cloudflare Workers, Pages, D1, KV, R2
- **Language**: JavaScript (no TypeScript, no build step for frontend)
- **Frontend**: Vanilla JS SPA — no React/Vue/framework. CSS custom properties for theming.
- **API fidelity**: Wire-compatible with upstream PeeringDB REST API (same JSON shape, pagination, filters)
- **Auth**: PeeringDB OAuth2 only. No local accounts.
- **Data**: Read-only mirror. No write path.
- **Dependencies**: Zero external runtime dependencies in frontend. Workers use only Cloudflare platform APIs.

## Key Decisions

| Decision | Rationale | PR |
|----------|-----------|----|
| D1 as primary store | Edge-local reads, no origin latency, SQL for complex queries | #1 |
| Zero-allocation JSON via SQLite json_object() | Push serialization to D1, avoid JS object allocation on hot path | #1 |
| Vanilla JS SPA (no framework) | Zero build step, instant deploys, minimal bundle, full control | #2 |
| Promise coalescing for cache stampede protection | Prevents thundering herd on cold Worker isolates | #3 |
| Django-style filter operators (__in, __contains, etc.) | Upstream PeeringDB API compatibility | #9 |
| PeeringDB OAuth2 with Double Submit Cookie CSRF | Industry-standard auth, no custom identity provider | #15 |
| D1 for user data (not KV) | ACID guarantees, eliminates race conditions in key management | #48 |
| Entity codegen from upstream Django models | Auto-sync schema changes, reduce manual field mapping | #33 |
| SWR + L2 Cache pipeline | Stale-while-revalidate with Cloudflare Cache API for multi-isolate sharing | #38 |
| Semantic search via Vectorize | AI-powered entity discovery without exact-match requirements | feat-semantic-search |
| Referer-based OAuth return origin | Clean redirect to Pages preview deployments without frontend changes | #70 (pending) |

## Current State

479 commits across 69 PRs. Production deployment on `pdbfe.dev` with branch previews on `*.pdbfe-frontend.pages.dev`. All 13 PeeringDB entity types synced and served. Frontend covers entity detail, search, advanced search, comparison, favorites, and account management. Auth via PeeringDB OAuth2 with user profiles, preferences, API keys, and server-persisted favorites.

**Active branch**: `frontend/account-mystuff-mobile` — account page reshuffle, mobile table cards, "my stuff" on homepage, compare with locked A-side, OAuth return-to-origin.

**Known tech debt**:
- Mobile rendering of detail page tables needs card-based responsive layout
- No tags/releases — version tracking via PR numbers only
- Worker test coverage is catch-up, not TDD
- No automated E2E browser tests
- Logo mirroring (R2) pipeline exists but bulk backfill not yet run

---
*Last updated: 2026-04-19 — 69 PRs merged, active work on account/mobile/auth improvements*
