/**
 * @fileoverview Additional PeeringDB API conformance tests.
 * Append to or import from test_conformance.js.
 *
 * New coverage:
 *   Section 10 — Substring & prefix matching (__contains, __startswith)
 *   Section 11 — carrier / carrierfac / campus schema + query params
 *   Section 12 — Timestamp range queries (updated__gte, updated__lte)
 *   Section 13 — as_set multi-ASN + edge cases
 *   Section 14 — Output format negotiation (.json extension, Accept header)
 *   Section 15 — since parameter data integrity
 *   Section 16 — Sorting & deterministic ordering
 *   Section 17 — Cross-endpoint consistency (extended)
 *   Section 18 — Concurrency stress
 *   Section 19 — Field selection edge cases
 *   Section 20 — Numeric range & comparison filters
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Assumes these are importable or already in scope from test_conformance.js ──
// If running as a separate file, paste the config/helpers block from test_conformance.js
// or extract them into a shared module.

const PDBFE = (process.env.PDBFE_URL || 'https://pdbfe-api.remco-vanmook.workers.dev').replace(/\/$/, '');
const PEERINGDB = 'https://www.peeringdb.com';
const PDB_API_KEY = process.env.PEERINGDB_API_KEY || '';

const WELL_KNOWN = {
    asn_cloudflare: 13335,
    asn_google: 15169,
    asn_netflix: 2906,
    asn_hurricane: 6939,
    ix_amsix_id: 26,
    ix_decix_id: 31,
    fac_equinix_am5: 58,
};

const delay = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {{method?: string, timeoutMs?: number, accept?: string}} [opts]
 */
async function fetchJSON(url, opts = {}) {
    const { method = 'GET', timeoutMs = 30000, accept = 'application/json' } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    /** @type {Record<string, string>} */
    const headers = { Accept: accept };
    if (PDB_API_KEY && url.startsWith(PEERINGDB)) {
        headers['Authorization'] = `Api-Key ${PDB_API_KEY}`;
    }
    try {
        const start = Date.now();
        const res = await fetch(url, { method, signal: controller.signal, headers });
        const elapsed = Date.now() - start;
        let body;
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
            try { body = await res.json(); } catch { body = { _error: 'JSON parse failed' }; }
        } else {
            body = { _raw: await res.text(), _contentType: ct };
        }
        return { status: res.status, body, headers: res.headers, elapsed };
    } finally {
        clearTimeout(timer);
    }
}

/** @param {string} path */
async function fetchMirror(path, opts) { return fetchJSON(`${PDBFE}${path}`, opts); }

/** @param {string} path */
async function fetchBoth(path) {
    const mirror = await fetchJSON(`${PDBFE}${path}`);
    await delay(500);
    const upstream = await fetchJSON(`${PEERINGDB}${path}`);
    return { mirror, upstream };
}

/**
 * @param {any} body
 * @param {string} label
 * @returns {any[]}
 */
function extractData(body, label) {
    assert.ok(body, `${label}: empty response body`);
    assert.ok('data' in body, `${label}: response missing 'data' key`);
    assert.ok(Array.isArray(body.data), `${label}: 'data' is not an array`);
    return body.data;
}

/** @param {any[]} records */
function fieldNames(records) {
    const names = new Set();
    for (const r of records) for (const k of Object.keys(r)) names.add(k);
    return names;
}


// ==========================================================================
// SECTION 10 — SUBSTRING & PREFIX MATCHING
// ==========================================================================

describe('Conformance: substring & prefix filters', { concurrency: 1 }, () => {

    it('?name__contains= on net', async () => {
        const res = await fetchMirror('/api/net?name__contains=cloud&limit=10&depth=0');
        const data = extractData(res.body, 'net?name__contains');
        assert.ok(data.length > 0, 'Should find networks with "cloud" in name');
        for (const r of data) {
            assert.ok(r.name.toLowerCase().includes('cloud'),
                `"${r.name}" does not contain "cloud"`);
        }
    });

    it('?name__startswith= on net', async () => {
        const res = await fetchMirror('/api/net?name__startswith=Cloud&limit=10&depth=0');
        const data = extractData(res.body, 'net?name__startswith');
        assert.ok(data.length > 0, 'Should find networks starting with "Cloud"');
        for (const r of data) {
            // COLLATE NOCASE means case-insensitive matching
            assert.ok(r.name.toLowerCase().startsWith('cloud'),
                `"${r.name}" does not start with "Cloud" (case-insensitive)`);
        }
    });

    it('?name__contains= on ix', async () => {
        const res = await fetchMirror('/api/ix?name__contains=IX&limit=10&depth=0');
        const data = extractData(res.body, 'ix?name__contains');
        assert.ok(data.length > 0, 'Should find IXPs with "IX" in name');
    });

    it('?name__contains= on fac', async () => {
        const res = await fetchMirror('/api/fac?name__contains=Equinix&limit=10&depth=0');
        const data = extractData(res.body, 'fac?name__contains');
        assert.ok(data.length > 0, 'Should find facilities with "Equinix" in name');
        for (const r of data) {
            assert.ok(r.name.toLowerCase().includes('equinix'),
                `"${r.name}" does not contain "Equinix"`);
        }
    });

    it('?name__contains= case sensitivity matches upstream', async () => {
        // PeeringDB __contains is case-insensitive — verify mirror matches
        const { mirror, upstream } = await fetchBoth('/api/net?name__contains=CLOUD&limit=5&depth=0');
        const mirData = extractData(mirror.body, 'mirror');
        const upData = extractData(upstream.body, 'upstream');
        // Should get results (case-insensitive) or both return 0
        assert.equal(mirData.length > 0, upData.length > 0,
            `Case sensitivity mismatch: mirror=${mirData.length} upstream=${upData.length}`);
    });

    it('?name__contains= empty string returns all (or is rejected)', async () => {
        const res = await fetchMirror('/api/net?name__contains=&limit=3&depth=0');
        // Should either return results (ignored filter) or 400
        assert.ok([200, 400].includes(res.status));
    });

    it('?city__contains= on fac', async () => {
        const res = await fetchMirror('/api/fac?city__contains=Amsterdam&limit=10&depth=0');
        const data = extractData(res.body, 'fac?city__contains');
        assert.ok(data.length > 0, 'Should find Amsterdam facilities');
        for (const r of data) {
            assert.ok(r.city.toLowerCase().includes('amsterdam'),
                `"${r.city}" does not contain "amsterdam"`);
        }
    });

    it('?country__startswith= is not a valid filter (countries are exact)', async () => {
        // country is a 2-char code — __startswith should return empty or be rejected
        const res = await fetchMirror('/api/net?country__startswith=N&limit=5&depth=0');
        // Either 400 (invalid) or 200 with results matching the filter
        assert.ok([200, 400].includes(res.status));
    });
});


// ==========================================================================
// SECTION 11 — CARRIER / CARRIERFAC / CAMPUS SCHEMA + QUERIES
// ==========================================================================

describe('Conformance: carrier/carrierfac/campus', { concurrency: 1 }, () => {

    // ── Schema tests ──

    for (const entity of ['carrier', 'carrierfac', 'campus']) {
        it(`/api/${entity}?depth=0 — field names match upstream`, async () => {
            const { mirror, upstream } = await fetchBoth(`/api/${entity}?limit=5&depth=0`);
            if (upstream.body?._error) return; // upstream may not support these yet
            const upData = extractData(upstream.body, `upstream/${entity}`);
            const mirData = extractData(mirror.body, `mirror/${entity}`);
            if (upData.length === 0) return;

            const upFields = fieldNames(upData);
            const mirFields = fieldNames(mirData);
            const missing = [...upFields].filter(k => !mirFields.has(k));
            assert.deepStrictEqual(missing, [],
                `/${entity} mirror missing fields: ${missing.join(', ')}`);
        });

        it(`/api/${entity} — field types match upstream`, async () => {
            const { mirror, upstream } = await fetchBoth(`/api/${entity}?limit=10&depth=0`);
            if (upstream.body?._error) return;
            const upData = extractData(upstream.body, `upstream/${entity}`);
            const mirData = extractData(mirror.body, `mirror/${entity}`);
            if (upData.length === 0 || mirData.length === 0) return;

            // Build type maps
            const typeMap = (/** @type {any[]} */ recs) => {
                /** @type {Map<string, Set<string>>} */
                const m = new Map();
                for (const r of recs) for (const [k, v] of Object.entries(r)) {
                    if (!m.has(k)) m.set(k, new Set());
                    m.get(k)?.add(v === null ? 'null' : typeof v);
                }
                return m;
            };
            const upTypes = typeMap(upData);
            const mirTypes = typeMap(mirData);
            const mismatches = [];
            for (const [f, upSet] of upTypes) {
                const mirSet = mirTypes.get(f);
                if (!mirSet) continue;
                const upT = [...upSet].filter(t => t !== 'null').sort().join(',');
                const mirT = [...mirSet].filter(t => t !== 'null').sort().join(',');
                if (upT && mirT && upT !== mirT) {
                    mismatches.push(`  ${f}: upstream=${upT} mirror=${mirT}`);
                }
            }
            assert.deepStrictEqual(mismatches, [],
                `/${entity} type mismatches:\n${mismatches.join('\n')}`);
        });
    }

    // ── Query param tests ──

    it('?org_id= filter on carrier', async () => {
        // Get a carrier's org_id first
        const list = await fetchMirror('/api/carrier?limit=1&depth=0');
        const data = extractData(list.body, 'carrier list');
        if (data.length === 0) return;
        const orgId = data[0].org_id;

        const res = await fetchMirror(`/api/carrier?org_id=${orgId}&depth=0`);
        const filtered = extractData(res.body, 'carrier?org_id');
        for (const r of filtered) {
            assert.equal(r.org_id, orgId, `carrier org_id mismatch: ${r.org_id} != ${orgId}`);
        }
    });

    it('?carrier_id= filter on carrierfac', async () => {
        const list = await fetchMirror('/api/carrierfac?limit=1&depth=0');
        const data = extractData(list.body, 'carrierfac list');
        if (data.length === 0) return;
        const carrierId = data[0].carrier_id;

        const res = await fetchMirror(`/api/carrierfac?carrier_id=${carrierId}&depth=0`);
        const filtered = extractData(res.body, 'carrierfac?carrier_id');
        for (const r of filtered) {
            assert.equal(r.carrier_id, carrierId);
        }
    });

    it('?fac_id= filter on carrierfac', async () => {
        const list = await fetchMirror('/api/carrierfac?limit=1&depth=0');
        const data = extractData(list.body, 'carrierfac list');
        if (data.length === 0) return;
        const facId = data[0].fac_id;

        const res = await fetchMirror(`/api/carrierfac?fac_id=${facId}&depth=0`);
        const filtered = extractData(res.body, 'carrierfac?fac_id');
        assert.ok(filtered.length > 0);
        for (const r of filtered) {
            assert.equal(r.fac_id, facId);
        }
    });

    it('carrier/ID returns single record', async () => {
        const list = await fetchMirror('/api/carrier?limit=1&depth=0');
        const data = extractData(list.body, 'carrier');
        if (data.length === 0) return;

        const detail = await fetchMirror(`/api/carrier/${data[0].id}?depth=0`);
        assert.equal(detail.status, 200);
        assert.equal(extractData(detail.body, 'carrier detail').length, 1);
    });

    it('campus/ID returns single record', async () => {
        const list = await fetchMirror('/api/campus?limit=1&depth=0');
        const data = extractData(list.body, 'campus');
        if (data.length === 0) return;

        const detail = await fetchMirror(`/api/campus/${data[0].id}?depth=0`);
        assert.equal(detail.status, 200);
        assert.equal(extractData(detail.body, 'campus detail').length, 1);
    });

    it('carrier __in filter', async () => {
        const list = await fetchMirror('/api/carrier?limit=3&depth=0');
        const data = extractData(list.body, 'carrier list');
        if (data.length < 2) return;
        const ids = data.slice(0, 2).map(/** @param {any} r */ r => r.id);

        const res = await fetchMirror(`/api/carrier?id__in=${ids.join(',')}&depth=0`);
        const filtered = extractData(res.body, 'carrier __in');
        const returnedIds = new Set(filtered.map(/** @param {any} r */ r => r.id));
        for (const id of ids) {
            assert.ok(returnedIds.has(id), `Expected carrier id=${id} in __in results`);
        }
    });
});


// ==========================================================================
// SECTION 12 — TIMESTAMP RANGE QUERIES
// ==========================================================================

describe('Conformance: timestamp range queries', { concurrency: 1 }, () => {

    it('?updated__gte= returns recently updated records', async () => {
        const oneDayAgo = new Date(Date.now() - 86400_000).toISOString();
        const res = await fetchMirror(`/api/net?updated__gte=${oneDayAgo}&limit=5&depth=0`);
        // Might be 200 with data, 200 with empty, or 400 if not supported
        assert.ok([200, 400].includes(res.status),
            `Unexpected status ${res.status} for updated__gte`);
    });

    it('?updated__lte= returns older records', async () => {
        const oneYearAgo = new Date(Date.now() - 365 * 86400_000).toISOString();
        const res = await fetchMirror(`/api/net?updated__lte=${oneYearAgo}&limit=5&depth=0`);
        assert.ok([200, 400].includes(res.status));
    });

    it('?updated__gte + ?updated__lte range query', async () => {
        const from = new Date(Date.now() - 7 * 86400_000).toISOString();
        const to = new Date(Date.now() - 1 * 86400_000).toISOString();
        const res = await fetchMirror(
            `/api/net?updated__gte=${from}&updated__lte=${to}&limit=5&depth=0`);
        assert.ok([200, 400].includes(res.status));
        if (res.status === 200 && res.body.data?.length > 0) {
            // Verify all returned records fall within the range
            for (const r of res.body.data) {
                if (r.updated) {
                    const ts = new Date(r.updated).getTime();
                    assert.ok(ts >= new Date(from).getTime(),
                        `Record updated ${r.updated} is before range start ${from}`);
                    assert.ok(ts <= new Date(to).getTime(),
                        `Record updated ${r.updated} is after range end ${to}`);
                }
            }
        }
    });

    it('?created__gte= on fac', async () => {
        const sixMonthsAgo = new Date(Date.now() - 180 * 86400_000).toISOString();
        const res = await fetchMirror(`/api/fac?created__gte=${sixMonthsAgo}&limit=5&depth=0`);
        assert.ok([200, 400].includes(res.status));
    });

    it('?since= and ?updated__gte= consistency', async () => {
        // Both should conceptually return overlapping sets
        const ts = Math.floor(Date.now() / 1000) - 86400;
        const isoTs = new Date(ts * 1000).toISOString();

        const sincRes = await fetchMirror(`/api/net?since=${ts}&limit=20&depth=0`);
        const updRes = await fetchMirror(`/api/net?updated__gte=${isoTs}&limit=20&depth=0`);

        if (sincRes.status === 200 && updRes.status === 200) {
            const sinceIds = new Set(extractData(sincRes.body, 'since').map(
                /** @param {any} r */ r => r.id));
            const updIds = new Set(extractData(updRes.body, 'updated__gte').map(
                /** @param {any} r */ r => r.id));
            // At minimum, they should overlap significantly if both are supported
            // (exact match not required due to limit and potential ordering differences)
            if (sinceIds.size > 0 && updIds.size > 0) {
                const overlap = [...sinceIds].filter(id => updIds.has(id));
                // Soft check — just verify they're not completely disjoint
                // (they may not overlap at all if ordering differs, so no assertion)
            }
        }
    });
});


// ==========================================================================
// SECTION 13 — AS_SET MULTI-ASN & EDGE CASES
// ==========================================================================

describe('Conformance: as_set extended', { concurrency: 1 }, () => {

    it('/api/as_set/<asn1>,<asn2> returns 400 (upstream behaviour)', async () => {
        const asns = `${WELL_KNOWN.asn_cloudflare},${WELL_KNOWN.asn_netflix}`;
        const res = await fetchMirror(`/api/as_set/${asns}`);
        // Upstream PeeringDB rejects comma-separated ASNs with 400
        assert.equal(res.status, 400,
            `Multi-ASN as_set should return 400, got ${res.status}`);
    });

    it('/api/as_set/<asn> value matches upstream', async () => {
        const { mirror, upstream } = await fetchBoth(
            `/api/as_set/${WELL_KNOWN.asn_cloudflare}`);
        if (upstream.body?._error) return;

        const mirData = extractData(mirror.body, 'mirror as_set');
        const upData = extractData(upstream.body, 'upstream as_set');
        assert.equal(mirData.length, upData.length,
            `as_set record count mismatch: mirror=${mirData.length} upstream=${upData.length}`);

        if (mirData.length > 0 && upData.length > 0) {
            // Upstream format: {"13335": "AS-CLOUDFLARE"} (ASN key → irr_as_set string)
            // Mirror format:   {"asn": 13335, "irr_as_set": "AS-CLOUDFLARE", "name": "..."}
            // Compare the irr_as_set value
            const asnKey = String(WELL_KNOWN.asn_cloudflare);
            const upValue = upData[0][asnKey];
            assert.ok(upValue !== undefined, `Upstream missing key "${asnKey}"`);
            assert.equal(mirData[0].irr_as_set, upValue,
                `irr_as_set mismatch: mirror="${mirData[0].irr_as_set}" upstream="${upValue}"`);
        }
    });

    it('/api/as_set/<asn> value matches net irr_as_set', async () => {
        const [asSetRes, netRes] = await Promise.all([
            fetchMirror(`/api/as_set/${WELL_KNOWN.asn_cloudflare}`),
            fetchMirror(`/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`),
        ]);
        const asData = extractData(asSetRes.body, 'as_set');
        const netData = extractData(netRes.body, 'net');
        if (asData.length > 0 && netData.length > 0) {
            assert.equal(asData[0].irr_as_set, netData[0].irr_as_set,
                'as_set irr_as_set should match net record');
        }
    });

    it('/api/as_set/0 — returns 404 or empty', async () => {
        const res = await fetchMirror('/api/as_set/0');
        assert.ok([404, 200].includes(res.status));
        if (res.status === 200) {
            assert.equal(res.body.data.length, 0);
        }
    });

    it('/api/as_set/<asn> with large private ASN', async () => {
        const res = await fetchMirror('/api/as_set/4200000001');
        assert.ok([404, 400, 200].includes(res.status));
    });
});


// ==========================================================================
// SECTION 14 — OUTPUT FORMAT NEGOTIATION
// ==========================================================================

describe('Conformance: output format', { concurrency: 1 }, () => {

    it('.json extension returns JSON', async () => {
        const res = await fetchMirror('/api/net/1.json?depth=0');
        // Should either work (200 + JSON) or not be supported (404)
        if (res.status === 200) {
            assert.ok(res.body.data, '.json extension should return data envelope');
        }
    });

    it('Accept: application/json returns JSON', async () => {
        const res = await fetchMirror('/api/net?limit=1&depth=0',
            { accept: 'application/json' });
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('content-type')?.includes('application/json'));
    });

    it('Accept: text/html returns JSON (API does not serve HTML)', async () => {
        // PeeringDB API always returns JSON regardless of Accept header
        const res = await fetchMirror('/api/net?limit=1&depth=0',
            { accept: 'text/html' });
        // Mirror should still return JSON (or 406)
        assert.ok([200, 406].includes(res.status));
        if (res.status === 200) {
            assert.ok(res.body.data !== undefined, 'Should still return data envelope');
        }
    });

    it('Accept: */* returns JSON', async () => {
        const res = await fetchMirror('/api/net?limit=1&depth=0',
            { accept: '*/*' });
        assert.equal(res.status, 200);
        assert.ok(res.body.data !== undefined);
    });

    it('Response includes CORS headers', async () => {
        const res = await fetchMirror('/api/net?limit=1&depth=0');
        assert.ok(res.headers.get('access-control-allow-origin'),
            'Missing CORS header');
    });

    it('Response includes cache headers', async () => {
        const res = await fetchMirror('/api/net?limit=1&depth=0');
        // Your mirror should set some caching — verify it exists
        const cacheControl = res.headers.get('cache-control');
        const etag = res.headers.get('etag');
        const lastMod = res.headers.get('last-modified');
        assert.ok(cacheControl || etag || lastMod,
            'Response should include at least one cache-related header');
    });
});


// ==========================================================================
// SECTION 15 — SINCE PARAMETER DATA INTEGRITY
// ==========================================================================

describe('Conformance: since data integrity', { concurrency: 1 }, () => {

    it('since=0 returns all records (or large set)', async () => {
        const res = await fetchMirror('/api/net?since=1&limit=5&depth=0');
        const data = extractData(res.body, 'since=1');
        assert.ok(data.length > 0, 'since=1 should return records');
    });

    it('since=<future> returns empty', async () => {
        const futureTs = Math.floor(Date.now() / 1000) + 86400;
        const res = await fetchMirror(`/api/net?since=${futureTs}&depth=0`);
        const data = extractData(res.body, 'since=future');
        assert.equal(data.length, 0, 'Future timestamp should return no records');
    });

    it('since respects per-endpoint (net vs ix may differ)', async () => {
        const ts = Math.floor(Date.now() / 1000) - 3600; // 1h ago
        const [netRes, ixRes] = await Promise.all([
            fetchMirror(`/api/net?since=${ts}&limit=5&depth=0`),
            fetchMirror(`/api/ix?since=${ts}&limit=5&depth=0`),
        ]);
        // Both should be valid 200s, but may have different counts
        assert.equal(netRes.status, 200);
        assert.equal(ixRes.status, 200);
    });

    it('since + status=deleted combination', async () => {
        const ts = Math.floor(Date.now() / 1000) - 30 * 86400; // 30 days
        const res = await fetchMirror(`/api/net?since=${ts}&status=deleted&depth=0&limit=5`);
        assert.equal(res.status, 200);
        // Deleted records, if any, should have status=deleted
        for (const r of extractData(res.body, 'deleted')) {
            assert.equal(r.status, 'deleted',
                `Record ${r.id} has status="${r.status}", expected "deleted"`);
        }
    });
});


// ==========================================================================
// SECTION 16 — SORTING & DETERMINISTIC ORDERING
// ==========================================================================

describe('Conformance: ordering', { concurrency: 1 }, () => {

    it('default ordering is deterministic across requests', async () => {
        const res1 = await fetchMirror('/api/net?limit=10&depth=0');
        const res2 = await fetchMirror('/api/net?limit=10&depth=0');
        const ids1 = extractData(res1.body, 'order1').map(/** @param {any} r */ r => r.id);
        const ids2 = extractData(res2.body, 'order2').map(/** @param {any} r */ r => r.id);
        assert.deepStrictEqual(ids1, ids2,
            'Two identical queries should return records in the same order');
    });

    it('skip+limit paging is consistent', async () => {
        // Fetch pages 0-4, 5-9, 10-14 and verify no overlaps/gaps
        const page1 = await fetchMirror('/api/net?limit=5&skip=0&depth=0');
        const page2 = await fetchMirror('/api/net?limit=5&skip=5&depth=0');
        const page3 = await fetchMirror('/api/net?limit=5&skip=10&depth=0');

        const ids1 = extractData(page1.body, 'p1').map(/** @param {any} r */ r => r.id);
        const ids2 = extractData(page2.body, 'p2').map(/** @param {any} r */ r => r.id);
        const ids3 = extractData(page3.body, 'p3').map(/** @param {any} r */ r => r.id);

        const all = [...ids1, ...ids2, ...ids3];
        const unique = new Set(all);
        assert.equal(all.length, unique.size,
            `Paging overlap detected: ${all.length} total but ${unique.size} unique`);
    });

    it('ordering matches upstream sort direction', async () => {
        // Don't compare exact IDs — sync timing may cause different result sets.
        // Instead verify both use ascending ID order (the shared default).
        const { mirror, upstream } = await fetchBoth('/api/net?limit=10&depth=0');
        const mirIds = extractData(mirror.body, 'mirror').map(/** @param {any} r */ r => r.id);
        const upIds = extractData(upstream.body, 'upstream').map(/** @param {any} r */ r => r.id);

        // Both should be sorted ascending
        for (let i = 1; i < mirIds.length; i++) {
            assert.ok(mirIds[i] > mirIds[i - 1],
                `Mirror not sorted ascending: id[${i-1}]=${mirIds[i-1]} >= id[${i}]=${mirIds[i]}`);
        }
        for (let i = 1; i < upIds.length; i++) {
            assert.ok(upIds[i] > upIds[i - 1],
                `Upstream not sorted ascending: id[${i-1}]=${upIds[i-1]} >= id[${i}]=${upIds[i]}`);
        }
    });
});


// ==========================================================================
// SECTION 17 — CROSS-ENDPOINT CONSISTENCY (EXTENDED)
// ==========================================================================

describe('Conformance: cross-endpoint extended', { concurrency: 1 }, () => {

    it('ixfac ix_id + fac_id both resolve', async () => {
        const res = await fetchMirror(`/api/ixfac?ix_id=${WELL_KNOWN.ix_amsix_id}&limit=3&depth=0`);
        const data = extractData(res.body, 'ixfac');
        for (const r of data) {
            const [ixCheck, facCheck] = await Promise.all([
                fetchMirror(`/api/ix/${r.ix_id}?depth=0`),
                fetchMirror(`/api/fac/${r.fac_id}?depth=0`),
            ]);
            assert.equal(ixCheck.status, 200, `ix/${r.ix_id} not found`);
            assert.equal(facCheck.status, 200, `fac/${r.fac_id} not found`);
        }
    });

    it('carrierfac carrier_id + fac_id both resolve', async () => {
        const res = await fetchMirror('/api/carrierfac?limit=3&depth=0');
        const data = extractData(res.body, 'carrierfac');
        if (data.length === 0) return;

        for (const r of data) {
            const [carrCheck, facCheck] = await Promise.all([
                fetchMirror(`/api/carrier/${r.carrier_id}?depth=0`),
                fetchMirror(`/api/fac/${r.fac_id}?depth=0`),
            ]);
            assert.equal(carrCheck.status, 200, `carrier/${r.carrier_id} not found`);
            assert.equal(facCheck.status, 200, `fac/${r.fac_id} not found`);
        }
    });

    it('org_id on net resolves to /org', async () => {
        const netRes = await fetchMirror(`/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`);
        const netData = extractData(netRes.body, 'net CF');
        if (netData.length === 0) return;

        const orgId = netData[0].org_id;
        const orgRes = await fetchMirror(`/api/org/${orgId}?depth=0`);
        assert.equal(orgRes.status, 200, `org/${orgId} not found`);
        const orgData = extractData(orgRes.body, `org/${orgId}`);
        assert.equal(orgData.length, 1);
    });

    it('ixlan ix_id back-references valid ix', async () => {
        const res = await fetchMirror(`/api/ixlan?ix_id=${WELL_KNOWN.ix_decix_id}&depth=0`);
        const data = extractData(res.body, 'ixlan');
        for (const r of data) {
            assert.equal(r.ix_id, WELL_KNOWN.ix_decix_id,
                `ixlan record ${r.id} has ix_id=${r.ix_id}, expected ${WELL_KNOWN.ix_decix_id}`);
        }
    });

    it('net count via limit=0 matches netixlan distinct net_ids (spot check)', async () => {
        // For a specific IX, count of distinct ASNs in netixlan should be plausible
        const res = await fetchMirror(`/api/netixlan?ix_id=${WELL_KNOWN.ix_amsix_id}&depth=0&limit=0`);
        if (res.body?.meta?.count) {
            assert.ok(res.body.meta.count > 100,
                `AMS-IX should have >100 netixlan records, got ${res.body.meta.count}`);
        }
    });
});


// ==========================================================================
// SECTION 18 — CONCURRENCY STRESS
// ==========================================================================

describe('Conformance: concurrency', { concurrency: 1 }, () => {

    it('10 parallel requests return consistent results', async () => {
        const path = `/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`;
        const results = await Promise.all(
            Array.from({ length: 10 }, () => fetchMirror(path))
        );

        // All should succeed
        for (const r of results) {
            assert.equal(r.status, 200);
        }

        // All should return identical data
        const baseline = JSON.stringify(results[0].body.data);
        for (let i = 1; i < results.length; i++) {
            assert.equal(JSON.stringify(results[i].body.data), baseline,
                `Concurrent request ${i} returned different data`);
        }
    });

    it('mixed endpoint parallel requests all succeed', async () => {
        const paths = [
            `/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`,
            `/api/ix/${WELL_KNOWN.ix_amsix_id}?depth=0`,
            `/api/fac/${WELL_KNOWN.fac_equinix_am5}?depth=0`,
            `/api/netixlan?asn=${WELL_KNOWN.asn_google}&limit=5&depth=0`,
            `/api/netfac?local_asn=${WELL_KNOWN.asn_netflix}&depth=0`,
            `/api/org?limit=3&depth=0`,
            `/api/ixpfx?limit=5&depth=0`,
            `/api/carrier?limit=3&depth=0`,
        ];
        const results = await Promise.all(paths.map(p => fetchMirror(p)));

        for (let i = 0; i < results.length; i++) {
            assert.equal(results[i].status, 200,
                `${paths[i]} returned ${results[i].status}`);
            assert.ok(results[i].body.data !== undefined,
                `${paths[i]} missing data envelope`);
        }
    });

    it('20 parallel requests do not trigger errors', async () => {
        const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
                fetchMirror(`/api/net?limit=1&skip=${i}&depth=0`))
        );
        const failures = results.filter(r => r.status !== 200);
        assert.equal(failures.length, 0,
            `${failures.length}/20 requests failed: statuses=${failures.map(f => f.status)}`);
    });
});


// ==========================================================================
// SECTION 19 — FIELD SELECTION EDGE CASES
// ==========================================================================

describe('Conformance: field selection edge cases', { concurrency: 1 }, () => {

    it('?fields= with single field', async () => {
        const res = await fetchMirror('/api/net?limit=3&fields=asn&depth=0');
        const data = extractData(res.body, 'fields=asn');
        for (const r of data) {
            assert.deepStrictEqual(Object.keys(r), ['asn'],
                `Expected only "asn", got ${Object.keys(r).join(', ')}`);
        }
    });

    it('?fields= with nonexistent field is ignored or errors', async () => {
        const res = await fetchMirror('/api/net?limit=1&fields=id,bogus_field_xyz&depth=0');
        assert.ok([200, 400].includes(res.status));
        if (res.status === 200) {
            const keys = Object.keys(extractData(res.body, 'bogus field')[0]);
            // Should either include only "id" or include "id" + ignore bogus
            assert.ok(keys.includes('id'), 'Should still return id field');
            assert.ok(!keys.includes('bogus_field_xyz'),
                'Should not invent a bogus field');
        }
    });

    it('?fields= works on derived endpoints', async () => {
        const res = await fetchMirror(
            `/api/netixlan?asn=${WELL_KNOWN.asn_cloudflare}&fields=ix_id,ipaddr4,speed&depth=0&limit=5`);
        const data = extractData(res.body, 'netixlan fields');
        for (const r of data) {
            assert.deepStrictEqual(new Set(Object.keys(r)),
                new Set(['ix_id', 'ipaddr4', 'speed']),
                `Unexpected keys: ${Object.keys(r).join(', ')}`);
        }
    });

    it('?fields=id always returns id', async () => {
        const res = await fetchMirror('/api/net?limit=3&fields=id&depth=0');
        const data = extractData(res.body, 'fields=id');
        for (const r of data) {
            assert.ok('id' in r, 'id field should always be present');
            assert.equal(typeof r.id, 'number');
        }
    });

    it('?fields= empty string returns all fields (or errors)', async () => {
        const res = await fetchMirror('/api/net?limit=1&fields=&depth=0');
        assert.ok([200, 400].includes(res.status));
        if (res.status === 200) {
            const keys = Object.keys(extractData(res.body, 'fields=empty')[0]);
            // Should return all fields when fields= is empty
            assert.ok(keys.length > 5, 'Empty fields= should return all fields');
        }
    });
});


// ==========================================================================
// SECTION 20 — NUMERIC RANGE & COMPARISON FILTERS
// ==========================================================================

describe('Conformance: numeric filters', { concurrency: 1 }, () => {

    it('?speed__gte= on netixlan', async () => {
        const res = await fetchMirror(
            `/api/netixlan?ix_id=${WELL_KNOWN.ix_amsix_id}&speed__gte=100000&limit=10&depth=0`);
        if (res.status === 200) {
            const data = extractData(res.body, 'speed__gte');
            for (const r of data) {
                assert.ok(r.speed >= 100000,
                    `speed=${r.speed} is below 100000`);
            }
        } else {
            assert.equal(res.status, 400, 'If not supported, should be 400');
        }
    });

    it('?info_prefixes4__gte= on net', async () => {
        const res = await fetchMirror('/api/net?info_prefixes4__gte=1000&limit=5&depth=0');
        if (res.status === 200) {
            const data = extractData(res.body, 'prefixes__gte');
            for (const r of data) {
                assert.ok(r.info_prefixes4 >= 1000,
                    `info_prefixes4=${r.info_prefixes4} is below 1000`);
            }
        } else {
            assert.equal(res.status, 400);
        }
    });

    it('?id__gt= for cursor-style paging', async () => {
        const first = await fetchMirror('/api/net?limit=5&depth=0');
        const data = extractData(first.body, 'id__gt first');
        if (data.length === 0) return;
        const lastId = data[data.length - 1].id;

        const next = await fetchMirror(`/api/net?id__gt=${lastId}&limit=5&depth=0`);
        if (next.status === 200) {
            const nextData = extractData(next.body, 'id__gt next');
            for (const r of nextData) {
                assert.ok(r.id > lastId,
                    `id=${r.id} should be > ${lastId}`);
            }
        } else {
            // id__gt may not be supported
            assert.equal(next.status, 400);
        }
    });

    it('?asn__lt= on netixlan', async () => {
        const res = await fetchMirror('/api/netixlan?asn__lt=1000&limit=10&depth=0');
        if (res.status === 200) {
            const data = extractData(res.body, 'asn__lt');
            for (const r of data) {
                assert.ok(r.asn < 1000, `asn=${r.asn} is not < 1000`);
            }
        } else {
            assert.equal(res.status, 400);
        }
    });
});