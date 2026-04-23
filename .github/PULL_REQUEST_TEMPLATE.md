## Description

<!-- Brief summary of what this PR does and why. -->

## Changes

<!-- List the key changes, grouped by component if needed. -->

## Checklist

- [ ] Pre-commit checks pass (`git config core.hooksPath .githooks`)
- [ ] New code has JSDoc type annotations
- [ ] New HTML interpolations use `escapeHTML()` or `/* safe */`
- [ ] Tests added/updated for new functionality
- [ ] If new API field: updated `entities.js`, `schema.sql`, and added migration
- [ ] If new UI string: added to `strings.json` and all locale files
- [ ] Documentation updated (if behavior changed)
- [ ] `VERSION` bumped via `./scripts/bump_version.sh <patch|minor|major>` (skip for `ci:` / `docs:` / `refactor:` / `chore:` PRs)
