# Roadmap: PDBFE

## Milestones

- ✅ **M1–M9** — shipped (see [MILESTONES.md](./MILESTONES.md))
- ✅ **M10 — Core Refactoring, Test Hardening, i18n & Versioning** — PRs #73–#76
- ✅ **M11 — Semantic Search** — PRs #77 + infra provisioning
- 🔄 **M12 — Async Queue Architecture & Graph Search** — PR #78, ready for merge

## Current: M12 — ready for merge

| Category | Item | Status |
|----------|------|--------|
| Backend | `pdbfe-async` queue consumer worker | ✅ |
| Backend | `pdbfe-sync` refactored to Queue publisher | ✅ |
| Backend | Graph-structural search (`graph-search.js`, `query-parser.js`) | ✅ |
| Infra | node2vec pipeline (`compute-graph-embeddings.py`) | ✅ |
| Infra | `deploy.sh` orchestration for 8-worker stack | ✅ |
| Test | 66 new unit tests for graph-search pipeline | ✅ |
| Docs | `deployment.md` rewrite for 8-worker architecture | ✅ |

## Next: M13 — Mobile & Responsive (planned)

| Category | Item |
|----------|------|
| Frontend | Full mobile card layout for all detail page entity tables |
| Frontend | Responsive breakpoints for header navigation |
| Frontend | Touch-friendly interactions for drag-and-drop |
| Frontend | Mobile-first compare page layout |

## Backlog

| Category | Item |
|----------|------|
| Infra | AUP approval → remove Cloudflare Access gate on production frontend |
