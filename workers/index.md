# pdbfe Worker Architecture

The Cloudflare Worker codebase is structured to enforce strict boundaries between core network primitives and the PeeringDB application domain.

## 1. Core Primitives (`workers/core/`)
The foundation layer. Contains generic, reusable components that have zero knowledge of PeeringDB entities or the API domain. Shared by both the API and sync workers.

- **`admin.js`**: Shared request validation and administrative endpoints. Exports:
  - `validateRequest(request, rawPath, methods)` — method, traversal, and scanner probe checks. Query strings are allowed (required for PeeringDB filters).
  - `routeAdminPath(rawPath, env, opts)` — robots.txt, health (with D1 probe), secret-gated `_cache_status`/`_cache_flush`
  - `wrapHandler(handler, serviceName)` — error trapping, X-Timer, X-Served-By, and X-Isolate-ID headers
- **`cache.js`**: TypedArray LRU cache. Uses contiguous `Uint32Array`, `Float64Array`, and `Int32Array` blocks for zero-GC eviction. Instantiated 14 times by `api/cache.js` (one per entity) and once by `api/ratelimit.js`.
- **`http.js`**: JSON response serving, ETag generation (DJB2 hash), 304 Not Modified handling, precompiled frozen CORS headers, and `encodeJSON()` for single-serialisation-point caching.
- **`utils.js`**: Zero-allocation URL parsing (`parseURL`) and PeeringDB filter syntax parser (`parseQueryFilters`). Cache-key normalisation lives in `api/cache.js`.
- **`auth.js`**: API key extraction from `Authorization: Api-Key` headers, SHA-256 key verification against USERS KV with per-isolate 5-minute cache, session ID extraction from Bearer tokens and cookies, and session resolution against SESSIONS KV.
- **`swr.js`**: `withEdgeSWR()` — stale-while-revalidate wrapper that encapsulates L1 cache reads, synchronous field extraction (shared `_ret` contract), SWR background refresh via `ctx.waitUntil()`, and `cachedQuery()` fallback for misses. Used by all API handlers instead of raw cache + pipeline calls.

## 2. API Domain (`workers/api/`)
The primary traffic handler serving read-only PeeringDB API responses.

- **`index.js`**: Top-level router. Resolves authentication (API key or session), applies per-isolate rate limiting, validates requests, dispatches to admin endpoints, CORS preflight, entity handlers, or returns 501 for write methods.
- **`pipeline.js`**: Shared D1 query pipeline used by all handlers. The `cachedQuery()` function encapsulates promise coalescing (stampede prevention), L2 cache lookups, D1 query execution, and L1+L2 cache write-back. Handlers pass a `queryFn` closure containing D1-specific logic. Also exports `EMPTY_ENVELOPE` (negative cache sentinel) and `isNegative()` (byte-level sentinel detection for L2 cache entries).
- **`handlers/index.js`**: Route handlers for list, detail, AS set, count, and 501 Not Implemented. Two code paths based on depth:
  - **depth=0 (hot)**: `buildJsonQuery` → D1 returns pre-formatted JSON envelope string → `TextEncoder.encode()` → cache → serve. Zero V8 object allocations per row.
  - **depth>0 (cold)**: `buildRowQuery` → V8 row expansion → `JSON.stringify` → cache → serve.
  - **D1 query pipeline**: All D1 queries delegate to `cachedQuery()` (pipeline.js) which owns promise coalescing, L2 cache reads/writes, and negative caching.
  - **SWR pre-fetch**: Paginated next pages fetched in background via `ctx.waitUntil()`.
- **`entities.js`**: Single source of truth for all 13 PeeringDB entity types. Maps API tags to D1 table names, column lists, allowed filter fields, and relationship definitions for depth expansion. Also exports `JSON_STORED_COLUMNS` — the set of columns that store JSON as TEXT in D1 — consumed by `query.js`, `depth.js`, and `handlers/index.js`.
- **`query.js`**: Dual query builder:
  - `buildJsonQuery()` — wraps SELECT in `json_group_array(json_object(...))` returning the full JSON envelope as a single D1 string. JSON-stored columns (`social_media`, `info_types`, `available_voltage_services`) are unwrapped with SQLite `json()` to prevent double-escaping.
  - `buildRowQuery()` — traditional SELECT returning individual rows (for depth>0 expansion).
  - Both share `buildWherePagination()` for filter/pagination SQL construction.
- **`depth.js`**: Depth expansion for `_set` fields. depth=0 is a no-op; depth=1 returns child IDs via batched IN queries.
- **`cache.js`**: Creates and configures 14 per-entity LRU cache instances across three tiers (1024/256/128 slots). Exposes `getCacheStats()`, `purgeAllCaches()`, `purgeEntityCache()`, `normaliseCacheKey()`. Defines TTL constants: `LIST_TTL` (5 min), `DETAIL_TTL` (15 min), `COUNT_TTL` (15 min), `NEGATIVE_TTL` (5 min).
- **`ratelimit.js`**: Isolate-level rate limiter using a dedicated LRU cache (4000 slots, 60s window). IPv6 addresses normalised to /64 prefixes. Anonymous callers keyed by IP (60/min), authenticated by API key or session ID (600/min). Exports `isRateLimited()`, `normaliseIP()`, `getRateLimitStats()`, `purgeRateLimit()`.
- **`l2cache.js`**: Per-PoP L2 cache using Cloudflare's Cache API (`caches.default`). Functions `getL2(cacheKey)` and `putL2(cacheKey, buf, ttlSeconds)` store/retrieve `Uint8Array` payloads keyed by synthetic URLs under `https://pdbfe-l2.internal/`. Errors silently degrade to D1 fallback.

## 3. Sync Domain (`workers/sync/`)
Scheduled worker running delta sync from upstream PeeringDB via Cron Trigger (every 15 min).

- **`index.js`**: Exports `{ scheduled, fetch }` handlers. Cron reads last sync timestamp from `_sync_meta`, fetches `?since=<epoch>&depth=0` per entity, UPSERTs active rows via `INSERT OR REPLACE`, deletes rows with `status='deleted'`. Batches in groups of 50 to stay within D1 limits. HTTP endpoints for manual control (`GET /sync/status`, `POST /sync/trigger`).
- **`entities.js`**: Re-exports entity definitions from `api/entities.js` (no duplication).

## 4. Tests (`workers/tests/`)

- **`tests/unit/query.test.js`**: Query builder — all filter operators, type coercion, pagination, injection prevention
- **`tests/unit/depth.test.js`**: Depth expansion — mock D1, batched IN queries, empty results
- **`tests/unit/cache.test.js`**: LRU operations, per-entity config, aggregate stats, key normalisation, negative cache TTL contracts, EMPTY_ENVELOPE sentinel detection
- **`tests/unit/ratelimit.test.js`**: Rate limiter — per-IP/per-identity limits, window expiry, IPv6 /64 normalisation, stats, purge
- **`tests/unit/auth.test.js`**: API key extraction/verification (SHA-256), session resolution, key hashing
- **`tests/unit/account.test.js`**: API key CRUD: create, list, delete, validation
- **`tests/unit/oauth.test.js`**: OAuth flow: start redirect, callback token exchange, logout, error handling
- **`tests/unit/pipeline.test.js`**: cachedQuery pipeline: cache miss/hit, coalescing, negative caching, error propagation
- **`tests/unit/swr.test.js`**: withEdgeSWR: fresh/stale/miss paths, negative cache, background refresh, error handling
- **`tests/unit/visibility.test.js`**: Anonymous visibility filters: enforceAnonFilter, depth expansion poc filtering
- **`tests/unit/status.test.js`**: /status endpoint: sync metadata, Content-Type, CORS
- **`tests/unit/sync.test.js`**: Auto-schema evolution: ensureColumns, ALTER TABLE for missing fields
- **`tests/test_api.js`**: Integration — full router with mock D1, admin endpoints, CORS, 501s, scanner blocking
- **`tests/test_conformance.js`**: Envelope, schema, query parameter, data type, cross-endpoint, and error handling conformance against live upstream PeeringDB
- **`tests/test_conformance_extended.js`**: Substring/prefix filters, carrier/campus entities, timestamp ranges, sorting, concurrency, field selection, numeric filters
- **`tests/test_equivalence.js`**: Compares responses against the live PeeringDB API for a set of reference queries
- **`tests/loadtest.js`**: Production load test covering sequential cold/warm scenarios, parallel bursts, sustained throughput, and negative cache (404) validation across entity types
