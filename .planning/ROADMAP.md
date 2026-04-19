# Roadmap: PDBFE

## Milestones

- ✅ **M1–M8** — shipped (see [MILESTONES.md](./MILESTONES.md))
- 🔧 **M9 — Account & Mobile** — in progress (branch `frontend/account-mystuff-mobile`)

## Current: M9 — Account & Mobile

<details>
<summary>🔧 M9 — Account & Mobile (in progress)</summary>

- [x] Account page org tree with affiliated entities
- [x] "My stuff" on homepage
- [x] Compare with locked A-side
- [x] Mobile table card layout (initial)
- [x] Account page reshuffle (profile left, right column)
- [x] PeeringDB profile link
- [x] Favorites drag-and-drop with server persistence
- [x] OAuth redirect to originating frontend (Referer-based)
- [x] Dynamic CORS for all account endpoints
- [ ] Mobile card layout for remaining detail page tables
- [ ] Visual QA pass on branch preview

Archive: PR branch `frontend/account-mystuff-mobile`

</details>

## Next: M10 — Mobile & Responsive (planned)

- Full mobile card layout for all detail page entity tables
- Responsive breakpoints for header navigation
- Touch-friendly interactions for drag-and-drop
- Mobile-first compare page layout

## Backlog

- **Semantic search** — Vectorize integration (branch `feat-semantic-search` exists)
- **R2 logo backfill** — bulk migration of entity logos to R2
- **E2E tests** — browser-based integration test suite
- **Release versioning** — git tags, changelog generation
- **Cache tags** — Cloudflare Pages cache invalidation via cache tags
