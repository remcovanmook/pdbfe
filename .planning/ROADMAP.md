# Roadmap: PDBFE

## Milestones

- ✅ **M1–M9** — shipped (see [MILESTONES.md](./MILESTONES.md))
- ✅ **M10 — Core Refactoring, Test Hardening, i18n & Versioning** — PRs #73–#76
- 🔄 **M11 — Semantic Search** — PRs #77, #78 (Part 3 pending merge)

## Current: M11 — in progress

| Category | Item | Status |
|----------|------|--------|
| Backend | Search worker + vector pipeline | ✅ |
| Infra | Vectorize provisioning + production backfill | ✅ |
| Backend | Async queue architecture + graph search (PR #78) | 🔄 pending merge |

## Next: M12 — Mobile & Responsive (planned)

| Category | Item |
|----------|------|
| Frontend | Full mobile card layout for all detail page entity tables |
| Frontend | Responsive breakpoints for header navigation |
| Frontend | Touch-friendly interactions for drag-and-drop |
| Frontend | Mobile-first compare page layout |
| Backend | Advanced search UI → search worker integration |

## Backlog

| Category | Item |
|----------|------|
| Frontend | Mobile card layout for remaining detail page entity tables |
| Infra | AUP approval → remove Cloudflare Access gate on production frontend |
