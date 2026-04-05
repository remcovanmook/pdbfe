# OAuth Authentication Architecture

This document describes the OAuth2 authentication system for the pdbfe stack.

## Overview

Authentication is split across two Cloudflare Workers and the frontend SPA:

| Component | Role | KV Access |
|---|---|---|
| **pdbfe-auth** | OAuth ceremony, session CRUD | Read/Write |
| **pdbfe-api** | Session verification only | Read |
| **Frontend (Pages)** | Token storage, UI state | None |

## Flow

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
        │  3. GET auth.peeringdb.com/profile/v1 → user profile
        │  4. Generate session ID (32 random bytes, hex)
        │  5. KV.put("session:<sid>", {profile}, TTL=24h)
        │  6. Redirect to frontend/#sid=<session_id>
        ▼
Frontend picks up #sid from URL fragment
        │  Stores in localStorage
        │  Validates via GET pdbfe-auth /auth/me
        │  Renders user name + "Sign out" in header
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

## KV Schema

Namespace: `pdbfe-sessions`

| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `session:<hex64>` | JSON SessionData | 24 hours | pdbfe-auth |
| `oauth_state:<hex64>` | JSON `{created_at}` | 5 minutes | pdbfe-auth |

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

## Security

- **CSRF protection**: State nonce is single-use (deleted after validation), stored in KV with 5-minute TTL.
- **Session ID**: 32 bytes from `crypto.getRandomValues`, making brute-force infeasible.
- **URL fragments**: Session IDs are passed via URL fragments (`#sid=...`), which are not sent to servers in HTTP requests — they stay client-side only.
- **Token storage**: Frontend stores session ID in `localStorage`. Not accessible to other origins.
- **OAuth secrets**: `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` are stored as wrangler secrets, not in source control.
- **Verified users only**: Unverified PeeringDB accounts are rejected at the callback step.

## Files

### Auth Worker
- `workers/auth/index.js` — Router for /auth/* endpoints
- `workers/core/oauth.js` — OAuth handlers (login, callback, logout, me)

### Shared Auth Module
- `workers/core/auth.js` — Session resolution (KV reads), session lifecycle (KV writes), session ID generation, API-Key extraction

### API Worker
- `workers/api/index.js` — Updated authentication block to try session resolution after API-Key

### Frontend
- `frontend/js/auth.js` — Session state management, UI rendering
- `frontend/js/api.js` — Attaches `Authorization: Bearer` header when session exists

### Configuration
- `workers/wrangler-auth.toml` — Auth worker config (KV binding, OAuth vars)
- `workers/wrangler.toml` — API worker config (KV binding added)
- `workers/types.d.ts` — PdbAuthEnv, SessionData types
