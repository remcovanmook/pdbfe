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

### 4. Dynamic JSON on the Hot Path
`JSON.parse` and `JSON.stringify` on response data should happen *exactly once* per cache miss.

*  **Forbidden:** Parsing or serialising inside a cache-hit code path.
*  **Architecture:** `encodeJSON()` encodes once to `Uint8Array`. Cache hits serve the stored bytes directly. The only `JSON.parse` on the hot path is `parseSocialMedia()` which handles a pre-stored TEXT column — this is unavoidable but scoped to individual column values, not full response bodies.

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

### 7. Bypassing the Pending Map
The `cache.pending` map prevents cache stampedes. If you skip the pending check, concurrent requests for the same uncached query will all hit D1 independently.

*  **Forbidden:** Querying D1 without checking `cache.pending.has(key)` first.
*  **Use:** Check pending → await if in-flight → check cache again → only then query D1.

### 8. Mutating Cached Buffers
The `Uint8Array` stored in the LRU cache is the *same reference* served to every client. Mutating it corrupts all future cache hits.

*  **Forbidden:** Modifying the buffer returned by `cache.get(key).buf`.
*  **Use:** If you need to modify response data, create a new buffer.
