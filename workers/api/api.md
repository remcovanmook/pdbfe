# PeeringDB API Worker Architecture

The API worker serves a read-only mirror of the PeeringDB database from Cloudflare D1, with per-entity LRU caching and raw JSON byte forwarding.

> See also: [ONBOARDING.md](../ONBOARDING.md), [ANTI_PATTERNS.md](../ANTI_PATTERNS.md), [index.md](../index.md)

## Request Flow

```
Client → wrapHandler (error trap + telemetry headers)
       → validateRequest (method, traversal, scanner probes)
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
├── api/handlers/index.js (handleList, handleDetail, handleAsSet, handleNotImplemented)
│   ├── api/pipeline.js   (cachedQuery, EMPTY_ENVELOPE, isNegative)
│   ├── api/query.js      (buildJsonQuery, buildRowQuery, nextPageParams)
│   ├── api/depth.js      (expandDepth)
│   ├── api/cache.js      (getEntityCache, normaliseCacheKey, TTL constants)
│   └── api/entities.js   (ENTITIES, ENTITY_TAGS, JSON_STORED_COLUMNS)
└── core/cache.js         (LRUCache — instantiated 14 times by api/cache.js)
```

Handlers live in `api/handlers/` for consistency with the debthin worker set.

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

When a paginated list response fills its limit, `handleList` fires a background D1 query for the next page via `ctx.waitUntil()`. The result is encoded and stored in the entity's LRU cache using the `pending` map (same SWR pattern as debthin's `r2Get`). Sequential page requests hit the cache.

### Cache Keys

Cache keys are normalised: URL path + alphabetically sorted query string. This ensures `?limit=10&asn=13335` and `?asn=13335&limit=10` hit the same cache slot.

### ETag / 304

Every response gets a weak ETag generated via DJB2 hash of the payload bytes. Clients sending `If-None-Match` get a `304 Not Modified` without retransmitting the payload.

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

### Restricted Entities

Some PeeringDB entities contain sensitive data gated behind authentication upstream. The entity registry supports this via two builder methods:

- `.restricted()` — marks the entity as requiring auth for full access
- `.anonFilter('visible', 'Public')` — defines a mandatory filter for unauthenticated callers

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
- `enforceAnonFilter()` strips user-supplied `visible=` parameters and injects the mandatory `visible=Public` filter (prevents `?visible=Private` injection in depth expansion contexts)

### Auth Scaffolding

`core/auth.js` provides:
- `extractApiKey(request)` — parses `Authorization: Api-Key <key>` headers
- `verifyApiKey(key)` — stub, always returns `false`

The router calls both on every request. When auth is needed, replace `verifyApiKey()` with a KV namespace lookup. Authenticated callers bypass both the endpoint block and the depth expansion filter.

## Entity Registry

`api/entities.js` is the single source of truth. Adding a new entity type means adding an entry there — the router, query builder, depth expander, and cache all consume it. Entity-level access control metadata (`.restricted()`, `.anonFilter()`) is also defined here.
