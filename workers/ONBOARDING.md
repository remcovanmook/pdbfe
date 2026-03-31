# pdbfe Worker Architecture & Onboarding

This system operates as a read-only PeeringDB mirror on Cloudflare Workers + D1. It shares the same performance constraints and architectural principles as the `debthin` worker set.

Read this document and [`ANTI_PATTERNS.md`](./ANTI_PATTERNS.md) before modifying any routing handlers or core utilities.

---

## 1. Project Layout

This repository contains **two independent Cloudflare Workers**, each with its own `wrangler.toml`, D1 binding, and env type:

| Worker | Directory | Env Type | Wrangler Config | Purpose |
|---|---|---|---|---|
| pdbfe-api | `workers/api/` | `PdbApiEnv` | `wrangler.toml` | Read-only PeeringDB API mirror |
| pdbfe-sync | `workers/sync/` | `PdbSyncEnv` | `wrangler-sync.toml` | Cron delta sync from upstream PeeringDB |

Both share `workers/core/` — the generic cache, HTTP, and routing library with no domain knowledge. Type contracts for all env interfaces live in `workers/types.d.ts`.

For a detailed per-file breakdown, see [`index.md`](./index.md).

**Entry point:** Every worker's `index.js` exports `wrapHandler(handler, serviceName)` (from `core/admin.js`). This is the function Cloudflare calls, the error boundary, and the source of `X-Timer`/`X-Served-By` headers. The env type flows end-to-end via a `@template E` generic — if your handler declares `@param {PdbApiEnv} env`, tsc enforces that at the module boundary.

---

## 2. The V8 Isolate Lifecycle

Cloudflare Workers do not behave like traditional Node.js servers. They spin up instantly (Cold Boot) and stay alive (Warm) as long as traffic dictates, before being silently evicted.

* **Global Scope (Cold Boot):** Code executed *outside* the `fetch()` handler runs exactly once per Isolate lifecycle. This is where we allocate the 14 per-entity LRU caches and parse static configuration.
* **Request Scope (Hot Path):** Code executed *inside* `handleRequest`. This must be tightly optimized. Every CPU cycle spent here delays the socket response.
* **Time:** `Date.now()` does not advance in the global scope to prevent side-channel attacks. It only advances inside the request handler. This is why `ISOLATE_START_TIME` in `core/admin.js` is captured lazily on first request.

## 3. Concurrency & The Cache Stampede

A single V8 Isolate handles hundreds of concurrent requests on the *same thread*.

If 50 requests ask for the same D1 query simultaneously, and you do not coordinate them, you will trigger 50 outbound D1 queries.
**This is why `cache.pending` exists.**

Before executing any D1 query for a cache miss, the system checks `cache.pending.has(key)`. If true, it `await`s the shared Promise. **Never bypass this coalescence lock.** The SWR pre-fetch for paginated next-page queries uses this same mechanism.

## 4. The L1 Memory Architecture

Our `LRUCache` (`core/cache.js`) bypasses traditional doubly-linked list implementations. Wrapper objects cause GC pauses. Instead, we use contiguous C-style memory blocks: `Uint32Array`, `Float64Array`, and `Int32Array`.

**Per-entity isolation:** Each of the 14 entity types gets its own LRU cache instance. This prevents hot entities (net, org) from evicting cold ones (carrier, campus). Cache tiers:

| Tier | Entities | Slots | Max Size |
|---|---|---|---|
| Heavy | net, org, netixlan | 1024 | 16 MB each |
| Medium | netfac, poc, fac | 256 | 4 MB each |
| Light | everything else | 128 | 2 MB each |

Total: 76 MB. Remaining ~52 MB is for working memory and future pre-cooked answer caches.

**Zero-serialisation serving:** D1 results are JSON-encoded *once* into a `Uint8Array` via `encodeJSON()`, then stored in the LRU cache. On cache hits, the bytes are forwarded directly as the `Response` body — no `JSON.parse` or `JSON.stringify` round-trip. This is the critical performance guarantee.

## 5. The `ctx.waitUntil()` Pattern

We use `ctx.waitUntil()` for two purposes:

1. **SWR pre-fetch:** When a paginated list response fills its limit, the handler fires a background D1 query for the next page. The result is encoded and stored in the entity cache.
2. **Non-blocking cache updates:** Future sync signal handling may use `waitUntil` to invalidate cache entries without blocking the response.

**Danger:** `waitUntil` executes *after* the client socket closes. Do not reference short-lived request objects (like reading a request stream) inside a `waitUntil` closure.

## 6. Request Flow Decision Tree

Every API request follows this strict hierarchy:

1. **L1 Warm (RAM):** Is it in the entity's LRU cache and not expired? → *Serve instantly (<1ms), raw bytes.*
2. **Flight Check:** Is the same cache key in `cache.pending`? → *Await the in-flight promise, then re-check L1.*
3. **Cold Path (D1):** Execute the parameterised SQL query against D1.
4. **Encode & Cache:** JSON-encode once into `Uint8Array`, store in entity cache, serve.
5. **Background:** If paginated, `waitUntil` to pre-fetch next page into cache.

## 7. Type Safety (The `tsc` Harness)

* **Zero-Build Step:** We use `tsc --noEmit` via `checkJs`. Full LSP autocomplete and CI compile-time safety, but code shipped to the edge is 100% vanilla JavaScript.
* **Global Contracts:** All environment bindings (`D1Database`, `ADMIN_SECRET`) are defined in `workers/types.d.ts`. Entity metadata, cache types, and query builder types are also defined there.
* **Validation:** Run `npx tsc --noEmit` (or `npm run typecheck`). If the compiler throws an error, your code will fail CI.

## 8. Unit Testing

* **The Test Suite:** Located in `workers/tests/unit/` and `workers/tests/test_api.js`.
* **Execution:** `npm test` for unit tests, `npm run test:integration` for router tests.
* **Testing with mock D1:** The integration tests construct a mock D1 binding that returns pre-defined rows. This lets us test the full router without a real database. See `tests/test_api.js` for the pattern.

## 9. Local Development

1. **Create D1:** `wrangler d1 create peeringdb`
2. **Populate:** `./database/migrate-to-d1.sh` (local dev mode)
3. **Run Locally:** `npx wrangler dev --config workers/wrangler.toml`
4. **Test:** Compare responses against `https://www.peeringdb.com/api/net?limit=5`
