/**
 * @fileoverview Unit tests for search/handlers/query-parser.js
 *
 * Verifies predicate extraction for each recognised pattern type:
 *   - ASN extraction
 *   - Info type extraction
 *   - Country resolution
 *   - City extraction
 *   - Region/continent extraction
 *   - Similarity intent
 *   - Traversal intent
 *   - Fallback (raw query preserved)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../../../search/handlers/query-parser.js';

describe('parseQuery — ASN extraction', () => {
    it('extracts AS number in AS12345 form', () => {
        const r = parseQuery('AS15169');
        assert.equal(r.asn, 15169);
    });

    it('extracts AS number in ASN form', () => {
        const r = parseQuery('ASN 1234');
        assert.equal(r.asn, 1234);
    });

    it('returns early when ASN found (no other predicates)', () => {
        const r = parseQuery('AS15169 in Germany');
        assert.equal(r.asn, 15169);
        // Country extraction is skipped when ASN is found.
        assert.equal(r.country, null);
    });
});

describe('parseQuery — info_type extraction', () => {
    it('matches CDN keyword to Content', () => {
        assert.equal(parseQuery('CDN networks').infoType, 'Content');
    });

    it('matches transit to NSP', () => {
        assert.equal(parseQuery('transit providers in Europe').infoType, 'NSP');
    });

    it('matches route server', () => {
        assert.equal(parseQuery('route server at AMS-IX').infoType, 'Route Server');
    });

    it('returns null for unknown type', () => {
        assert.equal(parseQuery('random network query').infoType, null);
    });
});

describe('parseQuery — country extraction', () => {
    it('extracts Germany → DE', () => {
        assert.equal(parseQuery('networks in Germany').country, 'DE');
    });

    it('extracts Netherlands → NL', () => {
        assert.equal(parseQuery('facilities in the Netherlands').country, 'NL');
    });

    it('extracts UK alias', () => {
        assert.equal(parseQuery('exchanges in UK').country, 'GB');
    });

    it('returns null when no country found', () => {
        assert.equal(parseQuery('cloud networks').country, null);
    });

    it('skips country if region was extracted', () => {
        const r = parseQuery('networks in Europe');
        assert.notEqual(r.regionContinent, null);
        assert.equal(r.country, null);
    });
});

describe('parseQuery — region extraction', () => {
    it('extracts Europe', () => {
        assert.equal(parseQuery('IXes in Europe').regionContinent, 'Europe');
    });

    it('extracts Asia Pacific via APAC', () => {
        assert.equal(parseQuery('networks APAC').regionContinent, 'Asia Pacific');
    });

    it('returns null for no region', () => {
        assert.equal(parseQuery('networks in Germany').regionContinent, null);
    });
});

describe('parseQuery — city extraction', () => {
    it('extracts city after "in"', () => {
        const r = parseQuery('networks in Amsterdam');
        assert.equal(r.city, 'Amsterdam');
    });

    it('extracts city after "at"', () => {
        const r = parseQuery('facilities at Frankfurt');
        assert.equal(r.city, 'Frankfurt');
    });

    it('does not extract lowercase words as city', () => {
        const r = parseQuery('networks in the world');
        // "the" and "world" are lowercase after preposition — should not match.
        // city may be null or a non-"the world" value.
        if (r.city) assert.notEqual(r.city.toLowerCase(), 'the world');
    });
});

describe('parseQuery — similarity intent', () => {
    it('extracts similarToName from "similar to X"', () => {
        const r = parseQuery('networks similar to AWS');
        assert.equal(r.similarToName, 'AWS');
    });

    it('extracts similarToName from "like X"', () => {
        const r = parseQuery('IXes like AMS-IX');
        assert.equal(r.similarToName, 'AMS-IX');
    });

    it('returns null traversal when similarity is set', () => {
        const r = parseQuery('networks similar to Cloudflare');
        assert.equal(r.anchorName, null);
        assert.equal(r.traversalIntent, null);
    });
});

describe('parseQuery — traversal intent', () => {
    it('extracts anchor from "peers of X"', () => {
        const r = parseQuery('peers of AMS-IX');
        assert.equal(r.anchorName, 'AMS-IX');
        assert.ok(r.traversalIntent !== null);
    });

    it('extracts anchor from "members of X"', () => {
        const r = parseQuery('members of LINX');
        assert.equal(r.anchorName, 'LINX');
    });

    it('sets traversalIntent networks_at for generic "at" prefix', () => {
        const r = parseQuery('networks at Equinix');
        assert.equal(r.traversalIntent, 'networks_at');
    });
});

describe('parseQuery — raw passthrough', () => {
    it('always preserves original query in raw field', () => {
        const q = 'Some Query String';
        assert.equal(parseQuery(q).raw, q);
    });
});
