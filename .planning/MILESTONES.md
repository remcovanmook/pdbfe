# Milestones

Milestones are derived from merged PR branches. Each milestone groups related PRs
by theme. PR descriptions and branch names are the source of truth — these summaries
are backfilled from the git history.

---

## M1: API Foundation (PRs #1–#3)

**Shipped**: 2026-04 (early)

- PeeringDB API worker with D1 storage, zero-allocation JSON via SQLite json_object()
- Frontend SPA shell with entity detail pages, search, routing
- Cached query pipeline with SWR, Promise coalescing for stampede protection

---

## M2: Frontend Parity (PRs #4–#8)

**Shipped**: 2026-04

- CSP headers, self-hosted Inter font, /status endpoint
- Homepage feature parity with upstream
- Entity field refactor for consistent rendering
- API worker review and cleanup
- Review fixes across frontend and workers

---

## M3: API Compatibility (PRs #9–#13)

**Shipped**: 2026-04

- Implicit cross-entity filters (Django-style __in, __contains, etc.)
- D1 sessions API for auth worker
- Conformance fixes against upstream API
- Django gotcha gaps (edge cases in filter parsing)
- Conformance upstream safety (structural diff tooling)

---

## M4: Authentication & Access Control (PRs #14–#18)

**Shipped**: 2026-04

- POC visibility filtering (upstream access control enforcement)
- OAuth2 auth worker with PeeringDB identity provider
- User profiles and API key management
- Mobile header/about/docs fixes
- Load test and cache tier validation

---

## M5: Public Release & Quality (PRs #19–#27)

**Shipped**: 2026-04

- Public release cleanup and documentation
- Cache optimisations (L2, SWR pipeline)
- i18n framework with upstream language tests
- i18n string catalog completion
- Developer safety guards (pre-commit hooks, linting)
- CI/CD pipeline (GitHub Actions)
- Security review remediations
- PeeringDB Python client compatibility

---

## M6: Infrastructure Hardening (PRs #28–#40)

**Shipped**: 2026-04

- Isolate-level rate limiter
- Anti-pattern test suite
- Sync invalidation and freshness tracking
- Migration integrity checks
- Upstream schema pipeline (Django model → entity codegen)
- Deploy pipeline fixes and config management
- Precompiled entities with L2 cache
- HTTP response headers (Allow, If-Modified-Since, X-Auth-Status)

---

## M7: Frontend Modernisation (PRs #41–#55)

**Shipped**: 2026-04

- Gitignore and orphan cleanup
- Worker refactoring (handler folders, module consolidation)
- Web component patterns
- Tokenizer, footer sync display, review bug fixes
- User DB migration (KV → D1)
- Frontend code quality (dataset API, SonarQube, replaceAll)
- Table filters and entity logos
- Auth origin fixes, SID input validation
- User preferences and favorites system

---

## M8: Visual Polish & API Fidelity (PRs #56–#69)

**Shipped**: 2026-04-18

- API key revocation fixes
- Account UI tweaks
- R2 logo sync infrastructure
- 24-hour time format
- IX prefix display improvements
- SonarQube remediation across all workers and frontend
- Code cleanups and CORS apex origin fixes
- Advanced search with tabbed entity forms
- Favorites management page with drag-to-reorder
- Homepage redesign (stats ticker, nav pills, hero)
- Compare infrastructure improvements
- Frontend visual polish (contrast, chip-select, drag-and-drop)
- Worker codebase deduplication and module consolidation
- POC access control enforcement across all workers
- Hot-path allocation elimination
- Upstream API parity (omitempty, field stripping, structural diff tooling)
- Worker unit test adoption (pdbcompat patterns, golden files, fuzz)

---

## M9: Account & Mobile (in progress)

**Branch**: `frontend/account-mystuff-mobile`
**Status**: Active development

- Account page org tree with affiliated networks, IXes, facilities
- "My stuff" section on homepage with affiliated entities
- Compare with locked A-side (pre-filled from entity pages)
- Mobile responsive table cards for detail pages
- Account page reshuffle (profile left, affiliations/favorites/keys right)
- Favorites drag-and-drop with server persistence (PUT /account/favorites)
- PeeringDB profile link on account page
- OAuth redirect to originating frontend (Referer-based return origin)
- Dynamic CORS origin resolution for all account endpoints

---

## Backlog

- Mobile card layout for all detail page tables
- E2E browser test suite
- R2 logo bulk backfill
- Semantic search (Vectorize integration — branch exists)
- Git tags and release versioning
