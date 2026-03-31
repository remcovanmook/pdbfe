# pdbfe Worker Architecture

The Cloudflare Worker codebase is structured to enforce strict boundaries between core network primitives and the PeeringDB application domain.

## 1. Core Primitives (`workers/core/`)
The foundation layer. Contains generic, reusable components that have zero knowledge of PeeringDB entities or the API domain. Shared by both the API and sync workers.

- **`admin.js`**: Shared request validation and administrative endpoints. Exports:
  - `validateRequest(request, rawPath, methods)` — method, traversal, and scanner probe checks. Query strings are allowed (required for PeeringDB filters).
  - `routeAdminPath(rawPath, env, opts)` — robots.txt, health (with D1 probe), secret-gated `_cache_status`/`_cache_flush`
  - `wrapHandler(handler, serviceName)` — error trapping, X-Timer, X-Served-By, and X-Isolate-ID headers
- **`cache.js`**: TypedArray LRU cache. Uses contiguous `Uint32Array`, `Float64Array`, and `Int32Array` blocks for zero-GC eviction. Instantiated 14 times by `api/cache.js` — one per entity type plus `as_set`.
- **`http.js`**: JSON response serving, ETag generation (DJB2 hash), 304 Not Modified handling, precompiled frozen CORS headers, and `encodeJSON()` for single-serialisation-point caching.
- **`utils.js`**: Zero-allocation URL parsing (`parseURL`), PeeringDB filter syntax parser (`parseQueryFilters`), and cache key normalisation (`normaliseCacheKey`).

## 2. API Domain (`workers/api/`)
The primary traffic handler serving read-only PeeringDB API responses.

- **`index.js`**: Top-level router. Validates requests, dispatches to admin endpoints, CORS preflight, entity handlers, or returns 501 for write methods.
- **`handlers/index.js`**: Route handlers for list, detail, AS set, and 501 Not Implemented responses. Implements the L1 cache → pending check → D1 query → encode → cache → serve flow. Fires SWR pre-fetch for paginated next pages via `ctx.waitUntil()`.
- **`entities.js`**: Single source of truth for all 13 PeeringDB entity types. Maps API tags to D1 table names, column lists, allowed filter fields, and relationship definitions for depth expansion.
- **`query.js`**: SQL query builder translating `__lt`, `__gt`, `__contains`, `__startswith`, `__in` filter syntax to parameterised D1 queries. Validates against entity whitelists.
- **`depth.js`**: Depth expansion for `_set` fields. depth=0 is a no-op 1 returns child IDs via batched IN queries. depth=2 is Phase 2.
- **`cache.js`**: Creates and configures 14 per-entity LRU cache instances across three tiers (1024/256/128 slots). Exposes `getCacheStats()`, `purgeAllCaches()`, `purgeEntityCache()`.

## 3. Sync Domain (`workers/sync/`) — Phase 2
Scheduled worker running delta sync from upstream PeeringDB via Cron Trigger.

- **`index.js`**: Exports `{ scheduled }` handler. Reads last sync timestamp from `_sync_meta`, fetches `?since=<epoch>` per entity, UPSERTs into D1.
- **`entities.js`**: Entity-to-table mapping with UPSERT SQL generation and type coercion.
- **`sync.md`**: Architecture documentation for the delta sync strategy.

## 4. Tests (`workers/tests/`)

- **`tests/unit/query.test.js`**: Query builder — all filter operators, type coercion, pagination, injection prevention
- **`tests/unit/depth.test.js`**: Depth expansion — mock D1, batched IN queries, empty results
- **`tests/unit/cache.test.js`**: LRU operations, per-entity config, aggregate stats, key normalisation
- **`tests/test_api.js`**: Integration — full router with mock D1, admin endpoints, CORS, 501s, scanner blocking
- **`tests/test_equivalence.js`** (Phase 2): Compares responses against the live PeeringDB API for a set of reference queries
