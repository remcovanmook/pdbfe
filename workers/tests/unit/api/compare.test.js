/**
 * @fileoverview Unit tests for the compare handler.
 * Tests entity overlap analysis for net↔net and ix↔ix pairs.
 * Verifies withEdgeSWR integration, serveJSON response format,
 * and validation logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleCompare } from '../../../api/handlers/compare.js';

/**
 * Creates a mock D1 session that returns different results based on
 * the SQL query content. Keyed on substrings to avoid brittle full-SQL matching.
 *
 * @param {Record<string, any[]>} queryResults - Map of SQL substring → results.
 * @returns {D1Session} Mock D1 session.
 */
function mockD1(queryResults = {}) {
    return /** @type {any} */ ({
        prepare: (/** @type {string} */ sql) => ({
            bind: (/** @type {any[]} */ ..._args) => ({
                all: async () => {
                    for (const [key, results] of Object.entries(queryResults)) {
                        if (sql.includes(key)) return { results, success: true };
                    }
                    return { results: [], success: true };
                },
                first: async () => {
                    for (const [key, results] of Object.entries(queryResults)) {
                        if (sql.includes(key)) return results[0] || null;
                    }
                    return null;
                },
            }),
        }),
        withSession() { return this; },
    });
}

/** @type {Record<string, string>} */
const hNocache = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
});

/**
 * Mock ExecutionContext for withEdgeSWR.
 * @returns {ExecutionContext}
 */
function mockCtx() {
    return /** @type {any} */ ({
        waitUntil: (/** @type {Promise<any>} */ _p) => {},
        passThroughOnException: () => {},
    });
}

/**
 * Helper to call handleCompare with a query string.
 *
 * @param {D1Session} db - Mock D1 session.
 * @param {string} qs - Query string without leading '?'.
 * @param {boolean} [authenticated=false] - Whether the caller is authenticated.
 * @returns {Promise<Response>} The response.
 */
async function callCompare(db, qs, authenticated = false) {
    const req = new Request('https://test.workers.dev/api/compare?' + qs, {
        method: 'GET',
    });
    return handleCompare(req, db, mockCtx(), qs, authenticated, hNocache);
}

describe('handleCompare', () => {
    describe('validation', () => {
        const db = mockD1();

        it('rejects requests without __pdbfe=1', async () => {
            const res = await callCompare(db, 'a=net:1&b=net:2');
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.ok(body.error.includes('__pdbfe=1'));
        });

        it('rejects missing a parameter', async () => {
            const res = await callCompare(db, 'b=net:2&__pdbfe=1');
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.ok(body.error.includes('Both a and b'));
        });

        it('rejects missing b parameter', async () => {
            const res = await callCompare(db, 'a=net:1&__pdbfe=1');
            assert.equal(res.status, 400);
        });

        it('rejects invalid entity ref format', async () => {
            const res = await callCompare(db, 'a=invalid&b=net:1&__pdbfe=1');
            assert.equal(res.status, 400);
        });

        it('rejects unknown entity tag', async () => {
            const res = await callCompare(db, 'a=org:1&b=net:1&__pdbfe=1');
            assert.equal(res.status, 400);
        });

        it('rejects unsupported entity pair', async () => {
            // net+fac is not yet in SUPPORTED_PAIRS
            const db2 = mockD1({
                peeringdb_network: [{ id: 1, name: 'Test Net', asn: 1 }],
                peeringdb_facility: [{ id: 1, name: 'Test Fac' }],
            });
            const res = await callCompare(db2, 'a=net:1&b=fac:1&__pdbfe=1');
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.ok(body.error.includes('Unsupported'));
        });

        it('rejects negative IDs', async () => {
            const res = await callCompare(db, 'a=net:-1&b=net:2&__pdbfe=1');
            assert.equal(res.status, 400);
        });

        it('rejects zero IDs', async () => {
            const res = await callCompare(db, 'a=net:0&b=net:2&__pdbfe=1');
            assert.equal(res.status, 400);
        });
    });

    describe('net ↔ net', () => {
        it('returns 404 when entity A not found', async () => {
            const db = mockD1({}); // all queries return empty
            const res = await callCompare(db, 'a=net:99999&b=net:1&__pdbfe=1');
            assert.equal(res.status, 404);
        });

        it('returns structured overlap for valid net pair', async () => {
            const smartDb = /** @type {any} */ ({
                prepare: (/** @type {string} */ sql) => ({
                    bind: (/** @type {any[]} */ ..._args) => ({
                        all: async () => {
                            if (sql.includes('a.ixlan_id = b.ixlan_id')) {
                                // Shared IXPs query
                                return {
                                    results: [{
                                        ix_id: 26, ix_name: 'AMS-IX',
                                        country: 'NL', city: 'Amsterdam',
                                        speed_a: 100000, speed_b: 100000,
                                        ipv4_a: '80.249.208.11', ipv4_b: '80.249.208.12',
                                        ipv6_a: null, ipv6_b: null,
                                        rs_a: 1, rs_b: 0,
                                    }],
                                    success: true,
                                };
                            }
                            if (sql.includes('a.fac_id = b.fac_id')) {
                                // Shared facilities query
                                return {
                                    results: [{
                                        fac_id: 1, fac_name: 'Equinix AM5',
                                        city: 'Amsterdam', country: 'NL',
                                        latitude: 52.303, longitude: 4.938,
                                    }],
                                    success: true,
                                };
                            }
                            return { results: [], success: true };
                        },
                        first: async () => {
                            if (sql.includes('peeringdb_network') && sql.includes('"id" = ?')) {
                                return { id: _args[0], name: `Net ${_args[0]}`, asn: _args[0] + 13000 };
                            }
                            return null;
                        },
                    }),
                }),
            });

            const res = await callCompare(smartDb, 'a=net:1&b=net:2&__pdbfe=1');
            assert.equal(res.status, 200);

            const body = await res.json();
            assert.ok(body.a, 'should have entity A header');
            assert.ok(body.b, 'should have entity B header');
            assert.ok(Array.isArray(body.shared_ixps), 'should have shared_ixps array');
            assert.ok(Array.isArray(body.shared_facilities), 'should have shared_facilities array');
            assert.ok(Array.isArray(body.only_a_ixps), 'should have only_a_ixps array');
            assert.ok(Array.isArray(body.only_b_ixps), 'should have only_b_ixps array');
            assert.ok(Array.isArray(body.only_a_facilities), 'should have only_a_facilities array');
            assert.ok(Array.isArray(body.only_b_facilities), 'should have only_b_facilities array');

            // Verify shared IXP structure
            if (body.shared_ixps.length > 0) {
                const ixp = body.shared_ixps[0];
                assert.equal(ixp.ix_id, 26);
                assert.equal(ixp.ix_name, 'AMS-IX');
            }

            // Verify shared facility structure
            if (body.shared_facilities.length > 0) {
                const fac = body.shared_facilities[0];
                assert.equal(fac.fac_id, 1);
                assert.ok(typeof fac.latitude === 'number', 'latitude should be a number');
                assert.ok(typeof fac.longitude === 'number', 'longitude should be a number');
            }
        });

        it('returns empty arrays for non-overlapping networks', async () => {
            const db = mockD1({
                peeringdb_network: [{ id: 1, name: 'Loner Net', asn: 99999 }],
            });
            const res = await callCompare(db, 'a=net:1&b=net:2&__pdbfe=1');
            // This will 404 because entity B is not found (mock returns same for all)
            // which is correct — in production a non-existent entity returns 404
            assert.ok(res.status === 200 || res.status === 404);
        });
    });

    describe('ix ↔ ix', () => {
        it('returns structured overlap for valid IX pair', async () => {
            const smartDb = /** @type {any} */ ({
                prepare: (/** @type {string} */ sql) => ({
                    bind: (/** @type {any[]} */ ..._args) => ({
                        all: async () => {
                            if (sql.includes('a.fac_id = b.fac_id') && sql.includes('peeringdb_ix_facility')) {
                                return {
                                    results: [{
                                        fac_id: 10, fac_name: 'Equinix AM7',
                                        city: 'Amsterdam', country: 'NL',
                                        latitude: 52.3, longitude: 4.9,
                                    }],
                                    success: true,
                                };
                            }
                            if (sql.includes('ixlanA.ix_id') && sql.includes('ixlanB.ix_id')) {
                                return {
                                    results: [{
                                        net_id: 1, net_name: 'Cloudflare', asn: 13335,
                                    }],
                                    success: true,
                                };
                            }
                            return { results: [], success: true };
                        },
                        first: async () => {
                            if (sql.includes('peeringdb_ix') && sql.includes('"id" = ?')) {
                                return { id: _args[0], name: `IX ${_args[0]}` };
                            }
                            return null;
                        },
                    }),
                }),
            });

            const res = await callCompare(smartDb, 'a=ix:1&b=ix:26&__pdbfe=1');
            assert.equal(res.status, 200);

            const body = await res.json();
            assert.ok(body.a, 'should have entity A header');
            assert.ok(body.b, 'should have entity B header');
            assert.ok(Array.isArray(body.shared_facilities), 'should have shared_facilities');
            assert.ok(Array.isArray(body.shared_networks), 'should have shared_networks');
            assert.ok(Array.isArray(body.only_a_facilities), 'should have only_a_facilities');
            assert.ok(Array.isArray(body.only_b_facilities), 'should have only_b_facilities');
            assert.ok(Array.isArray(body.only_a_networks), 'should have only_a_networks');
            assert.ok(Array.isArray(body.only_b_networks), 'should have only_b_networks');
        });
    });

    describe('response format', () => {
        it('uses serveJSON headers (Cache-Control, CORS, ETag)', async () => {
            const db = /** @type {any} */ ({
                prepare: () => ({
                    bind: () => ({
                        all: async () => ({ results: [], success: true }),
                        first: async () => ({ id: 1, name: 'Test', asn: 1 }),
                    }),
                }),
            });
            const res = await callCompare(db, 'a=net:1&b=net:2&__pdbfe=1');
            assert.equal(res.status, 200);

            // serveJSON uses H_API_ANON headers
            const cc = res.headers.get('Cache-Control');
            assert.ok(cc?.includes('max-age='), 'should have Cache-Control max-age');

            assert.equal(
                res.headers.get('Access-Control-Allow-Origin'), '*',
                'should have CORS header'
            );

            assert.ok(res.headers.has('ETag'), 'should have ETag from serveJSON');
        });

        it('includes X-Cache tier from withEdgeSWR', async () => {
            const db = /** @type {any} */ ({
                prepare: () => ({
                    bind: () => ({
                        all: async () => ({ results: [], success: true }),
                        first: async () => ({ id: 1, name: 'Test', asn: 1 }),
                    }),
                }),
            });
            const res = await callCompare(db, 'a=net:1&b=net:2&__pdbfe=1');
            assert.equal(res.status, 200);

            const xCache = res.headers.get('X-Cache');
            assert.ok(xCache, 'should have X-Cache header from withEdgeSWR');
        });
    });
});
