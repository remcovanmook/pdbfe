# Anti-Patterns for pdbfe Workers

This codebase runs inside high-concurrency Cloudflare Worker V8 Isolates. The same constraints from the `debthin` worker set apply here.

Before submitting a PR, ensure your code avoids the following patterns.

---

### 1. URL Parsing
The native `URL` constructor is a massive object allocation sink.

*  **Forbidden:** `const url = new URL(request.url);`
*  **Use:** `const { protocol, rawPath, queryString } = parseURL(request);` (from `core/utils.js`)

### 2. Regular Expressions on the Hot Path
Regex execution paths are unpredictable and subject to ReDoS attacks. On the hot routing path (L1 lookup → response), we use O(N) linear string sweeps instead.

*  **Forbidden on route handlers:** `if (/pattern/.test(value))`
*  **Use:** manual `indexOf` / `startsWith` / `endsWith` checks.
*  *Exception:* Regex is acceptable in cold-boot entity metadata and in test files.

### 3. Functional Array Methods & Spread Syntax on the Hot Path
Creating intermediate arrays via `.map()`, `.filter()`, or spreading `[...a, ...b]` forces V8 GC to clean up dead wrappers.

*  **Forbidden in route handlers:** `const active = items.filter(i => i.valid).map(i => i.id);`
*  **Use:** Standard imperative `for` loops pushing to a pre-allocated array.
*  *Exception:* `.map()` in cold-boot entity metadata construction (e.g. `entities.js`) is acceptable.

### 4. V8-side JSON Serialisation on the Hot Path
For `depth=0` queries, D1 constructs the full JSON envelope via `json_group_array(json_object(...))`. The worker receives a single string and calls `TextEncoder.encode()`. There is no `JSON.parse` and no `JSON.stringify` anywhere on this path.

*  **Forbidden:** `JSON.parse` or `JSON.stringify` in the depth=0 handler path.
*  **Forbidden:** `try/catch` inside a loop on the hot path (V8 de-optimiser).
*  **Architecture:** `buildJsonQuery()` returns the pre-formatted envelope. JSON-stored TEXT columns are unwrapped with SQLite `json()`. The cold path (depth>0) may use `JSON.parse` on individual column values (`parseJsonFields`) and one final `encodeJSON()` — this is acceptable because depth>0 is inherently expensive and rare.

### 5. Dynamic Object Keys (Dictionary Mode)
Adding random keys to an object at runtime forces V8 to abandon its optimized Hidden Classes.

*  **Forbidden:** `const cache = {}; cache[dynamicUserString] = data;`
*  **Use:** `Map` objects for arbitrary key-value storage, or pre-define all keys.

### 6. Unnecessary `async` on Synchronous Cache Reads
The L1 cache lookup (`cache.get(key)`) is synchronous. Wrapping it in `async` adds an unnecessary microtask round-trip.

*  **Forbidden:**
   ```js
   async function lookup(key) {
     return cache.get(key);
   }
   ```
*  **Use:** Keep the L1 read path synchronous. Only introduce `async` at the point where you actually need to `await` a D1 query.

### 7. Bypassing the Pending Map (Cache Stampede)
The `cache.pending` map prevents thundering herd / cache stampede. All three handler entry points (list, detail, as_set) check for an in-flight Promise before creating a new D1 query. If you bypass this, N concurrent requests for the same expired key will spawn N identical D1 queries.

*  **Forbidden:** Querying D1 without checking `cache.pending.has(key)` first.
*  **Required flow:** L1 cache check → pending check → if pending exists, `await` it → if not, create fetch Promise, store in `cache.pending`, clean up via `.finally()`.

### 8. Mutating Cached Buffers
The `Uint8Array` stored in the LRU cache is the *same reference* served to every client. Mutating it corrupts all future cache hits.

*  **Forbidden:** Modifying the buffer returned by `cache.get(key).buf`.
*  **Use:** If you need to modify response data, create a new buffer.

### 9. Querying D1 Outside `cachedQuery()`
All D1 queries in API handlers must flow through `cachedQuery()` (pipeline.js), which owns promise coalescing (cache stampede prevention) and the L1/L2 cache write-back lifecycle.

*  **Forbidden:** Calling `env.PDB.prepare(...).bind(...).all()` directly in handler code without going through `cachedQuery()`.
*  **Forbidden:** Manually manipulating `cache.pending` (`.get()`, `.set()`, `.delete()`). Coalescing is internal to `cachedQuery()`.
*  **Required flow:** Pass a `queryFn` closure to `cachedQuery()`. The closure receives no arguments — capture what you need from the outer scope.
*  **Exception:** `depth.js` child-set queries run inside a `queryFn` closure that already went through `cachedQuery()`. This is correct.
*  **Exception:** Admin endpoints (`handleSyncStatus`, `/health`, `/_cache_status`) query D1 directly. These are low-traffic diagnostic paths where caching would defeat the purpose.

### 10. Awaiting L2 Cache Writes
`putL2()` writes to the per-PoP Cache API. These writes are fire-and-forget — the response should not block on them.

*  **Forbidden:** `await putL2(key, buf, ttl);` on the response path.
*  **Use:** `putL2(key, buf, ttl);` — the returned Promise resolves in the background.
*  *Exception:* Inside `ctx.waitUntil()` closures, awaiting is fine.
