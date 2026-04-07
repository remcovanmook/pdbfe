# Anti-Patterns for pdbfe Workers

This codebase runs inside high-concurrency Cloudflare Worker V8 Isolates.
Every pattern below exists because it caused a measurable regression in
latency, memory, or correctness. Before submitting a PR, check your code
against this list.

---

## 1. URL Parsing

The native `URL` constructor allocates a large object graph (origin, searchParams, etc.)
that triggers GC pressure on every request.

**Don't:**
```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;
    // ...
  }
};
```

**Do:**
```js
import { parseURL } from '../core/utils.js';

export default {
  async fetch(request) {
    const { rawPath, queryString } = parseURL(request);
    // rawPath is a plain string, queryString is the raw ?key=val portion
    // ...
  }
};
```

See: `core/utils.js` → `parseURL()`

---

## 2. Regular Expressions on the Hot Path

Regex execution is unpredictable and opens the door to ReDoS. On the
routing/serving path, use linear string operations instead.

**Don't:**
```js
// In a route handler or middleware
if (/^\/api\/([a-z_]+)$/.test(path)) {
  const entity = path.match(/^\/api\/([a-z_]+)$/)[1];
}
```

**Do:**
```js
// O(1) prefix check + indexOf for segment extraction
if (path.startsWith('/api/')) {
  const entity = path.substring(5);  // skip '/api/'
  const slash = entity.indexOf('/');
  // ...
}
```

Exception: regex is fine in cold-boot entity metadata construction
(`entities.js`) and in test files.

---

## 3. Functional Array Methods on the Hot Path

`.map()`, `.filter()`, and spread syntax (`[...a, ...b]`) create
intermediate arrays that become GC garbage on every request.

**Don't:**
```js
// In a handler processing rows
const ids = rows.filter(r => r.status === 'ok').map(r => r.id);
```

**Do:**
```js
const ids = [];
for (let i = 0; i < rows.length; i++) {
  if (rows[i].status === 'ok') ids.push(rows[i].id);
}
```

Exception: `.map()` in cold-boot code (e.g., building entity metadata
in `entities.js`) is fine — it runs once per isolate lifetime.

---

## 4. JSON Round-Tripping on the Hot Path

For depth=0 queries, D1 returns the complete JSON envelope as a string
via `json_group_array(json_object(...))`. The worker encodes it to bytes
once and caches the `Uint8Array`. There is no parse/stringify cycle.

**Don't:**
```js
// depth=0 handler
const rows = await db.prepare(sql).bind(...params).all();
const body = JSON.stringify({ data: rows.results, meta: {} });
return new Response(body);
```

**Do:**
```js
// depth=0: D1 returns the JSON string directly
const result = await db.prepare(jsonWrappedSql).bind(...params).first('json');
const envelope = `{"data":${result},"meta":{}}`;
const buf = encoder.encode(envelope);
// Cache buf, serve directly on future hits
```

**Don't:**
```js
// try/catch inside a loop on the hot path (V8 de-optimiser)
for (const row of rows) {
  try {
    row.social_media = JSON.parse(row.social_media);
  } catch (e) { /**/ }
}
```

**Do:**
```js
// JSON columns are unwrapped in SQL via json(), not in JS
// For cold path (depth>0), parse once outside the loop
parseJsonFields(row);  // see handlers/index.js
```

See: `api/query.js` → `buildJsonQuery()`, `handlers/index.js`

---

## 5. Dynamic Object Keys (Dictionary Mode)

Adding arbitrary keys at runtime forces V8 to abandon optimised Hidden
Classes and switch to slow dictionary mode for the object.

**Don't:**
```js
const cache = {};
cache[userProvidedKey] = data;      // dynamic shape → dictionary mode
cache[anotherDynamicKey] = moreData;
```

**Do:**
```js
const cache = new Map();
cache.set(userProvidedKey, data);    // Map is designed for dynamic keys
```

---

## 6. Unnecessary `async` on Synchronous Reads

The L1 cache lookup (`cache.get(key)`) is synchronous. Wrapping it in
`async` adds a microtask queue round-trip for no reason.

**Don't:**
```js
async function lookup(key) {
  return cache.get(key);  // synchronous, but async wrapper adds ~0.1ms
}
```

**Do:**
```js
function lookup(key) {
  return cache.get(key);  // stays on the synchronous fast path
}
// Only introduce async at the point where you actually await D1
```

---

## 7. Bypassing the Pending Map (Cache Stampede)

The `cache.pending` map prevents thundering herd: if N concurrent
requests ask for the same expired key, only 1 hits D1.

**Don't:**
```js
// Direct D1 query without checking for in-flight requests
async function getData(key, db) {
  const cached = cache.get(key);
  if (!cached) {
    const result = await db.prepare(sql).all();  // N requests = N queries
    cache.set(key, encode(result));
  }
}
```

**Do:**
```js
// Use cachedQuery() which handles coalescing internally
const buf = await cachedQuery(entityCache, cacheKey, ttl, async () => {
  // This closure runs AT MOST ONCE per cache miss,
  // even under concurrent load
  const result = await db.prepare(sql).bind(...params).all();
  return result.results.length ? encodeJSON(envelope) : null;
});
```

See: `api/pipeline.js` → `cachedQuery()`

---

## 8. Mutating Cached Buffers

The `Uint8Array` in the LRU cache is the same reference served to every
client. Mutating it corrupts all concurrent and future responses.

**Don't:**
```js
const entry = cache.get(key);
entry.buf[0] = 0x7B;  // corrupts the shared buffer
```

**Do:**
```js
const entry = cache.get(key);
const copy = new Uint8Array(entry.buf);  // copy if you need to modify
copy[0] = 0x7B;
```

---

## 9. Querying D1 Outside `cachedQuery()`

All API handler D1 queries must go through `cachedQuery()` (pipeline.js),
which owns promise coalescing and the L1/L2 cache lifecycle.

**Don't:**
```js
// Direct D1 access in handler code
const result = await db.prepare('SELECT ...').bind(...).all();
```

**Don't:**
```js
// Manually manipulating the pending map
entityCache.pending.set(key, promise);
// ...
entityCache.pending.delete(key);
```

**Do:**
```js
import { cachedQuery } from '../pipeline.js';

const buf = await cachedQuery(entityCache, cacheKey, ttl, async () => {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results.length ? encodeJSON(data) : null;
});
```

Exceptions:
- `depth.js` child-set queries run inside a `queryFn` closure
  that already went through `cachedQuery()`.
- Admin endpoints (`/health`, `/_cache_status`) query D1 directly.
  These are low-traffic diagnostic paths where caching would defeat
  the purpose.

---

## 10. Awaiting L2 Cache Writes

`putL2()` stores payloads in the per-PoP Cache API. These writes are
fire-and-forget — blocking the response on them adds latency for no gain.

**Don't:**
```js
await putL2(key, buf, ttl);  // blocks the response
return serveJSON(buf);
```

**Do:**
```js
putL2(key, buf, ttl);        // fire-and-forget, resolves in background
return serveJSON(buf);
```

Exception: inside `ctx.waitUntil()` closures, awaiting is fine since
the response has already been sent.

---

## 11. Holding LRU Cache Results Across Calls

`cache.get()` returns a **shared mutable object** to avoid allocating a
fresh object on every cache hit. The same object is overwritten on the
next `get()` call.

**Don't:**
```js
const a = cache.get("key-a");
const b = cache.get("key-b");
// BUG: a.buf now contains key-b's data — 'a' and 'b' are the same object
return serveJSON(request, a.buf);
```

**Do:**
```js
const entry = cache.get("key-a");
const buf = entry.buf;          // extract what you need
const hits = entry.hits;
// Safe to call get() again — buf and hits are primitive/reference copies
const other = cache.get("key-b");
```

Rule: read all needed fields from the return object synchronously before
calling `get()` again. This eliminates young-generation GC pressure on
the hottest code path (L1 cache hits).
