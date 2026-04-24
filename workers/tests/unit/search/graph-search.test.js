/**
 * @fileoverview Unit tests for query-parser.js and graph-search.js.
 *
 * Covers the graph-structural search pipeline:
 *   - parseQuery: all predicate types — ASN, infoType, region, country, city,
 *     similarToName, traversalIntent, raw fallback, and combinations.
 *   - executeGraphSearch: ASN lookup, similarity search (with Vectorize),
 *     named-entity traversal (all 7 edge types), metadata filters, and keyword
 *     fallback. Also verifies priority ordering between paths.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../../../search/handlers/query-parser.js';
import { executeGraphSearch } from '../../../search/handlers/graph-search.js';

// ── Mock factories ────────────────────────────────────────────────────────────

/**
 * Builds a D1 mock whose response is determined by a user-supplied handler.
 *
 * The handler receives (sql, bindings) and must return a Promise resolving to
 * a D1Result-like object `{ success: boolean, results: object[] }`.
 *
 * @param {function(string, any[]): Promise<{success: boolean, results: object[]}>} handler
 * @returns {D1Database}
 */
function makeDB(handler) {
    return /** @type {any} */ ({
        withSession() { return this; },
        prepare(sql) {
            return {
                bind(...args) {
                    return {
                        all:   () => handler(sql, args),
                        first: () => handler(sql, args).then(r => r.results?.[0] ?? null),
                    };
                },
            };
        },
    });
}

/** Successful D1 result with rows. */
const ok    = (rows) => Promise.resolve({ success: true,  results: rows });
/** Empty D1 result. */
const empty = ()     => Promise.resolve({ success: true,  results: [] });

/**
 * Builds a Vectorize mock.
 *
 * @param {{ storedVector?: number[]|null, knnMatches?: {id:string,score:number}[] }} opts
 * @returns {any}
 */
function makeVectorize({ storedVector = null, knnMatches = [] } = {}) {
    return /** @type {any} */ ({
        getByIds: async (ids) => storedVector ? [{ id: ids[0], values: storedVector }] : [],
        query:    async ()     => ({ matches: knnMatches }),
    });
}

/** A no-op DB — every query returns empty. */
const emptyDB = makeDB(() => empty());

// ── parseQuery ────────────────────────────────────────────────────────────────

describe('parseQuery — ASN extraction', () => {
    it('extracts ASN from "AS13335"', () => {
        const p = parseQuery('AS13335');
        assert.equal(p.asn, 13335);
    });

    it('extracts ASN from "ASN 15169"', () => {
        const p = parseQuery('ASN 15169');
        assert.equal(p.asn, 15169);
    });

    it('extracts ASN from lowercase "as 7922"', () => {
        const p = parseQuery('as 7922');
        assert.equal(p.asn, 7922);
    });

    it('returns immediately on ASN — all other predicates are null', () => {
        const p = parseQuery('AS13335 CDN networks in Germany');
        assert.equal(p.asn, 13335);
        assert.equal(p.country, null);
        assert.equal(p.infoType, null);
        assert.equal(p.city, null);
    });

    it('preserves raw query string', () => {
        const p = parseQuery('AS13335');
        assert.equal(p.raw, 'AS13335');
    });
});

describe('parseQuery — infoType extraction', () => {
    it('extracts CDN → Content', () => {
        assert.equal(parseQuery('CDN networks').infoType, 'Content');
    });

    it('extracts transit → NSP', () => {
        assert.equal(parseQuery('transit providers in Europe').infoType, 'NSP');
    });

    it('extracts "tier 1" → NSP', () => {
        assert.equal(parseQuery('tier 1 carriers').infoType, 'NSP');
    });

    it('extracts enterprise → Enterprise', () => {
        assert.equal(parseQuery('enterprise networks').infoType, 'Enterprise');
    });

    it('extracts colocation → Hosting and Co-Location', () => {
        assert.equal(parseQuery('colocation facilities').infoType, 'Hosting and Co-Location');
    });

    it('extracts route server → Route Server', () => {
        assert.equal(parseQuery('route server operators').infoType, 'Route Server');
    });

    it('returns null for plain entity query', () => {
        assert.equal(parseQuery('Cloudflare').infoType, null);
    });
});

describe('parseQuery — region extraction', () => {
    it('extracts "europe" → Europe', () => {
        assert.equal(parseQuery('networks in europe').regionContinent, 'Europe');
    });

    it('extracts "apac" → Asia Pacific', () => {
        assert.equal(parseQuery('apac exchanges').regionContinent, 'Asia Pacific');
    });

    it('extracts "north america" → North America', () => {
        assert.equal(parseQuery('north america transit').regionContinent, 'North America');
    });

    it('extracts "middle east" → Middle East', () => {
        assert.equal(parseQuery('middle east ISPs').regionContinent, 'Middle East');
    });

    it('suppresses country extraction when region is matched', () => {
        // "european" matches region; 'germany' in query should NOT also set country
        const p = parseQuery('European CDN networks germany');
        assert.equal(p.regionContinent, 'Europe');
        assert.equal(p.country, null);
    });
});

describe('parseQuery — country extraction', () => {
    it('extracts country from preposition phrase "in Germany"', () => {
        assert.equal(parseQuery('networks in Germany').country, 'DE');
    });

    it('extracts country from "in Netherlands"', () => {
        assert.equal(parseQuery('IXes in Netherlands').country, 'NL');
    });

    it('extracts country from "from Japan"', () => {
        assert.equal(parseQuery('networks from Japan').country, 'JP');
    });

    it('extracts country from standalone country name (4+ chars, no preposition)', () => {
        // Short codes like 'us'/'uk' are skipped to reduce false positives.
        // 'netherlands' (11 chars) is in the country table and not a region key.
        assert.equal(parseQuery('networks netherlands').country, 'NL');
    });

    it('returns null for unrecognised country', () => {
        assert.equal(parseQuery('networks in Narnia').country, null);
    });
});

describe('parseQuery — city extraction', () => {
    it('extracts city from "in Amsterdam"', () => {
        assert.equal(parseQuery('facilities in Amsterdam').city, 'Amsterdam');
    });

    it('extracts city from "at Frankfurt"', () => {
        assert.equal(parseQuery('exchanges at Frankfurt').city, 'Frankfurt');
    });

    it('extracts multi-word city from "in New York"', () => {
        assert.equal(parseQuery('facilities in New York').city, 'New York');
    });

    it('returns null when no location preposition present', () => {
        assert.equal(parseQuery('Cloudflare network').city, null);
    });
});

describe('parseQuery — similarToName extraction', () => {
    it('extracts name from "similar to Cloudflare"', () => {
        const p = parseQuery('similar to Cloudflare');
        assert.equal(p.similarToName, 'Cloudflare');
        assert.equal(p.anchorName, null);
    });

    it('extracts name from "like AMS-IX"', () => {
        assert.equal(parseQuery('like AMS-IX').similarToName, 'AMS-IX');
    });

    it('returns early on similarToName — traversal fields remain null', () => {
        const p = parseQuery('similar to Cloudflare');
        assert.equal(p.traversalIntent, null);
    });
});

describe('parseQuery — traversal extraction', () => {
    it('"networks at AMS-IX" → anchorName=AMS-IX, traversalIntent=networks_at', () => {
        const p = parseQuery('networks at AMS-IX');
        assert.equal(p.anchorName, 'AMS-IX');
        assert.equal(p.traversalIntent, 'networks_at');
    });

    it('"facilities at Equinix" → traversalIntent=facilities_at', () => {
        const p = parseQuery('facilities at Equinix');
        assert.equal(p.traversalIntent, 'facilities_at');
        assert.equal(p.anchorName, 'Equinix');
    });

    it('"exchanges at Equinix NY4" → traversalIntent=exchanges_at', () => {
        const p = parseQuery('exchanges at Equinix NY4');
        assert.equal(p.traversalIntent, 'exchanges_at');
    });

    it('"peers of AMS-IX" → anchorName=AMS-IX, default traversalIntent=networks_at', () => {
        const p = parseQuery('peers of AMS-IX');
        assert.equal(p.anchorName, 'AMS-IX');
        assert.equal(p.traversalIntent, 'networks_at');
    });

    it('"connected to AMS-IX" → traversalIntent=networks_at', () => {
        const p = parseQuery('connected to AMS-IX');
        assert.equal(p.anchorName, 'AMS-IX');
        assert.equal(p.traversalIntent, 'networks_at');
    });
});

describe('parseQuery — keyword fallback', () => {
    it('plain text sets raw and leaves all predicates null', () => {
        const p = parseQuery('cloudflare');
        assert.equal(p.raw, 'cloudflare');
        assert.equal(p.asn, null);
        assert.equal(p.country, null);
        assert.equal(p.city, null);
        assert.equal(p.regionContinent, null);
        assert.equal(p.infoType, null);
        assert.equal(p.similarToName, null);
        assert.equal(p.anchorName, null);
        assert.equal(p.traversalIntent, null);
    });

    it('combination: "CDN networks in Germany" → infoType + country', () => {
        const p = parseQuery('CDN networks in Germany');
        assert.equal(p.infoType, 'Content');
        assert.equal(p.country, 'DE');
        assert.equal(p.asn, null);
    });

    it('combination: "transit in Europe" → infoType + region', () => {
        const p = parseQuery('transit in Europe');
        assert.equal(p.infoType, 'NSP');
        assert.equal(p.regionContinent, 'Europe');
    });
});

// ── executeGraphSearch ────────────────────────────────────────────────────────

describe('executeGraphSearch — ASN path', () => {
    it('routes ASN query to exact D1 asn lookup and returns ID', async () => {
        const db = makeDB((sql, args) => {
            if (sql.includes('asn = ?')) return ok([{ id: 13335 }]);
            return empty();
        });
        const result = await executeGraphSearch('AS13335', 'net', db, null);
        assert.equal(result, '13335');
    });

    it('returns null for ASN lookup on non-net entity (net-only field)', async () => {
        // lookupByAsn returns null for non-net entities, falls to keyword fallback
        const db = makeDB(() => empty());
        const result = await executeGraphSearch('AS13335', 'ix', db, null);
        // keyword fallback also finds nothing → null
        assert.equal(result, null);
    });

    it('falls through to keyword fallback when ASN not found in D1', async () => {
        let keywordCalled = false;
        const db = makeDB((sql, args) => {
            if (sql.includes('asn = ?')) return empty();
            if (sql.includes('name LIKE ?') || sql.includes('aka LIKE ?')) {
                keywordCalled = true;
                return ok([{ id: 99 }]);
            }
            return empty();
        });
        const result = await executeGraphSearch('AS99999', 'net', db, null);
        assert.ok(keywordCalled, 'keyword fallback should be called when ASN lookup misses');
        assert.equal(result, '99');
    });
});

describe('executeGraphSearch — keyword fallback', () => {
    it('performs LIKE search when query has no recognised predicates', async () => {
        const db = makeDB((sql) => {
            if (sql.includes('name LIKE') && sql.includes('aka LIKE')) {
                return ok([{ id: 1 }, { id: 2 }]);
            }
            return empty();
        });
        const result = await executeGraphSearch('cloudflare', 'net', db, null);
        assert.equal(result, '1,2');
    });

    it('returns null when keyword search finds no rows', async () => {
        const result = await executeGraphSearch('xyzzy-no-match', 'net', emptyDB, null);
        assert.equal(result, null);
    });

    it('returns CSV IDs in DB result order', async () => {
        const db = makeDB((sql) => {
            if (sql.includes('name LIKE')) return ok([{ id: 10 }, { id: 20 }, { id: 30 }]);
            return empty();
        });
        const result = await executeGraphSearch('test', 'fac', db, null);
        assert.equal(result, '10,20,30');
    });
});

describe('executeGraphSearch — metadata filter path', () => {
    it('filters by country when country predicate present', async () => {
        let sawCountry = false;
        const db = makeDB((sql, args) => {
            if (sql.includes('country = ?')) {
                sawCountry = true;
                return ok([{ id: 5 }]);
            }
            return empty();
        });
        const result = await executeGraphSearch('networks in Germany', 'net', db, null);
        assert.ok(sawCountry, 'should issue country = ? filter');
        assert.equal(result, '5');
    });

    it('filters by city with LIKE when city predicate present', async () => {
        let sawCity = false;
        const db = makeDB((sql) => {
            if (sql.includes('city LIKE ?')) {
                sawCity = true;
                return ok([{ id: 7 }]);
            }
            return empty();
        });
        const result = await executeGraphSearch('facilities in Amsterdam', 'fac', db, null);
        assert.ok(sawCity, 'should issue city LIKE ? filter');
        assert.equal(result, '7');
    });

    it('filters by info_type for net entity', async () => {
        let sawInfoType = false;
        const db = makeDB((sql) => {
            if (sql.includes('info_type = ?')) {
                sawInfoType = true;
                return ok([{ id: 3 }]);
            }
            return empty();
        });
        const result = await executeGraphSearch('CDN networks', 'net', db, null);
        assert.ok(sawInfoType, 'should issue info_type = ? for net');
        assert.equal(result, '3');
    });

    it('does not add info_type filter for non-net entities', async () => {
        let sawInfoType = false;
        const db = makeDB((sql) => {
            if (sql.includes('info_type = ?')) sawInfoType = true;
            return ok([{ id: 1 }]);
        });
        await executeGraphSearch('CDN networks in Frankfurt', 'fac', db, null);
        assert.ok(!sawInfoType, 'info_type should not filter non-net entities');
    });

    it('filters by region_continent when region predicate present', async () => {
        let sawRegion = false;
        const db = makeDB((sql) => {
            if (sql.includes('region_continent = ?')) {
                sawRegion = true;
                return ok([{ id: 9 }]);
            }
            return empty();
        });
        const result = await executeGraphSearch('European IXes', 'ix', db, null);
        assert.ok(sawRegion, 'should issue region_continent = ? filter');
        assert.equal(result, '9');
    });

    it('falls through to keyword when metadata filter finds nothing', async () => {
        let keywordCalled = false;
        const db = makeDB((sql) => {
            if (sql.includes('region_continent = ?') || sql.includes('country = ?')) return empty();
            if (sql.includes('name LIKE')) { keywordCalled = true; return ok([{ id: 42 }]); }
            return empty();
        });
        await executeGraphSearch('European networks', 'net', db, null);
        assert.ok(keywordCalled, 'should fall through to keyword when filter empty');
    });
});

describe('executeGraphSearch — traversal path', () => {
    /**
     * Returns a DB mock that resolves anchorName by exact-match on a given
     * entity table, then returns rows for the subsequent traversal query.
     *
     * @param {string} anchorTable - Table the anchor is resolved from.
     * @param {number} anchorId    - ID to return for the anchor.
     * @param {string} traversalTable - Table the traversal query hits.
     * @param {number[]} resultIds - IDs returned by the traversal.
     */
    function makeTraversalDB(anchorTable, anchorId, traversalTable, resultIds) {
        return makeDB((sql) => {
            if (sql.includes(anchorTable) && sql.includes('WHERE name =')) {
                return ok([{ id: anchorId }]);
            }
            if (sql.includes(traversalTable) && !sql.includes('WHERE name =')) {
                return ok(resultIds.map(id => ({ id })));
            }
            return empty();
        });
    }

    it('ix anchor → net: queries peeringdb_network_ixlan for ix_id', async () => {
        const db = makeTraversalDB(
            'peeringdb_ix', 5,
            'peeringdb_network_ixlan', [10, 11],
        );
        const result = await executeGraphSearch('networks at AMS-IX', 'net', db, null);
        assert.equal(result, '10,11');
    });

    it('fac anchor → net: queries peeringdb_network_facility for fac_id', async () => {
        const db = makeTraversalDB(
            'peeringdb_facility', 20,
            'peeringdb_network_facility', [30, 31],
        );
        const result = await executeGraphSearch('networks at Equinix', 'net', db, null);
        assert.equal(result, '30,31');
    });

    it('ix anchor → fac: queries peeringdb_ix_facility for ix_id', async () => {
        const db = makeTraversalDB(
            'peeringdb_ix', 5,
            'peeringdb_ix_facility', [40, 41],
        );
        const result = await executeGraphSearch('facilities at AMS-IX', 'fac', db, null);
        assert.equal(result, '40,41');
    });

    it('fac anchor → ix: queries peeringdb_ix_facility for fac_id', async () => {
        const db = makeTraversalDB(
            'peeringdb_facility', 20,
            'peeringdb_ix_facility', [50],
        );
        const result = await executeGraphSearch('exchanges at Equinix', 'ix', db, null);
        assert.equal(result, '50');
    });

    it('net anchor → ix: queries peeringdb_network_ixlan for net_id', async () => {
        const db = makeTraversalDB(
            'peeringdb_network', 694,
            'peeringdb_network_ixlan', [60, 61],
        );
        // parseQuery for "IXes peering with Cloudflare" → anchorName=Cloudflare, traversalIntent=networks_at (default)
        // We need the target entity to be ix and the query to trigger traversal
        // Use a query that resolves net → ix traversal
        const result = await executeGraphSearch('exchanges peering with Cloudflare', 'ix', db, null);
        // anchorName='Cloudflare', resolves as net → peeringdb_network_ixlan net_id=694
        assert.equal(result, '60,61');
    });

    it('net anchor → fac: queries peeringdb_network_facility for net_id', async () => {
        const db = makeTraversalDB(
            'peeringdb_network', 694,
            'peeringdb_network_facility', [70, 71],
        );
        const result = await executeGraphSearch('facilities peering with Cloudflare', 'fac', db, null);
        assert.equal(result, '70,71');
    });

    it('campus anchor → fac: queries peeringdb_facility for campus_id', async () => {
        const db = makeTraversalDB(
            'peeringdb_campus', 3,
            'peeringdb_facility', [80, 81, 82],
        );
        const result = await executeGraphSearch('facilities at Campus3', 'fac', db, null);
        assert.equal(result, '80,81,82');
    });

    it('falls through to keyword when anchor not found in D1', async () => {
        let keywordCalled = false;
        const db = makeDB((sql) => {
            if (sql.includes('name LIKE') && sql.includes('aka LIKE')) {
                keywordCalled = true;
                return ok([{ id: 99 }]);
            }
            return empty(); // name resolution always fails
        });
        await executeGraphSearch('networks at NonExistentExchange', 'net', db, null);
        assert.ok(keywordCalled, 'keyword fallback should fire when anchor not found');
    });

    it('falls through to keyword when traversal combination unsupported', async () => {
        // ix → campus is not a supported traversal combination
        let keywordCalled = false;
        const db = makeDB((sql) => {
            if (sql.includes('peeringdb_ix') && sql.includes('WHERE name =')) {
                return ok([{ id: 5 }]); // anchor resolves
            }
            if (sql.includes('name LIKE') && sql.includes('aka LIKE')) {
                keywordCalled = true;
                return ok([{ id: 1 }]);
            }
            return empty();
        });
        await executeGraphSearch('facilities at AMS-IX', 'campus', db, null);
        assert.ok(keywordCalled, 'should fall through to keyword for unsupported traversal');
    });
});

describe('executeGraphSearch — similarity path', () => {
    it('uses vectorize.getByIds and query when similarToName present', async () => {
        let getByIdsCalled = false;
        let queryCalled    = false;

        const db = makeDB((sql) => {
            // resolveNameToId: return anchor on first table tried (ix)
            if (sql.includes('WHERE name =')) return ok([{ id: 5 }]);
            return empty();
        });

        const vectorize = /** @type {any} */ ({
            getByIds: async () => { getByIdsCalled = true; return [{ id: 'ix:5', values: [0.1, 0.2] }]; },
            query:    async () => { queryCalled    = true; return { matches: [{ id: 'net:10' }, { id: 'net:11' }] }; },
        });

        const result = await executeGraphSearch('similar to AMS-IX', 'net', db, vectorize);
        assert.ok(getByIdsCalled, 'should call vectorize.getByIds');
        assert.ok(queryCalled,    'should call vectorize.query');
        assert.equal(result, '10,11');
    });

    it('skips similarity when vectorize binding is null', async () => {
        // With null vectorize, similarity is skipped; falls through to keyword
        const db = makeDB((sql) => {
            if (sql.includes('name LIKE') && sql.includes('aka LIKE')) return ok([{ id: 99 }]);
            return empty();
        });
        const result = await executeGraphSearch('similar to Cloudflare', 'net', db, null);
        // keyword fallback fires → 99
        assert.equal(result, '99');
    });

    it('falls to keyword when anchor name cannot be resolved', async () => {
        const db = makeDB((sql) => {
            if (sql.includes('name LIKE') && sql.includes('aka LIKE')) return ok([{ id: 42 }]);
            return empty(); // name resolution fails
        });
        const vectorize = makeVectorize(); // no storedVector
        const result = await executeGraphSearch('similar to UnknownEntity', 'net', db, vectorize);
        assert.equal(result, '42');
    });

    it('falls to keyword when anchor has no stored vector in Vectorize', async () => {
        const db = makeDB((sql) => {
            if (sql.includes('WHERE name =')) return ok([{ id: 5 }]);
            if (sql.includes('name LIKE') && sql.includes('aka LIKE')) return ok([{ id: 43 }]);
            return empty();
        });
        // getByIds returns empty → no anchor vector
        const vectorize = makeVectorize({ storedVector: null });
        const result = await executeGraphSearch('similar to AMS-IX', 'net', db, vectorize);
        assert.equal(result, '43');
    });

    it('strips anchor ID from similarity results', async () => {
        const db = makeDB((sql) => {
            if (sql.includes('WHERE name =')) return ok([{ id: 5 }]); // anchor resolves as ix:5
            return empty();
        });
        const vectorize = /** @type {any} */ ({
            getByIds: async () => [{ id: 'ix:5', values: [0.1] }],
            // Returns ix:5 as first match (anchor) and two other nets
            query:    async () => ({ matches: [
                { id: 'net:5' },  // different entity type — should not be filtered by anchor check
                { id: 'net:10' },
            ]}),
        });
        const result = await executeGraphSearch('similar to AMS-IX', 'net', db, vectorize);
        // The anchor resolves as ix:5. similaritySearch excludes results whose
        // numeric entityId equals anchor.id (5) regardless of entity type.
        // net:5 has entityId='5' = anchor.id=5 → excluded. net:10 → included.
        assert.equal(result, '10');
    });

    it('returns null when Vectorize query returns no matches', async () => {
        const db = makeDB((sql) => {
            if (sql.includes('WHERE name =')) return ok([{ id: 5 }]);
            return empty();
        });
        const vectorize = makeVectorize({ storedVector: [0.1, 0.2], knnMatches: [] });
        // No kNN matches → similaritySearch returns null → falls to keyword → empty
        const result = await executeGraphSearch('similar to AMS-IX', 'net', db, vectorize);
        assert.equal(result, null);
    });
});

describe('executeGraphSearch — priority ordering', () => {
    it('ASN path wins over metadata filters when both present', async () => {
        let asnCalled  = false;
        let metaCalled = false;
        const db = makeDB((sql) => {
            if (sql.includes('asn = ?'))           { asnCalled  = true; return ok([{ id: 1 }]); }
            if (sql.includes('region_continent'))   { metaCalled = true; return ok([{ id: 2 }]); }
            return empty();
        });
        const result = await executeGraphSearch('AS13335', 'net', db, null);
        assert.ok(asnCalled,   'ASN lookup should run');
        assert.ok(!metaCalled, 'metadata filter should not run after ASN hit');
        assert.equal(result, '1');
    });

    it('keyword fallback is last resort — only fires when all other paths empty', async () => {
        let callOrder = [];
        const db = makeDB((sql) => {
            if (sql.includes('country = ?'))           { callOrder.push('meta'); return empty(); }
            if (sql.includes('name LIKE') && sql.includes('aka LIKE')) {
                callOrder.push('keyword');
                return ok([{ id: 7 }]);
            }
            return empty();
        });
        await executeGraphSearch('networks in Germany', 'net', db, null);
        assert.ok(callOrder.includes('meta'),    'metadata filter should have run first');
        assert.ok(callOrder.includes('keyword'), 'keyword should have run as fallback');
        assert.ok(
            callOrder.indexOf('meta') < callOrder.indexOf('keyword'),
            'metadata should precede keyword'
        );
    });
});
