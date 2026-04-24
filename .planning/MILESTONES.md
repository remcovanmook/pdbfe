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

## M9: Account & Mobile (PR #70, #71, #72)

**Branches**: `frontend/account-mystuff-mobile`, `fix/ix-peer-network-names`, `refactor/auth-handler-structure`
**Shipped**: 2026-04-19

| Category | Work |
|----------|------|
| Frontend | Account page reshuffle (profile left, affiliations/favorites/keys right) |
| Frontend | Org affiliation tree with grouped child entities (networks, IXes, facilities) |
| Frontend | "My stuff" section on homepage with affiliated entities |
| Frontend | Compare with locked A-side (pre-filled from entity pages) |
| Frontend | Mobile table card layout — rows become labelled cards at ≤640px via `data-label` attributes |
| Frontend | Mobile-specific CSS: card borders, IP stack inline wrap, scroll-hint removal |
| Frontend | PeeringDB profile link on account page |
| Frontend | Unit tests for countries, entities, router, theme, timezone (79 → 123 tests) |
| Frontend | Hotfix: `fetchIxPeers` depth=1 to restore `net_name` JOIN column stripped by #69 |
| Auth | Favorites drag-and-drop with server persistence (PUT /account/favorites) |
| Auth | OAuth redirect to originating frontend (Referer-based return origin) |
| Auth | Dynamic CORS origin resolution for all account endpoints |
| Auth | Auth worker handler-based architecture (method dispatch inside handlers, barrel exports) |
| Infra | .planning directory with PROJECT, MILESTONES, ROADMAP, STATE docs |

---

## M10: Core Refactoring, Test Hardening, i18n & Versioning (PRs #73–#76)

**Branches**: `chore/core-internal-tags`, `feat/frontend-tests`, `feat/versioning`
**Shipped**: 2026-04-23

| Category | Work |
|----------|------|
| Backend | Reorganise `core/pipeline/` — move `l2cache`, `query`, `swr` into subdirectory with barrel export |
| Backend | Tag test-only core exports as `@internal` to clarify public API surface |
| Auth | Extract generic OAuth2 Authorization Code flow factory (`core/oauth.js`) with typed `OAuthHandlerConfig` hooks |
| Auth | Reduce `auth/handlers/oauth.js` to PeeringDB-specific config and thin router (~441 → ~175 lines) |
| Auth | New `tests/unit/auth/oauth.test.js` — 30+ assertions covering CSRF flow, token exchange, profile parsing, session management, routing |
| Infra | Comprehensive frontend unit test suite — 190 tests across api, auth, render, typeahead, pdb-table, router, pages, and utility modules |
| Infra | Playwright E2E test suite — 54 tests covering navigation, search, accessibility, theme switching, and typeahead across all entity types |
| Infra | Test layout reorganised into `tests/unit/<area>/` subdirectories; shared `mock-dom.js` helper |
| Frontend | Router `_navGen` guard — monotonic counter prevents stale async renders from overwriting active page content (back-button race condition) |
| i18n | Full `t()` audit across all frontend pages and components; 152 missing strings added to `strings.json` catalogue |
| i18n | String wrapping applied to 13 page/component files (column labels, loading states, error messages, stat bar labels, UI controls) |
| i18n | 148 PDBFE-specific translations added to all 13 locale override files via `scripts/patch_overrides.py` |
| i18n | Coverage restored: 57% → 99% (340/343 strings) across cs, de, el, es, fr, it, ja, lt, pt, ro, ru, zh-cn, zh-tw |
| Infra | Semantic versioning (`VERSION` file at `0.9.0`, `scripts/bump_version.sh` for patch/minor/major bumps) |
| Infra | CI `version-check` job — hard blocks PRs with functional commits (`feat:`, `fix:`) that lack a version bump; exempt for `ci:`, `docs:`, `refactor:`, `chore:` |
| Infra | Deploy workflow creates and pushes annotated git tag `v{VERSION}` after each successful production deploy |
| Infra | `X-PDBFE-Version` response header injected in `wrapHandler` across all five workers |

---

## M11: Semantic Search

**Branch**: `feat/search-worker`
**Status**: Shipped

### Part 1 — Search worker + vector pipeline (PR #77, shipped 2026-04-23)

| Category | Work |
|----------|------|
| Backend | New `pdbfe-search` worker — keyword (`LIKE`) and semantic (Workers AI + Vectorize) search with SWR cache |
| Backend | Multi-entity fan-out: `entities=net,ix,fac` parallel D1 queries, grouped response with `meta.mode` |
| Backend | `syncVectors()` in sync worker — incremental embedding (100 rows/entity/run) with `__vector_embedded` tracking column |
| Database | Migration 005: `__vector_embedded` column on six entity tables (`ALTER TABLE`); tracked in `_migrations` |
| Database | `_LOCAL_FIELDS` updated in `parse_django_models.py` so regenerated schemas include the column for fresh installs |
| Frontend | Typeahead and search page wired to search worker; semantic mode badge in search heading |
| Frontend | JSDoc types corrected for `searchWithAsn`/`searchAllViaWorker` grouped+meta return shape |
| Infra | `scripts/backfill-vectors.mjs` — one-shot bulk embedder using Cloudflare REST APIs (D1 + AI + Vectorize), idempotent |
| Infra | `deploy.sh --generate-configs` — all wrangler toml + `config.js` generation in one place; eliminates 60-line sed block from `deploy.yml` |
| Infra | `.gitignore` updated with all generated toml files (`wrangler-graphql`, `wrangler-rest`, `wrangler-search`) |
| Infra | `Ai`, `VectorizeIndex`, `VectorizeVector` type stubs added to `workers/types.d.ts` |

### Part 2 — Infrastructure provisioning ✅

| Category | Item |
|----------|------|
| Infra | ~~`wrangler vectorize create pdbfe-vectors --dimensions=1024 --metric=cosine`~~ ✓ |
| Infra | ~~Deploy sync worker with `AI` + `VECTORIZE` bindings in production~~ ✓ |
| Backend | ~~Run backfill against production D1~~ ✓ (74k vectors) |
| Backend | ~~Validate semantic search results on production frontend~~ ✓ |

### Part 3 — Async queue architecture & graph search (PR #78, pending merge)

**Branch**: `feature/async-queue-worker`

| Category | Work |
|----------|------|
| Backend | New `pdbfe-async` queue consumer worker — decouples embed/delete/logo side-effects from the sync hot path |
| Backend | `embed` task: neighbour-vector averaging via ENTITIES FK registry (zero hardcoding) |
| Backend | `delete` task: vectorize cleanup with re-creation guard |
| Backend | `logo` task: S3→R2 pipeline with R2 HEAD dedup and permanent-failure marking |
| Backend | `pdbfe-sync` refactored: publishes `embed`/`delete`/`logo` task messages to Queue, drops all Vectorize/R2/AI bindings |
| Backend | Graph-structural search pipeline — `graph-search.js` + `query-parser.js` replacing BGE text embeddings with node2vec structural embeddings |
| Backend | `query-parser.js`: rule-based NL decomposition — ASN, infoType, region, country, city, similarity, traversal intent |
| Backend | `graph-search.js`: priority-ordered execution — ASN → similarity (Vectorize kNN) → traversal (D1 JOINs) → metadata → keyword |
| Infra | `scripts/compute-graph-embeddings.py`: node2vec (1024-dim) graph training + Vectorize bulk upload |
| Infra | `scripts/cleanup-junk-vectors.py`: removes contaminated vectors written before cutover |
| Infra | `deploy.sh`: async worker config generation and correct deploy order (consumer before producer) |
| Infra | `deploy.sh`: scripts venv Python resolution (checks `scripts/.venv` before system Python) |
| Infra | `docs/deployment.md`: full rewrite for 8-worker architecture — Vectorize, Queue, R2 provisioning, graph embedding step |
| Infra | `scripts/` cleanup: removed `backfill-vectors.mjs`, `viz_embeddings.py` |
| Test | 66 new unit tests for `query-parser.js` and `graph-search.js` (14 suites) |

---

## Backlog

| Category | Item |
|----------|------|
| Frontend | Mobile card layout for remaining detail page entity tables |
| Infra | AUP approval → remove Cloudflare Access gate on production frontend |

---

## M12 — Mobile, Responsive & Advanced Search (planned)

**Branch**: TBD

| Category | Work |
|----------|------|
| Frontend | Full mobile card layout for all entity detail page tables |
| Frontend | Responsive header navigation breakpoints |
| Frontend | Mobile-first compare page layout |
| Frontend | Advanced search form UI — field-specific filter inputs per entity type |
| Backend | Search worker: structured filter parameters beyond `q` (country, ASN range, info_type, policy, speed tier) |
| Backend | `keyword.js` extension: translate structured filters into typed D1 WHERE clauses alongside the existing LIKE path |
| Backend | `auto` mode: detect structured filter params in the request and route to the filter path without requiring `mode=graph` |
| Backend | `entities.js`: expose per-entity filterable field metadata (type, operator, valid values) for form generation |
| Test | Unit tests for structured filter parameter parsing and D1 WHERE clause generation |

