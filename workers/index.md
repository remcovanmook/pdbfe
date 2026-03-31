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
- **`handlers/index.js`**: Route handlers for list, detail, AS set, and 501 Not Implemented. Two code paths based on depth:
  - **depth=0 (hot)**: `buildJsonQuery` → D1 returns pre-formatted JSON envelope string → `TextEncoder.encode()` → cache → serve. Zero V8 object allocations per row.
  - **depth>0 (cold)**: `buildRowQuery` → V8 row expansion → `JSON.stringify` → cache → serve.
  - **Stampede protection**: All handlers coalesce concurrent cache-miss requests via `cache.pending`. N requests for the same expired key = 1 D1 query.
  - **SWR pre-fetch**: Paginated next pages fetched in background via `ctx.waitUntil()`.
- **`entities.js`**: Single source of truth for all 13 PeeringDB entity types. Maps API tags to D1 table names, column lists, allowed filter fields, and relationship definitions for depth expansion.
- **`query.js`**: Dual query builder:
  - `buildJsonQuery()` — wraps SELECT in `json_group_array(json_object(...))` returning the full JSON envelope as a single D1 string. JSON-stored columns (`social_media`, `info_types`, `available_voltage_services`) are unwrapped with SQLite `json()` to prevent double-escaping.
  - `buildRowQuery()` — traditional SELECT returning individual rows (for depth>0 expansion).
  - Both share `buildWherePagination()` for filter/pagination SQL construction.
- **`depth.js`**: Depth expansion for `_set` fields. depth=0 is a no-op; depth=1 returns child IDs via batched IN queries.
- **`cache.js`**: Creates and configures 14 per-entity LRU cache instances across three tiers (1024/256/128 slots). Exposes `getCacheStats()`, `purgeAllCaches()`, `purgeEntityCache()`.

## 3. Sync Domain (`workers/sync/`)
Scheduled worker running delta sync from upstream PeeringDB via Cron Trigger (every 15 min). Deployed at `https://pdbfe-sync.remco-vanmook.workers.dev`.

- **`index.js`**: Exports `{ scheduled, fetch }` handlers. Cron reads last sync timestamp from `_sync_meta`, fetches `?since=<epoch>&depth=0` per entity, UPSERTs active rows via `INSERT OR REPLACE`, deletes rows with `status='deleted'`. Batches in groups of 50 to stay within D1 limits. HTTP endpoints for manual control (`GET /sync/status`, `POST /sync/trigger`).
- **`entities.js`**: Re-exports entity definitions from `api/entities.js` (no duplication).

## 4. Tests (`workers/tests/`)

- **`tests/unit/query.test.js`**: Query builder — all filter operators, type coercion, pagination, injection prevention
- **`tests/unit/depth.test.js`**: Depth expansion — mock D1, batched IN queries, empty results
- **`tests/unit/cache.test.js`**: LRU operations, per-entity config, aggregate stats, key normalisation
- **`tests/test_api.js`**: Integration — full router with mock D1, admin endpoints, CORS, 501s, scanner blocking
- **`tests/test_equivalence.js`** (Phase 2): Compares responses against the live PeeringDB API for a set of reference queries
