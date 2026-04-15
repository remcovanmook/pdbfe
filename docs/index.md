# pdbfe Documentation

## Architecture & Onboarding

- [Worker Architecture](../workers/index.md) — Per-file breakdown of the worker codebase
- [Developer Onboarding](../workers/ONBOARDING.md) — V8 isolate lifecycle, concurrency model, cache architecture, type safety
- [Anti-Patterns](../workers/ANTI_PATTERNS.md) — Forbidden code patterns for hot-path performance
- [API Worker](../workers/api/api.md) — Request flow, caching strategy, query builder, depth expansion
- [Auth Architecture](../workers/auth/auth.md) — OAuth login flow, API key management, user preferences, CORS

## Frontend

- [Frontend Architecture](../frontend/js/ARCHITECTURE.md) — Rendering pipeline, component hierarchy, data flow
- [`<pdb-table>` Component](../frontend/js/components/pdb-table.md) — Column config, sorting, filtering, export, column toggle

## Deployment

- [Deployment Guide](deployment.md) — Cloudflare setup, PeeringDB OAuth, credentials, worker deployment

## Reference

- [Django/D1 Gotchas](django-gotchas.md) — Behavioral divergences between Django+MySQL and Cloudflare Workers+D1
- [PeeringDB API Patterns](peeringdb-api-patterns.md) — Common PeeringDB API integration patterns and consumer workflows
