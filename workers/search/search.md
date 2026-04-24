# Search Worker Architecture

## Overview

The search worker provides a keyword and graph-structural search API for the PeeringDB dataset at `api.pdbfe.dev/search`. It is a standalone Cloudflare Worker with its own wrangler config, D1 binding, and route.

## Request Flow

```
Client → wrapHandler (core/admin.js)
       → initGraphSearch(env)           — probe VECTORIZE binding once per isolate
       → parseURL (core/utils.js)       — §1: no new URL()
       → validateRequest                — method check
       → handlePreflight / routeAdmin   — CORS / health / stats
       → resolveAuth (core/auth.js)     — API key or session
       → isRateLimited                  — 10/100 req/min (anon/auth)
       → handleSearch (handlers/query.js)
           → parseSearchParams          — tokenizeString §2: no regex
           → buildSearchKey             — SHA-256, auth-scoped
           → withSearchSWR (cache.js)
               → L1 LRU read
               → coalesce (cache.pending — §7 stampede prevention)
               → L2 Cache API read
               → queryFn:
                   graph-search → resolveGraphIds → executeGraphSearch → hydrateGraphIds (D1 CASE sort)
                   keyword      → handleKeyword (D1 LIKE)  §3: for loops, §4: single encode
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
    ├── graph.js          initGraphSearch / isGraphSearchEnabled / resolveGraphIds
    ├── graph-search.js   executeGraphSearch() — predicate routing and Vectorize kNN
    └── query-parser.js   parseQuery() — rule-based NL decomposition into typed predicates
```

Dependencies flow downward: handlers → cache.js / entities.js → core/. No imports from api/, auth/, or sync/.

## Caching Strategy

Search requests carry parameters that cannot be keyed by URL path alone, so results are keyed by a SHA-256 hash of the normalised parameter set.

### Key generation (`buildSearchKey`)

- Canonical serialisation: `entity\0mode\0limit\0skip\0q` (NUL-separated, fixed order)
- SHA-256 digest → hex string → `search/{hex}`
- Auth prefix: `anon:search/...` vs `auth:search/...`
- Fast-path: `paramKeyCache` Map skips hashing for repeat queries

### L1 / L2

- **L1 LRU**: 1024 slots, 32 MB. Single instance for all entity types and modes.
- **L2 PoP Cache**: Cloudflare Cache API via `core/pipeline/`. Results propagate to the edge PoP.
- **TTL**: 30 minutes for hits; 60 seconds for negative (empty / error) results.

### SWR

`withSearchSWR()` wraps `core/pipeline/withSWR()` with search-specific cache, TTL, and sentinel. Stale entries are served immediately while a background revalidation fires in `ctx.waitUntil()`.

## Graph-Structural Search

The external API exposes `mode=semantic` for backwards compatibility. Internally, this runs graph-structural search — there is no Workers AI text embedding.

### Why BGE was dropped

The original implementation used Cloudflare Workers AI (bge-large-en-v1.5) to embed each query at request time, then queried Vectorize for nearest text-embedded entity vectors. It was replaced for the following reasons:

1. **Cold-start cost**: every search request incurred a Workers AI embed round-trip (~200–400 ms). The 10 req/min anonymous rate limit existed primarily to keep the worker from falling over under this load.

2. **Semantic mismatch**: BGE text embeddings encode surface-level linguistic similarity, not PeeringDB topology. Two networks that peer heavily share no lexical features, so "similar to AS3356" returned results ranked by name similarity rather than peering relationships.

3. **Index staleness**: the sync worker was embedding 100 entities per run via Workers AI, meaning the Vectorize index was perpetually partial and coverage was unpredictable.

4. **Architectural coupling**: the sync worker carried Workers AI and Vectorize bindings purely for the background embedding job, violating its single-responsibility design.

### What replaced it

A node2vec graph embedding pipeline (`scripts/compute-graph-embeddings.py`) trains a 1024-dim embedding matrix over the full PeeringDB graph (75k nodes, 175k edges) offline and uploads all vectors to Vectorize in one batch. The `pdbfe-async` queue consumer recomputes neighbour-averaged vectors as each sync delta arrives, keeping the index current without touching Workers AI.

### Query flow

1. `initGraphSearch(env)` probes `env.VECTORIZE` on first request. No-op on repeat.
2. `isGraphSearchEnabled()` gates the graph-search path at dispatch time.
3. `parseQuery(q)` (query-parser.js) decomposes the query into typed predicates without external NLP dependencies.
4. `executeGraphSearch(q, entity, db, vectorize, limit)` (graph-search.js) executes predicates in priority order:
   - ASN → D1 exact match on `asn` column
   - infoType → D1 `info_type` filter
   - Region / country / city → D1 metadata filters
   - Similarity ("similar to X") → Vectorize kNN from anchor vector
   - Traversal ("at Y", "peers of Y") → D1 multi-table edge JOINs
   - Fallback → D1 LIKE keyword
5. `hydrateGraphIds(db, entity, idList, limit)` retrieves matching rows from D1, preserving rank via a SQL CASE expression.

### Mode selection in `auto`

`mode=auto` (the default) routes each query based on its content, not just on binding availability:

1. The query is decomposed by `parseQuery()` (query-parser.js) into typed predicates.
2. If any structural predicate is found (ASN, country, city, region, info_type, similarity, traversal) **and** Vectorize is available → graph-search.
3. Otherwise → keyword (D1 LIKE). This covers typeahead-style partial-name queries, single words, and any query where graph-search adds no value over a fast lexical match.

This means a plain name search like "Cogent" or "AMS-IX" will always use keyword mode (fastest path), while "networks in DE" or "similar to AS3356" will use graph-search when available.

### Degradation

- `mode=auto` (default): see Mode selection above.
- `mode=graph` without Vectorize: returns 503 with a clear error message.
- Vectorize unavailable at runtime: `resolveGraphIds` returns null → queryFn returns null → negative cache entry → 60 s before retry.

## Rate Limiting

Isolate-level, keyed by `identity` (API key / session ID) or `cf-connecting-ip`.

| Tier | Limit |
|---|---|
| Anonymous | 10 req/min |
| Authenticated | 100 req/min |

Graph-structural queries require a Vectorize round-trip for similarity searches but no Workers AI call, making them substantially cheaper than the previous BGE approach.

## Anti-Pattern Compliance

| Rule | Approach |
|---|---|
| §1 No `new URL()` | `parseURL(request)` from `core/utils.js` |
| §2 No regex on hot path | `tokenizeString(qs, '&', -1)` + `tokenizeString(pair, '=', 2)` for parameter parsing |
| §3 No `.map()` on hot path | `for` loops for row accumulation and LIKE bind params |
| §4 No JSON round-trip | Single `encoder.encode(JSON.stringify(...))` at exit |
| §7 No stampede | `withSearchSWR` → `withSWR` → `cachedQuery` coalesces concurrent misses via `cache.pending` |
| §9 No raw D1 outside pipeline | All D1/Vectorize calls inside `queryFn` closures |
| §11 No holding LRU results | Fields extracted synchronously before any further `get()` call |
| §12 No manual L1 boilerplate | `withSearchSWR` owns the full L1 → SWR → L2 flow |
