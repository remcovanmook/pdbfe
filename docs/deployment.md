# Deployment Guide

How to deploy the pdbfe stack from scratch.

## Prerequisites

- Node.js 22+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A Cloudflare account (Workers Paid plan recommended for D1 row limits)
- A PeeringDB account with an API key (https://www.peeringdb.com/apidocs/)
- Python 3 (for database population scripts)

## 1. Cloudflare Resource Setup

### Create D1 databases

```bash
# PeeringDB mirror data
wrangler d1 create peeringdb

# User profiles and API keys
wrangler d1 create pdbfe-users
```

Note both `database_id` values from the output — you'll need them for the wrangler configs.

### Create a KV namespace

```bash
wrangler kv namespace create SESSIONS
```

Note the namespace ID.

## 2. PeeringDB OAuth Application

Register an OAuth application at https://auth.peeringdb.com:

1. Log in to PeeringDB
2. Navigate to your profile → OAuth Applications
3. Create a new application:
   - **Redirect URI**: `https://pdbfe-auth.<your-subdomain>.workers.dev/auth/callback`
   - **Grant type**: Authorization Code
4. Note the **Client ID** and **Client Secret**

You'll also need a PeeringDB API key for the sync worker and WAF bypass:
1. Go to your PeeringDB profile → API Keys
2. Generate a new key

## 3. Wrangler Configuration

Copy each `.example` file and fill in your resource IDs:

```bash
cd workers
cp wrangler.toml.example wrangler.toml
cp wrangler-sync.toml.example wrangler-sync.toml
cp wrangler-auth.toml.example wrangler-auth.toml
```

Edit each file and replace the placeholders:
- `<your-d1-database-id>` → the ID from `wrangler d1 create peeringdb`
- `<your-users-d1-database-id>` → the ID from `wrangler d1 create pdbfe-users`
- `<your-sessions-kv-namespace-id>` → the SESSIONS namespace ID
- `<your-subdomain>` → your Cloudflare Workers subdomain
- `<your-pages-project>` → your Cloudflare Pages project name

## 4. Secrets

Set secrets for each worker. These are stored in Cloudflare and never committed to the repo.

### Sync worker

```bash
wrangler secret put PEERINGDB_API_KEY --config wrangler-sync.toml
```

### Auth worker

```bash
wrangler secret put OAUTH_CLIENT_ID --config wrangler-auth.toml
wrangler secret put OAUTH_CLIENT_SECRET --config wrangler-auth.toml
wrangler secret put PEERINGDB_API_KEY --config wrangler-auth.toml
```

The `PEERINGDB_API_KEY` on the auth worker is used in the `Authorization` header during the OAuth token exchange to bypass PeeringDB's WAF, which blocks requests from Cloudflare Workers without an auth header.

## 5. Local Environment

Copy the environment template and fill in your values:

```bash
cp .env.example .env
# Edit .env with your actual credentials
```

The `.env` file is sourced by `migrate-to-d1.sh` and used for local development. It is gitignored.

## 6. Database Population

### Initial cold start

Download entity JSON from the PeeringDB API and populate D1:

```bash
# Local dev database
./scripts/migrate-to-d1.sh --fetch

# Production D1
./scripts/migrate-to-d1.sh --fetch --remote
```

This downloads all 13 entity types from the PeeringDB API, converts them to INSERT statements, and loads them into D1 in batches. The `--fetch` flag downloads fresh JSON; without it, the script expects pre-existing JSON files in `database/`.

After the initial load, the sync worker handles incremental updates every 15 minutes via the `since` parameter.

### Users database schema

Bootstrap the users database schema (required before any logins or API key creation):

```bash
# From the repo root
npx wrangler d1 execute pdbfe-users --file=database/users/schema.sql --remote
```

## 7. Worker Deployment

Deploy all three workers:

```bash
cd workers

# API worker
npx wrangler deploy --config wrangler.toml

# Sync worker (cron-triggered)
npx wrangler deploy --config wrangler-sync.toml

# Auth worker (OAuth + account management)
npx wrangler deploy --config wrangler-auth.toml
```

## 8. Frontend Deployment

The frontend is a static SPA deployed to Cloudflare Pages.

### Configure the frontend

```bash
cd frontend
cp js/config.js.example js/config.js
cp _headers.example _headers
cp _redirects.example _redirects
```

Edit each file and replace the `<your-subdomain>` placeholders with your actual hostnames.

### Deploy to Pages

Create a Cloudflare Pages project via the dashboard or CLI:

```bash
npx wrangler pages project create <your-pages-project>
npx wrangler pages deploy frontend/ --project-name <your-pages-project>
```

The `_redirects` file proxies `/api/*` requests to the API worker, so the frontend can make same-origin API calls.

## 9. Verification

### Health check

```bash
curl https://pdbfe-api.<your-subdomain>.workers.dev/health
```

Should return `200 OK` with D1 connectivity status.

### First API call

```bash
curl https://pdbfe-api.<your-subdomain>.workers.dev/api/net?limit=5
```

### Sync status

```bash
curl https://pdbfe-sync.<your-subdomain>.workers.dev/sync/status
```

Shows last sync timestamp and row counts per entity.

### Frontend

Visit `https://<your-pages-project>.pages.dev` — you should see the PeeringDB mirror SPA.

## Credential Summary

| Credential | Where it lives | Used by |
|---|---|---|
| `PEERINGDB_API_KEY` | `.env` (local), wrangler secret (prod) | Sync worker, auth worker (WAF bypass) |
| `CLOUDFLARE_API_TOKEN` | `.env` (local only) | Wrangler CLI for deployments |
| `OAUTH_CLIENT_ID` | wrangler secret | Auth worker |
| `OAUTH_CLIENT_SECRET` | wrangler secret | Auth worker |
| `AUTH_ORIGIN` | `frontend/js/config.js` | Frontend SPA |
| `API_ORIGIN` | `frontend/js/config.js` | Frontend SPA |
| D1 database ID (peeringdb) | `wrangler.toml`, `wrangler-sync.toml` | API + sync workers |
| D1 database ID (pdbfe-users) | `wrangler.toml`, `wrangler-auth.toml` | API + auth workers |
| KV namespace ID (SESSIONS) | `wrangler.toml`, `wrangler-auth.toml` | API + auth workers |
