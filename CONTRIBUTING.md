# Contributing to pdbfe

Thanks for your interest in contributing. This document covers the
development setup, conventions, and submission process.

## Development Setup

### Prerequisites

- Node.js 22+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- A Cloudflare account (for local D1 development)

### First-time setup

```bash
# Clone the repo
git clone https://github.com/remcovanmook/pdbfe.git
cd pdbfe

# Install worker dependencies (only devDependencies — TypeScript + CF types)
cd workers && npm ci && cd ..

# Enable the pre-commit hook
git config core.hooksPath .githooks

# Copy config templates
cp workers/wrangler.toml.example workers/wrangler.toml
cp frontend/js/config.js.example frontend/js/config.js
```

### Running tests

```bash
# Workers — unit tests + upstream conformance
cd workers && npm test && npm run test:upstream

# Frontend — unit tests
cd frontend && npm test

# Type checking (both)
cd workers && npm run typecheck
cd frontend && npm run typecheck

# XSS lint
node scripts/lint_xss.js
```

All of these run automatically via the pre-commit hook. CI runs the same
checks on every PR.

## Project Structure

- **`workers/`** — Cloudflare Workers (API, sync, auth). Zero runtime dependencies.
- **`frontend/`** — Vanilla JS single-page app. Zero runtime dependencies.
- **`database/`** — D1 schema and migration scripts.
- **`scripts/`** — CI and pre-commit tooling.

## Conventions

### Code style

- Vanilla JavaScript with JSDoc type annotations — no TypeScript source files.
- `tsc --noEmit` enforces type safety via JSDoc (`@param`, `@returns`, `@type`).
- All exported functions must have JSDoc with parameter and return types.
- Use `escapeHTML()` for any user-controlled data interpolated into HTML.
  The XSS scanner enforces this at commit time. Use `/* safe */` to
  annotate verified-safe interpolations.

### Architecture

- Read [ANTI_PATTERNS.md](workers/ANTI_PATTERNS.md) before touching the
  cache or handler code. It documents 12 specific pitfalls with do/don't
  examples.
- The entity registry (`workers/api/entities.js`) is the source of truth
  for what the API exposes. The D1 schema (`database/schema.sql`) is the
  source of truth for storage. These must stay in sync — CI checks this.
- No external runtime dependencies. If you need a library, open an issue
  first to discuss.

### Git workflow

1. Create a feature branch from `main`.
2. Make your changes with descriptive commits.
3. Ensure all pre-commit checks pass.
4. Open a PR against `main`.
5. CI must pass. A maintainer will review.

### Commit messages

Use conventional commit prefixes:

- `feat:` — new feature
- `fix:` — bug fix
- `ci:` — CI/tooling changes
- `docs:` — documentation only
- `refactor:` — code restructuring without behavior change

### What to update when...

| Change | Also update |
|--------|-------------|
| New API field | `entities.js`, `schema.sql`, migration file |
| New UI string | `frontend/locales/strings.json`, all locale files |
| New HTML interpolation | Wrap in `escapeHTML()` or annotate `/* safe */` |
| New worker module | `workers/tsconfig.json` include paths |
| New test file | Verify it runs in `npm test` glob |

## Submitting a PR

- Fill in the PR template — it has a checklist.
- Keep PRs focused. One concern per PR.
- Add tests for new functionality. The project maintains a ~0.85:1
  test-to-code ratio.
- Update documentation if you change behavior.

## Reporting Issues

Use the GitHub issue templates for bug reports and feature requests.
For security issues, see [SECURITY.md](SECURITY.md).
