/**
 * @fileoverview PeeringDB API conformance test suite.
 * Validates the pdbfe mirror against the canonical PeeringDB API.
 * Covers envelope structure, schema conformance, query parameters,
 * data types, cross-endpoint consistency, and error handling.
 * Performance benchmarks are in test_performance.js.
 *
 * Environment variables:
 *   PDBFE_URL          - Mirror URL (default: https://pdbfe-api.remco-vanmook.workers.dev)
 *   PEERINGDB_API_KEY  - API key for authenticated PeeringDB requests
 *
 * Usage:
 *   # Run all conformance tests
 *   PEERINGDB_API_KEY=... node --test workers/tests/test_conformance.js
 *
 *   # Run a specific section
 *   PEERINGDB_API_KEY=... node --test --test-name-pattern="schema" workers/tests/test_conformance.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Configuration ────────────────────────────────────────────────────────────

const PDBFE = (process.env.PDBFE_URL || 'https://pdbfe-api.remco-vanmook.workers.dev').replace(/\/$/, '');
const PEERINGDB = 'https://www.peeringdb.com';
const PDB_API_KEY = process.env.PEERINGDB_API_KEY || '';

/** Well-known entities unlikely to vanish from PeeringDB. */
const WELL_KNOWN = {
    asn_cloudflare: 13335,
    asn_google: 15169,
    asn_netflix: 2906,
    ix_amsix_id: 26,
    ix_decix_id: 31,
    fac_equinix_am5: 58,
};

/**
 * All entity endpoint tags supported by the mirror.
 * @type {string[]}
 */
const ENTITY_TAGS = [
    'net', 'org', 'fac', 'ix', 'ixlan', 'ixpfx',
    'netfac', 'netixlan', 'poc', 'carrier', 'carrierfac', 'ixfac', 'campus',
];

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * Delay for rate-limit spacing.
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetches JSON from a URL with timeout and optional API key.
 * Retries once on 429 (rate limit).
 *
 * @param {string} url - Full URL to fetch.
 * @param {{method?: string, timeoutMs?: number}} [opts] - Request options.
 * @returns {Promise<{status: number, body: any, headers: Headers, elapsed: number}>}
 */
async function fetchJSON(url, opts = {}) {
    const { method = 'GET', timeoutMs = 30000 } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    /** @type {Record<string, string>} */
    const headers = { 'Accept': 'application/json' };
    if (PDB_API_KEY && url.startsWith(PEERINGDB)) {
        headers['Authorization'] = `Api-Key ${PDB_API_KEY}`;
    }

    try {
        const start = Date.now();
        const res = await fetch(url, { method, signal: controller.signal, headers });
        let body;
        try {
            body = await res.json();
        } catch {
            body = { _error: `Non-JSON response (status ${res.status})` };
        }
        const elapsed = Date.now() - start;

        if (res.status === 429 && url.startsWith(PEERINGDB)) {
            clearTimeout(timer);
            const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
            await delay((retryAfter + 1) * 1000);
            const start2 = Date.now();
            const res2 = await fetch(url, { method, signal: controller.signal, headers });
            const body2 = await res2.json();
            return { status: res2.status, body: body2, headers: res2.headers, elapsed: Date.now() - start2 };
        }
        return { status: res.status, body, headers: res.headers, elapsed };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Timestamp of the most recent upstream fetch. Used to space
 * sequential upstream requests without adding fixed delays.
 */
let _lastUpstreamTs = 0;

/**
 * Minimum milliseconds between consecutive upstream PeeringDB requests.
 * Applied automatically — no per-call delay needed.
 */
const UPSTREAM_SPACING_MS = 500;

/**
 * Fetches the same API path from both mirror and upstream PeeringDB.
 * Spaces upstream requests to avoid rate limiting, and reports
 * wall clock timing via the test diagnostic channel.
 *
 * @param {string} path - API path starting with / (e.g. "/api/net?limit=1").
 * @param {import('node:test').TestContext} [t] - Test context for timing diagnostics.
 * @returns {Promise<{mirror: {status: number, body: any, elapsed: number}, upstream: {status: number, body: any, elapsed: number}}>}
 */
async function fetchBoth(path, t) {
    const mirror = await fetchJSON(`${PDBFE}${path}`);

    // Rate-limit upstream: wait if last request was too recent
    const gap = Date.now() - _lastUpstreamTs;
    if (gap < UPSTREAM_SPACING_MS) await delay(UPSTREAM_SPACING_MS - gap);

    const upstream = await fetchJSON(`${PEERINGDB}${path}`);
    _lastUpstreamTs = Date.now();

    if (t) {
        // Extract server-side metrics from mirror response headers
        const timer = mirror.headers.get('X-Timer') || '';
        const veMatch = timer.match(/VE(\d+)/);
        const ve = veMatch ? veMatch[1] + 'ms' : '–';
        const cache = mirror.headers.get('X-Cache') || '–';
        const hits = mirror.headers.get('X-Cache-Hits') || '0';

        t.diagnostic(
            `mirror=${mirror.elapsed}ms (VE=${ve} cache=${cache} hits=${hits})  upstream=${upstream.elapsed}ms`
        );
    }
    return { mirror, upstream };
}

/**
 * Fetches from the mirror only.
 *
 * @param {string} path - API path starting with /.
 * @param {{method?: string}} [opts] - Request options.
 * @returns {Promise<{status: number, body: any, headers: Headers, elapsed: number}>}
 */
async function fetchMirror(path, opts) {
    return fetchJSON(`${PDBFE}${path}`, opts);
}

/**
 * Extracts the data array from a PeeringDB-style response.
 *
 * @param {any} body - Parsed JSON body.
 * @param {string} label - Context label for error messages.
 * @returns {any[]} The data array.
 */
function extractData(body, label) {
    assert.ok(body, `${label}: empty response body`);
    assert.ok('data' in body, `${label}: response missing 'data' key, got keys: ${Object.keys(body)}`);
    assert.ok(Array.isArray(body.data), `${label}: 'data' is not an array`);
    return body.data;
}

/**
 * Returns the union of all keys across all records.
 *
 * @param {Record<string, any>[]} records
 * @returns {Set<string>}
 */
function fieldNames(records) {
    const names = new Set();
    for (const r of records) {
        for (const k of Object.keys(r)) names.add(k);
    }
    return names;
}

/**
 * Returns a map of field name to the set of JS typeof values observed.
 *
 * @param {Record<string, any>[]} records
 * @returns {Map<string, Set<string>>}
 */
function fieldTypesMap(records) {
    /** @type {Map<string, Set<string>>} */
    const types = new Map();
    for (const r of records) {
        for (const [k, v] of Object.entries(r)) {
            if (!types.has(k)) types.set(k, new Set());
            const t = v === null ? 'null' : typeof v;
            types.get(k)?.add(t);
        }
    }
    return types;
}

// ==========================================================================
// SECTION 1 — ENVELOPE & PROTOCOL CONFORMANCE
// ==========================================================================

describe('Conformance: envelope', { concurrency: 1 }, () => {
    for (const entity of ENTITY_TAGS) {
        it(`/api/${entity} — returns {data: [...]}`, async () => {
            const res = await fetchMirror(`/api/${entity}?limit=1&depth=0`);
            assert.equal(res.status, 200);
            const data = extractData(res.body, entity);
            assert.ok(data.length > 0, `${entity} returned empty data`);
        });
    }

    for (const entity of ['net', 'ix', 'fac', 'org', 'netixlan', 'netfac', 'ixlan', 'ixpfx', 'ixfac']) {
        it(`/api/${entity}/ID — returns {data: [single]}`, async () => {
            const list = await fetchMirror(`/api/${entity}?limit=1&depth=0`);
            const data = extractData(list.body, entity);
            if (data.length === 0) return;

            const id = data[0].id;
            const detail = await fetchMirror(`/api/${entity}/${id}?depth=0`);
            assert.equal(detail.status, 200);
            const detailData = extractData(detail.body, `${entity}/${id}`);
            assert.equal(detailData.length, 1, `Expected 1 record for /${entity}/${id}`);
        });
    }

    it('/api/net/999999999 — returns 404 or empty', async () => {
        const res = await fetchMirror('/api/net/999999999');
        assert.ok([404, 200].includes(res.status));
        if (res.status === 200) {
            assert.deepStrictEqual(res.body.data, []);
        }
    });

    it('Content-Type is application/json', async () => {
        const res = await fetchMirror('/api/net?limit=1');
        assert.match(res.headers.get('content-type') || '', /application\/json/);
    });
});

// ==========================================================================
// SECTION 2 — SCHEMA CONFORMANCE
// ==========================================================================

describe('Conformance: schema', { concurrency: 1 }, () => {
    const schemaEntities = [
        { entity: 'net', depth: 0 },
        { entity: 'net', depth: 1 },
        { entity: 'ix', depth: 0 },
        { entity: 'fac', depth: 0 },
        { entity: 'org', depth: 0 },
        { entity: 'netixlan', depth: 0 },
        { entity: 'netfac', depth: 0 },
        { entity: 'ixlan', depth: 0 },
        { entity: 'ixpfx', depth: 0 },
        { entity: 'ixfac', depth: 0 },
    ];

    for (const { entity, depth } of schemaEntities) {
        it(`/api/${entity}?depth=${depth} — field names match upstream`, async (t) => {
            const { mirror, upstream } = await fetchBoth(`/api/${entity}?limit=5&depth=${depth}`, t);
            const upData = extractData(upstream.body, `upstream/${entity}`);
            const mirData = extractData(mirror.body, `mirror/${entity}`);

            if (upData.length === 0) return; // skip if upstream empty

            const upFields = fieldNames(upData);
            const mirFields = fieldNames(mirData);
            const missing = [...upFields].filter(k => !mirFields.has(k));
            assert.deepStrictEqual(missing, [],
                `/${entity}?depth=${depth} mirror missing fields: ${missing.join(', ')}`);
        });
    }

    for (const entity of ['net', 'ix', 'fac', 'org', 'netixlan', 'netfac']) {
        it(`/api/${entity} — field types match upstream`, async (t) => {
            const { mirror, upstream } = await fetchBoth(`/api/${entity}?limit=20&depth=0`, t);
            const upData = extractData(upstream.body, `upstream/${entity}`);
            const mirData = extractData(mirror.body, `mirror/${entity}`);

            if (upData.length === 0 || mirData.length === 0) return;

            const upTypes = fieldTypesMap(upData);
            const mirTypes = fieldTypesMap(mirData);
            const mismatches = [];

            for (const [field, upSet] of upTypes) {
                const mirSet = mirTypes.get(field);
                if (!mirSet) continue;
                // Strip null — both sides may have nullable fields
                const upNonNull = new Set([...upSet].filter(t => t !== 'null'));
                const mirNonNull = new Set([...mirSet].filter(t => t !== 'null'));
                if (upNonNull.size > 0 && mirNonNull.size > 0) {
                    const upStr = [...upNonNull].sort().join(',');
                    const mirStr = [...mirNonNull].sort().join(',');
                    if (upStr !== mirStr) {
                        mismatches.push(`  ${field}: upstream=${upStr} mirror=${mirStr}`);
                    }
                }
            }
            assert.deepStrictEqual(mismatches, [],
                `/${entity} type mismatches:\n${mismatches.join('\n')}`);
        });
    }

    it('depth=0 — _set fields absent', async () => {
        const res = await fetchMirror(`/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`);
        const data = extractData(res.body, 'net depth=0');
        if (data.length === 0) return;

        for (const k of Object.keys(data[0])) {
            if (k.endsWith('_set') && k !== 'irr_as_set') {
                assert.fail(`${k} should be absent at depth=0`);
            }
        }
    });

    it('depth=1 — _set fields are lists of integer IDs', async () => {
        const res = await fetchMirror(`/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=1`);
        const data = extractData(res.body, 'net depth=1');
        if (data.length === 0) return;

        let foundAny = false;
        for (const [k, v] of Object.entries(data[0])) {
            if (k.endsWith('_set') && k !== 'irr_as_set' && Array.isArray(v) && v.length > 0) {
                assert.equal(typeof v[0], 'number', `${k}[0] should be int at depth=1, got ${typeof v[0]}`);
                foundAny = true;
            }
        }
        assert.ok(foundAny, 'No _set fields found at depth=1');
    });
});

// ==========================================================================
// SECTION 3 — QUERY PARAMETER CONFORMANCE
// ==========================================================================

describe('Conformance: query parameters', { concurrency: 1 }, () => {
    it('?asn= filter on net', async () => {
        const res = await fetchMirror(`/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`);
        const data = extractData(res.body, 'net?asn');
        assert.ok(data.length > 0);
        assert.equal(data[0].asn, WELL_KNOWN.asn_cloudflare);
    });

    it('?asn= filter on netixlan', async () => {
        const res = await fetchMirror(`/api/netixlan?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`);
        const data = extractData(res.body, 'netixlan?asn');
        assert.ok(data.length > 0, 'Cloudflare should have IX peerings');
    });

    it('?local_asn= filter on netfac', async () => {
        const res = await fetchMirror(`/api/netfac?local_asn=${WELL_KNOWN.asn_google}&depth=0`);
        const data = extractData(res.body, 'netfac?local_asn');
        assert.ok(data.length > 0, 'Google should have facility presence');
        for (const r of data) {
            assert.equal(r.local_asn, WELL_KNOWN.asn_google);
        }
    });

    it('?ix_id= filter on netixlan', async () => {
        const res = await fetchMirror(`/api/netixlan?ix_id=${WELL_KNOWN.ix_amsix_id}&depth=0`);
        const data = extractData(res.body, 'netixlan?ix_id');
        assert.ok(data.length > 10, 'AMS-IX should have many participants');
    });

    it('?fac_id= filter on netfac', async () => {
        const res = await fetchMirror(`/api/netfac?fac_id=${WELL_KNOWN.fac_equinix_am5}&depth=0`);
        const data = extractData(res.body, 'netfac?fac_id');
        assert.ok(data.length > 0, 'Equinix AM5 should have networks');
    });

    it('?ixlan_id= filter on ixpfx', async () => {
        // Get an ixlan_id for DE-CIX
        const ixlanRes = await fetchMirror(`/api/ixlan?ix_id=${WELL_KNOWN.ix_decix_id}&depth=0`);
        const ixlans = extractData(ixlanRes.body, 'ixlan lookup');
        if (ixlans.length === 0) return;

        const res = await fetchMirror(`/api/ixpfx?ixlan_id=${ixlans[0].id}&depth=0`);
        const data = extractData(res.body, 'ixpfx?ixlan_id');
        assert.ok(data.length > 0, 'DE-CIX should have peering LAN prefixes');
    });

    it('__in filter', async () => {
        const res = await fetchMirror('/api/netixlan?net_id__in=694,1100&depth=0');
        const data = extractData(res.body, 'netixlan?__in');
        const netIds = new Set(data.map(/** @param {any} r */ r => r.net_id));
        for (const id of netIds) {
            assert.ok([694, 1100].includes(id), `Unexpected net_id: ${id}`);
        }
    });

    it('?fields= limits returned fields', async () => {
        const res = await fetchMirror('/api/net?limit=3&fields=id,asn,name&depth=0');
        const data = extractData(res.body, 'net?fields');
        for (const r of data) {
            const keys = new Set(Object.keys(r));
            assert.deepStrictEqual(keys, new Set(['id', 'asn', 'name']),
                `fields filter not respected: got ${[...keys].join(', ')}`);
        }
    });

    it('?limit= caps result count', async () => {
        const res = await fetchMirror('/api/net?limit=3&depth=0');
        const data = extractData(res.body, 'net?limit');
        assert.ok(data.length <= 3, `Expected <=3, got ${data.length}`);
    });

    it('?skip= offsets results', async () => {
        const res0 = await fetchMirror('/api/net?limit=2&skip=0&depth=0');
        const res2 = await fetchMirror('/api/net?limit=2&skip=2&depth=0');
        const d0 = extractData(res0.body, 'skip=0');
        const d2 = extractData(res2.body, 'skip=2');
        if (d0.length > 0 && d2.length > 0) {
            const ids0 = new Set(d0.map(/** @param {any} r */ r => r.id));
            const ids2 = new Set(d2.map(/** @param {any} r */ r => r.id));
            for (const id of ids2) {
                assert.ok(!ids0.has(id), `skip=2 returned overlapping ID: ${id}`);
            }
        }
    });

    it('?region_continent= filter on ix', async () => {
        const res = await fetchMirror('/api/ix?region_continent=Europe&limit=5&depth=0');
        const data = extractData(res.body, 'ix?region_continent');
        for (const r of data) {
            assert.equal(r.region_continent, 'Europe');
        }
    });

    it('?country=NL filter on net (cross-entity)', async (t) => {
        const { mirror, upstream } = await fetchBoth('/api/net?country=NL&limit=5&depth=0', t);
        const mirData = extractData(mirror.body, 'mirror net?country');
        const upData = extractData(upstream.body, 'upstream net?country');
        assert.ok(Math.abs(mirData.length - upData.length) <= 1,
            `Country filter count mismatch: mirror=${mirData.length} upstream=${upData.length}`);
    });

    it('?since= returns recently modified', async () => {
        const recentTs = Math.floor(Date.now() / 1000) - 86400;
        const res = await fetchMirror(`/api/net?since=${recentTs}&depth=0&limit=10`);
        assert.equal(res.status, 200);
        // Just verify the parameter is accepted; data may be empty
    });

    it('?status=deleted is accepted', async () => {
        const recentTs = Math.floor(Date.now() / 1000) - 604800;
        const res = await fetchMirror(`/api/net?status=deleted&since=${recentTs}&depth=0`);
        assert.equal(res.status, 200);
    });

    it('?limit=0 returns count', async () => {
        const res = await fetchMirror('/api/net?limit=0&skip=0&depth=0');
        assert.equal(res.status, 200);
        const body = res.body;
        assert.ok('meta' in body, 'count response should have meta');
        assert.ok(typeof body.meta.count === 'number', 'meta.count should be a number');
        assert.ok(body.meta.count > 0, 'net count should be > 0');
    });
});

// ==========================================================================
// SECTION 4 — DATA TYPE VALIDATION
// ==========================================================================

describe('Conformance: data types', { concurrency: 1 }, () => {
    it('net — info_prefixes4/6 are integers', async () => {
        const res = await fetchMirror(`/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`);
        const rec = extractData(res.body, 'net prefixes')[0];
        assert.equal(typeof rec.info_prefixes4, 'number');
        assert.equal(typeof rec.info_prefixes6, 'number');
    });

    it('netixlan — ipaddr4/6 are strings or null', async () => {
        const res = await fetchMirror(`/api/netixlan?asn=${WELL_KNOWN.asn_cloudflare}&limit=10&depth=0`);
        for (const rec of extractData(res.body, 'netixlan ips')) {
            for (const f of ['ipaddr4', 'ipaddr6']) {
                assert.ok(rec[f] === null || typeof rec[f] === 'string',
                    `${f} should be string|null, got ${typeof rec[f]}`);
            }
        }
    });

    it('netixlan — speed is integer', async () => {
        const res = await fetchMirror(`/api/netixlan?ix_id=${WELL_KNOWN.ix_amsix_id}&limit=10&depth=0`);
        for (const rec of extractData(res.body, 'netixlan speed')) {
            assert.equal(typeof rec.speed, 'number');
        }
    });

    it('netixlan — is_rs_peer is boolean', async () => {
        const res = await fetchMirror(`/api/netixlan?ix_id=${WELL_KNOWN.ix_amsix_id}&limit=10&depth=0`);
        for (const rec of extractData(res.body, 'netixlan booleans')) {
            assert.equal(typeof rec.is_rs_peer, 'boolean',
                `is_rs_peer should be boolean, got ${typeof rec.is_rs_peer} (${rec.is_rs_peer})`);
        }
    });

    it('net — boolean fields are booleans (not 0/1)', async () => {
        const res = await fetchMirror(`/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`);
        const rec = extractData(res.body, 'net booleans')[0];
        const boolFields = ['info_unicast', 'info_multicast', 'info_ipv6',
            'info_never_via_route_servers', 'policy_ratio', 'allow_ixp_update'];
        for (const f of boolFields) {
            if (f in rec) {
                assert.equal(typeof rec[f], 'boolean',
                    `${f} should be boolean, got ${typeof rec[f]} (${rec[f]})`);
            }
        }
    });

    it('fac — latitude/longitude are numbers or null', async () => {
        const res = await fetchMirror(`/api/fac/${WELL_KNOWN.fac_equinix_am5}?depth=0`);
        const rec = extractData(res.body, 'fac geo')[0];
        for (const f of ['latitude', 'longitude']) {
            assert.ok(rec[f] === null || typeof rec[f] === 'number',
                `${f} should be number|null, got ${typeof rec[f]}`);
        }
    });

    it('ixpfx — protocol is IPv4 or IPv6', async () => {
        const ixlanRes = await fetchMirror(`/api/ixlan?ix_id=${WELL_KNOWN.ix_decix_id}&depth=0`);
        const ixlans = extractData(ixlanRes.body, 'ixlan');
        if (ixlans.length === 0) return;

        const res = await fetchMirror(`/api/ixpfx?ixlan_id=${ixlans[0].id}&depth=0`);
        for (const rec of extractData(res.body, 'ixpfx protocol')) {
            assert.ok(['IPv4', 'IPv6'].includes(rec.protocol),
                `Unexpected protocol: ${rec.protocol}`);
        }
    });

    it('net — social_media is array', async () => {
        const res = await fetchMirror('/api/net?limit=1&depth=0');
        const rec = extractData(res.body, 'net social_media')[0];
        assert.ok(Array.isArray(rec.social_media),
            `social_media should be array, got ${typeof rec.social_media}`);
    });
});

// ==========================================================================
// SECTION 5 — CROSS-ENDPOINT CONSISTENCY
// ==========================================================================

describe('Conformance: cross-endpoint consistency', { concurrency: 1 }, () => {
    it('netixlan ix_ids exist in /ix', async () => {
        const res = await fetchMirror(`/api/netixlan?asn=${WELL_KNOWN.asn_cloudflare}&limit=5&depth=0`);
        const ixIds = new Set(extractData(res.body, 'netixlan').map(/** @param {any} r */ r => r.ix_id));
        const spotCheck = [...ixIds].slice(0, 3);

        for (const ixId of spotCheck) {
            const check = await fetchMirror(`/api/ix/${ixId}?depth=0`);
            assert.equal(check.status, 200, `ix/${ixId} returned ${check.status}`);
            assert.equal(extractData(check.body, `ix/${ixId}`).length, 1);
        }
    });

    it('netfac fac_ids exist in /fac', async () => {
        const res = await fetchMirror(`/api/netfac?local_asn=${WELL_KNOWN.asn_google}&limit=5&depth=0`);
        const facIds = new Set(extractData(res.body, 'netfac').map(/** @param {any} r */ r => r.fac_id));
        const spotCheck = [...facIds].slice(0, 3);

        for (const facId of spotCheck) {
            const check = await fetchMirror(`/api/fac/${facId}?depth=0`);
            assert.equal(check.status, 200, `fac/${facId} returned ${check.status}`);
        }
    });

    it('net_id from netixlan resolves to correct ASN', async () => {
        const res = await fetchMirror(`/api/netixlan?asn=${WELL_KNOWN.asn_netflix}&depth=0&limit=1`);
        const data = extractData(res.body, 'netixlan Netflix');
        if (data.length === 0) return;

        const netId = data[0].net_id;
        const netRes = await fetchMirror(`/api/net/${netId}?depth=0`);
        const netData = extractData(netRes.body, `net/${netId}`);
        assert.equal(netData[0].asn, WELL_KNOWN.asn_netflix);
    });
});

// ==========================================================================
// SECTION 6 — DATA VALUE COMPARISON
// ==========================================================================

describe('Conformance: value comparison', { concurrency: 1 }, () => {
    it('net — stable fields match upstream for Netflix', async (t) => {
        const { mirror, upstream } = await fetchBoth(`/api/net?asn=${WELL_KNOWN.asn_netflix}&depth=0`, t);
        const mirData = extractData(mirror.body, 'mirror Netflix');
        const upData = extractData(upstream.body, 'upstream Netflix');

        assert.equal(mirData.length, 1);
        assert.equal(upData.length, 1);

        const stableFields = ['asn', 'name', 'irr_as_set', 'info_type', 'policy_general'];
        const mismatches = [];
        for (const f of stableFields) {
            if (f in upData[0] && upData[0][f] !== mirData[0][f]) {
                mismatches.push(`  ${f}: upstream=${JSON.stringify(upData[0][f])} mirror=${JSON.stringify(mirData[0][f])}`);
            }
        }
        assert.deepStrictEqual(mismatches, [],
            `Stable field mismatches:\n${mismatches.join('\n')}`);
    });

    it('ix — AMS-IX data matches upstream', async (t) => {
        const { mirror, upstream } = await fetchBoth(`/api/ix/${WELL_KNOWN.ix_amsix_id}?depth=0`, t);
        const mirRec = extractData(mirror.body, 'mirror AMS-IX')[0];
        const upRec = extractData(upstream.body, 'upstream AMS-IX')[0];

        assert.equal(mirRec.id, WELL_KNOWN.ix_amsix_id);
        for (const f of ['name', 'country', 'region_continent', 'city']) {
            assert.equal(mirRec[f], upRec[f], `IX ${f}: mirror=${mirRec[f]} upstream=${upRec[f]}`);
        }
    });
});

// ==========================================================================
// SECTION 7 — ERROR HANDLING
// ==========================================================================

describe('Conformance: error handling', { concurrency: 1 }, () => {
    it('unknown endpoint returns 404', async () => {
        const res = await fetchMirror('/api/nonexistent_xyz');
        assert.ok([400, 404].includes(res.status));
    });

    it('invalid ASN filter does not crash', async () => {
        const res = await fetchMirror('/api/net?asn=notanumber&depth=0');
        assert.ok([200, 400].includes(res.status));
        if (res.status === 200) {
            assert.deepStrictEqual(res.body.data, []);
        }
    });

    it('negative limit handled', async () => {
        const res = await fetchMirror('/api/net?limit=-1&depth=0');
        assert.ok([200, 400].includes(res.status));
    });

    it('depth > 2 clamped or rejected', async () => {
        const res = await fetchMirror('/api/net?limit=1&depth=99');
        assert.ok([200, 400].includes(res.status));
    });

    it('asn=0 returns empty data', async () => {
        const res = await fetchMirror('/api/net?asn=0&depth=0');
        const body = res.body;
        assert.ok(body.data?.length === 0 || res.status === 404);
    });

    it('POST returns 501', async () => {
        const res = await fetchMirror('/api/net', { method: 'POST' });
        assert.equal(res.status, 501);
    });

    it('PUT returns 501', async () => {
        const res = await fetchMirror('/api/net/1', { method: 'PUT' });
        assert.equal(res.status, 501);
    });

    it('DELETE returns 501', async () => {
        const res = await fetchMirror('/api/net/1', { method: 'DELETE' });
        assert.equal(res.status, 501);
    });

    it('CORS preflight returns 204', async () => {
        const res = await fetch(`${PDBFE}/api/net`, { method: 'OPTIONS' });
        assert.equal(res.status, 204);
        assert.ok(res.headers.get('access-control-allow-origin'));
    });
});

// ==========================================================================
// SECTION 8 — AS_SET ENDPOINT
// ==========================================================================

describe('Conformance: as_set', { concurrency: 1 }, () => {
    it('/api/as_set/{asn} returns irr_as_set', async () => {
        const res = await fetchMirror(`/api/as_set/${WELL_KNOWN.asn_cloudflare}`);
        assert.equal(res.status, 200);
        const data = extractData(res.body, 'as_set');
        assert.equal(data.length, 1);
        assert.ok('irr_as_set' in data[0], 'Missing irr_as_set field');
    });

    it('/api/as_set/invalid — returns 400', async () => {
        const res = await fetchMirror('/api/as_set/abc');
        assert.equal(res.status, 400);
    });

    it('/api/as_set/999999999 — returns 404', async () => {
        const res = await fetchMirror('/api/as_set/999999999');
        assert.equal(res.status, 404);
    });
});

// ==========================================================================
// SECTION 9 — DIVERGENCE EDGE CASES
// ==========================================================================

describe('Conformance: divergence edge cases', { concurrency: 1 }, () => {

    // ── Default depth ────────────────────────────────────────────────────
    it('default depth (no param) matches depth=0', async () => {
        const noDepth = await fetchMirror(`/api/net?asn=${WELL_KNOWN.asn_cloudflare}`);
        const depth0 = await fetchMirror(`/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`);
        const noDepthData = extractData(noDepth.body, 'net no-depth');
        const depth0Data = extractData(depth0.body, 'net depth=0');

        if (noDepthData.length === 0) return;

        // Should have identical key sets (no _set fields)
        const noDepthKeys = Object.keys(noDepthData[0]).sort();
        const depth0Keys = Object.keys(depth0Data[0]).sort();
        assert.deepStrictEqual(noDepthKeys, depth0Keys,
            'Default depth should produce same fields as depth=0');
    });

    // ── Default sort order ───────────────────────────────────────────────
    it('default sort order is ascending by id', async (t) => {
        const { mirror, upstream } = await fetchBoth('/api/net?limit=5&depth=0', t);
        const upIds = extractData(upstream.body, 'upstream').map(r => r.id);
        const mirIds = extractData(mirror.body, 'mirror').map(r => r.id);

        // Both should be sorted ascending — exact IDs may differ
        // due to deleted records being present in the mirror's D1
        const mirSorted = [...mirIds].sort((a, b) => a - b);
        const upSorted = [...upIds].sort((a, b) => a - b);
        assert.deepStrictEqual(mirIds, mirSorted, 'Mirror should sort by id ASC');
        assert.deepStrictEqual(upIds, upSorted, 'Upstream should sort by id ASC');
    });

    // ── Case-insensitive string filters ──────────────────────────────────
    it('?name= filter is case-insensitive (MySQL parity)', async (t) => {
        // Upstream MySQL uses case-insensitive collation; mirror must match
        const { mirror, upstream } = await fetchBoth(
            '/api/net?name=cloudflare&limit=1&depth=0', t
        );
        const upData = extractData(upstream.body, 'upstream');
        const mirData = extractData(mirror.body, 'mirror');

        assert.equal(mirData.length, upData.length,
            `Case-insensitive filter: mirror=${mirData.length} results, upstream=${upData.length}`);
        if (upData.length > 0) {
            assert.equal(mirData[0].name, upData[0].name);
        }
    });

    it('?name__contains= is case-insensitive', async (t) => {
        const { mirror, upstream } = await fetchBoth(
            '/api/ix?name__contains=ams-ix&limit=1&depth=0', t
        );
        const upData = extractData(upstream.body, 'upstream');
        const mirData = extractData(mirror.body, 'mirror');

        assert.equal(mirData.length, upData.length,
            `Case-insensitive contains: mirror=${mirData.length}, upstream=${upData.length}`);
    });

    // ── Duplicate query parameters ───────────────────────────────────────
    it('duplicate params — last value wins (Django parity)', async (t) => {
        // Django's QueryDict.get() returns the last value for a repeated key
        const { mirror, upstream } = await fetchBoth(
            `/api/net?asn=${WELL_KNOWN.asn_cloudflare}&asn=${WELL_KNOWN.asn_netflix}&limit=1&depth=0`, t
        );
        const upData = extractData(upstream.body, 'upstream');
        const mirData = extractData(mirror.body, 'mirror');

        assert.equal(mirData.length, upData.length,
            'Duplicate param should return same count');
        if (upData.length > 0 && mirData.length > 0) {
            assert.equal(mirData[0].asn, upData[0].asn,
                'Duplicate param: mirror and upstream should resolve to same ASN');
        }
    });

    // ── Date format ──────────────────────────────────────────────────────
    it('created/updated date format matches upstream', async (t) => {
        const { mirror, upstream } = await fetchBoth(
            `/api/net?asn=${WELL_KNOWN.asn_cloudflare}&limit=1&depth=0`, t
        );
        const upRow = extractData(upstream.body, 'upstream')[0];
        const mirRow = extractData(mirror.body, 'mirror')[0];
        if (!upRow || !mirRow) return;

        // Should be ISO 8601: 2024-01-01T00:00:00Z
        assert.equal(mirRow.created, upRow.created,
            `created mismatch: mirror=${mirRow.created}, upstream=${upRow.created}`);
    });

    // ── Depth=2 FK exclusion ─────────────────────────────────────────────
    it('depth=2 child objects exclude parent FK', async () => {
        const res = await fetchMirror(
            `/api/net?asn=${WELL_KNOWN.asn_cloudflare}&limit=1&depth=2`
        );
        const data = extractData(res.body, 'net depth=2');
        if (data.length === 0) return;

        const row = data[0];
        if (row.netfac_set && row.netfac_set.length > 0) {
            assert.equal(row.netfac_set[0].net_id, undefined,
                'netfac_set child should not contain net_id at depth=2');
        }
        if (row.poc_set && row.poc_set.length > 0) {
            assert.equal(row.poc_set[0].net_id, undefined,
                'poc_set child should not contain net_id at depth=2');
        }
    });

    // ── Empty string vs null ─────────────────────────────────────────────
    it('nullable field types match upstream', async (t) => {
        const { mirror, upstream } = await fetchBoth(
            `/api/net?asn=${WELL_KNOWN.asn_cloudflare}&limit=1&depth=0`, t
        );
        const upRow = extractData(upstream.body, 'upstream')[0];
        const mirRow = extractData(mirror.body, 'mirror')[0];
        if (!upRow || !mirRow) return;

        // Check that for each field, null/non-null matches
        const mismatches = [];
        for (const key of Object.keys(upRow)) {
            const upNull = upRow[key] === null;
            const mirNull = mirRow[key] === null;
            if (upNull !== mirNull) {
                mismatches.push(`${key}: upstream=${upRow[key]}, mirror=${mirRow[key]}`);
            }
        }
        assert.deepStrictEqual(mismatches, [],
            `Null/non-null mismatches:\n${mismatches.join('\n')}`);
    });
});

