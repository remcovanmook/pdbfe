# REST API Worker Architecture

The REST worker surfaces a versioned API architecture modeled around the generated OpenAPI specification mapping. It acts as an abstraction layer above the PeeringDB data layer.

## Request Flow

```
Client → wrapHandler (error trap + telemetry headers)
       → extractApiKey / extractSessionId → authenticated
       → isRateLimited (isolate-level, per-IP or per-identity)
       → validateRequest (method checks, URL validation)
       → Router
            → GET /openapi.json
            → GET / → Scalar API Docs mapping
            → GET /v1/{entity}
            → GET /v1/{entity}/{id}
            → GET /v1/{entity}/{id}/{relation} (sub-resources)
       → L1 Read + Stale While Revalidate (SWR) mapping
       → L2 Read
       → D1 Read
```

## Endpoints

1. **Entities & Detail (`/v1/{entity}` and `/v1/{entity}/{id}`)**: Surfaced from `index.js`. 
2. **Sub-Resource Traversal (`/v1/{entity}/{id}/{relation}`)**: These traversals map relationships without JOIN formulation required, via `subresource.js`.
3. **Specification (`/openapi.json`)**: Pre-encoded OpenAPI spec surfaced from the auto-generation pipeline.
4. **Docs UI (`/`)**: Scalar HTML template loaded dynamically. 

## Code Sharing and Dependency Architecture

The REST API utilizes the underlying database engine elements established inside the root API worker:

* Uses the same filter parsers (`parseQueryFilters()` from `api/utils.js`).
* Utilizes the same query composition models (`buildJsonQuery()` and `buildRowQuery()` from `api/query.js`).
* Utilizes the same caching engines (`withEdgeSWR()` mapping to `cachedQuery()`).
* Extends `api/entities.js` without modification.

This avoids duplication across API generation surfaces and guarantees performance parity.

## Sub-Resource Traversal

The REST sub-resource engine `subresource.js` inspects relational maps to compute queries:

* **FK Forwards (`/v1/network-facilities/1/network`)**: Evaluates a single record utilizing `foreignKey` properties in its parent to resolve its 1:1 mapped FK constraint ID across the parent.
* **Child Traversals (`/v1/network/1/network-facilities`)**: Establishes filtered parameter scopes on secondary lookup logic (`?net_id=1`).

These lookups utilize the same SQL caching pipelines and are paginated parameters mapping `limit` and `skip`.

## Specification and Visual Documentation

### OpenAPI Specification

The full specification exists inside `extracted/openapi.json`. It relies upon the `gen_openapi_spec.py` pipeline definition to map upstream schema definitions into 3.1 references that bind sub-resource parameter lookups and definition blocks. The worker caches its serialized JSON payload at module-load execution to serve it instantly.

### Scalar API Docs UI

The REST module acts as the UI distributor mapping interactive reference definitions via the open-source Scalar ecosystem UI. The response body directly mounts UI specifications bypassing any legacy Javascript hydration steps via declarative data attributes (`data-url`). 

Similar to the GraphQL deployment, `frontend/api/rest.html` decouples layout functionality by establishing inlined layout CSS structures and importing typography to satisfy Cloudflare Access CORS parameters.
