# Roadmap: PDBFE

## Milestones

- ✅ **M1–M9** — shipped (see [MILESTONES.md](./MILESTONES.md))
- ✅ **M10 — Core Refactoring, Test Hardening, i18n & Versioning** — PRs #73–#76

## Current: M10 — shipped

All M10 work is merged or in-flight for merge:

| Category | Item | Status |
|----------|------|--------|
| Backend | `core/pipeline/` reorganisation | ✅ |
| Auth | Generic OAuth2 factory (`core/oauth.js`) | ✅ |
| Infra | Frontend + E2E test suite (190 unit, 54 Playwright) | ✅ |
| i18n | Full string catalog coverage (57% → 99%) | ✅ |
| Infra | Semantic versioning (`VERSION`, `bump_version.sh`, CI gate, auto-tagging) | ✅ |

## Next: M11 — Mobile & Responsive (planned)

| Category | Item |
|----------|------|
| Frontend | Full mobile card layout for all detail page entity tables |
| Frontend | Responsive breakpoints for header navigation |
| Frontend | Touch-friendly interactions for drag-and-drop |
| Frontend | Mobile-first compare page layout |

## Backlog

| Category | Item |
|----------|------|
| Backend | Semantic search — Vectorize integration (branch `feat-semantic-search` exists) |
| Infra | AUP approval → remove Cloudflare Access gate on production frontend |
