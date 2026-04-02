# PeeringDB API — 10 Most Common Integration Patterns

**Base URL:** `https://www.peeringdb.com/api/`  
**Auth:** `Authorization: Api-Key $API_KEY` header, or basic auth, or anonymous (lower rate limits)  
**Format:** JSON by default. All responses wrap in `{"data": [...], "meta": {}}`

---

## 1. Network Lookup by ASN

The single most common call. Used by Peering Manager, peerpal, arouteserver, ixgen, and virtually every automation tool.

```bash
# Get network record for AS42
curl -H "Authorization: Api-Key $API_KEY" \
  "https://www.peeringdb.com/api/net?asn=42"
```

Returns: `info_prefixes4`, `info_prefixes6`, `irr_as_set`, `policy_general`, `name`, `website`, `notes`, all `*_set` arrays.

---

## 2. IX Peering LAN Presence by ASN (netixlan)

Used to find where a network peers at IXPs — IPs, speeds, route server peering status. Core of any "common IX" finder.

```bash
# All IX connections for AS58717
curl -sG "https://www.peeringdb.com/api/netixlan" \
  --data-urlencode "asn=58717" \
  --data-urlencode "fields=ix_id,ipaddr4,ipaddr6,speed,is_rs_peer"

# By net_id instead
curl "https://www.peeringdb.com/api/netixlan?net_id=31"
```

---

## 3. Facility Presence by ASN (netfac)

Which datacenters/facilities does a network have presence in? Used for PNI/cross-connect planning.

```bash
# Facilities for a network by ASN
curl "https://www.peeringdb.com/api/netfac?local_asn=196610"

# Or by net_id
curl "https://www.peeringdb.com/api/netfac?net_id=13251"
```

---

## 4. IX Participant List

Get all networks present at a specific IX. Used by IX operators and peering coordinators.

```bash
# All participants at AMS-IX (ix_id=26)
curl "https://www.peeringdb.com/api/netixlan?ix_id=26"

# With expanded fields
curl "https://www.peeringdb.com/api/netixlan?ixlan_id=62"
```

---

## 5. Find Common IXPs Between Two ASNs

The classic "where can we peer?" query. Requires two calls + client-side intersection, or use the overlap endpoint.

```bash
# Step 1: get IX presence for both ASNs
curl "https://www.peeringdb.com/api/netixlan?asn=13335" > left.json
curl "https://www.peeringdb.com/api/netixlan?asn=15169" > right.json
# Step 2: intersect on ix_id client-side

# Or, if available, use the built-in overlap:
# (added via GitHub issue #16 / #1020)
```

---

## 6. IX Details + Prefix Info

Get IX metadata and its peering LAN prefixes. Used by route server config generators (arouteserver, etc.).

```bash
# IX details
curl "https://www.peeringdb.com/api/ix/31"

# IX LAN info
curl "https://www.peeringdb.com/api/ixlan?ix_id=31"

# Peering LAN prefixes (IPv4/IPv6 ranges)
curl "https://www.peeringdb.com/api/ixpfx?ixlan_id=31"
```

---

## 7. Facility Details + Networks in a Facility

Used by sales teams, capacity planners, and colo evaluation.

```bash
# Facility details
curl "https://www.peeringdb.com/api/fac/1"

# All networks in a facility
curl "https://www.peeringdb.com/api/netfac?fac_id=752"

# All IXPs in a facility
curl "https://www.peeringdb.com/api/ixfac?fac_id=752"
```

---

## 8. Incremental Sync with `since` Parameter

Used by peeringdb-py, Peering Manager, and any local cache/replica. Pulls only records modified after a unix timestamp.

```bash
# Get all networks modified since a timestamp
curl "https://www.peeringdb.com/api/net?since=1700000000&depth=0"

# Full sync pattern (all object types):
for OBJ in org fac ix ixlan ixpfx net netfac netixlan poc; do
  curl "https://www.peeringdb.com/api/$OBJ?since=$LAST_SYNC&depth=0" \
    > "${OBJ}.json"
done

# Detect deletions
curl "https://www.peeringdb.com/api/net?status=deleted&since=$LAST_SYNC"
```

---

## 9. Contact / PoC Lookup (Authenticated)

Get peering contact info for a network. Requires authentication — anonymous gets nothing.

```bash
# Contacts for a specific network
curl -H "Authorization: Api-Key $API_KEY" \
  "https://www.peeringdb.com/api/poc?net_id=13251"

# Filter by role
curl -H "Authorization: Api-Key $API_KEY" \
  "https://www.peeringdb.com/api/poc?net_id=13251&role=Peering"
```

---

## 10. Regional/Filtered Queries (Continent, Country, State)

Used for market analysis, regional IX discovery, and targeted peering outreach.

```bash
# All IXPs in Europe
curl -sG "https://www.peeringdb.com/api/ix" \
  --data-urlencode "region_continent=Europe"

# IXPs in facilities in a specific state/province
curl "https://www.peeringdb.com/api/ixfac?fac__state=NSW"

# Networks in a country
curl "https://www.peeringdb.com/api/net?country=NL"

# Combined: European IX participants for specific networks
curl -sG "https://www.peeringdb.com/api/netixlan" \
  --data-urlencode "net_id__in=694,1100,1418" \
  --data-urlencode "ix_id__in=$(curl -sG https://www.peeringdb.com/api/ix \
    --data-urlencode region_continent=Europe | jq -c '[.data[].id]' | \
    sed 's/\[//;s/\]//')"
```

---

## Key Query Parameters (All Endpoints)

| Parameter | Type | Description |
|-----------|------|-------------|
| `depth`   | int  | 0 = flat (fast), 1+ = expand nested `*_set` fields |
| `fields`  | str  | Comma-separated field whitelist |
| `since`   | int  | Unix timestamp — only objects modified after this |
| `limit`   | int  | Max rows returned |
| `skip`    | int  | Offset for pagination |
| `status`  | str  | `ok` (default) or `deleted` |
| `__in`    | str  | Suffix for IN queries: `net_id__in=1,2,3` |
| `__contains` | str | Substring match |
| `__startswith` | str | Prefix match |

## Object Types (Endpoints)

| Endpoint | Tag | Description |
|----------|-----|-------------|
| `/api/org` | Basic | Organization |
| `/api/fac` | Basic | Facility / datacenter |
| `/api/ix` | Basic | Internet exchange |
| `/api/net` | Basic | Network / ASN |
| `/api/poc` | Basic | Point of contact (auth required) |
| `/api/ixlan` | Derived | IX LAN abstraction |
| `/api/ixpfx` | Derived | IX peering LAN prefix |
| `/api/ixfac` | Derived | IX ↔ Facility relationship |
| `/api/netixlan` | Derived | Network ↔ IX LAN (peering point) |
| `/api/netfac` | Derived | Network ↔ Facility presence |
| `/api/carrier` | Newer | Carrier / transport provider |
| `/api/carrierfac` | Newer | Carrier ↔ Facility relationship |

## Notable Consumers

- **Peering Manager** — full local sync via `since`, ASN lookups, IX network resolution
- **peeringdb-py** — official Python client, local Django ORM replica
- **arouteserver** — route server config generation from IX participant data
- **ixgen** — IX peering config generator (Juniper, Cisco, Extreme)
- **peerpal** — common IX finder + Cisco BGP config generator
- **alice-lg** / looking glass tools — IX participant enrichment
- **Go peeringdb lib** (gmazoyer) — `GetASN()`, facility lookups
- **peeringdb-tools** — helper functions wrapping `net`, `netixlan`, `ixpfx`
