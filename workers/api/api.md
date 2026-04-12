# PeeringDB API Worker Architecture

The API worker serves a read-only mirror of the PeeringDB database from Cloudflare D1, with per-entity LRU caching and raw JSON byte forwarding.

> See also: [ONBOARDING.md](../ONBOARDING.md), [ANTI_PATTERNS.md](../ANTI_PATTERNS.md), [index.md](../index.md)

## Request Flow

```
Client → wrapHandler (error trap + telemetry headers)
       → validateRequest (method, traversal, scanner probes)
       → extractApiKey / extractSessionId → authenticated
       → isRateLimited (isolate-level, per-IP or per-identity)
       → env.PDB.withSession("first-unconstrained") → db
       → OPTIONS? → handlePreflight (precompiled CORS 204)
       → admin path? → routeAdminPath (robots.txt, health, cache status/flush)
       → POST/PUT/DELETE? → handleNotImplemented (501 JSON)
       → api/{entity} → handleList(db, ...)
       → api/{entity}/{id} → handleDetail(db, ...)
       → api/as_set/{asn} → handleAsSet(db, ...)
       → else → 404
```

## D1 Read Replication

The API worker creates a D1 session per request (`"first-unconstrained"`), enabling global read replication. Queries hit the nearest replica instead of always routing to the primary.

All handler functions receive `db` (typed as `D1Session`) instead of `env`. The sync worker does not use sessions — writes always go to the primary.

## Module Dependency Graph

```
api/index.js (router)
├── core/admin.js         (validateRequest, wrapHandler, routeAdminPath)
├── core/http.js          (encoder, serveJSON, handlePreflight, jsonError, encodeJSON)
├── core/utils.js         (parseURL, parseQueryFilters)
├── core/auth.js          (extractApiKey, verifyApiKey, extractSessionId, resolveSession)
├── api/ratelimit.js      (isRateLimited, normaliseIP, getRateLimitStats, purgeRateLimit)
├── api/handlers/index.js (handleList, handleDetail, handleAsSet, handleNotImplemented)
│   ├── core/swr.js       (withEdgeSWR — L1 read + SWR + cachedQuery miss flow)
│   ├── api/pipeline.js   (cachedQuery, EMPTY_ENVELOPE, isNegative)
│   ├── api/query.js      (buildJsonQuery, buildRowQuery, nextPageParams)
│   ├── api/depth.js      (expandDepth)
│   ├── api/cache.js      (getEntityCache, normaliseCacheKey, TTL constants)
│   └── api/entities.js   (ENTITIES, ENTITY_TAGS, getFilterType, validateQuery)
└── core/cache.js         (LRUCache — instantiated 14× by api/cache.js + 1× by api/ratelimit.js)
```

Handlers live in `api/handlers/` for separation of routing and query logic.

## Caching Strategy

### Per-Entity LRU Caches

Each entity type gets its own LRU cache instance. This prevents heavy traffic on one entity (e.g. `net`) from evicting cached responses for another (e.g. `ix`).

| Tier | Entities | Slots | Max Size |
|---|---|---|---|
| Heavy | net | 1024 | 16 MB |
| Heavy | netixlan | 2048 | 16 MB |
| Mid-high | netfac, org | 512 | 8 MB each |
| Mid | fac, ix | 512 | 4 MB each |
| Low | poc | 256 | 1 MB |
| Light | ixlan, ixpfx, ixfac, carrier, carrierfac, campus | 128 | 1 MB each |

Total: ~64 MB. Remaining ~64 MB is available for working memory and a future pre-cooked answer cache.

### Raw JSON Byte Forwarding (Zero-Allocation Hot Path)

For `depth=0` queries (the common case), JSON construction is pushed down to SQLite. `buildJsonQuery` wraps the SELECT in `json_group_array(json_object(...))`, making D1 return the complete `{"data":[...],"meta":{}}` envelope as a single string. The worker calls `TextEncoder.encode()` on this string and caches the resulting `Uint8Array`. No `JSON.parse`, no row iteration, no `JSON.stringify` — zero transient V8 heap objects per row.

JSON-stored TEXT columns (`social_media`, `info_types`, `available_voltage_services`) are unwrapped with SQLite's `json()` function to prevent double-escaping.

For `depth>0` queries, the handler falls back to `buildRowQuery` (traditional row-level SELECT), expands relationship sets in V8, then calls `encodeJSON()` (one-time `JSON.stringify`). This cold path is cached identically.

### Cache Stampede Protection

All three handlers coalesce concurrent cache-miss requests via the `cache.pending` map. When a popular key expires and N requests arrive before the D1 query resolves, only the first request creates the fetch Promise — the remaining N-1 await the same Promise. The pending entry is cleaned up via `.finally()` regardless of success or failure.

### SWR Pre-fetch

When a paginated list response fills its limit, `handleList` fires a background D1 query for the next page via `ctx.waitUntil()`. The result is encoded and stored in the entity's LRU cache using the `pending` map (same coalescing pattern as cache misses). Sequential page requests hit the cache.

### Cache Keys

Cache keys are normalised: URL path + alphabetically sorted query string. This ensures `?limit=10&asn=13335` and `?asn=13335&limit=10` hit the same cache slot.

Cache keys are **partitioned by authentication state** (prefixed with `auth:` or `anon:`) to prevent cache poisoning. Anonymous users see restricted `poc_set` filtered to `visible=Public`; authenticated users see all visibility levels. Without partitioning, whichever request populates the cache first determines what the other group sees until TTL expires.

### SWR (Stale-While-Revalidate)

Handlers use `withEdgeSWR()` (`core/swr.js`) instead of raw `cache.get()` + `cachedQuery()`. This encapsulates:
1. L1 cache hit with synchronous field extraction (respects the shared `_ret` contract)
2. Fresh entry → serve immediately
3. Stale entry (within SWR window) → serve stale, fire `ctx.waitUntil()` background refresh
4. Expired/miss → block on `cachedQuery()` (L2 → D1 fallback)
5. Negative cache TTL override for 404 entries

See ANTI_PATTERNS.md §12 for rationale.

### Rate Limiting

`api/ratelimit.js` provides isolate-level rate limiting using a dedicated LRU cache instance (4000 slots, 60s window). No KV reads, no external dependencies, sub-millisecond overhead.

- **Anonymous callers**: Keyed by client IP (IPv6 truncated to /64 prefix), 60 req/min per isolate
- **Authenticated callers**: Keyed by API key or session ID, 600 req/min per isolate
- 429 responses include guidance for anonymous callers to authenticate for higher limits
- Stats and flush integrated into the admin `/_cache_status` and `/_cache_flush` endpoints

## Query Builder

`api/query.js` provides two query paths sharing common filter/pagination logic:

### `buildJsonQuery()` (depth=0)
Wraps the SELECT in `json_group_array(json_object(...))` returning a single string. Used on the hot path where no V8-side row processing is needed.

### `buildRowQuery()` (depth>0)
Traditional SELECT returning individual rows for V8-side depth expansion.

### Shared filter logic (`buildWherePagination()`)
- All user input goes through prepared statement `?` bindings
- Filters are validated against the entity's declared filter fields (whitelisted from the OpenAPI spec)
- Unknown fields and operators are silently ignored (matching upstream PeeringDB behaviour)
- Type coercion: numbers → `Number()`, booleans → `0/1`, strings → as-is
- `since` → `WHERE updated >= datetime(?, 'unixepoch')`
- Pagination capped at 250 rows when `depth > 0`

## Depth Expansion

`api/depth.js` handles the `_set` field expansion:

- **depth=0**: No expansion (hot path, D1 returns complete JSON envelope)
- **depth=1**: Each `_set` field contains an array of child IDs. Uses a single batched `IN` query per relationship across all parent rows (falls back to `buildRowQuery` path).

## CORS

Precompiled frozen headers on every response:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
- `OPTIONS` → 204 with CORS headers, no handler logic

## Write Endpoint Handling

`POST`, `PUT`, `PATCH`, `DELETE` on `/api/*` paths return `501 Not Implemented` with a JSON body:
```json
{"error": "POST /api/net is not available on this read-only mirror. See peeringdb.com for write access."}
```

## Authentication & Access Control

### Authentication Methods

The API worker supports two authentication methods, resolved in order:
1. **API Key** (`Authorization: Api-Key pdbfe.<hex>`) — SHA-256 hashed and verified against the USERS KV namespace with a per-isolate 5-minute cache. Upstream PeeringDB API keys are rejected with a 403.
2. **Session token** (`Authorization: Bearer <sid>` or cookie) — verified against the SESSIONS KV namespace.

Both authentication checks complete before rate limiting, so authenticated vs anonymous limits are applied correctly.

### Restricted Entities

Some PeeringDB entities contain sensitive data gated behind authentication upstream. The precompiled entity registry marks these with two properties:

- `_restricted: true` — marks the entity as requiring auth for full access
- `_anonFilter: { field: 'visible', value: 'Public' }` — defines a mandatory filter for unauthenticated callers

Currently only `poc` (network contacts) is restricted. Upstream PeeringDB uses a `visible` field with three levels: `Public` (anyone), `Users` (authenticated), `Private` (org-only).

### Access Control Model

Restricted entities have two layers of access control:

**Direct endpoint access** (`/api/poc`, `/api/poc/{id}`):
- Anonymous callers get empty results immediately — no database query is made
- `/api/poc` returns `{"data":[], "meta":{}}`
- `/api/poc/{id}` returns 404
- This matches upstream PeeringDB, which returns empty for anonymous `/api/poc` requests

**Depth expansion** (`poc_set` in `/api/net?depth=1` or `depth=2`):
- Anonymous callers see only `visible=Public` contacts
- `expandDepth()` adds `WHERE "visible" = ?` to `poc_set` child queries
- `enforceAnonFilter()` strips user-supplied `visible=` parameters and injects the mandatory `visible=Public` filter

## Nullable Fields

Upstream PeeringDB represents absent values as `null`, but D1 stores them as empty strings after bulk import. The query builder applies `NULLIF(column, '')` at query time for all columns marked `nullable: true` in the entity registry, restoring API parity without requiring a D1 rebuild.

Entity metadata is precompiled by `parse_django_models.py` from upstream Django models and the OpenAPI spec. `api/entities.js` re-exports from the generated `extracted/entities-worker.js` module and adds field accessor helpers. Adding a new entity upstream is handled automatically by the pipeline — the router, query builder, depth expander, and cache all consume the registry. Access control metadata (`_restricted`, `_anonFilter`) is derived from the upstream `visible` enum.
