# pdbfe

Read-only [PeeringDB](https://www.peeringdb.com/) API mirror running on Cloudflare Workers + D1.

Serves the full PeeringDB dataset (13 entity types, 260K+ rows) from the edge with sub-second latency, zero-allocation JSON serving on the hot path, and automated delta sync every 15 minutes. Includes a single-page frontend and PeeringDB OAuth integration.

## Architecture

```
pdbfe/
├── workers/
│   ├── api/                       # API worker — read-only PeeringDB mirror
│   │   ├── index.js               # Router
│   │   ├── handlers/index.js      # List, detail, as_set, count handlers
│   │   ├── entities.js            # Entity registry (13 types)
│   │   ├── pipeline.js            # D1 query pipeline, cache stampede prevention
│   │   ├── query.js               # Dual query builder (JSON + row modes)
│   │   ├── depth.js               # Depth 0/1/2 expansion
│   │   ├── cache.js               # Per-entity LRU cache config (3 tiers)
│   │   └── l2cache.js             # Per-PoP L2 cache (Cache API)
│   ├── sync/                      # Sync worker — cron-triggered delta sync
│   │   └── index.js               # Delta sync via `since` parameter
│   ├── auth/                      # Auth worker — PeeringDB OAuth + API keys
│   │   └── index.js               # OAuth ceremony, session/key management
│   ├── core/                      # Shared primitives (no domain knowledge)
│   │   ├── cache.js               # TypedArray LRU implementation
│   │   ├── http.js                # JSON serving, ETag, CORS
│   │   ├── admin.js               # Request validation, health, robots.txt
│   │   ├── utils.js               # URL parsing, filter parsing
│   │   ├── auth.js                # Session resolution, API key verification
│   │   ├── oauth.js               # OAuth handlers
│   │   └── account.js             # Account/API key CRUD
│   └── tests/                     # Test suites (see Testing below)
├── frontend/                      # Single-page application (Cloudflare Pages)
│   ├── index.html                 # SPA shell
│   ├── css/index.css              # Styles
│   ├── js/                        # Application modules
│   │   ├── pages/                 # Route-specific page renderers
│   │   ├── api.js                 # API client
│   │   ├── auth.js                # Client-side auth state
│   │   ├── router.js              # SPA router
│   │   └── ...
│   └── third_party/inter/         # Vendored Inter font (with LICENSE)
├── database/                      # D1 population tooling
│   ├── schema.sql                 # D1 schema definition
│   ├── migrate-to-d1.sh           # Cold start: fetch PeeringDB JSON → populate D1
│   ├── json_to_sql.py             # JSON → INSERT statement converter
│   └── migrations/                # Schema migrations
├── docs/                          # Documentation index
└── .env.example                   # Environment variable template
```

## Prerequisites

- Node.js 22+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Python 3 (for database population)
- A Cloudflare account with D1 and KV access
- A PeeringDB API key

## Configuration

Copy the example files and fill in your values:

```bash
# Environment variables
cp .env.example .env

# Worker configs (replace resource IDs)
cd workers
cp wrangler.toml.example wrangler.toml
cp wrangler-sync.toml.example wrangler-sync.toml
cp wrangler-auth.toml.example wrangler-auth.toml

# Frontend configs (replace hostnames)
cd ../frontend
cp js/config.js.example js/config.js
cp _headers.example _headers
cp _redirects.example _redirects
```

See [docs/deployment.md](docs/deployment.md) for the full setup walkthrough.

## Local Development

```bash
# Populate local D1 from PeeringDB API
./database/migrate-to-d1.sh --fetch

# Run API worker locally
cd workers
XDG_CONFIG_HOME=.wrangler-home XDG_DATA_HOME=.wrangler-home npx wrangler dev

# Run auth worker locally (separate terminal)
XDG_CONFIG_HOME=.wrangler-home XDG_DATA_HOME=.wrangler-home npx wrangler dev --config wrangler-auth.toml --port 8788

# Type check
npm run typecheck
```

## Testing

### Unit tests (`workers/tests/unit/`)

Test individual modules in isolation with mock D1 bindings. 9 test files covering query building, cache operations, depth expansion, auth, OAuth, pipeline, and visibility filtering.

```bash
cd workers && npm test
```

### Integration tests (`workers/tests/test_api.js`)

Full router tests with mock D1 — admin endpoints, CORS, entity routing, error handling.

```bash
cd workers && npm run test:integration
```

### Conformance tests (`workers/tests/test_conformance*.js`)

Validate API behavior against the live PeeringDB API — envelope structure, data types, filter operators, field selection, timestamps, and error handling.

```bash
# Requires PEERINGDB_API_KEY in environment
cd workers && npm run test:conformance
cd workers && npm run test:conformance-ext
```

### Equivalence tests (`workers/tests/test_equivalence.js`)

Side-by-side comparison of mirror responses against the upstream PeeringDB API for a set of reference queries.

```bash
# Requires PDBFE_URL and PEERINGDB_API_KEY
cd workers && npm run test:equivalence
```

### Frontend tests (`frontend/tests/`)

Unit tests for the SPA rendering and markdown parser.

```bash
cd frontend && npm test
```

## API Usage

```bash
# List networks
curl $API_URL/api/net?limit=5

# Filter by ASN
curl $API_URL/api/net?asn=13335

# Search by name
curl $API_URL/api/org?name__contains=Cloudflare

# Depth expansion (child IDs)
curl $API_URL/api/net/1?depth=1

# Depth expansion (full child objects)
curl "$API_URL/api/net?asn=13335&depth=2"

# AS-SET lookup
curl $API_URL/api/as_set/13335

# Pagination
curl "$API_URL/api/net?limit=20&skip=40"
```

### Filter operators

| Operator | Example | SQL equivalent |
|---|---|---|
| `(none)` / `eq` | `?asn=13335` | `WHERE asn = 13335` |
| `__lt` | `?id__lt=100` | `WHERE id < 100` |
| `__gt` | `?id__gt=100` | `WHERE id > 100` |
| `__lte` / `__gte` | `?id__lte=100` | `WHERE id <= 100` |
| `__contains` | `?name__contains=Cloud` | `WHERE name LIKE '%Cloud%'` |
| `__startswith` | `?name__startswith=Cloud` | `WHERE name LIKE 'Cloud%'` |
| `__in` | `?asn__in=13335,15169` | `WHERE asn IN (13335, 15169)` |

### Depth levels

| Level | Behaviour |
|---|---|
| `depth=0` | Entity fields only (default) |
| `depth=1` | `_set` fields contain child IDs |
| `depth=2` | `_set` fields contain full child objects |

## Deploying

See [docs/deployment.md](docs/deployment.md) for the full deployment guide, including:
- Cloudflare resource setup (D1, KV)
- PeeringDB OAuth application registration
- Wrangler secret configuration
- Database population
- Worker and frontend deployment
- Verification

## Documentation

See [docs/index.md](docs/index.md) for the full documentation index.

Key documents:
- [Deployment Guide](docs/deployment.md) — Setup and deployment walkthrough
- [Worker Architecture](workers/index.md) — Per-file codebase breakdown
- [Developer Onboarding](workers/ONBOARDING.md) — V8 isolate lifecycle, cache architecture
- [Anti-Patterns](workers/ANTI_PATTERNS.md) — Forbidden patterns with do/don't examples
- [API Worker](workers/api/api.md) — Request flow, caching, query builder
- [Auth Architecture](workers/auth/auth.md) — OAuth, sessions, API key management
- [Django/D1 Gotchas](docs/django-gotchas.md) — Behavioral divergences from upstream

## License

BSD 3-Clause — see [LICENSE](LICENSE).
