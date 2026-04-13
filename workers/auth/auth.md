# OAuth Authentication Architecture

This document describes the OAuth2 authentication and API key management
system for the pdbfe stack.

## Overview

Authentication is split across two Cloudflare Workers and the frontend SPA:

| Component | Role | KV Access |
|---|---|---|
| **pdbfe-auth** | OAuth ceremony, session CRUD, account/key management | SESSIONS (rw), USERS (rw) |
| **pdbfe-api** | Session + API key verification | SESSIONS (ro), USERS (ro) |
| **Frontend (Pages)** | Token storage, UI state, /account SPA page | None |

## OAuth Login Flow

```
User clicks "Sign in with PeeringDB"
        │
        ▼
pdbfe-auth /auth/login
        │  Generates CSRF state nonce → KV (5min TTL)
        │  Redirects to auth.peeringdb.com/oauth2/authorize/
        ▼
PeeringDB authorize page (user logs in)
        │
        ▼
pdbfe-auth /auth/callback?code=...&state=...
        │  1. Validate state nonce (KV get + delete)
        │  2. POST code → auth.peeringdb.com/oauth2/token/ → access_token
        │     (with Api-Key header to bypass PeeringDB WAF — see below)
        │  3. GET auth.peeringdb.com/profile/v1 → user profile
        │  4. Generate session ID (32 random bytes, hex)
        │  5. KV.put("session:<sid>", {profile}, TTL=24h)
        │  6. Redirect to frontend/?sid=<session_id>
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
    verifyApiKey(env.USERS, key) → boolean
        │  1. Check in-memory per-isolate cache (5min TTL)
        │  2. If miss: KV.get("apikey:<full_key>")
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

## KV Schema

### SESSIONS namespace (`pdbfe-sessions`)

| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `session:<hex64>` | JSON SessionData | 24 hours | pdbfe-auth |
| `oauth_state:<hex64>` | JSON `{created_at}` | 5 minutes | pdbfe-auth |

### USERS namespace (`pdbfe-users`)

| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `user:<pdb_user_id>` | JSON UserRecord | None (persistent) | pdbfe-auth |
| `apikey:<full_key>` | JSON ApiKeyEntry `{user_id, label, created_at}` | None (persistent) | pdbfe-auth |

The `apikey:` entries are reverse indexes — the API worker looks up incoming
`Api-Key` headers by key value. The user record stores the key list with only
the 4-char prefix (for display), never the full key.

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

| Endpoint | Method | Description |
|---|---|---|
| `/account/profile` | GET | Return user profile from USERS KV |
| `/account/keys` | GET | List API keys (label + prefix, no full keys) |
| `/account/keys` | POST | Generate new API key, return full key once |
| `/account/keys/:id` | DELETE | Revoke an API key |

User records are auto-provisioned on first OAuth login if missing.

## Security

- **CSRF protection**: State nonce is single-use (deleted after validation), stored in KV with 5-minute TTL.
- **Session ID**: 32 bytes from `crypto.getRandomValues`, making brute-force infeasible.
- **Query parameters**: Session IDs are passed via `?sid=` (survives Cloudflare Access redirects). The frontend strips the query param immediately after reading it.
- **Token storage**: Frontend stores session ID in `localStorage`. Not accessible to other origins.
- **OAuth secrets**: `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, and `PEERINGDB_API_KEY` are stored as wrangler secrets, not in source control.
- **Verified users only**: Unverified PeeringDB accounts are rejected at the callback step.
- **API key display**: Full API keys are shown only once at creation. Only the 4-char prefix is stored in the user record.

## Secrets

| Secret | Worker | Purpose |
|---|---|---|
| `OAUTH_CLIENT_ID` | pdbfe-auth | PeeringDB OAuth application ID |
| `OAUTH_CLIENT_SECRET` | pdbfe-auth | PeeringDB OAuth application secret |
| `PEERINGDB_API_KEY` | pdbfe-auth | Used in Authorization header to bypass PeeringDB WAF |

## Files

### Auth Worker
- `workers/auth/index.js` — Router for /auth/* and /account/* endpoints
- `workers/auth/oauth.js` — OAuth handlers (login, callback, logout, me)
- `workers/auth/account.js` — Account profile and API key CRUD handlers

### Shared Auth Module
- `workers/core/auth.js` — Session resolution, API key verification (with in-memory cache), session lifecycle

### API Worker
- `workers/api/index.js` — Authentication block: tries API-Key, then session

### Frontend
- `frontend/js/auth.js` — Session state management, UI rendering
- `frontend/js/api.js` — Attaches `Authorization: Bearer` header when session exists
- `frontend/js/pages/account.js` — Account page with profile, networks, API key management

### Configuration
- `workers/wrangler-auth.toml` — Auth worker config (SESSIONS + USERS KV, OAuth vars)
- `workers/wrangler.toml` — API worker config (SESSIONS + USERS KV for read)
- `workers/types.d.ts` — PdbAuthEnv, PdbApiEnv, SessionData, UserRecord, ApiKeyEntry types
