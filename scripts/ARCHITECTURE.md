# Schema Ingest & Entity Production Pipeline

The PeeringDB mirror relies on a three-stage code generation pipeline to synchronize upstream Django models and OpenAPI specifications with the local Cloudflare Workers environment. This pipeline ensures that our D1 schema, worker entity definitions, GraphQL schema, and REST API specification match upstream without requiring manual intervention.

## 1. Pipeline Overview

```mermaid
graph TD
    subgraph Upstream
        DJ[django-peeringdb<br/>models (Python)]
        SPEC[peeringdb<br/>api-schema.yaml]
    end

    subgraph "parse_django_models.py"
        AST[Python AST Parser]
        YML[YAML Parser]
        MERGE[Merge Logic &<br/>PDBFE Extensions]
    end

    subgraph Artifacts
        JSON[extracted/entities.json<br/>Intermediate Schema]
        SQL[extracted/schema.sql<br/>D1 DDL migrations]
        FE[frontend/js/entities.js<br/>Frontend module]
        WK[extracted/entities-worker.js<br/>Worker Registry]
    end
    
    subgraph Downstream Generators
        GQL[gen_graphql_schema.py]
        REST[gen_openapi_spec.py]
        
        GQL_A[graphql-typedefs.js<br/>graphql-resolvers.js]
        REST_A[openapi.json]
    end

    DJ --> AST
    SPEC --> YML
    AST --> MERGE
    YML --> MERGE
    
    MERGE --> JSON
    MERGE --> SQL
    MERGE --> FE
    MERGE --> WK
    
    JSON --> GQL
    JSON --> REST
    
    GQL --> GQL_A
    REST --> REST_A
```

## 2. Upstream Sources

The pipeline requires two sources of truth to build a picture of the PeeringDB data model:

### `django-peeringdb` Models
Parsed directly from `src/django_peeringdb/models/abstract.py` and `concrete.py` via Python's `ast` module.
Provides:
- Field names and native types
- Nullability (`null=True`, `blank=True`)
- Table names (`Meta.db_table`)
- Foreign Key relationships and target entities

### `api-schema.yaml` (OpenAPI Spec)
Fetched from the live PeeringDB API instance.
Provides:
- Which fields are explicitly queryable via parameters
- API-injected fields that aren't physical database columns (e.g., `_count` fields, cross-table resolved names like `org_name`)
- Access control metadata: detects `restricted` and `anonFilter` by examining the `visible` enum on the `poc` entity.

### Version Tracking
The script checks the latest GitHub tag for `django-peeringdb` and the live `Ctl/VERSION` from PeeringDB. If both versions match the metadata stored in `entities.json`, the script aborts generation to save time. Pass `--force` to bypass this check.

## 3. Intermediate Format (`extracted/entities.json`)

The output of the merge process is the intermediate schema JSON, which is the single source of truth for all downstream tools.

### Example Structure
```json
{
  "schema_version": "3.5.0+2.54.0",
  "versions": {
    "django_peeringdb": "3.5.0",
    "api_schema": "2.54.0"
  },
  "entities": {
    "net": {
      "tag": "net",
      "label": "Network",
      "table": "peeringdb_network",
      "address": true,
      "restricted": false,
      "fields": [
        { "name": "asn", "type": "number", "queryable": true },
        { "name": "name", "type": "string", "queryable": true },
        { "name": "org_id", "type": "number", "queryable": true, "foreignKey": "org" },
        { "name": "info_types", "type": "json", "queryable": false }
      ],
      "naming": {
        "type": "Network",
        "singular": "network",
        "plural": "networks",
        "subresource": "networks",
        "label": "Network"
      }
    }
  }
}
```

The `naming` dictionary is centralized in `scripts/parse_django_models.py` (`ENTITY_NAMING`) and propagates to GraphQL types, REST sub-resources, and UI labels.

## 4. PDBFE Extensions

The pipeline applies our mirror-specific extensions on top of the upstream schema.

### Local Fields
`_LOCAL_FIELDS` injects columns that only exist in our D1 database.
Example: `__logo_migrated` is a boolean added to organizations, networks, and facilities to track Logo R2 migration status. The pipeline adds these *after* extracting standard fields, so they survive schema regeneration.

### Entity Overrides
`scripts/lib/entity-overrides.json` allows manual corrections to the upstream schema.
This is used to resolve FK names so that `subresource.js` and `graphql-resolvers.js` know which columns contain the literal name/string representations of a related object:
```json
{
  "netfac": {
    "fieldOverrides": {
      "net_id": { "resolve": { "name": "net_name", "asn": "net_asn" } }
    }
  }
}
```

### Cache Tiers
`_CACHE_TIERS` configures slot boundaries and size limits (16MB for heavy entities like `net` down to 1MB for low-traffic entities) and writes them directly into the compiled `entities-worker.js`.

## 5. Downstream Generators

Two specialized scripts consume `entities.json` to produce API surfaces:

### `gen_graphql_schema.py`
Builds the GraphQL schema.
- **Type Definitions**: Emits SDL (`graphql-typedefs.js`) representing entities, Connection structures (for Relay pagination), Reverse Edges (e.g., `network.facilities`), and `WhereInput` filters (e.g., `NetworkWhereInput`).
- **Resolver Map**: Emits `graphql-resolvers.js`, resolving all lists, details, FK forward lookups, and reverse edges. Maps GraphQL arguments to our internal API worker query builder.
- **Aliases**: Uses the `naming` property to generate PeeringDB Plus compatible aliases (e.g., `internetExchange` alongside `exchange`).

### `gen_openapi_spec.py`
Builds the REST OpenAPI specification.
- Evaluates `entities.json` to generate an OpenAPI 3.1 structure (`openapi.json`).
- Dynamically creates `/v1/{entity}` (list), `/v1/{entity}/{id}` (detail), and `/v1/{entity}/{id}/{relation}` (sub-resource) paths.
- Creates explicit query parameters for any field marked `queryable: true`.

## 6. Running the Pipeline

Whenever a new field or entity is added to PeeringDB, or if you modify one of the code generators:

```bash
# Force regeneration of models from upstream
.venv/bin/python scripts/parse_django_models.py --force

# Regenerate GraphQL SDL and Resolvers
.venv/bin/python scripts/gen_graphql_schema.py

# Regenerate REST OpenAPI Spec
.venv/bin/python scripts/gen_openapi_spec.py
```

These generated files should be committed to version control.

## 7. Cold Start: Database Bootstrap & Backfill

When standing up a fresh environment, data is pulled from PeeringDB JSON dumps.

### `migrate-to-d1.sh`
1. Fetches JSON dumps from `public.peeringdb.com` (with `--fetch`).
2. Generates initial SQL INSERT files.
3. Cleans orphaned Foreign Key references (using `lib/fk_cleanup.sql`) and verifies integrity.
4. Executes the DDL (`schema.sql`) and DML inserts against D1.

### POC Backfill Caveat
The public JSON dumps at `public.peeringdb.com` **only contain points of contact (POCs) with `visible=Public`**.
To maintain functional parity for authenticated users, we must backfill `visible=Users` and `visible=Private` records directly from the API.

After running `migrate-to-d1.sh`, you must backfill the remaining POC data using an authenticated upstream API key:

```bash
# Ensure PEERINGDB_API_KEY is in your environment (.env)
source .env

# Generate POC backfill script via upstream API
python3 scripts/backfill_poc.py > /tmp/poc_backfill.sql

# Apply manually to D1
wrangler d1 execute peeringdb --remote --yes --file /tmp/poc_backfill.sql
```

After this initial bootstrap and POC backfill, the production `sync` worker (running every 15 minutes) guarantees all future `visible=Users/Private` POC updates are pulled natively.
