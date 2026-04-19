# Milestones

Milestones are derived from merged PR branches. Each milestone groups related PRs
by theme and category. PR descriptions and branch names are the source of truth —
these summaries are backfilled from the git history.

Categories: **Backend** (workers, API, sync), **Frontend** (SPA, UI, UX),
**Database** (D1 schema, migrations, data), **Auth** (OAuth, sessions, accounts),
**Infra** (CI/CD, deploy, config), **i18n** (localisation), **Content** (logos, assets, docs).

---

## M1: API Foundation (PRs #1–#3)

**Shipped**: 2026-04 (early)

| Category | Work |
|----------|------|
| Backend | PeeringDB API worker with D1 storage, zero-allocation JSON via SQLite json_object() |
| Backend | Cached query pipeline with SWR, Promise coalescing for stampede protection |
| Database | Initial D1 schema for all 13 PeeringDB entity types |
| Frontend | SPA shell with entity detail pages, search, client-side routing |

---

## M2: Frontend Parity (PRs #4–#8)

**Shipped**: 2026-04

| Category | Work |
|----------|------|
| Frontend | Homepage parity with upstream PeeringDB |
| Frontend | Entity field refactor for consistent rendering |
| Infra | CSP headers, self-hosted Inter font, /status endpoint |
| Backend | API worker review and cleanup |

---

## M3: API Compatibility (PRs #9–#13)

**Shipped**: 2026-04

| Category | Work |
|----------|------|
| Backend | Implicit cross-entity filters (Django-style __in, __contains, etc.) |
| Backend | D1 sessions API for auth worker |
| Backend | Conformance fixes and structural diff tooling against upstream API |
| Database | Django gotcha gaps (edge cases in filter parsing, schema alignment) |

---

## M4: Authentication & Access Control (PRs #14–#18)

**Shipped**: 2026-04

| Category | Work |
|----------|------|
| Auth | OAuth2 auth worker with PeeringDB identity provider |
| Auth | User profiles and API key management |
| Backend | POC visibility filtering (upstream access control enforcement) |
| Frontend | Mobile header, about page, docs page fixes |
| Backend | Load test and cache tier validation |

---

## M5: Public Release & Quality (PRs #19–#27)

**Shipped**: 2026-04

| Category | Work |
|----------|------|
| Infra | Public release cleanup, documentation |
| Infra | CI/CD pipeline (GitHub Actions — lint, typecheck, XSS scan, tests) |
| Infra | Security review remediations |
| Backend | Cache optimisations (L2, SWR pipeline) |
| Backend | PeeringDB Python client compatibility |
| i18n | i18n framework with upstream language tests |
| i18n | i18n string catalog completion |
| Infra | Developer safety guards (pre-commit hooks, linting) |

---

## M6: Infrastructure Hardening (PRs #28–#40)

**Shipped**: 2026-04

| Category | Work |
|----------|------|
| Backend | Isolate-level rate limiter |
| Backend | Anti-pattern test suite |
| Backend | Sync invalidation and freshness tracking |
| Backend | HTTP response headers (Allow, If-Modified-Since, X-Auth-Status) |
| Database | Migration integrity checks |
| Database | Upstream schema pipeline (Django model → entity codegen) |
| Infra | Deploy pipeline fixes, config management, precompiled entities with L2 cache |

---

## M7: Frontend Modernisation (PRs #41–#55)

**Shipped**: 2026-04

| Category | Work |
|----------|------|
| Frontend | Web component patterns, table filters, entity logos |
| Frontend | Advanced search with tabbed entity forms |
| Frontend | Favorites management page with drag-to-reorder |
| Frontend | Code quality (dataset API, SonarQube, replaceAll) |
| Auth | User DB migration (KV → D1 for profiles, API keys, favorites) |
| Auth | SID input validation, auth origin fixes |
| Backend | Worker refactoring (handler folders, module consolidation) |
| Infra | Gitignore cleanup, orphan removal |

---

## M8: Visual Polish & API Fidelity (PRs #56–#69)

**Shipped**: 2026-04-18

| Category | Work |
|----------|------|
| Frontend | Homepage redesign (stats ticker, nav pills, hero) |
| Frontend | Compare infrastructure improvements |
| Frontend | Visual polish (contrast, chip-select, drag-and-drop) |
| Backend | Upstream API parity (omitempty, field stripping, structural diff) |
| Backend | POC access control enforcement across all workers |
| Backend | Hot-path allocation elimination |
| Backend | Worker codebase deduplication and module consolidation |
| Backend | Worker unit test adoption (pdbcompat patterns, golden files, fuzz) |
| Content | R2 logo sync infrastructure and bulk backfill |
| Auth | API key revocation fixes, account UI tweaks |
| Database | IX prefix display, 24h time format, schema updates |
| Infra | SonarQube remediation, CORS apex origin fixes |

---

## M9: Account & Mobile (PR pending)

**Branch**: `frontend/account-mystuff-mobile`
**Status**: PR ready — 11 commits, 18 files changed, +1840/-238 lines

| Category | Work |
|----------|------|
| Frontend | Account page reshuffle (profile left, affiliations/favorites/keys right) |
| Frontend | "My stuff" section on homepage with affiliated entities |
| Frontend | Compare with locked A-side (pre-filled from entity pages) |
| Frontend | Mobile responsive table cards for detail pages |
| Frontend | PeeringDB profile link on account page |
| Frontend | Unit tests for countries, entities, router, theme, timezone (79 → 123 tests) |
| Auth | Favorites drag-and-drop with server persistence (PUT /account/favorites) |
| Auth | OAuth redirect to originating frontend (Referer-based return origin) |
| Auth | Dynamic CORS origin resolution for all account endpoints |
| Infra | .planning directory with PROJECT, MILESTONES, ROADMAP, STATE docs |

---

## Backlog

| Category | Item |
|----------|------|
| Frontend | Mobile card layout for remaining detail page entity tables |
| Backend | Semantic search (Vectorize integration — branch `feat-semantic-search` exists) |
| Infra | E2E browser test suite |
| Infra | Git tags and release versioning |
| Infra | AUP approval → remove Cloudflare Access gate on production frontend |
