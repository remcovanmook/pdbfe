# Worker Security & Quality Audit — July 2026

**Scope:** the entire Cloudflare Workers codebase under `workers/` — the API,
GraphQL, REST, search, auth, and sync workers, **plus the shared `core/`
layer** they all depend on. Not limited to a single diff.

**Trigger:** enabling the Cloudflare Workers Cache (`#84`, `#85`, `#87`)
widened the blast radius of any anonymous-reachable data-exposure or
correctness bug — a wrong response is no longer per-request, it can be cached
and re-served at the edge. That prompted a full review of the request path
before leaning on the cache.

**Method:** a fan-out review — independent finder passes over each worker and
`core/` for (a) anonymous-reachable data exposure, (b) resource/DoS bounds,
(c) input coverage, and (d) maintainability/quality — followed by a
verification pass on each candidate. Findings were then batched into focused
PRs by theme.

**Outcome:** all verified findings fixed across `#90`–`#99`. No `VERSION` bump
per PR; releases are cut from git tags via the Release workflow (`#98`).

---

## Fixes by theme

### 1. Anonymous-reachable data exposure — `#90`

The highest-severity class: data an unauthenticated caller should not see,
reachable on the public read path (and therefore cacheable once the edge cache
was on).

| Finding | Fix |
| --- | --- |
| Column projection returned columns the route never intended to expose (e.g. `notes_private`, internal `__vector_embedded`). | `resolveColumns(entity, opts)` intersects the caller's requested `fields` with an explicit per-entity allowlist (`getColumns`). Extension columns are gated by `PDBFE_EXTENSION_COLUMNS` (`['__logo_migrated']`). |
| Restricted entities (`poc`) could leak non-public rows to anonymous callers. | Visibility injection in `buildWherePagination`: for restricted entities, anonymous requests are forced to `"visible" = 'Public'` (`_restricted` + `_anonFilter`), and any caller-supplied `visible` filter is ignored for anon. |
| `__pdbfe=1` marker exposed internal migration state to any client. | Removed as an input flag; `__logo_migrated` (a harmless "logo is in our R2" hint) is emitted through the allowlist only. |
| 500 responses returned `err.stack` in the body. | `wrapHandler` logs the stack server-side only; the body carries no internals. |

### 2. Resource / DoS bounds — `#91`

| Finding | Fix |
| --- | --- |
| Depth expansion had no ceiling — a crafted `depth=` could fan out unboundedly. | `DEPTH_EXPANSION_CAP = 250`. |
| No cap on page size. | `MAX_PAGE_LIMIT = 1_000_000` as a backstop. Deliberately high: the entire upstream dataset is ~60 MB / ~65k rows, so this bounds pathological requests without constraining legitimate bulk reads. |

### 3. GraphQL query complexity — `#92`

| Finding | Fix |
| --- | --- |
| GraphQL accepted arbitrarily deep / wide queries — a cheap amplification vector. | `createComplexityRule({ maxDepth: 12, maxFields: 1000 })`, a validation rule with fragment resolution and cycle guarding, wired in via an `onValidate` plugin. |

### 4. Search input hardening — `#93`

| Finding | Fix |
| --- | --- |
| `LIKE` inputs weren't escaped — metacharacter injection into the pattern. | `escapeLike` char-loop + `ESCAPE '\'`. |
| Unbounded query length / skip. | `MAX_Q_LEN = 256`, `MAX_SKIP = 10000`. |
| Graph id hydration interpolated ids without validation. | Ids validated to integers before use. |

### 5. Auth input caps — `#94`

| Finding | Fix |
| --- | --- |
| Favorites reorder / add had no bounds or dedup. | Descending-order write (`baseTime - order`), dedup `Set` + `INSERT OR IGNORE`. |
| Profile name / preferences unbounded. | `MAX_NAME_LEN = 200`, `MAX_PREF_KEYS = 50`. |
| Rate-limit key could be built from an empty IP. | `normaliseIP` returns `'unknown'` when the IP is absent. |

### 6. Sync input coverage — `#95`

| Finding | Fix |
| --- | --- |
| Non-finite numerics (`NaN`, `Infinity`) reached D1. | `coerceValue` maps them to `null`. |
| Column set derived from a single row could miss keys. | Columns taken from the union of active row keys; `ensureColumns` returns the existing set. |
| Vector averaging over mismatched-length vectors. | `averageVectors` skips vectors whose length doesn't match. |

### 7. Auth mutation hardening (CSRF) — `#96`

| Finding | Fix |
| --- | --- |
| State-changing requests could authenticate via the `pdbfe_sid` cookie, which the browser auto-attaches — a latent CSRF vector. | New `extractBearerToken(request)` (Bearer only). `requireSession` accepts cookie **or** Bearer for reads, but **Bearer only** for `POST/PUT/PATCH/DELETE`. The SPA already uses Bearer/localStorage, so this is transparent. |
| API `key_id` was 8 hex chars (32 bits) derived from the key prefix — birthday-bound collision at ~2¹⁶ keys, and leaked key material. | `keyId` is now 16 hex chars (64 bits) derived from the key **hash**. Backward-compatible: lookups are by `hash`, so existing 8-char ids keep working. |

### 8. Compare handler — `#97`

| Finding | Fix |
| --- | --- |
| The six overlap functions duplicated `only_a`/`only_b` SQL and ran serially, unbounded. | Same-entity pairs define the SQL once and bind twice; all sub-queries run via `Promise.all`; each is bounded by `LIMIT COMPARE_ROW_LIMIT` (10000). Param parse widened to `tokenizeString(..., -1)`. |

### 9. Cache / pipeline correctness + hot-path cleanups — `#99`

The cache-specific correctness pass, once the cache was actually load-bearing:

| Finding | Fix |
| --- | --- |
| L2 (per-PoP Cache API) key was `prefix + rawKey`; a key with a `..` segment path-normalised into a **different** key (cross-request byte mix-up), and a space/quote/`#` truncated the synthetic URL and silently disabled L2 for that entry. | `l2Url()` percent-encodes the key; get and put share it. |
| L2 `Cache-Control: max-age` took a fractional TTL (e.g. `0.5` from a 500 ms negative TTL), which rounded to `0` and disabled caching. | Floor to `≥ 1s`. |
| The L1 byte-budget eviction loop spun forever when every remaining entry was pinned (`evict()` returned `-1` without freeing anything while `size` stayed over budget). | Loop stops on `-1`. |
| `isNotModified` compared the whole `If-None-Match` header against one ETag, missing `304`s when the client held more than one representation. | Compare each token of the comma-separated list (RFC 9110 §13.1.2). |
| Cold-boot `/status`: if `refresh()` couldn't build a payload (D1 briefly down, or `_sync_meta` empty), it served `new Response(null, {status: 200})` — a misleading empty **200** that cached nothing. | Return `503` instead. |
| The list handler `TextDecoder`-decoded the whole (up to ~60 MB) payload to a string on every hit just to count rows for prefetch. | `countRowsBytes()` scans the raw `Uint8Array` for the `},{` separator — the ASCII bytes can't collide with UTF-8 continuation bytes, so it's exactly equivalent without the allocation. |
| Misc: `new URL()` in the auth router; empty CORS origin on two early `400`s; dead `TRAVERSAL_VERBS`. | `parseURL()` (also stricter — no dot-segment normalisation); reflect the resolved origin; remove dead code. |

---

## Production incidents surfaced during the work

Two outages were diagnosed and fixed with `wrangler tail` ground-truth before
shipping (an initial hypothesis on each turned out wrong):

- **`net` 500s — `no such column: ixp_update_exclude_speed`** (`#86`): a
  regenerated entity schema outran the D1 columns. Fixed with migration `008`
  (three boolean columns). **Guarded** by a CI check (`#88`,
  `scripts/diff_schema.py --check`) that fails when a schema addition ships
  without a matching migration.
- **Sync 500 — `batch message count of 200 exceeds limit of 100`** (`#89`):
  `QUEUE_BATCH` was 200 vs Cloudflare Queues' hard limit of 100.

## Release-model change — `#98`

Concurrent audit PRs kept colliding on the `VERSION` line, producing release
churn. The fix decoupled releases from merges: PRs never touch `VERSION`; the
**Release** workflow (`workflow_dispatch`) derives the next version from the
latest `git tag` and tags on deploy. The per-PR version-check CI job was
removed.

---

## Deferred (intentional, low-risk)

- **`isNegative` byte-match (C12).** The negative-cache sentinel is detected by
  byte-comparing against `EMPTY_ENVELOPE`. In practice this is harmless: list
  handlers serve `EMPTY_ENVELOPE` as `200` on a null result anyway, and detail
  payloads never equal the sentinel bytes. The clean fix (an explicit
  negativity flag threaded through the pipeline) is a riskier shared-pipeline
  change, left for its own PR.
- **Cold-boot `/status` request coalescing.** The `503` guard fixes the
  correctness issue; de-duping concurrent cold-boot polls (each one cheap
  query on a low-traffic endpoint) was not worth the added machinery.

## Additional hardening (0.13)

A cheap-hardening pass after the audit, once the surface was well understood.

**Already in place (verified, no change needed):**

- Auth/anon **cache-key partitioning** (`api/index.js` — `cachePath` is prefixed
  `auth:`/`anon:`) so an authenticated response can never be served to an
  anonymous caller from cache.
- `Vary: Authorization` + `Cache-Control: private` on authenticated responses,
  so the edge never stores or replays them.
- GraphQL `graphiql: false`, `landingPage: false`, and the depth/field
  complexity plugin.
- Restricted-entity (`poc`) anonymous gating with anti-spoofing on the
  `visible` filter.

**Added:**

- **`X-Content-Type-Options: nosniff` on every response.** Injected once in
  `wrapHandler` (`core/admin.js`), the single choke point all five request
  workers export through — so it covers cached, error, preflight, static, and
  GraphQL/Yoga responses uniformly.

**Considered and deferred (low value / more than cheap):**

- **Disabling GraphQL introspection.** The SDL is already published (generated
  `graphql` schema + OpenAPI spec), so introspection leaks nothing secret — it
  would only trim query surface. Not worth the change.
- **Auth-worker rate limiting.** Every auth endpoint is behind `requireSession`
  and key creation is capped (`MAX_KEYS_PER_USER = 5`), so abuse is
  authenticated-only. Per-user throttling on profile/favorites/key writes is a
  reasonable future addition but is more than a one-line change.
