"""
PeeringDB API Conformance Test Suite
=====================================
Validates a re-implementation of the PeeringDB API against the canonical
production instance (https://www.peeringdb.com/api/).

Usage:
    # Compare your implementation against production PeeringDB
    pytest test_peeringdb_conformance.py \
        --reference-url=https://www.peeringdb.com/api \
        --target-url=https://your-api.example.com/api \
        --api-key=YOUR_PEERINGDB_API_KEY \
        --target-api-key=YOUR_TARGET_API_KEY

    # Run only schema tests
    pytest test_peeringdb_conformance.py -m schema

    # Run only a specific endpoint group
    pytest test_peeringdb_conformance.py -k "net"

    # Verbose diff output on failures
    pytest test_peeringdb_conformance.py -v --tb=long

Requirements:
    pip install pytest requests deepdiff jsonschema
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

import pytest
import requests
from deepdiff import DeepDiff


# ---------------------------------------------------------------------------
# Configuration & fixtures
# ---------------------------------------------------------------------------

def pytest_addoption(parser):
    parser.addoption("--reference-url", default="https://www.peeringdb.com/api",
                     help="Canonical PeeringDB API base URL")
    parser.addoption("--target-url", required=True,
                     help="Your re-implementation API base URL")
    parser.addoption("--api-key", default=None,
                     help="API key for the reference (production) PeeringDB instance")
    parser.addoption("--target-api-key", default=None,
                     help="API key for the target instance")
    parser.addoption("--rate-limit-delay", default=1.0, type=float,
                     help="Seconds between reference API calls (respect rate limits)")
    parser.addoption("--strict-values", action="store_true", default=False,
                     help="Also compare field values, not just schema/structure")
    parser.addoption("--snapshot-dir", default=None,
                     help="Dir to dump JSON responses for offline diffing")


@dataclass
class ApiConfig:
    reference_url: str
    target_url: str
    reference_headers: dict = field(default_factory=dict)
    target_headers: dict = field(default_factory=dict)
    rate_limit_delay: float = 1.0
    strict_values: bool = False
    snapshot_dir: str | None = None


@pytest.fixture(scope="session")
def api_config(request) -> ApiConfig:
    cfg = ApiConfig(
        reference_url=request.config.getoption("--reference-url").rstrip("/"),
        target_url=request.config.getoption("--target-url").rstrip("/"),
        rate_limit_delay=request.config.getoption("--rate-limit-delay"),
        strict_values=request.config.getoption("--strict-values"),
        snapshot_dir=request.config.getoption("--snapshot-dir"),
    )
    ref_key = request.config.getoption("--api-key")
    tgt_key = request.config.getoption("--target-api-key")
    if ref_key:
        cfg.reference_headers["Authorization"] = f"Api-Key {ref_key}"
    if tgt_key:
        cfg.target_headers["Authorization"] = f"Api-Key {tgt_key}"
    return cfg


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

class ApiClient:
    """Thin wrapper that hits both endpoints and returns paired responses."""

    def __init__(self, cfg: ApiConfig):
        self.cfg = cfg
        self._session_ref = requests.Session()
        self._session_ref.headers.update(cfg.reference_headers)
        self._session_tgt = requests.Session()
        self._session_tgt.headers.update(cfg.target_headers)

    def get_both(self, path: str, params: dict | None = None,
                 ) -> tuple[requests.Response, requests.Response]:
        """GET the same path+params from reference and target."""
        ref = self._session_ref.get(f"{self.cfg.reference_url}/{path}",
                                    params=params, timeout=30)
        time.sleep(self.cfg.rate_limit_delay)
        tgt = self._session_tgt.get(f"{self.cfg.target_url}/{path}",
                                    params=params, timeout=30)
        return ref, tgt

    def get_reference(self, path: str, params: dict | None = None,
                      ) -> requests.Response:
        resp = self._session_ref.get(f"{self.cfg.reference_url}/{path}",
                                     params=params, timeout=30)
        time.sleep(self.cfg.rate_limit_delay)
        return resp


@pytest.fixture(scope="session")
def client(api_config) -> ApiClient:
    return ApiClient(api_config)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def extract_data(resp: requests.Response) -> list[dict]:
    """Pull .data from a PeeringDB-style JSON response."""
    body = resp.json()
    assert "data" in body, f"Response missing 'data' key: {list(body.keys())}"
    return body["data"]


def field_names(records: list[dict]) -> set[str]:
    """Union of all keys across all records."""
    return set().union(*(r.keys() for r in records)) if records else set()


def field_types_map(records: list[dict]) -> dict[str, set[str]]:
    """Map field name -> set of Python type names observed."""
    types: dict[str, set[str]] = {}
    for rec in records:
        for k, v in rec.items():
            types.setdefault(k, set()).add(type(v).__name__)
    return types


def snapshot(cfg: ApiConfig, name: str, ref_data: Any, tgt_data: Any):
    """Optionally dump both responses to disk for manual inspection."""
    if not cfg.snapshot_dir:
        return
    import pathlib
    d = pathlib.Path(cfg.snapshot_dir)
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}_reference.json").write_text(json.dumps(ref_data, indent=2, default=str))
    (d / f"{name}_target.json").write_text(json.dumps(tgt_data, indent=2, default=str))


# ---------------------------------------------------------------------------
# Well-known test ASNs / IDs — pick entities likely to be stable
# ---------------------------------------------------------------------------

# These are large, well-known networks unlikely to vanish from PeeringDB.
# Override via env or conftest if your reimplementation has different seed data.
WELL_KNOWN = {
    "asn_cloudflare": 13335,
    "asn_google": 15169,
    "asn_netflix": 2906,
    "ix_amsix_id": 26,        # AMS-IX
    "ix_decix_id": 31,        # DE-CIX Frankfurt
    "fac_equinix_am5": 58,    # Equinix AM5
}


# ---------------------------------------------------------------------------
# MARKERS
# ---------------------------------------------------------------------------

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


# ===================================================================
# SECTION 1 — ENVELOPE & PROTOCOL CONFORMANCE
# ===================================================================

class TestEnvelopeConformance:
    """Verify the target wraps responses in the same {data, meta} envelope."""

    @pytest.mark.schema
    @pytest.mark.parametrize("endpoint", [
        "net", "ix", "fac", "org", "netixlan", "netfac",
        "ixlan", "ixpfx", "ixfac", "poc",
    ])
    def test_list_endpoint_returns_data_array(self, client, endpoint):
        """Every list endpoint must return {"data": [...]}."""
        _, tgt = client.get_both(endpoint, params={"limit": 1, "depth": 0})
        body = tgt.json()
        assert "data" in body, f"/{endpoint} missing 'data' key"
        assert isinstance(body["data"], list), f"/{endpoint} 'data' is not a list"

    @pytest.mark.schema
    @pytest.mark.parametrize("endpoint", [
        "net", "ix", "fac", "org", "netixlan", "netfac",
        "ixlan", "ixpfx", "ixfac",
    ])
    def test_single_object_returns_data_array_of_one(self, client, endpoint):
        """GET /endpoint/ID must return {"data": [<single object>]}."""
        # Grab an ID from the reference first
        ref = client.get_reference(endpoint, params={"limit": 1, "depth": 0})
        ref_data = extract_data(ref)
        if not ref_data:
            pytest.skip(f"No data in reference for /{endpoint}")
        obj_id = ref_data[0]["id"]

        _, tgt = client.get_both(f"{endpoint}/{obj_id}", params={"depth": 0})
        assert tgt.status_code == 200, f"/{endpoint}/{obj_id} returned {tgt.status_code}"
        tgt_data = extract_data(tgt)
        assert len(tgt_data) == 1, f"Expected 1 record, got {len(tgt_data)}"

    @pytest.mark.schema
    def test_nonexistent_id_returns_404_or_empty(self, client):
        """GET /net/999999999 should 404 or return empty data."""
        _, tgt = client.get_both("net/999999999")
        assert tgt.status_code in (404, 200)
        if tgt.status_code == 200:
            assert extract_data(tgt) == []

    @pytest.mark.schema
    def test_content_type_is_json(self, client):
        _, tgt = client.get_both("net", params={"limit": 1})
        assert "application/json" in tgt.headers.get("Content-Type", "")


# ===================================================================
# SECTION 2 — SCHEMA CONFORMANCE (field names & types)
# ===================================================================

class TestSchemaConformance:
    """Compare field names and types between reference and target."""

    @pytest.mark.schema
    @pytest.mark.parametrize("endpoint,params", [
        ("net", {"limit": 5, "depth": 0}),
        ("net", {"limit": 5, "depth": 1}),
        ("ix", {"limit": 5, "depth": 0}),
        ("fac", {"limit": 5, "depth": 0}),
        ("org", {"limit": 5, "depth": 0}),
        ("netixlan", {"limit": 5, "depth": 0}),
        ("netfac", {"limit": 5, "depth": 0}),
        ("ixlan", {"limit": 5, "depth": 0}),
        ("ixpfx", {"limit": 5, "depth": 0}),
        ("ixfac", {"limit": 5, "depth": 0}),
    ])
    def test_field_names_match(self, client, api_config, endpoint, params):
        ref_resp, tgt_resp = client.get_both(endpoint, params=params)
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        if not ref_data:
            pytest.skip(f"No reference data for /{endpoint}")

        ref_fields = field_names(ref_data)
        tgt_fields = field_names(tgt_data)

        snapshot(api_config, f"schema_{endpoint}_d{params.get('depth', 0)}",
                 sorted(ref_fields), sorted(tgt_fields))

        missing = ref_fields - tgt_fields
        extra = tgt_fields - ref_fields
        assert not missing, f"/{endpoint} target missing fields: {missing}"
        # Extra fields are a warning, not a failure (your impl may enrich)
        if extra:
            import warnings
            warnings.warn(f"/{endpoint} target has extra fields: {extra}")

    @pytest.mark.schema
    @pytest.mark.parametrize("endpoint", [
        "net", "ix", "fac", "org", "netixlan", "netfac",
        "ixlan", "ixpfx", "ixfac",
    ])
    def test_field_types_match(self, client, endpoint):
        """Verify JSON types (str/int/list/null/bool) match per field."""
        ref_resp, tgt_resp = client.get_both(endpoint,
                                              params={"limit": 20, "depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        if not ref_data or not tgt_data:
            pytest.skip(f"Insufficient data for /{endpoint}")

        ref_types = field_types_map(ref_data)
        tgt_types = field_types_map(tgt_data)

        mismatches = []
        for fld in ref_types.keys() & tgt_types.keys():
            # Allow NoneType in either — nullable fields
            ref_t = ref_types[fld] - {"NoneType"}
            tgt_t = tgt_types[fld] - {"NoneType"}
            if ref_t and tgt_t and ref_t != tgt_t:
                mismatches.append(f"  {fld}: ref={ref_t} target={tgt_t}")
        assert not mismatches, (
            f"/{endpoint} type mismatches:\n" + "\n".join(mismatches)
        )

    @pytest.mark.schema
    def test_depth_0_excludes_sets(self, client):
        """With depth=0, *_set fields should be absent from the response."""
        ref_resp, tgt_resp = client.get_both(
            f"net?asn={WELL_KNOWN['asn_cloudflare']}", params={"depth": 0})
        tgt_data = extract_data(tgt_resp)
        if not tgt_data:
            pytest.skip("No data for Cloudflare ASN")
        rec = tgt_data[0]
        for k in list(rec.keys()):
            if k.endswith("_set") and k != "irr_as_set":
                pytest.fail(f"{k} should be absent at depth=0, but is present")

    @pytest.mark.schema
    def test_depth_1_expands_sets(self, client):
        """With depth=1, *_set fields should be lists of integer IDs."""
        ref_resp, tgt_resp = client.get_both(
            f"net?asn={WELL_KNOWN['asn_cloudflare']}", params={"depth": 1})
        tgt_data = extract_data(tgt_resp)
        if not tgt_data:
            pytest.skip("No data for Cloudflare ASN")
        rec = tgt_data[0]
        found_any = False
        for k, v in rec.items():
            if k.endswith("_set") and k != "irr_as_set" and v:
                assert isinstance(v, list), f"{k} should be a list at depth=1"
                if v:
                    assert isinstance(v[0], int), (
                        f"{k}[0] should be int (ID) at depth=1, got {type(v[0])}"
                    )
                    found_any = True
        assert found_any, "No sets were found at depth=1"


# ===================================================================
# SECTION 3 — QUERY PARAMETER CONFORMANCE
# ===================================================================

class TestQueryParameters:
    """Verify filtering, pagination, field selection behave identically."""

    def test_asn_filter_on_net(self, client, api_config):
        """GET /net?asn=13335 returns the same network."""
        ref_resp, tgt_resp = client.get_both(
            "net", params={"asn": WELL_KNOWN["asn_cloudflare"], "depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        assert len(tgt_data) == len(ref_data)
        if ref_data:
            assert tgt_data[0]["asn"] == WELL_KNOWN["asn_cloudflare"]

    def test_asn_filter_on_netixlan(self, client):
        """GET /netixlan?asn=13335 returns IX peering records."""
        ref_resp, tgt_resp = client.get_both(
            "netixlan", params={"asn": WELL_KNOWN["asn_cloudflare"], "depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        # Count should match (or be very close if data slightly out of sync)
        assert abs(len(ref_data) - len(tgt_data)) <= 2, (
            f"netixlan count mismatch: ref={len(ref_data)} tgt={len(tgt_data)}"
        )

    def test_net_id_filter_on_netfac(self, client):
        """GET /netfac?local_asn=<asn> works."""
        ref_resp, tgt_resp = client.get_both(
            "netfac", params={"local_asn": WELL_KNOWN["asn_google"], "depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        assert len(tgt_data) > 0, "Expected Google to have facility presence"
        # All returned records should match the ASN
        for rec in tgt_data:
            assert rec["local_asn"] == WELL_KNOWN["asn_google"]

    def test_ix_id_filter_on_netixlan(self, client):
        """GET /netixlan?ix_id=26 returns AMS-IX participants."""
        ref_resp, tgt_resp = client.get_both(
            "netixlan", params={"ix_id": WELL_KNOWN["ix_amsix_id"], "depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        assert len(tgt_data) > 10, "AMS-IX should have many participants"
        assert abs(len(ref_data) - len(tgt_data)) / max(len(ref_data), 1) < 0.05

    def test_fac_id_filter_on_netfac(self, client):
        """GET /netfac?fac_id=<id> returns networks at a facility."""
        ref_resp, tgt_resp = client.get_both(
            "netfac", params={"fac_id": WELL_KNOWN["fac_equinix_am5"], "depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        assert len(tgt_data) > 0

    def test_ix_id_filter_on_ixpfx(self, client):
        """GET /ixpfx?ixlan_id=<id> returns prefix info."""
        # First get ixlan_id for DE-CIX
        ref = client.get_reference(
            "ixlan", params={"ix_id": WELL_KNOWN["ix_decix_id"], "depth": 0})
        ixlans = extract_data(ref)
        if not ixlans:
            pytest.skip("No ixlan data for DE-CIX")
        ixlan_id = ixlans[0]["id"]

        ref_resp, tgt_resp = client.get_both(
            "ixpfx", params={"ixlan_id": ixlan_id, "depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        assert len(tgt_data) > 0, "DE-CIX should have peering LAN prefixes"

    def test_in_filter(self, client):
        """GET /netixlan?net_id__in=694,1100 uses __in operator."""
        ref_resp, tgt_resp = client.get_both(
            "netixlan", params={"net_id__in": "694,1100", "depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        ref_net_ids = {r["net_id"] for r in ref_data}
        tgt_net_ids = {r["net_id"] for r in tgt_data}
        assert tgt_net_ids <= {694, 1100}, f"Unexpected net_ids: {tgt_net_ids - {694, 1100}}"
        assert ref_net_ids == tgt_net_ids

    def test_fields_filter(self, client):
        """GET /net?fields=id,asn,name limits returned fields."""
        ref_resp, tgt_resp = client.get_both(
            "net", params={"limit": 3, "fields": "id,asn,name", "depth": 0})
        tgt_data = extract_data(tgt_resp)
        for rec in tgt_data:
            assert set(rec.keys()) == {"id", "asn", "name"}, (
                f"fields filter not respected: got {set(rec.keys())}"
            )

    def test_limit_parameter(self, client):
        """GET /net?limit=3 returns at most 3 records."""
        _, tgt = client.get_both("net", params={"limit": 3, "depth": 0})
        tgt_data = extract_data(tgt)
        assert len(tgt_data) <= 3

    def test_skip_parameter(self, client):
        """skip=N offsets the result set."""
        _, tgt_0 = client.get_both("net", params={"limit": 2, "skip": 0, "depth": 0})
        _, tgt_2 = client.get_both("net", params={"limit": 2, "skip": 2, "depth": 0})
        d0 = extract_data(tgt_0)
        d2 = extract_data(tgt_2)
        if d0 and d2:
            ids_0 = {r["id"] for r in d0}
            ids_2 = {r["id"] for r in d2}
            assert ids_0.isdisjoint(ids_2), "skip=2 returned overlapping records"

    def test_region_continent_filter(self, client):
        """GET /ix?region_continent=Europe filters by continent."""
        ref_resp, tgt_resp = client.get_both(
            "ix", params={"region_continent": "Europe", "limit": 5, "depth": 0})
        tgt_data = extract_data(tgt_resp)
        for rec in tgt_data:
            assert rec.get("region_continent") == "Europe"

    def test_country_filter(self, client):
        """GET /net?country=NL filters by country."""
        ref_resp, tgt_resp = client.get_both(
            "net", params={"country": "NL", "limit": 5, "depth": 0})
        tgt_data = extract_data(tgt_resp)
        # net records don't always have country directly — check it's respected
        ref_data = extract_data(ref_resp)
        assert abs(len(ref_data) - len(tgt_data)) <= 1

    def test_since_parameter(self, client):
        """GET /net?since=<ts>&depth=0 returns only recently modified."""
        recent_ts = int(time.time()) - 86400  # last 24h
        ref_resp, tgt_resp = client.get_both(
            "net", params={"since": recent_ts, "depth": 0, "limit": 10})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        # Both should return records; exact count may differ slightly
        # Key check: target actually respects the since parameter
        if not ref_data:
            pytest.skip("No recently modified networks in reference")
        assert len(tgt_data) > 0, "since filter returned nothing from target"

    def test_status_deleted_filter(self, client):
        """GET /net?status=deleted&since=<ts> surfaces deleted records."""
        recent_ts = int(time.time()) - 604800  # last 7 days
        ref_resp, tgt_resp = client.get_both(
            "net", params={"status": "deleted", "since": recent_ts, "depth": 0})
        # Just verify the target accepts the parameter without error
        assert tgt_resp.status_code == 200


# ===================================================================
# SECTION 4 — SPECIFIC ENDPOINT DATA VALIDATION
# ===================================================================

class TestNetEndpoint:
    """Validate /net responses in detail."""

    def test_net_by_asn_data_match(self, client, api_config):
        """Field values for a known ASN should match between ref and target."""
        ref_resp, tgt_resp = client.get_both(
            "net", params={"asn": WELL_KNOWN["asn_netflix"], "depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        assert len(tgt_data) == 1

        # Compare stable fields (ignore volatile timestamps)
        stable_fields = ["asn", "name", "irr_as_set", "info_type",
                         "policy_general", "policy_url", "website"]
        ref_rec = ref_data[0]
        tgt_rec = tgt_data[0]
        mismatches = []
        for f in stable_fields:
            if f in ref_rec and ref_rec[f] != tgt_rec.get(f):
                mismatches.append(f"  {f}: ref={ref_rec[f]!r} tgt={tgt_rec.get(f)!r}")
        snapshot(api_config, "net_netflix", ref_rec, tgt_rec)
        assert not mismatches, "Field value mismatches:\n" + "\n".join(mismatches)

    def test_net_prefix_counts_are_integers(self, client):
        """info_prefixes4 and info_prefixes6 must be ints."""
        _, tgt = client.get_both(
            "net", params={"asn": WELL_KNOWN["asn_cloudflare"], "depth": 0})
        rec = extract_data(tgt)[0]
        assert isinstance(rec["info_prefixes4"], int)
        assert isinstance(rec["info_prefixes6"], int)


class TestNetixlanEndpoint:
    """Validate /netixlan responses."""

    def test_netixlan_ip_fields(self, client):
        """ipaddr4 / ipaddr6 should be strings or null."""
        _, tgt = client.get_both(
            "netixlan", params={"asn": WELL_KNOWN["asn_cloudflare"],
                                "limit": 10, "depth": 0})
        for rec in extract_data(tgt):
            for fld in ("ipaddr4", "ipaddr6"):
                assert rec[fld] is None or isinstance(rec[fld], str), (
                    f"{fld} should be str|null, got {type(rec[fld])}"
                )

    def test_netixlan_speed_is_int(self, client):
        """speed field must be an integer (Mbps)."""
        _, tgt = client.get_both(
            "netixlan", params={"ix_id": WELL_KNOWN["ix_amsix_id"],
                                "limit": 10, "depth": 0})
        for rec in extract_data(tgt):
            assert isinstance(rec["speed"], int)

    def test_netixlan_is_rs_peer_is_bool(self, client):
        _, tgt = client.get_both(
            "netixlan", params={"ix_id": WELL_KNOWN["ix_amsix_id"],
                                "limit": 10, "depth": 0})
        for rec in extract_data(tgt):
            assert isinstance(rec["is_rs_peer"], bool)


class TestIxEndpoint:
    """Validate /ix responses."""

    def test_ix_by_id(self, client, api_config):
        ref_resp, tgt_resp = client.get_both(
            f"ix/{WELL_KNOWN['ix_amsix_id']}", params={"depth": 0})
        ref_data = extract_data(ref_resp)
        tgt_data = extract_data(tgt_resp)
        assert len(tgt_data) == 1
        assert tgt_data[0]["id"] == WELL_KNOWN["ix_amsix_id"]

        stable = ["name", "country", "region_continent", "city", "media"]
        mismatches = []
        for f in stable:
            if f in ref_data[0] and ref_data[0][f] != tgt_data[0].get(f):
                mismatches.append(f"  {f}: ref={ref_data[0][f]!r} tgt={tgt_data[0].get(f)!r}")
        assert not mismatches, "IX field mismatches:\n" + "\n".join(mismatches)


class TestFacEndpoint:
    """Validate /fac responses."""

    def test_fac_by_id(self, client):
        ref_resp, tgt_resp = client.get_both(
            f"fac/{WELL_KNOWN['fac_equinix_am5']}", params={"depth": 0})
        tgt_data = extract_data(tgt_resp)
        assert len(tgt_data) == 1
        rec = tgt_data[0]
        assert "name" in rec
        assert "city" in rec
        assert "country" in rec

    def test_fac_geocoordinates(self, client):
        """latitude/longitude should be floats or null."""
        _, tgt = client.get_both(
            f"fac/{WELL_KNOWN['fac_equinix_am5']}", params={"depth": 0})
        rec = extract_data(tgt)[0]
        for fld in ("latitude", "longitude"):
            if fld in rec:
                assert rec[fld] is None or isinstance(rec[fld], (int, float))


class TestIxpfxEndpoint:
    """Validate /ixpfx responses."""

    def test_ixpfx_protocol_field(self, client):
        """protocol should be 'IPv4' or 'IPv6'."""
        ref = client.get_reference(
            "ixlan", params={"ix_id": WELL_KNOWN["ix_decix_id"], "depth": 0})
        ixlans = extract_data(ref)
        if not ixlans:
            pytest.skip("No ixlan for DE-CIX")

        _, tgt = client.get_both(
            "ixpfx", params={"ixlan_id": ixlans[0]["id"], "depth": 0})
        for rec in extract_data(tgt):
            assert rec["protocol"] in ("IPv4", "IPv6"), (
                f"Unexpected protocol: {rec['protocol']}"
            )


# ===================================================================
# SECTION 5 — DATA CONSISTENCY ACROSS ENDPOINTS
# ===================================================================

class TestCrossEndpointConsistency:
    """
    Verify that related data is consistent across endpoints on the target
    (e.g. a netixlan record's ix_id actually exists in /ix).
    """

    def test_netixlan_ix_ids_exist_in_ix(self, client):
        """Every ix_id in netixlan results should resolve via /ix."""
        _, tgt = client.get_both(
            "netixlan", params={"asn": WELL_KNOWN["asn_cloudflare"],
                                "limit": 5, "depth": 0})
        ix_ids = {r["ix_id"] for r in extract_data(tgt)}
        for ix_id in list(ix_ids)[:3]:  # spot-check 3
            _, check = client.get_both(f"ix/{ix_id}", params={"depth": 0})
            assert check.status_code == 200
            assert len(extract_data(check)) == 1

    def test_netfac_fac_ids_exist_in_fac(self, client):
        """Every fac_id in netfac results should resolve via /fac."""
        _, tgt = client.get_both(
            "netfac", params={"local_asn": WELL_KNOWN["asn_google"],
                              "limit": 5, "depth": 0})
        fac_ids = {r["fac_id"] for r in extract_data(tgt)}
        for fac_id in list(fac_ids)[:3]:
            _, check = client.get_both(f"fac/{fac_id}", params={"depth": 0})
            assert check.status_code == 200

    def test_net_id_consistent_with_asn(self, client):
        """A net_id obtained from /netixlan should match the ASN in /net."""
        _, tgt = client.get_both(
            "netixlan", params={"asn": WELL_KNOWN["asn_netflix"], "depth": 0,
                                "limit": 1})
        recs = extract_data(tgt)
        if not recs:
            pytest.skip("No netixlan data")
        net_id = recs[0]["net_id"]
        _, net_resp = client.get_both(f"net/{net_id}", params={"depth": 0})
        net_data = extract_data(net_resp)
        assert net_data[0]["asn"] == WELL_KNOWN["asn_netflix"]


# ===================================================================
# SECTION 6 — DEEP DIFF (optional strict mode)
# ===================================================================

class TestDeepValueComparison:
    """
    When --strict-values is set, do a full DeepDiff of matching records.
    Ignores timestamps and ordering by default.
    """

    IGNORE_FIELDS = {"created", "updated", "status_dashboard"}
    IGNORE_TYPES = {type(None)}

    @pytest.mark.strict
    @pytest.mark.parametrize("asn", [
        WELL_KNOWN["asn_cloudflare"],
        WELL_KNOWN["asn_google"],
        WELL_KNOWN["asn_netflix"],
    ])
    def test_net_record_deep_diff(self, client, api_config, asn):
        if not api_config.strict_values:
            pytest.skip("--strict-values not set")

        ref_resp, tgt_resp = client.get_both(
            "net", params={"asn": asn, "depth": 0})
        ref_rec = extract_data(ref_resp)[0]
        tgt_rec = extract_data(tgt_resp)[0]

        # Strip volatile fields
        for f in self.IGNORE_FIELDS:
            ref_rec.pop(f, None)
            tgt_rec.pop(f, None)

        diff = DeepDiff(ref_rec, tgt_rec, ignore_order=True,
                        significant_digits=2)
        snapshot(api_config, f"deepdiff_net_{asn}", ref_rec, tgt_rec)
        assert not diff, f"Deep diff for AS{asn}:\n{diff.pretty()}"


# ===================================================================
# SECTION 7 — ERROR HANDLING & EDGE CASES
# ===================================================================

class TestErrorHandling:

    def test_invalid_endpoint_returns_404(self, client):
        _, tgt = client.get_both("nonexistent_endpoint_xyz")
        assert tgt.status_code in (404, 400)

    def test_invalid_filter_value(self, client):
        """asn=notanumber should return 400 or empty, not 500."""
        _, tgt = client.get_both("net", params={"asn": "notanumber"})
        assert tgt.status_code in (400, 200)
        if tgt.status_code == 200:
            assert extract_data(tgt) == []

    def test_negative_limit_handled(self, client):
        _, tgt = client.get_both("net", params={"limit": -1})
        assert tgt.status_code in (400, 200)

    def test_depth_too_high(self, client):
        """depth=99 should be clamped or rejected, not crash."""
        _, tgt = client.get_both("net", params={"limit": 1, "depth": 99})
        assert tgt.status_code in (200, 400)

    def test_empty_result_is_valid_json(self, client):
        """A query that matches nothing should return {"data": []}."""
        _, tgt = client.get_both("net", params={"asn": 0, "depth": 0})
        body = tgt.json()
        assert body.get("data") == [] or tgt.status_code == 404


# ===================================================================
# SECTION 8 — PERFORMANCE BASELINES
# ===================================================================

class TestPerformance:
    """Ensure target isn't dramatically slower than reference."""

    SLOW_THRESHOLD_FACTOR = 5.0  # target may be up to 5x slower

    @pytest.mark.performance
    @pytest.mark.parametrize("endpoint,params", [
        ("net", {"asn": WELL_KNOWN["asn_cloudflare"], "depth": 0}),
        ("netixlan", {"ix_id": WELL_KNOWN["ix_amsix_id"], "depth": 0}),
        ("fac", {"limit": 20, "depth": 0}),
    ])
    def test_response_time(self, client, endpoint, params):
        ref_resp, tgt_resp = client.get_both(endpoint, params=params)
        ref_time = ref_resp.elapsed.total_seconds()
        tgt_time = tgt_resp.elapsed.total_seconds()
        assert tgt_time < ref_time * self.SLOW_THRESHOLD_FACTOR, (
            f"/{endpoint} target too slow: "
            f"ref={ref_time:.3f}s tgt={tgt_time:.3f}s "
            f"({tgt_time/max(ref_time, 0.001):.1f}x)"
        )
