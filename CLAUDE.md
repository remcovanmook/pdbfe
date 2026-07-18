# CLAUDE.md — working notes for AI-assisted development

Guidance for Claude Code (and humans) working in this repo. Kept deliberately
short; deep detail lives in the linked docs.

## What this is

A read-only PeeringDB mirror: Cloudflare Workers (`workers/`: api, rest, auth,
graphql, sync) + a vanilla-JS frontend (`frontend/`, no framework, no build
step). Production: `pdbfe.dev` (frontend, behind Cloudflare Access),
`api./rest./auth./graphql.pdbfe.dev` (workers, public API).

## Dev toolkit (scripts/dev/)

| Command | What it does |
|---------|--------------|
| `scripts/dev/verify.sh [--frontend / --workers]` | The full local gate: typechecks, unit tests, XSS lint, locale coverage — everything CI runs, one command, PASS/FAIL summary. |
| `node scripts/dev/browse.mjs --url /net/4224 [--wait <sel>] [--shot out.png]` | Headless-browser check against **real production data**: auto-swaps `config.js` origins, starts `wrangler pages dev`, collects console errors, **always restores config**. `--script check.mjs` runs a custom Playwright function (`export default async ({page, ...}) => {...}`). |
| `scripts/dev/pr-status.sh <PR#> [--wait]` | One-shot PR health: GitHub checks + SonarCloud gate + open Sonar issues. |
| `scripts/dev/live-version.sh` | Live `X-PDBFE-Version` of every worker vs the latest git tag; verifies the frontend 302→CF-Access signature. |
| `node scripts/dev/d1-drift.mjs` | **Run before any release that touches schema/entities.** Compares LIVE production D1 against `extracted/schema.sql` (missing tables/columns = the production-500 class unit tests can't catch — they mock D1) and `database/migrations/*.sql` against the `_migrations` table (unapplied migrations). Read-only; exit 1 on drift. |

## Hard rules

- **workers/ hot paths**: read `workers/ANTI_PATTERNS.md` before touching
  pipeline/cache code. No `new URL`, no regex, no map/filter/spread on hot
  paths; suppress deliberate exceptions with `// ap-ok: <reason>` (precedent:
  `workers/api/utils.js`).
- **frontend XSS**: DOM-building via `createElement`/`textContent` only —
  `scripts/lint_xss.js` enforces it (pre-commit). URLs from API data go
  through `sanitiseURL` (links) or `sanitiseImageURL` (img src only — allows
  `data:image/*`, which is in active PeeringDB use and inert in `<img>`;
  NEVER route it into an href). The two sanitisers stay separate by design.
- **every user-visible string** goes through `t('...')` AND gets registered in
  `frontend/locales/strings.json` (alphabetical order; `check_locales.js`
  gates coverage).
- **auth flow is deliberate**: `?code=` query transport (not fragments — CF
  Access strips them), PKCE-style exchange, sid reconstruction before
  localStorage (Sonar taint). Don't "simplify" it; see
  `docs/audits/2026-07-worker-security-quality-audit.md`.

## Quality gates & their quirks

- **SonarCloud**: the gate fails on real vulnerabilities (taint into browser
  storage, super-linear regex). It does NOT fail on cognitive complexity —
  the server profile allows far more than the IDE's local threshold of 15;
  **ignore complexity warnings below ~50**. A boolean `regex.test()` does not
  break Sonar's taint flow — reconstruct tainted strings from their allowed
  alphabet before storing (see `frontend/js/auth.js` `_exchangeCode`).
- **pre-push hook runs Playwright E2E needing a live server** — it fails in
  sandboxed/headless environments. After the full local gate passes
  (`scripts/dev/verify.sh`), pushing with `--no-verify` is the established
  practice.
- Commit messages with backticks/apostrophes: write to a file and use
  `git commit -F <file>` (heredoc quoting bites).

## Release model (tag-authoritative)

- Deploys happen ONLY via the manual **Release** workflow
  (`gh workflow run "Release" -f bump=<auto|patch|minor|major>`). Merges to
  main do NOT deploy.
- Version derives from the latest `v*` git tag, not the `VERSION` file — the
  file on main lags the tag **by design** (branch protection blocks the
  workflow's push-back). Never "fix" a stale VERSION.
- `bump=auto` promotes any `feat:` commit to a **minor** bump. If a specific
  version was requested, pass the explicit level that produces it.
- Verify a release with `scripts/dev/live-version.sh`.

## Secrets & local config

- Wrangler credentials live in `.env` at repo root: `. .env; npx wrangler ...`
- `frontend/js/config.js` is gitignored, generated from
  `config.js.example` at deploy; locally it holds `<your-domain>`
  placeholders. `browse.mjs` swaps/restores it automatically — don't edit it
  by hand for testing.
