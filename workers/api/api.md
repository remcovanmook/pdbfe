# PeeringDB API Worker Architecture

The API worker serves a read-only mirror of the PeeringDB database from Cloudflare D1, with per-entity LRU caching and raw JSON byte forwarding.

> See also: [ONBOARDING.md](../ONBOARDING.md), [ANTI_PATTERNS.md](../ANTI_PATTERNS.md), [index.md](../index.md)

## Request Flow

```
Client → wrapHandler (error trap + telemetry headers)
       → validateRequest (method, traversal, scanner probes)
       → identifyCaller (core/gate.js): API key unverified, Bearer session via KV → authenticated
       → rateLimited (Workers rate-limit binding RL_AUTH / RL_ANON, per location)
       → startVerification: API key looked up in USERDB alongside the request's D1 work
       → env.PDB.withSession("first-unconstrained") → db
       → OPTIONS? → handlePreflight (precompiled CORS 204)
       → admin path? → routeAdminPath (robots.txt, health, cache status/flush)
       → POST/PUT/DELETE? → handleNotImplemented (501 JSON)
       → api/compare → handleCompare(db, ...)
       → api/{entity} → handleList(db, ...)
       → api/{entity}/{id} → handleDetail(db, ...)
       → api/as_set/{asn} → handleAsSet(db, ...)
       → else → 404
```

## D1 Read Replication

The API worker creates a D1 session per request (`"first-unconstrained"`), enabling global read replication. Queries hit the nearest replica instead of always routing to the primary.

All handler functions receive `db` (typed as `D1Session`) instead of `env`. The sync worker does not use sessions — writes always go to the primary.

## Module Layout

```
api/
├── index.js          Router, request gate (core/gate.js)
├── cache.js          Per-entity LRU caches, TTLs, withEdgeSWR(), cachedQuery()
├── http.js           serveJSON, jsonError, header sets
├── entities.js       Entity registry (re-exports extracted/entities-worker.js)
├── query.js          buildJsonQuery, buildJsonFragmentQuery, buildRowQuery, nextPageParams
├── json_list.js      depth=0 lists: pages of D1-built JSON, buffered or streamed
├── depth.js          expandDepth (_set field expansion)
├── utils.js          parseQueryFilters
├── sync_state.js     Entity version tracking
└── handlers/
    ├── index.js      Re-exports from handler modules
    ├── list.js       handleList, executeListQuery, handlePaged, prefetchPage
    ├── detail.js     handleDetail, executeDetailQuery
    ├── as_set.js     handleAsSet
    ├── compare.js    handleCompare
    └── shared.js     handleNotImplemented, parseJsonFields, countRows
```

Dependencies flow downward: handlers → `cache.js` / `query.js` / `http.js` → `core/`.
No cross-worker imports — shared logic lives in `core/`.

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

Total: ~64 MB. Remaining ~64 MB is available for working memory.

### Raw JSON Byte Forwarding (Zero-Allocation Hot Path)

For `depth=0` queries (the common case), JSON construction is pushed down to SQLite. A list page (`buildJsonFragmentQuery`) returns its rows' JSON comma-joined, `group_concat(json_object(...), ',')`, with their count; the worker encodes each page once as it arrives and assembles `{"data":[` + pages + `],"meta":{}}` from byte chunks (never by joining strings), caching the resulting `Uint8Array`. A detail (`buildJsonQuery`) returns the whole envelope from `json_group_array`. A page is at most the entity's `PAGE_ROWS` (json_list.js), sized from measured row sizes to stay under D1's ~8 MB limit on a computed string; an unfiltered list of a table larger than a page streams to the client as a pull-based byte stream (the next page is queried only once the client has taken the last; first byte after the first page, one page in memory) instead of being cached (ANTI_PATTERNS.md §9). No `JSON.parse`, no row iteration, no `JSON.stringify` — zero transient V8 heap objects per row.

JSON-stored TEXT columns (`social_media`, `info_types`, `available_voltage_services`) are unwrapped with SQLite's `json()` function to prevent double-escaping.

For `depth>0` queries, the handler falls back to `buildRowQuery` (traditional row-level SELECT), expands relationship sets in V8, then calls `encodeJSON()` (one-time `JSON.stringify`). This cold path is cached identically.

### Cache Stampede Protection

All handlers coalesce concurrent cache-miss requests via the `cache.pending` map. When a popular key expires and N requests arrive before the D1 query resolves, only the first request creates the fetch Promise — the remaining N-1 await the same Promise. The pending entry is cleaned up via `.finally()` regardless of success or failure.

### SWR (Stale-While-Revalidate)

Handlers use `withEdgeSWR()` from `cache.js` instead of raw `cache.get()` + `cachedQuery()`. This encapsulates:
1. L1 cache hit with synchronous field extraction (respects the shared `_ret` contract)
2. Fresh entry → serve immediately
3. Stale entry (within SWR window) → serve stale, fire `ctx.waitUntil()` background refresh
4. Expired/miss → block on `cachedQuery()` (D1)
5. Negative cache TTL override for 404 entries

`cachedQuery()` is also in `cache.js` — a thin wrapper around `core/pipeline.js` that injects the API worker's `NEGATIVE_TTL` and `getEntityVersion`.

### SWR Pre-fetch

When a paginated list response fills its limit, `handleList` fires a background D1 query for the next page via `ctx.waitUntil()`. The result is encoded and stored in the entity's LRU cache using the `pending` map (same coalescing pattern as cache misses). Sequential page requests hit the cache.

### Cache Keys

Cache keys are normalised (`core/cache.js`): URL path + alphabetically sorted query string. This ensures `?limit=10&asn=13335` and `?asn=13335&limit=10` hit the same cache slot.

Cache keys are **partitioned by authentication state** (prefixed with `auth:` or `anon:`) to prevent cache poisoning. Anonymous users see restricted `poc_set` filtered to `visible=Public`; authenticated users see all visibility levels.

### Rate Limiting

Workers rate-limit bindings (`RL_ANON` / `RL_AUTH`, `[[ratelimits]]` in wrangler.toml), checked by `core/gate.js`. Counters are shared by every isolate in a Cloudflare location and read from a locally cached count: no round trip. They are approximate (eventually consistent, per location), which is enough to stop floods.

- **Anonymous callers**: Keyed by client IP (IPv6 truncated to /64 prefix), 60 req/min per location
- **API key or valid session**: Keyed by the key or session ID, 600 req/min per location. An API key counts before it is verified; an invalid one ends in a 401 either way.
- 429 responses include guidance for anonymous callers to authenticate for higher limits

## Query Builder

`api/query.js` provides two query paths sharing common filter/pagination logic:

### `buildJsonQuery()` / `buildJsonFragmentQuery()` (depth=0)
`buildJsonQuery` wraps the SELECT in `json_group_array(json_object(...))` returning the whole envelope as a single string (details). `buildJsonFragmentQuery` returns the same rows as `group_concat(json_object(...), ',')` plus `COUNT(*)` (list pages). Used on the hot path where no V8-side row processing is needed.

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
1. **API Key** (`Authorization: Api-Key pdbfe.<hex>`) — any key without the `pdbfe.` prefix (an upstream PeeringDB key) is rejected with a 403 before any lookup. A pdbfe key is served as authenticated straight away while it is SHA-256 hashed and verified against USERDB (per-isolate 5-minute cache) alongside the request's own D1 work; the response leaves only once the key holds. An unknown, revoked or expired key gets a **401**, never the data.
2. **Session token** (`Authorization: Bearer <sid>` or cookie, the frontend's) — verified against SESSIONS KV *before* the rate limit. A session that does not hold is served anonymously (not refused), so it must not pick its own rate-limit bucket.

Rate limits (`[[ratelimits]]` in the wrangler configs, core/gate.js): 60/min anonymous by IP (IPv6 /64), 600/min per API key or session. They are Workers rate-limit bindings: counted per Cloudflare location across all isolates, approximate.

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
