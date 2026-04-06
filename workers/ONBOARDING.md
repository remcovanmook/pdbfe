# pdbfe Worker Architecture & Onboarding

Read this document and [`ANTI_PATTERNS.md`](./ANTI_PATTERNS.md) before modifying any routing handlers or core utilities.

---

## 1. Project Layout

This repository contains **three independent Cloudflare Workers**, each with its own `wrangler.toml`, bindings, and env type:

| Worker | Directory | Env Type | Wrangler Config | Purpose |
|---|---|---|---|---|
| pdbfe-api | `workers/api/` | `PdbApiEnv` | `wrangler.toml` | Read-only PeeringDB API mirror |
| pdbfe-sync | `workers/sync/` | `PdbSyncEnv` | `wrangler-sync.toml` | Cron delta sync from upstream PeeringDB |
| pdbfe-auth | `workers/auth/` | `PdbAuthEnv` | `wrangler-auth.toml` | PeeringDB OAuth login + API key management |

Shared code lives in `workers/core/` — the generic cache, HTTP, auth, and routing library with no domain knowledge. Type contracts for all env interfaces live in `workers/types.d.ts`.

For a per-file breakdown, see [`index.md`](./index.md).

**Entry point:** Every worker's `index.js` exports `wrapHandler(handler, serviceName)` (from `core/admin.js`). This is the function Cloudflare calls, the error boundary, and the source of `X-Timer`/`X-Served-By` headers. The env type flows end-to-end via a `@template E` generic — if your handler declares `@param {PdbApiEnv} env`, tsc enforces that at the module boundary.

---

## 2. The V8 Isolate Lifecycle

Cloudflare Workers do not behave like traditional Node.js servers. They spin up instantly (Cold Boot) and stay alive (Warm) as long as traffic dictates, before being silently evicted.

* **Global Scope (Cold Boot):** Code executed *outside* the `fetch()` handler runs once per isolate lifetime. This is where we allocate per-entity LRU caches, parse the entity registry, and derive relationship metadata.
* **Request Scope (Hot Path):** Code executing *inside* `handleRequest`. This must be tightly optimised. Every CPU cycle spent here delays the socket response.
* **Time:** `Date.now()` does not advance in the global scope (V8 side-channel protection). It only advances inside the request handler. This is why `ISOLATE_START_TIME` in `core/admin.js` is captured lazily on first request.

## 3. Concurrency & The Cache Stampede

A single V8 isolate handles hundreds of concurrent requests on the *same thread*.

If 50 requests hit the same D1 query simultaneously without coordination, you get 50 outbound D1 queries. **This is why `cache.pending` exists.**

Before executing any D1 query for a cache miss, `cachedQuery()` (pipeline.js) checks `cache.pending.has(key)`. If true, it `await`s the shared Promise. Never bypass this coalescence lock.

### D1 Query Serialisation

D1 handles query serialisation internally — SQLite is single-threaded with its own request queue. No application-level concurrency limiter is needed.

### D1 Read Replication

The API worker creates a D1 session per request using `env.PDB.withSession("first-unconstrained")`. This enables global read replication — D1 routes read queries to the nearest replica rather than the primary. This is optimal because:

- The API worker is read-only (all writes happen in the sync worker).
- Eventual consistency is acceptable given our 5–15 minute cache TTLs.
- The sync worker does **not** use sessions — writes always go to the primary.

Handler functions receive a `D1Session` parameter named `db` instead of the full `env` object. This keeps the session boundary explicit and prevents accidental direct `env.PDB` access in query code.

## 4. Authentication

The API worker supports two authentication methods, resolved in this order:

1. **API Key** (`Authorization: Api-Key pdbfe.<hex>`) — verified against the USERS KV namespace. Only pdbfe-issued keys are accepted; upstream PeeringDB API keys are rejected with a 403.
2. **Session token** (`Authorization: Bearer <sid>` or cookie) — verified against the SESSIONS KV namespace.

Unauthenticated callers:
- Cannot access restricted entities (`poc`) — direct queries return `{"data":[]}`.
- Have `visible=Public` filters applied during depth expansion on poc_set.

The auth worker handles the OAuth ceremony (`/auth/start`, `/auth/callback`, `/auth/logout`) and API key CRUD (`/api-keys/*`). See [`auth/auth.md`](./auth/auth.md) for details.

## 5. The Cache Architecture

The API uses a three-tier cache hierarchy:

### L1: Per-Isolate LRU (RAM)

The `LRUCache` (`core/cache.js`) uses contiguous typed arrays (`Uint32Array`, `Float64Array`, `Int32Array`) instead of doubly-linked lists. This avoids wrapper object allocations and associated GC pauses.

**Per-entity isolation:** Each of the 13 entity types gets its own LRU cache instance (plus one for `as_set` lookups). This prevents hot entities (net, netixlan) from evicting cold ones (carrier, campus). Cache tiers:

| Tier | Entities | Slots | Max Size |
|---|---|---|---|
| Heavy | net | 1024 | 16 MB |
| Heavy | netixlan | 2048 | 16 MB |
| Mid-high | netfac, org | 512 | 8 MB each |
| Mid | fac, ix | 512 | 4 MB each |
| Low | poc | 256 | 1 MB |
| Light | ixlan, ixpfx, ixfac, carrier, carrierfac, campus, as_set | 128 | 1 MB each |

Total: ~59 MB. Remaining ~69 MB of the 128 MB isolate budget is for working memory, V8 heap, and the D1 query pipeline.

**Zero-serialisation serving:** D1 results are JSON-encoded *once* into a `Uint8Array` via `encodeJSON()`, then stored in the LRU cache. On cache hits, the bytes are forwarded directly as the `Response` body — no `JSON.parse` or `JSON.stringify` round-trip.

**TTLs:** `LIST_TTL` = 5 min, `DETAIL_TTL` = 15 min, `COUNT_TTL` = 15 min, `NEGATIVE_TTL` = 5 min, `ERROR_TTL` = 5 min.

### L2: Per-PoP Cache API (`caches.default`)

`l2cache.js` stores `Uint8Array` payloads in Cloudflare's per-PoP `caches.default` Cache API. Multiple isolates at the same PoP share this cache, so a cold isolate can skip D1 if another isolate at the same PoP already fetched the same key.

- Keys are synthetic URLs under `https://pdbfe-l2.internal/`
- TTL is set via `Cache-Control` headers on stored `Response` objects
- Errors silently degrade to D1 fallback (L2 is best-effort)

### L3: D1 (Global)

SQLite-backed Cloudflare D1. The source of truth. Updated every 15 minutes by the sync worker via delta sync (`?since=<epoch>`).

### Negative and Error Caching

- **404s:** Non-existent entity IDs are cached at L1 and L2 using `EMPTY_ENVELOPE` as a sentinel. Negative TTL is 5 minutes (shorter than detail TTL since entities can be created).
- **400s:** Invalid query errors (unknown fields, bad operators) are cached in L1 and L2 per-entity. The error body is deterministic for the same query string, so caching prevents repeated validation.

## 6. The `ctx.waitUntil()` Pattern

We use `ctx.waitUntil()` for:

1. **SWR pre-fetch:** When a paginated list response fills its limit, the handler fires a background D1 query for the next page. The result is encoded and stored in the entity cache.
2. **Non-blocking cache updates:** L2 writes are fire-and-forget. See `putL2()` in `l2cache.js`.

**Danger:** `waitUntil` executes *after* the client socket closes. Do not reference short-lived request objects (like reading a request stream) inside a `waitUntil` closure.

## 7. Request Flow

Every API request follows this hierarchy:

1. **Authentication:** Resolve API key or session token. Reject upstream PeeringDB keys.
2. **Routing:** Parse entity tag and optional ID from the path. Validate method, entity, filters.
3. **Error cache:** Check L1 for a cached 400 for this query string. If found, return it.
4. **L1 (RAM):** Is it in the entity's LRU cache and not expired? Serve instantly (<1ms). For negative entries (`EMPTY_ENVELOPE`), return 404.
5. **`cachedQuery()` pipeline** (pipeline.js):
   - **Coalesce:** Is the same cache key in `cache.pending`? Await the in-flight promise.
   - **L2 PoP cache:** Is it in `caches.default`? Populate L1 from L2, return.
   - **D1:** Execute the handler's `queryFn` closure.
   - **Write-back:** Store result in L1 + L2 (fire-and-forget), return.
   - If `queryFn` returns `null`, `EMPTY_ENVELOPE` is stored with `NEGATIVE_TTL`.
6. **Background:** If paginated, `waitUntil` to pre-fetch next page.

## 8. Type Safety

* **Zero-build:** We use `tsc --noEmit` via `checkJs`. Full LSP autocomplete and CI compile-time safety, but code shipped to the edge is 100% vanilla JavaScript.
* **Global contracts:** All environment bindings (`D1Database`, `KVNamespace`, `ADMIN_SECRET`) are defined in `workers/types.d.ts`. Entity metadata, cache types, and query builder types are also defined there.
* **Validation:** Run `npx tsc --noEmit` (or `npm run typecheck`). If it throws, the code will fail CI.

## 9. Testing

Tests are split by scope:

| Suite | Location | Command | Description |
|---|---|---|---|
| Unit tests | `workers/tests/unit/*.test.js` | `npm test` | 9 files. Individual module tests with mock D1 (query, cache, depth, auth, OAuth, pipeline, visibility, status, account) |
| Integration | `workers/tests/test_api.js` | `npm run test:integration` | Full router with mock D1: admin endpoints, CORS, entity routing, error handling |
| Conformance | `workers/tests/test_conformance*.js` | `npm run test:conformance` | Validates API behavior against the live PeeringDB API |
| Equivalence | `workers/tests/test_equivalence.js` | `npm run test:equivalence` | Side-by-side comparison of mirror vs upstream responses |
| Frontend | `frontend/tests/*.test.js` | `cd frontend && npm test` | SPA rendering and markdown parser tests |

The unit and integration tests use mock D1 bindings — no real database needed. See `tests/test_api.js` for the mock pattern.

Conformance and equivalence tests require a running instance and `PDBFE_URL` / `PEERINGDB_API_KEY` environment variables.

## 10. Local Development

```bash
# 1. Copy example configs and fill in your resource IDs
cp wrangler.toml.example wrangler.toml
cp wrangler-sync.toml.example wrangler-sync.toml
cp wrangler-auth.toml.example wrangler-auth.toml

# 2. Populate local D1
cd ../database && ./migrate-to-d1.sh --fetch && cd ../workers

# 3. Run API worker locally (XDG overrides keep wrangler state in-tree)
XDG_CONFIG_HOME=.wrangler-home XDG_DATA_HOME=.wrangler-home npx wrangler dev

# 4. Run auth worker locally (separate terminal, different port)
XDG_CONFIG_HOME=.wrangler-home XDG_DATA_HOME=.wrangler-home npx wrangler dev --config wrangler-auth.toml --port 8788

# 5. Type check
npm run typecheck

# 6. Unit tests
npm test
```
