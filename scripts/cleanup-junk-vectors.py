#!/usr/bin/env python3
"""
cleanup-junk-vectors.py

One-shot cleanup script: removes BGE text embedding vectors that were
added to Vectorize by the old syncVectors sync-worker path after our
graph-embedding pipeline ran. Resets __vector_embedded = 0 in D1 for
those entities so the incremental pipeline can re-embed them correctly.

Entities identified as contaminated are those updated after our graph
embedding upload timestamp AND present in the VECTOR_ENTITY_TAGS set.
After cleanup, run the compute script with --incremental to re-embed
them via neighbor averaging.

Prerequisites
-------------
- .env with CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
  VECTORIZE_INDEX_NAME, D1_DATABASE_ID
- Run AFTER deploying the updated sync worker (which stops the BGE path)

Usage
-----
    scripts/.venv/bin/python3 scripts/cleanup-junk-vectors.py
"""

import json
import os
import sys
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent

def _load_env(path: Path) -> None:
    try:
        text = path.read_text()
    except FileNotFoundError:
        return
    for line in text.splitlines():
        stripped = line.removeprefix("export ").strip()
        if not stripped or stripped.startswith("#"):
            continue
        eq = stripped.find("=")
        if eq == -1:
            continue
        key = stripped[:eq].strip()
        val = stripped[eq + 1:].strip()
        if key not in os.environ:
            os.environ[key] = val

_load_env(REPO_ROOT / ".env")
_load_env(REPO_ROOT / ".env.deploy")

ACCOUNT_ID     = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN      = os.environ.get("CLOUDFLARE_API_TOKEN", "")
VECTORIZE_NAME = os.environ.get("VECTORIZE_INDEX_NAME", "pdbfe-vectors")
D1_DATABASE_ID = os.environ.get("D1_DATABASE_ID", "")

for var, val in [
    ("CLOUDFLARE_ACCOUNT_ID", ACCOUNT_ID),
    ("CLOUDFLARE_API_TOKEN",  API_TOKEN),
    ("D1_DATABASE_ID",        D1_DATABASE_ID),
]:
    if not val:
        sys.exit(f"Missing required env: {var}")

CF_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
AUTH_HEADERS = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type":  "application/json",
}

# ---------------------------------------------------------------------------
# Graph embedding upload timestamp.
# Entities updated at or after this time were not in the graph when we
# ran node2vec. Any that got __vector_embedded=1 after this point were
# embedded by the old syncVectors BGE path and are contaminated.
# Adjust if you re-ran the pipeline at a different time.
# ---------------------------------------------------------------------------

UPLOAD_CUTOFF = "2026-04-24 00:43:00"

# Entity tables that carry __vector_embedded.
ENTITY_TABLES = {
    "net":     "peeringdb_network",
    "ix":      "peeringdb_ix",
    "fac":     "peeringdb_facility",
    "org":     "peeringdb_organization",
    "campus":  "peeringdb_campus",
    "carrier": "peeringdb_carrier",
}

# ---------------------------------------------------------------------------
# D1 REST API
# ---------------------------------------------------------------------------

def d1_query(sql: str, params: list | None = None) -> list[dict]:
    """
    Executes a SQL statement against the remote D1 database via REST API.

    :param sql: SQL statement with ? placeholders.
    :param params: Positional parameters for the placeholders.
    :returns: List of result row dicts (empty list for non-SELECT statements).
    :raises requests.HTTPError: On API error.
    """
    payload: dict = {"sql": sql}
    if params:
        payload["params"] = params

    resp = requests.post(
        f"{CF_BASE}/d1/database/{D1_DATABASE_ID}/query",
        headers=AUTH_HEADERS,
        json=payload,
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"D1 query failed: {data}")
    results = data.get("result", [])
    if results and isinstance(results, list):
        return results[0].get("results", [])
    return []


# ---------------------------------------------------------------------------
# Vectorize REST API
# ---------------------------------------------------------------------------

def vectorize_delete(vector_ids: list[str]) -> None:
    """
    Deletes vectors from the Vectorize index by ID using the wrangler CLI.

    Uses wrangler rather than the REST API because the v2 REST delete-by-ids
    endpoint 404s on indexes provisioned with v1 tooling. Wrangler handles
    v1/v2 versioning transparently.

    :param vector_ids: List of vector ID strings (e.g. ['net:694', 'ix:26']).
    :raises subprocess.CalledProcessError: If wrangler exits non-zero.
    """
    import subprocess
    cmd = [
        "npx", "--yes", "wrangler",
        "vectorize", "delete-vectors", VECTORIZE_NAME,
        "--ids", *vector_ids,
        "--force",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_ROOT / "workers")
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"wrangler vectorize delete-vectors failed (exit {result.returncode})")


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

def find_contaminated_entities() -> dict[str, list[int]]:
    """
    Queries D1 for entities updated after UPLOAD_CUTOFF that have
    __vector_embedded = 1. These were embedded by the old BGE syncVectors
    path and have incompatible text vectors in Vectorize.

    :returns: Dict mapping entity tag → list of numeric entity IDs.
    """
    contaminated: dict[str, list[int]] = {}

    for tag, table in ENTITY_TABLES.items():
        rows = d1_query(
            f'SELECT id FROM "{table}" WHERE updated >= ? AND __vector_embedded = 1',
            [UPLOAD_CUTOFF],
        )
        ids = [int(r["id"]) for r in rows]
        if ids:
            contaminated[tag] = ids
            print(f"  [{tag}] {len(ids):,} contaminated entities")
        else:
            print(f"  [{tag}] clean")

    return contaminated


def delete_contaminated_vectors(contaminated: dict[str, list[int]]) -> None:
    """
    Deletes Vectorize vectors for all contaminated entities in batches.

    :param contaminated: Dict mapping entity tag → list of numeric entity IDs.
    """
    BATCH = 500
    all_vector_ids = [
        f"{tag}:{eid}"
        for tag, ids in contaminated.items()
        for eid in ids
    ]

    if not all_vector_ids:
        print("[vectorize] nothing to delete")
        return

    total = 0
    for i in range(0, len(all_vector_ids), BATCH):
        batch = all_vector_ids[i : i + BATCH]
        vectorize_delete(batch)
        total += len(batch)
        print(f"\r[vectorize] deleted {total:,} / {len(all_vector_ids):,}", end="", flush=True)

    print(f"\n[vectorize] done — {total:,} contaminated vectors deleted")


def reset_d1_flags(contaminated: dict[str, list[int]]) -> None:
    """
    Resets __vector_embedded = 0 in D1 for all contaminated entities.
    This marks them for re-embedding by the incremental pipeline.

    :param contaminated: Dict mapping entity tag → list of numeric entity IDs.
    """
    for tag, ids in contaminated.items():
        table = ENTITY_TABLES[tag]
        placeholders = ",".join("?" * len(ids))
        d1_query(
            f'UPDATE "{table}" SET __vector_embedded = 0 WHERE id IN ({placeholders})',
            ids,
        )
        print(f"  [{tag}] reset {len(ids):,} flags → 0")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    """Finds and removes BGE-contaminated vectors, resets D1 flags."""
    print(f"[cleanup] cutoff: {UPLOAD_CUTOFF}")
    print("[cleanup] scanning D1 for contaminated entities …")
    contaminated = find_contaminated_entities()

    total = sum(len(v) for v in contaminated.values())
    if total == 0:
        print("[cleanup] no contamination found — nothing to do")
        return

    print(f"[cleanup] {total:,} contaminated entities across {len(contaminated)} types")

    print("[cleanup] deleting from Vectorize …")
    delete_contaminated_vectors(contaminated)

    print("[cleanup] resetting D1 __vector_embedded flags …")
    reset_d1_flags(contaminated)

    print("[cleanup] done")
    print("[cleanup] next: run compute-graph-embeddings.py --incremental to re-embed via neighbor averaging")


if __name__ == "__main__":
    main()
