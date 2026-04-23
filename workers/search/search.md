# Search Worker Architecture

## Overview

The search worker provides a keyword and semantic search API for the PeeringDB dataset at `api.pdbfe.dev/search`. It is a standalone Cloudflare Worker with its own wrangler config, D1 binding, and route — following the same pattern as the GraphQL and REST workers.

## Request Flow

```
Client → wrapHandler (core/admin.js)
       → initSemantic(env)               — probe AI/VECTORIZE bindings once per isolate
       → parseURL (core/utils.js)        — §1: no new URL()
       → validateRequest                 — method check
       → handlePreflight / routeAdmin    — CORS / health / stats
       → resolveAuth (core/auth.js)      — API key or session
       → isRateLimited                   — 10/100 req/min (anon/auth)
       → handleSearch (handlers/query.js)
           → parseSearchParams           — tokenizeString §2: no regex
           → buildSearchKey              — SHA-256, auth-scoped
           → withSearchSWR (cache.js)
               → L1 LRU read
               → L2 Cache API read
               → queryFn:
                   semantic → resolveSemanticIds → hydrateSemanticIds (D1 CASE sort)
                   keyword  → handleKeyword (D1 LIKE)  §3: for loops, §4: single encode
```

## Module Layout

```
search/
├── index.js              Router, rate limiter init, wrapHandler default export
├── cache.js              LRU instance, TTLs, sentinel, buildSearchKey(), withSearchSWR()
├── entities.js           SEARCH_FIELDS map (keyword field list per entity type)
├── search.md             This file
└── handlers/
    ├── query.js          handleSearch() — param parse, mode dispatch, SWR integration
    ├── keyword.js        D1 LIKE search across primary display fields
    └── semantic.js       initSemantic / isSemanticEnabled / resolveSemanticIds
```

Dependencies flow downward: handlers → cache.js / entities.js → core/. No imports from api/, auth/, or sync/.

## Caching Strategy

Mirrors the GraphQL worker. Search requests carry parameters that cannot be keyed by URL path alone (especially for POST or complex queries), so results are keyed by a SHA-256 hash of the normalised parameter set.

### Key generation (`buildSearchKey`)

- Canonical serialisation: `entity\0mode\0limit\0skip\0q` (NUL-separated, fixed order)
- SHA-256 digest → hex string → `search/{hex}`
- Auth prefix: `anon:search/...` vs `auth:search/...`
- Fast-path: `paramKeyCache` Map skips hashing for repeat queries (same "cache for the cache key" pattern as GraphQL)

### L1 / L2

- **L1 LRU**: 1024 slots, 32 MB. Single instance for all entity types and modes.
- **L2 PoP Cache**: Cloudflare Cache API via `core/pipeline/`. Results propagate to the edge PoP.
- **TTL**: 30 minutes for hits; 60 seconds for negative (empty / error) results.

### SWR

`withSearchSWR()` wraps `core/pipeline/withSWR()` with search-specific cache, TTL, and sentinel. Stale entries are served immediately while a background revalidation fires in `ctx.waitUntil()`.

## Semantic Search

`handlers/semantic.js` — moved verbatim from `api/semantic.js` (which is deleted). The `__semantic` filter operator has been removed from the API worker.

### Flow
1. `initSemantic(env)` probes `env.AI` and `env.VECTORIZE` on first request. No-op on repeat.
2. `isSemanticEnabled()` gates the semantic path at dispatch time.
3. `resolveSemanticIds(entity, field, q, limit)` embeds the query with BGE-large-en-v1.5 and queries Vectorize with an entity-scoped metadata filter.
4. `hydrateSemanticIds(db, entity, idList, limit)` retrieves the matching rows from D1 preserving rank via a SQL CASE expression.

### Degradation
- `mode=auto` (default): uses semantic if bindings present, falls back to keyword silently.
- `mode=semantic` without bindings: returns 503 with a clear error message.
- Vectorize unavailable at runtime: `resolveSemanticIds` returns null → queryFn returns null → negative cache entry → 60 s before retry.

## Rate Limiting

Isolate-level, keyed by `identity` (API key / session ID) or `cf-connecting-ip`. Lower limits than the API worker because semantic queries involve an AI embed + Vectorize round-trip:

| Tier | Limit |
|---|---|
| Anonymous | 10 req/min |
| Authenticated | 100 req/min |

## Anti-Pattern Compliance

| Rule | Approach |
|---|---|
| §1 No `new URL()` | `parseURL(request)` from `core/utils.js` |
| §2 No regex on hot path | `tokenizeString(qs, '&', -1)` + `tokenizeString(pair, '=', 2)` for parameter parsing |
| §3 No `.map()` on hot path | `for` loops for row accumulation and LIKE bind params |
| §4 No JSON round-trip | Single `encoder.encode(JSON.stringify(...))` at exit |
| §7 No stampede | `withSearchSWR` → `withSWR` coalesces concurrent misses |
| §9 No raw D1 outside pipeline | All D1/AI calls inside `queryFn` closures |
| §11 No holding LRU results | Fields extracted synchronously before any further `get()` call |
| §12 No manual L1 boilerplate | `withSearchSWR` owns the full L1 → SWR → L2 flow |
