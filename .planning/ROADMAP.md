# Roadmap: PDBFE

## Milestones

- ✅ **M1–M8** — shipped (see [MILESTONES.md](./MILESTONES.md))
- 🔧 **M9 — Account & Mobile** — in progress (branch `frontend/account-mystuff-mobile`)

## Current: M9 — Account & Mobile

<details>
<summary>🔧 M9 — Account & Mobile (in progress)</summary>

| Category | Item | Status |
|----------|------|--------|
| Frontend | Account page reshuffle (profile left, right column) | ✅ |
| Frontend | "My stuff" on homepage | ✅ |
| Frontend | Compare with locked A-side | ✅ |
| Frontend | Mobile table card layout (initial) | ✅ |
| Frontend | PeeringDB profile link | ✅ |
| Auth | Favorites drag-and-drop with server persistence | ✅ |
| Auth | OAuth redirect to originating frontend (Referer-based) | ✅ |
| Auth | Dynamic CORS for all account endpoints | ✅ |
| Frontend | Mobile card layout for remaining detail page tables | ☐ |
| Frontend | Visual QA pass on branch preview | ☐ |

Archive: PR branch `frontend/account-mystuff-mobile`

</details>

## Next: M10 — Mobile & Responsive (planned)

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
| Infra | E2E browser test suite |
| Infra | Git tags and release versioning |
| Infra | AUP approval → remove Cloudflare Access gate on production frontend |
