# OAuth Authentication Architecture

This document describes the OAuth2 authentication and API key management
system for the pdbfe stack.

## Overview

Authentication is split across two Cloudflare Workers and the frontend SPA:

| Component | Role | Storage |
|---|---|---|
| **pdbfe-auth** | OAuth ceremony, session CRUD, account/key management | SESSIONS KV (rw), USERDB D1 (rw) |
| **pdbfe-api** | Session + API key verification | SESSIONS KV (ro), USERDB D1 (ro) |
| **Frontend (Pages)** | Token storage, UI state, /account SPA page | localStorage |

## OAuth Login Flow

```
User clicks "Sign in with PeeringDB"
        │
        ▼
pdbfe-auth /auth/login
        │  Generates CSRF state nonce → HttpOnly cookie (5min Max-Age)
        │  Redirects to auth.peeringdb.com/oauth2/authorize/
        ▼
PeeringDB authorize page (user logs in)
        │
        ▼
pdbfe-auth /auth/callback?code=...&state=...
        │  1. Validate state nonce (cookie must match URL state parameter)
        │  2. POST code → auth.peeringdb.com/oauth2/token/ → access_token
        │     (with Api-Key header to bypass PeeringDB WAF — see below)
        │  3. GET auth.peeringdb.com/profile/v1 → user profile
        │  4. Generate session ID (32 random bytes, hex)
        │  5. KV.put("session:<sid>", {profile}, TTL=24h)
        │  6. Clear oauth_state cookie
        │  7. Redirect to frontend/?sid=<session_id>
        ▼
Frontend picks up ?sid= from URL query parameters
        │  Stores in localStorage, strips param from URL
        │  Validates via GET pdbfe-auth /auth/me
        │  Renders user name + "Account" + "Sign out" in header
        ▼
Subsequent API requests include:
    Authorization: Bearer <sid>
        │
        ▼
pdbfe-api resolves session:
    extractSessionId(request) → sid
    resolveSession(env.SESSIONS, sid) → SessionData | null
    authenticated = session !== null
```

### PeeringDB WAF Workaround

PeeringDB's WAF blocks Cloudflare Worker subrequests that lack an
`Authorization` header. The token exchange sends OAuth client credentials
in the POST body (for Django OAuth Toolkit) and a `PEERINGDB_API_KEY`
in the `Authorization: Api-Key` header (to satisfy the WAF).

Session tokens are passed via URL query parameters (`?sid=...`) rather than
URL fragments (`#sid=...`) because Cloudflare Access strips fragments during
its redirect chain.

## API Key Authentication

Users can generate `pdbfe.`-prefixed API keys via the /account page.
These keys are independent of PeeringDB credentials and grant
`authenticated = true` status on the mirror's API.

```
Client sends: Authorization: Api-Key pdbfe.<32 hex chars>
        │
        ▼
pdbfe-api:
    extractApiKey(request) → "pdbfe.<hex>"
    verifyApiKey(env.USERDB, key) → boolean
        │  1. Check in-memory per-isolate cache (5min TTL)
        │  2. If miss: SELECT 1 FROM api_keys WHERE hash = SHA-256(key)
        │  3. Cache result (positive and negative)
        │
    if valid → authenticated = true
    if invalid → fall through to session check or anonymous
```

### Key format

- Full key: `pdbfe.<32 hex characters>` (e.g. `pdbfe.a1b2c3d4...`)
- Key ID: First 8 hex characters (for identification in delete requests)
- Display prefix: First 4 hex characters (shown in the UI as `pdbfe.a1b2…`)
- Maximum 5 keys per user

## Data Storage

### SESSIONS KV namespace (`pdbfe-sessions`)

| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `session:<hex64>` | JSON SessionData | 24 hours | pdbfe-auth |

### USERDB D1 database (`pdbfe-users`)

User profiles and API keys are stored in a dedicated D1 database, separate
from the PeeringDB mirror data. This ensures user data is never affected
by mirror rebuilds and provides ACID guarantees on key operations.

#### `users` table

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | PeeringDB user ID |
| `name` | TEXT | Display name |
| `email` | TEXT | Email address |
| `preferences` | TEXT | JSON preferences (`{ language?, ... }`) |
| `created_at` | TEXT | ISO 8601 timestamp |
| `updated_at` | TEXT | ISO 8601 timestamp |

#### `api_keys` table

| Column | Type | Description |
|---|---|---|
| `key_id` | TEXT (PK) | First 8 hex chars of key |
| `user_id` | INTEGER (PK, FK) | References users.id |
| `label` | TEXT | User-assigned label |
| `prefix` | TEXT | First 4 hex chars (for UI display) |
| `hash` | TEXT (UNIQUE) | SHA-256 hex digest of the full key |
| `created_at` | TEXT | ISO 8601 timestamp |

The `idx_api_keys_hash` index on `hash` serves the API worker's key
verification hot path. The full key is never stored.

#### `user_favorites` table

| Column | Type | Description |
|---|---|---|
| `user_id` | INTEGER (PK, FK) | References users.id |
| `entity_type` | TEXT (PK) | Entity type tag (net, ix, fac, org, carrier, campus) |
| `entity_id` | INTEGER (PK) | Entity ID in the mirror database |
| `label` | TEXT | Cached display name |
| `created_at` | TEXT | ISO 8601 timestamp |

Composite PK `(user_id, entity_type, entity_id)` prevents duplicates.
`idx_user_favorites_list` on `(user_id, created_at DESC)` supports
ordered listing. Maximum 50 favorites per user (application-enforced).

#### `preference_options` table

Lookup table defining valid preference keys and values. Used by both
the `GET /account/preferences/options` (public) and
`PUT /account/profile` (validation) endpoints.

| Column | Type | Description |
|---|---|---|
| `pref_key` | TEXT (PK) | Preference key (language, theme, timezone) |
| `pref_value` | TEXT (PK) | Valid value for that key |

Seeded by migration `0002_preference_options.sql` with:
- `language`: en, cs, de, el, es, fr, it, ja, lt, pt, ro, ru, zh-cn, zh-tw
- `theme`: auto, dark, light
- `timezone`: IANA timezone names

## Session Data Structure

```json
{
  "id": 3,
  "name": "Matt Griswold",
  "given_name": "Matt",
  "family_name": "Griswold",
  "email": "grizz@20c.com",
  "verified_user": true,
  "verified_email": true,
  "networks": [
    { "perms": 15, "asn": 63311, "name": "20C", "id": 20 }
  ],
  "created_at": "2026-04-05T18:00:00.000Z"
}
```

## Account Management API

Served by pdbfe-auth under `/account/*`. All endpoints require a valid
session (`Authorization: Bearer <sid>`).

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/account/preferences/options` | GET | No | Available preference keys/values (language, theme, timezone) |
| `/account/profile` | GET | Yes | Return user profile + preferences from USERDB D1 |
| `/account/profile` | PUT | Yes | Update profile name and/or preferences |
| `/account/keys` | GET | Yes | List API keys (label + prefix, no full keys) |
| `/account/keys` | POST | Yes | Generate new API key, return full key once |
| `/account/keys/:id` | DELETE | Yes | Revoke an API key |
| `/account/favorites` | GET | Yes | List favorited entities |
| `/account/favorites` | POST | Yes | Add a favorite (entity_type, entity_id, label) |
| `/account/favorites` | PUT | Yes | Replace entire favorites list (reorder) |
| `/account/favorites/:type/:id` | DELETE | Yes | Remove a favorite |

User records are auto-provisioned on first OAuth login if missing.

Preference validation is data-driven: `PUT /account/profile` checks each
preference key/value pair against `preference_options` via D1 query.
No hardcoded lists in the worker code.

## Security

- **CSRF protection**: Double Submit Cookie pattern — state nonce is set as an `HttpOnly; Secure; SameSite=Lax` cookie during `/auth/login` and verified against the URL `state` parameter in `/auth/callback`. No server-side state storage needed. Cookie is cleared after use.
- **CORS origin matching**: `resolveAllowedOrigin()` reflects the request's `Origin` header when it matches the production `FRONTEND_ORIGIN` or any Cloudflare Pages preview subdomain (`*.pdbfe-frontend.pages.dev`). This allows branch preview deployments to use the auth API without CORS failures. Non-matching origins fall back to the production origin.
- **Session ID**: 32 bytes from `crypto.getRandomValues`, making brute-force infeasible.
- **Query parameters**: Session IDs are passed via `?sid=` (survives Cloudflare Access redirects). The frontend strips the query param immediately after reading it.
- **Token storage**: Frontend stores session ID in `localStorage`. Not accessible to other origins.
- **OAuth secrets**: `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, and `PEERINGDB_API_KEY` are stored as wrangler secrets, not in source control.
- **Verified users only**: Unverified PeeringDB accounts are rejected at the callback step.
- **API key display**: Full API keys are shown only once at creation. Only the 4-char prefix is stored.
- **ACID key operations**: API key creation and deletion use D1 `batch()` for atomic multi-statement execution, preventing orphaned reverse-index entries ("Ghost Keys").

## Secrets

| Secret | Worker | Purpose |
|---|---|---|
| `OAUTH_CLIENT_ID` | pdbfe-auth | PeeringDB OAuth application ID |
| `OAUTH_CLIENT_SECRET` | pdbfe-auth | PeeringDB OAuth application secret |
| `PEERINGDB_API_KEY` | pdbfe-auth | Used in Authorization header to bypass PeeringDB WAF |

## Files

### Auth Worker
- `workers/auth/index.js` — Router: path prefix matching, delegates to handlers
- `workers/auth/http.js` — Shared CORS, preflight, response helpers, session resolution, user record helpers
- `workers/auth/handlers/index.js` — Barrel re-exports: handleAuth, handlePreferences, handleProfile, handleKeys, handleFavorites
- `workers/auth/handlers/oauth.js` — handleAuth: login, callback, logout, me
- `workers/auth/handlers/profile.js` — handlePreferences + handleProfile: preference options, profile GET/PUT
- `workers/auth/handlers/keys.js` — handleKeys: API key list, create, revoke
- `workers/auth/handlers/favorites.js` — handleFavorites: favorites list, add, replace, remove

### Shared Auth Module
- `workers/core/auth.js` — Session resolution, API key verification (with in-memory cache), session lifecycle

### API Worker
- `workers/api/index.js` — Authentication block: tries API-Key, then session

### Frontend
- `frontend/js/auth.js` — Session state management, UI rendering
- `frontend/js/api.js` — Attaches `Authorization: Bearer` header when session exists
- `frontend/js/pages/account.js` — Account page with profile, networks, API key management

### Configuration
- `workers/wrangler-auth.toml` — Auth worker config (SESSIONS KV, USERDB D1, OAuth vars)
- `workers/wrangler.toml` — API worker config (SESSIONS KV, USERDB D1 for read)
- `workers/types.d.ts` — PdbAuthEnv, PdbApiEnv, SessionData, UserRecord, ApiKeyEntry types
