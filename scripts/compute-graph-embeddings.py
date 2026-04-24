#!/usr/bin/env python3
"""
compute-graph-embeddings.py

Builds a node2vec graph embedding over the full PeeringDB entity graph,
projects it to 2D with UMAP, uploads the 1024-dim vectors to Cloudflare
Vectorize via the REST API, and exports an embeddings.csv for Nomic Atlas
validation.

Prerequisites
-------------
- peeringdb-local.db  (wrangler d1 export peeringdb --remote --output=database/database.sqlite)
- .venv with requirements installed  (pip install -r scripts/requirements.txt)
- .env or environment variables:
    CLOUDFLARE_ACCOUNT_ID
    CLOUDFLARE_API_TOKEN
    VECTORIZE_INDEX_NAME  (default: pdbfe-vectors)

Usage
-----
    .venv/bin/python3 scripts/compute-graph-embeddings.py

Outputs
-------
    embeddings.csv              — for Nomic Atlas validation
    (Vectorize index updated)
"""

import csv
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

import networkx as nx
import numpy as np
import requests

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent

def _load_env(path: Path) -> None:
    """
    Parses a KEY=VALUE env file into os.environ.
    Strips leading ``export ``, skips comments and blank lines.
    Existing env vars take precedence.

    :param path: Absolute path to the env file.
    """
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

ACCOUNT_ID      = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN       = os.environ.get("CLOUDFLARE_API_TOKEN", "")
VECTORIZE_NAME  = os.environ.get("VECTORIZE_INDEX_NAME", "pdbfe-vectors")
DB_PATH         = REPO_ROOT / "database" / "peeringdb.db"
CSV_PATH        = REPO_ROOT / "embeddings.csv"

missing = [k for k, v in {
    "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID,
    "CLOUDFLARE_API_TOKEN":  API_TOKEN,
}.items() if not v]

if missing:
    sys.exit(f"Missing required env: {', '.join(missing)}")

if not DB_PATH.exists():
    sys.exit(f"Database not found: {DB_PATH}\nRun: wrangler d1 export peeringdb --remote --output=database/database.sqlite")

CF_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
AUTH_HEADERS: dict[str, str] = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type":  "application/json",
}

# ---------------------------------------------------------------------------
# Node2vec parameters
# ---------------------------------------------------------------------------

WALK_LENGTH    = 80    # Steps per random walk.
WALKS_PER_NODE = 10   # Random walks generated per node.
EMBED_DIM      = 1024  # Output dimensionality; matches Vectorize index.
P              = 1.0   # Return parameter (BFS vs DFS balance).
Q              = 0.5   # In-out parameter; <1 favours DFS (deeper exploration).
WORKERS        = 8     # Parallel workers for walk generation and word2vec training.

# ---------------------------------------------------------------------------
# Metadata fields per entity type
# These fields are stored on each Vectorize vector as filterable metadata.
# Fields must exist in the corresponding D1 table.
# ---------------------------------------------------------------------------

METADATA_FIELDS: dict[str, list[str]] = {
    "fac": [
        "name", "name_long", "aka", "city", "country", "region_continent",
        "clli", "rencode", "npanxx", "latitude", "longitude",
    ],
    "net": [
        "name", "name_long", "aka", "asn", "info_type", "info_types",
        "policy_general", "policy_locations", "policy_ratio", "policy_contracts",
        "info_unicast", "info_multicast", "info_ipv6",
        "info_prefixes4", "info_prefixes6",
    ],
    "ix": [
        "name", "name_long", "aka", "city", "country", "region_continent",
        "proto_ipv6", "proto_multicast",
    ],
    "org": ["name", "aka", "city", "country", "latitude", "longitude"],
    "campus": ["name", "name_long", "aka", "city", "country"],
    "carrier": ["name", "aka"],
}

ENTITY_TABLES: dict[str, str] = {
    "fac":     "peeringdb_facility",
    "net":     "peeringdb_network",
    "ix":      "peeringdb_ix",
    "org":     "peeringdb_organization",
    "campus":  "peeringdb_campus",
    "carrier": "peeringdb_carrier",
}

# ---------------------------------------------------------------------------
# Step 1 — Load graph from SQLite
# ---------------------------------------------------------------------------

def load_graph(db: sqlite3.Connection) -> tuple[list[str], list[tuple[str, str]], dict[str, dict]]:
    """
    Extracts nodes, edges, and entity metadata from the local SQLite export.

    Nodes are identified by string keys in the form ``{tag}:{id}``
    (e.g. ``net:694``, ``fac:42``). Edges are listed once per physical
    relationship with a single canonical direction; node2vec treats the
    graph as undirected during walking.

    :param db: Open SQLite connection to the local D1 export.
    :returns: Tuple of (node_keys, edge_pairs, metadata_by_node_key).
    """
    print("[graph] loading nodes …")

    node_keys: list[str] = []
    metadata: dict[str, dict] = {}

    for tag, table in ENTITY_TABLES.items():
        fields = METADATA_FIELDS[tag]
        quoted = ", ".join(f'"{f}"' for f in fields)
        rows = db.execute(
            f'SELECT id, {quoted} FROM "{table}" WHERE status = \'ok\''
        ).fetchall()
        col_names = ["id"] + fields
        for row in rows:
            row_dict = dict(zip(col_names, row))
            key = f"{tag}:{row_dict['id']}"
            node_keys.append(key)
            # Build metadata: entity tag + all scalar fields
            meta = {"entity": tag, "entityId": row_dict["id"]}
            for f in fields:
                v = row_dict.get(f)
                # Store non-null scalars only; skip empty strings.
                if v is not None and v != "":
                    meta[f] = v
            metadata[key] = meta

    print(f"[graph] {len(node_keys):,} nodes loaded")

    # ------------------------------------------------------------------
    # Edges — one canonical direction per relationship type.
    # node2vec walks the graph as undirected; listing each edge once
    # avoids duplicate walks along the same physical connection.
    # ------------------------------------------------------------------
    print("[graph] loading edges …")

    edge_queries: list[tuple[str, str, str]] = [
        # (left_tag, right_tag, SQL returning (left_id, right_id))
        # net → ix: peeringdb_network_ixlan has ix_id directly; no join needed.
        ("net", "ix",
         "SELECT net_id, ix_id FROM peeringdb_network_ixlan WHERE status = 'ok'"),
        ("net", "fac",
         "SELECT net_id, fac_id FROM peeringdb_network_facility"),
        ("net", "org",
         "SELECT id, org_id FROM peeringdb_network WHERE status = 'ok' AND org_id IS NOT NULL"),
        ("ix", "fac",
         "SELECT ix_id, fac_id FROM peeringdb_ix_facility"),
        ("ix", "org",
         "SELECT id, org_id FROM peeringdb_ix WHERE status = 'ok' AND org_id IS NOT NULL"),
        ("fac", "org",
         "SELECT id, org_id FROM peeringdb_facility WHERE status = 'ok' AND org_id IS NOT NULL"),
        # campus → fac: campus_id is a FK on peeringdb_facility, no join table.
        ("campus", "fac",
         "SELECT campus_id, id FROM peeringdb_facility WHERE campus_id IS NOT NULL AND status = 'ok'"),
        # carrier → fac: stored in peeringdb_ix_carrier_facility (not peeringdb_carrierfac).
        ("carrier", "fac",
         "SELECT carrier_id, fac_id FROM peeringdb_ix_carrier_facility WHERE status = 'ok'"),
    ]

    node_set = set(node_keys)
    edges: list[tuple[str, str]] = []

    for left_tag, right_tag, sql in edge_queries:
        rows = db.execute(sql).fetchall()
        for left_id, right_id in rows:
            lk = f"{left_tag}:{left_id}"
            rk = f"{right_tag}:{right_id}"
            # Only include edges where both endpoints are known active nodes.
            if lk in node_set and rk in node_set:
                edges.append((lk, rk))

    print(f"[graph] {len(edges):,} edges loaded")
    return node_keys, edges, metadata


# Module-level globals populated by the worker initializer.
# Multiprocessing on macOS uses 'spawn', so these must be at module level.
_ADJ_LISTS: dict[str, list[str]] = {}    # node → list of neighbours (for sampling)
_ADJ_SETS:  dict[str, frozenset[str]] = {}  # node → frozenset of neighbours (for O(1) lookup)
_WALK_P:      float = 1.0
_WALK_Q:      float = 0.5
_WALK_LENGTH: int   = 80


def _walk_worker_init(
    adj_lists: dict[str, list[str]],
    adj_sets: dict[str, frozenset[str]],
    p: float,
    q: float,
    walk_length: int,
) -> None:
    """
    Initialises per-process globals used by ``_walk_one``.

    Called once per worker process when the Pool is created. Storing
    the adjacency structures here avoids pickling them on every task.

    :param adj_lists: Adjacency list dict for random sampling.
    :param adj_sets: Adjacency frozenset dict for O(1) neighbour lookup.
    :param p: node2vec return parameter.
    :param q: node2vec in-out parameter.
    :param walk_length: Number of steps per walk.
    """
    global _ADJ_LISTS, _ADJ_SETS, _WALK_P, _WALK_Q, _WALK_LENGTH
    _ADJ_LISTS   = adj_lists
    _ADJ_SETS    = adj_sets
    _WALK_P      = p
    _WALK_Q      = q
    _WALK_LENGTH = walk_length


def _walk_one(node: str) -> list[str]:
    """
    Generates a single node2vec biased random walk starting from ``node``.

    Uses module-level ``_ADJ_LISTS`` / ``_ADJ_SETS`` set by the worker
    initializer. Called in parallel across Pool workers.

    Transition weights per step:
    - Back to previous node: 1/p
    - Neighbour of previous node: 1
    - Non-neighbour of previous: 1/q

    :param node: Starting node key.
    :returns: Walk as a list of node key strings.
    """
    import random

    walk = [node]
    while len(walk) < _WALK_LENGTH:
        cur  = walk[-1]
        nbrs = _ADJ_LISTS.get(cur)
        if not nbrs:
            break
        if len(walk) == 1:
            walk.append(random.choice(nbrs))
        else:
            prev      = walk[-2]
            prev_nbrs = _ADJ_SETS.get(prev, frozenset())
            weights: list[float] = []
            for nbr in nbrs:
                if nbr == prev:
                    weights.append(1.0 / _WALK_P)
                elif nbr in prev_nbrs:
                    weights.append(1.0)
                else:
                    weights.append(1.0 / _WALK_Q)
            walk.append(random.choices(nbrs, weights=weights)[0])
    return walk


def run_node2vec(node_keys: list[str], edges: list[tuple[str, str]]) -> np.ndarray:
    """
    Runs node2vec over the entity graph and returns a float32 embedding
    matrix with one row per node in ``node_keys`` order.

    Walk generation is parallelised across ``WORKERS`` processes using
    ``multiprocessing.Pool``. The adjacency structure is sent to each
    worker once via the pool initializer, not once per task. gensim
    Word2Vec training is also multi-threaded via its own ``workers``
    parameter.

    :param node_keys: Ordered list of node key strings (``{tag}:{id}``).
    :param edges: List of (src, dst) string key pairs.
    :returns: float32 ndarray of shape (len(node_keys), EMBED_DIM).
    """
    import multiprocessing
    import random
    from gensim.models import Word2Vec

    print("[node2vec] building adjacency …")
    adj_lists: dict[str, list[str]] = {k: [] for k in node_keys}
    for src, dst in edges:
        if src in adj_lists:
            adj_lists[src].append(dst)
        if dst in adj_lists:
            adj_lists[dst].append(src)  # undirected
    adj_sets: dict[str, frozenset[str]] = {
        k: frozenset(v) for k, v in adj_lists.items()
    }
    n_nodes = len(node_keys)
    n_edges = sum(len(v) for v in adj_lists.values()) // 2
    print(f"[node2vec] {n_nodes:,} nodes, {n_edges:,} edges")

    print(f"[node2vec] generating walks "
          f"(p={P}, q={Q}, length={WALK_LENGTH}, walks/node={WALKS_PER_NODE}, "
          f"workers={WORKERS}) …")

    # Build task list: each node appears WALKS_PER_NODE times, shuffled.
    tasks = node_keys * WALKS_PER_NODE
    random.shuffle(tasks)
    total = len(tasks)

    walks: list[list[str]] = []
    with multiprocessing.Pool(
        processes=WORKERS,
        initializer=_walk_worker_init,
        initargs=(adj_lists, adj_sets, P, Q, WALK_LENGTH),
    ) as pool:
        for i, walk in enumerate(
            pool.imap_unordered(_walk_one, tasks, chunksize=500), start=1
        ):
            walks.append(walk)
            if i % 10_000 == 0:
                print(f"\r[node2vec] {i:,} / {total:,} walks", end="", flush=True)

    print(f"\n[node2vec] training Word2Vec (dim={EMBED_DIM}, workers={WORKERS}) …")
    model = Word2Vec(
        sentences=walks,
        vector_size=EMBED_DIM,
        window=10,
        min_count=0,
        sg=1,
        workers=WORKERS,
        epochs=1,
    )

    embeddings = np.zeros((len(node_keys), EMBED_DIM), dtype=np.float32)
    for i, key in enumerate(node_keys):
        if key in model.wv:
            embeddings[i] = model.wv[key]

    print(f"[node2vec] done — {embeddings.shape} embedding matrix")
    return embeddings


# ---------------------------------------------------------------------------
# Step 3 — UMAP projection to 2D
# ---------------------------------------------------------------------------

def run_umap(embeddings: np.ndarray) -> np.ndarray:
    """
    Projects the 1024-dim node2vec embeddings to 2D using UMAP.

    The resulting coordinates are stored as ``x``/``y`` in Vectorize
    metadata and in the CSV export for Nomic Atlas and the PDBFE
    vector space explorer.

    :param embeddings: float32 ndarray of shape (n_nodes, EMBED_DIM).
    :returns: float32 ndarray of shape (n_nodes, 2).
    """
    import umap

    print("[umap] projecting to 2D …")
    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=15,
        min_dist=0.1,
        metric="cosine",
        verbose=True,
    )
    coords = reducer.fit_transform(embeddings).astype(np.float32)
    print("[umap] done")
    return coords


# ---------------------------------------------------------------------------
# Step 4 — Export embeddings.csv (Nomic Atlas)
# ---------------------------------------------------------------------------

def export_csv(
    node_keys: list[str],
    embeddings: np.ndarray,
    coords_2d: np.ndarray,
    metadata: dict[str, dict],
) -> None:
    """
    Writes embeddings.csv for upload to Nomic Atlas.

    Columns: id, entity, name, asn, city, country, x, y.
    The full 1024-dim vector is not included (Nomic Atlas accepts a
    separate embeddings matrix; this file provides labels and layout).

    :param node_keys: Ordered node key list.
    :param embeddings: Full embedding matrix (n, 1024) — not written to CSV.
    :param coords_2d: 2D UMAP coordinates (n, 2).
    :param metadata: Metadata dict keyed by node key.
    """
    print(f"[csv] writing {CSV_PATH} …")
    with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["id", "entity", "name", "asn", "city", "country", "x", "y"])
        for i, key in enumerate(node_keys):
            meta = metadata[key]
            writer.writerow([
                key,
                meta.get("entity", ""),
                meta.get("name", ""),
                meta.get("asn", ""),
                meta.get("city", ""),
                meta.get("country", ""),
                round(float(coords_2d[i, 0]), 6),
                round(float(coords_2d[i, 1]), 6),
            ])
    print(f"[csv] {len(node_keys):,} rows written")


# ---------------------------------------------------------------------------
# Step 5 — Upsert to Vectorize
# ---------------------------------------------------------------------------

VECTORIZE_BATCH = 1000  # Vectors per NDJSON upsert call.


def vectorize_upsert(vectors: list[dict[str, Any]]) -> None:
    """
    Upserts a batch of vectors to the Cloudflare Vectorize index via REST.

    Vectorize v2 expects NDJSON body: one JSON object per line, each with
    ``id`` (string), ``values`` (float list), and ``metadata`` (object).

    :param vectors: List of vector dicts ready for serialisation.
    :raises requests.HTTPError: On non-2xx response from Vectorize.
    """
    ndjson = "\n".join(json.dumps(v) for v in vectors)
    resp = requests.post(
        f"{CF_BASE}/vectorize/v2/indexes/{VECTORIZE_NAME}/upsert",
        headers={**AUTH_HEADERS, "Content-Type": "application/x-ndjson"},
        data=ndjson,
        timeout=60,
    )
    resp.raise_for_status()


def upload_to_vectorize(
    node_keys: list[str],
    embeddings: np.ndarray,
    coords_2d: np.ndarray,
    metadata: dict[str, dict],
) -> None:
    """
    Uploads all node embeddings and metadata to the Vectorize index in batches.

    Each vector's metadata includes the full set of filterable node properties
    plus the UMAP 2D coordinates (``x``, ``y``) for the frontend explorer.

    :param node_keys: Ordered node key list.
    :param embeddings: float32 ndarray of shape (n_nodes, EMBED_DIM).
    :param coords_2d: float32 ndarray of shape (n_nodes, 2) from UMAP.
    :param metadata: Metadata dict keyed by node key.
    """
    print(f"[vectorize] uploading {len(node_keys):,} vectors in batches of {VECTORIZE_BATCH} …")
    total = 0
    batch: list[dict[str, Any]] = []

    for i, key in enumerate(node_keys):
        meta = dict(metadata[key])
        meta["x"] = round(float(coords_2d[i, 0]), 6)
        meta["y"] = round(float(coords_2d[i, 1]), 6)

        batch.append({
            "id":       key,
            "values":   embeddings[i].tolist(),
            "metadata": meta,
        })

        if len(batch) >= VECTORIZE_BATCH:
            vectorize_upsert(batch)
            total += len(batch)
            print(f"\r[vectorize] {total:,} / {len(node_keys):,}", end="", flush=True)
            batch = []
            # Brief pause to respect Vectorize rate limits.
            time.sleep(0.25)

    if batch:
        vectorize_upsert(batch)
        total += len(batch)

    print(f"\n[vectorize] done — {total:,} vectors uploaded")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    """Entry point — runs the full graph embedding pipeline."""
    print(f"[main] opening {DB_PATH}")
    db = sqlite3.connect(DB_PATH)

    node_keys, edges, metadata = load_graph(db)
    db.close()

    embeddings = run_node2vec(node_keys, edges)
    coords_2d  = run_umap(embeddings)

    export_csv(node_keys, embeddings, coords_2d, metadata)
    upload_to_vectorize(node_keys, embeddings, coords_2d, metadata)

    print("[main] complete")


if __name__ == "__main__":
    main()
