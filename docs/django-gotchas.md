# Django ↔ D1/SQLite Behavioral Gotchas for PeeringDB API Mirrors

Non-obvious divergences when reimplementing Django REST Framework + MySQL/PostgreSQL
behavior on Cloudflare Workers + D1 (SQLite).

---

## 1. `__contains` / `__startswith` — Unicode case folding

**Django on MySQL**: `__contains` maps to `LIKE BINARY %s` (case-sensitive).
PeeringDB actually exposes `__contains` but their MySQL collation (`utf8_general_ci`)
makes it **case-insensitive** in practice. So `name__contains=CLOUD` and
`name__contains=cloud` return the same results on production PeeringDB.

**D1/SQLite**: `LIKE` is case-insensitive for **ASCII A-Z only**. Characters
outside ASCII (ü, ö, é, ñ, ß, Ç, Ø, etc.) are matched **case-sensitively**.
`NOCASE` collation has the same limitation. There is no ICU extension on D1.

**Impact**: A facility named "Zürich" won't match `city__contains=zürich` on D1,
but **will** match on production PeeringDB (MySQL utf8_general_ci folds ü↔Ü).
This affects network names with accented characters (common in LATAM, DACH, Nordics).

**Mitigation**: Store a lowercased shadow column or normalize at sync time.
Alternatively, apply `LOWER()` in JS before the query — but note SQLite's
built-in `LOWER()` also only handles ASCII.

---

## 2. `null` vs empty string (`""`) on CharFields

**Django convention**: `CharField(blank=True, null=False)` stores empty values as
`""`, never as `NULL`. PeeringDB follows this — text fields that have no value are
`""` in the API response, while nullable numeric/FK fields are `null`.

**SQLite trap**: If your sync pipeline doesn't distinguish between `null` and `""`
when inserting, or if you `JSON_EXTRACT` a missing key, you'll get `NULL` where
Django would return `""`. Consumers that do `if (rec.policy_url)` will behave
differently for `null` vs `""`.

**Fields to watch**: `policy_url`, `policy_general`, `irr_as_set`, `notes`,
`info_type`, `aka`, `name_long` on net; `notes`, `aka` on ix/fac.

**Test**: `GET /api/net?limit=50&depth=0` — scan for fields that are `null` in
your mirror but `""` upstream (or vice versa).

---

## 3. Default ordering — Django's `Meta.ordering` vs SQLite rowid

**Django**: PeeringDB models inherit `ordering = ['id']` from the abstract base.
Django's ORM always appends `ORDER BY id ASC` unless overridden. This ordering is
guaranteed and deterministic.

**SQLite/D1**: Without an explicit `ORDER BY`, SQLite returns rows in **rowid order**,
which is usually insertion order. If your sync pipeline upserts in a different order
than PeeringDB's IDs (e.g., batched by entity type, or by `updated` timestamp),
your default sort will diverge from upstream. `skip`/`limit` pagination then returns
different pages.

**Fix**: Always `ORDER BY id ASC` in your SQL. Sounds obvious but easy to miss on
filtered queries where you might omit it for performance.

---

## 4. `__in` filter — max query variable limit

**Django/MySQL**: No practical limit on `IN (...)` clause size.

**D1/SQLite**: SQLite has a compiled-in limit of **999 bound parameters** by default
(SQLITE_MAX_VARIABLE_NUMBER). If someone sends
`net_id__in=1,2,3,...,1500`, your D1 query will fail.

PeeringDB's own docs show queries like `ix_id__in=<huge list>` for the
"European IXPs" pattern. A programmatic consumer could send thousands of IDs.

**Mitigation**: Chunk `__in` queries into batches of ~500, UNION the results.
Or switch to `WHERE id IN (SELECT value FROM json_each(?))` with a JSON array
parameter (single bind variable).

---

## 5. Timestamp precision — `updated` / `created` fields

**Django on MySQL/PostgreSQL**: Stores datetime with microsecond precision.
PeeringDB's `since` parameter compares against these timestamps using
`updated >= to_datetime(since)`.

**D1/SQLite**: `DATETIME` is stored as TEXT (ISO 8601) or REAL (Julian) or INTEGER
(Unix epoch). If you store as TEXT and truncate to seconds, you'll lose microsecond
ordering. Two records updated in the same second may sort differently than upstream.

**Also**: Django's `auto_now` fields include timezone info (`2024-01-15T10:30:00Z`).
If you strip the `Z` or store naive timestamps, `since` comparisons against
ISO strings will break lexicographically.

---

## 6. `depth` expansion — Django REST serializer recursion vs manual JOINs

**Django**: `depth=2` on PeeringDB uses nested serializers that recursively fetch
related objects via the ORM's `select_related`/`prefetch_related`. The expansion
follows FK relationships defined on the model.

**Your mirror**: You're doing JOINs or post-fetch assembly in JS. The gotcha is
**which direction** the relationship expands:

- `depth=1` on a `net` record: `netixlan_set` contains integer IDs (in your impl)
  or objects? PeeringDB canonical does **objects** at depth=1, **IDs** at depth=0.
  Your tests show you shifted this by one level (depth=0 omits sets entirely,
  depth=1 returns IDs). This is a known divergence — just document it if intentional.

- `depth=2` on `net`: the `netixlan_set` entries themselves should have their
  `ix_id` expanded into a full ix object. Django does this automatically via
  nested serializers. If your JOIN only goes one level deep, depth=2 and depth=1
  will look identical.

---

## 7. Cross-entity filters — Django's `__` relationship traversal

**Django**: `net?country=NL` works because of a queryset filter that joins through
`org__country=NL`. The `country` field lives on `org`, not on `net` directly.
This is Django ORM relationship traversal via `__` syntax.

**Your mirror**: You need to replicate this JOIN. If you stored a denormalized
`country` on the net table at sync time, it works. If not, `country=NL` on
`/api/net` requires a JOIN to `org`. Same for `fac__state` on ixfac.

**Other cross-entity filters**:
- `ix?region_continent=Europe` — continent is on ix directly, no JOIN needed
- `netfac?fac__city=Amsterdam` — traverses netfac → fac
- `netixlan?net__policy_general=Open` — traverses netixlan → net

If any of these silently return empty results instead of erroring, consumers
won't know their filter was ignored.

---

## 8. Boolean serialization

**Django REST Framework**: Serializes Python `True`/`False` as JSON `true`/`false`.
MySQL stores booleans as TINYINT(1), Django maps 0/1 → True/False in Python,
DRF serializes to JSON booleans.

**D1/SQLite**: SQLite has no native boolean type. Stores as INTEGER 0/1.
If you SELECT and return without casting, you get `0`/`1` in JSON, not
`true`/`false`. Your conformance tests already cover this, so you've likely
handled it. But watch for edge cases on **nullable booleans** — Django's
`NullBooleanField` serializes to `null`/`true`/`false`, SQLite gives `NULL`/`1`/`0`.

---

## 9. Empty result set with `limit=0` — count behavior

**Django**: PeeringDB uses `limit=0` to return a count in `meta.count` with
empty `data: []`. This is custom middleware, not standard DRF pagination.
The count comes from `queryset.count()` which does `SELECT COUNT(*)`.

**D1/SQLite**: `COUNT(*)` on large tables without a WHERE clause is **slow** on
SQLite because it does a full table scan (no row-count metadata like InnoDB).
Your loadtest showed two 30s timeouts on upstream for count queries, so you're
actually faster here. But watch for count queries with complex WHERE clauses —
D1 might be slower if indexes are missing.

---

## 10. `since` with `status=deleted` — soft delete semantics

**Django**: PeeringDB uses `status` field with values `ok`, `pending`, `deleted`.
Default queryset filters to `status=ok`. The `status=deleted` override with
`since>0` is a special case that bypasses the default filter.

**Your mirror**: If your sync only pulls `status=ok` records, you won't have
deleted records to serve. If your sync pulls everything, make sure your default
queries filter to `status=ok` and only include deleted records when explicitly
requested via `status=deleted`.

**Also**: deleted records on PeeringDB retain their data but with `status=deleted`.
If your sync deletes rows instead of soft-deleting, you can't serve
`status=deleted` queries at all.

---

## 11. Float vs Decimal — latitude/longitude, policy_ratio

**Django**: Uses `DecimalField` for lat/lng on facilities. Python's `Decimal` type
serializes with exact precision in JSON (e.g., `52.356700`).

**SQLite/JS**: Stores as REAL (IEEE 754 float). `52.3567` might serialize as
`52.35670000000001` in JSON. Most consumers won't care, but a strict byte-for-byte
comparison between your mirror and upstream will fail on these fields.

---

## 12. `social_media` and other JSON fields

**Django**: PeeringDB stores `social_media` as a JSONField (PostgreSQL native JSON
or MySQL JSON). DRF serializes it directly as a JSON array/object.

**D1/SQLite**: JSON is stored as TEXT. You need to `JSON_PARSE` on read or store
pre-parsed. If you double-serialize (JSON string inside a JSON response), you'll
get `"social_media": "[{\"service\":\"twitter\"}]"` instead of
`"social_media": [{"service":"twitter"}]`.

---

## 13. Integer overflow on speed field

**Django/MySQL**: `speed` on netixlan is `PositiveIntegerField` — max 2,147,483,647.
Some 800G ports are stored as `800000` (Mbps), well within range.

**D1/SQLite**: INTEGER is 64-bit signed. No issue here, but if you're using
JavaScript's `Number` type and any aggregation pushes past `Number.MAX_SAFE_INTEGER`
(2^53), you'll get silent precision loss. Unlikely but possible on SUM queries
across large IX participant lists.

---

## Implementation Status

| # | Gotcha | Status | Notes |
|---|--------|--------|-------|
| 1 | Unicode case folding | **Known divergence** | SQLite NOCASE only folds ASCII A-Z. Non-ASCII accented characters (ü, ö, é) won't match case-insensitively. Affects LATAM, DACH, Nordic facility names. |
| 2 | null vs empty string | **Mitigated** | Sync worker coerces null→"" for NOT NULL string columns (Django CharField convention). |
| 3 | Default ORDER BY | **Covered** | All queries include `ORDER BY id ASC`. |
| 4 | `__in` parameter limit | **Mitigated** | `validateQuery` rejects `__in` lists exceeding 500 values with a 400 error. |
| 5 | Timestamp precision | **Covered** | `since` uses `datetime(?, 'unixepoch')`. Minor format mismatch (space vs T separator) is benign. |
| 6 | Depth expansion | **Known divergence** | depth=2 resolves cross-entity name columns via JOINs but does not recursively expand child _set fields. |
| 7 | Cross-entity filters | **Covered** | Explicit (`fac__state=NSW`) and implicit (`net?country=NL`) filters both work via FK traversal. |
| 8 | Boolean serialization | **Covered** | Hot path uses SQL CASE→json(); cold path coerces via `!!val`; depth=2 child objects now also coerced. |
| 9 | limit=0 count | **Covered** | `handleCount` returns `{data:[], meta:{count:N}}`. |
| 10 | Soft delete semantics | **Known divergence** | Sync worker hard-deletes records. `?status=deleted` queries return empty. |
| 11 | Float precision | **Known divergence** | lat/lng stored as REAL (IEEE 754). May produce trailing precision digits in JSON. |
| 12 | JSON fields | **Covered** | `json()` wrapper on hot path; `JSON.parse()` on cold path and depth=2 children. |
| 13 | Integer overflow | **Non-issue** | No aggregation queries on speed. Individual values well within safe range. |