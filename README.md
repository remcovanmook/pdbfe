# pdbfe

Read-only [PeeringDB](https://www.peeringdb.com/) API mirror running on Cloudflare Workers + D1.

Serves 263K rows across 13 entity types from the edge with sub-second latency, zero-allocation JSON serving on the hot path, and automated delta sync every 15 minutes.

## Endpoints

| Service | URL | Schedule |
|---|---|---|
| API | `https://pdbfe-api.remco-vanmook.workers.dev/api/{entity}` | On-demand |
| Sync | `https://pdbfe-sync.remco-vanmook.workers.dev` | `*/15 * * * *` |

## Supported entities

`net` · `org` · `fac` · `ix` · `ixlan` · `ixpfx` · `netfac` · `netixlan` · `poc` · `carrier` · `carrierfac` · `ixfac` · `campus` · `as_set`

## Usage

```bash
# List networks
curl https://pdbfe-api.remco-vanmook.workers.dev/api/net?limit=5

# Filter by ASN
curl https://pdbfe-api.remco-vanmook.workers.dev/api/net?asn=13335

# Search by name
curl https://pdbfe-api.remco-vanmook.workers.dev/api/org?name__contains=Cloudflare

# Depth expansion (child IDs)
curl https://pdbfe-api.remco-vanmook.workers.dev/api/net/1?depth=1

# Depth expansion (full child objects)
curl https://pdbfe-api.remco-vanmook.workers.dev/api/net?asn=13335&depth=2

# AS-SET lookup
curl https://pdbfe-api.remco-vanmook.workers.dev/api/as_set/13335

# Pagination
curl https://pdbfe-api.remco-vanmook.workers.dev/api/net?limit=20&skip=40
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
| `depth=2` | `_set` fields contain full child objects (FK excluded) |

## Project structure

```
pdbfe/
├── database/                  # D1 population tooling
│   ├── migrate-to-d1.sh       # Pull from PeeringDB API → populate D1
│   ├── gen_schema.py          # Auto-generate schema from API data
│   └── json_to_sql.py         # JSON → INSERT statements
├── workers/
│   ├── api/                   # API worker
│   │   ├── index.js           # Router
│   │   ├── handlers/index.js  # List, detail, as_set handlers
│   │   ├── entities.js        # Entity registry (13 types)
│   │   ├── query.js           # Dual query builder
│   │   ├── depth.js           # Depth 0/1/2 expansion
│   │   └── cache.js           # Per-entity LRU caches
│   ├── sync/                  # Sync cron worker
│   │   └── index.js           # Delta sync via `since` parameter
│   ├── core/                  # Shared primitives
│   │   ├── cache.js           # TypedArray LRU implementation
│   │   ├── http.js            # JSON response serving, ETag, CORS
│   │   ├── admin.js           # Health, robots.txt, cache admin
│   │   └── utils.js           # URL parsing, filter parsing
│   ├── tests/
│   │   ├── unit/              # 75 unit tests
│   │   ├── test_api.js        # 24 integration tests
│   │   └── test_equivalence.js # 40 equivalence tests vs live PeeringDB
│   ├── wrangler.toml          # API worker config
│   ├── wrangler-sync.toml     # Sync worker config
│   └── types.d.ts             # Shared type definitions
└── .env                       # Local secrets (gitignored)
```

## Local development

```bash
# Prerequisites: Node.js 22+, wrangler

# Populate local D1 from PeeringDB API
cd database
./migrate-to-d1.sh --fetch    # downloads JSON + populates local D1

# Run API worker locally
cd workers
XDG_CONFIG_HOME=.wrangler-home XDG_DATA_HOME=.wrangler-home npx wrangler dev

# Run tests
node --test workers/tests/unit/*.test.js workers/tests/test_api.js

# Equivalence tests (requires API key + running mirror)
PDBFE_URL=http://localhost:8787 \
PEERINGDB_API_KEY=... \
node --test workers/tests/test_equivalence.js

# Type check
cd workers && npx tsc --noEmit
```

## Deploying

```bash
# API worker
cd workers
npx wrangler deploy --config wrangler.toml

# Sync worker
npx wrangler deploy --config wrangler-sync.toml
npx wrangler secret put PEERINGDB_API_KEY --config wrangler-sync.toml

# Populate production D1
cd database
./migrate-to-d1.sh --fetch --remote
```

## Architecture docs

| Document | Content |
|---|---|
| [workers/index.md](workers/index.md) | Per-file architecture breakdown |
| [workers/api/api.md](workers/api/api.md) | API worker internals, caching, query builder |
| [workers/ONBOARDING.md](workers/ONBOARDING.md) | Developer onboarding, V8 isolate lifecycle |
| [workers/ANTI_PATTERNS.md](workers/ANTI_PATTERNS.md) | 8 forbidden code patterns for hot-path safety |

## License

Private.
