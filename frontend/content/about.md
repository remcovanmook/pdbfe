# About This Mirror

## What is this?

This site is a read-only mirror of the [PeeringDB](https://www.peeringdb.com) database. The data is synchronised periodically from the PeeringDB API and served from Cloudflare's edge network for low-latency lookups.

The mirror provides the same REST API interface as the upstream PeeringDB, with the exception of write operations (POST, PUT, PATCH, DELETE), which are not supported. For account management, data submission, or any other write operations, visit [peeringdb.com](https://www.peeringdb.com).

## Data Freshness

The database is synchronised incrementally. The sync status is displayed in the footer of every page. Typical sync intervals are on the order of minutes, though delays may occur. This mirror should not be considered authoritative — the canonical source is always [peeringdb.com](https://www.peeringdb.com).

## Authentication

You can sign in using your existing PeeringDB account. Click **Sign in with PeeringDB** in the header to authenticate via PeeringDB's OAuth2 flow. No separate registration is required — your PeeringDB credentials are used directly.

Signing in gives you access to contact information (POC data) that is restricted to authenticated users on the upstream PeeringDB. Your session lasts 24 hours.

## API Keys

Once signed in, you can create API keys for programmatic access to the mirror at [your account page](/account). These keys are specific to this mirror — upstream PeeringDB API keys are not accepted here.

To use a key, include it in the `Authorization` header of your API requests:

```
curl -H "Authorization: Api-Key pdbfe.your_key_here" \
    https://your-mirror-host/api/net?asn=13335
```

Keys follow the format `pdbfe.<32 hex chars>`. You can create up to 5 keys per account. The full key is shown only once at creation — copy it then. You can revoke keys at any time from the account page.

## API

The mirror exposes a PeeringDB-compatible REST API. Example:

```
GET /api/net/694?depth=2
```

Supported query parameters include `depth`, `limit`, `skip`, `since`, and the standard PeeringDB filter suffixes (`__contains`, `__lt`, `__gt`, `__in`, etc.).

Endpoints available: `net`, `org`, `fac`, `ix`, `ixlan`, `ixpfx`, `netixlan`, `netfac`, `poc`, `carrier`, `carrierfac`, `ixfac`, `campus`, `as_set`.

## Acceptable Use

All data served by this mirror originates from PeeringDB and is subject to the PeeringDB [Acceptable Use Policy](https://www.peeringdb.com/aup) and [Privacy Policy](https://docs.peeringdb.com/gov/misc/2017-04-02-PeeringDB_Privacy_Policy.pdf).

## Source Code

The code for this mirror is open source. PeeringDB itself is maintained at [github.com/peeringdb/peeringdb](https://github.com/peeringdb/peeringdb).
