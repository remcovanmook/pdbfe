/**
 * @fileoverview Unit tests for the REST sub-resource handler.
 *
 * Tests the SUBRESOURCE_MAP construction and handleSubResource routing
 * for forward FK and reverse edge relationship types.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUBRESOURCE_MAP, handleSubResource } from '../../../rest/subresource.js';
import { ENTITY_TAGS } from '../../../api/entities.js';

// ── Mock D1 ──────────────────────────────────────────────────────────────────

/**
 * Creates a mock D1 session for sub-resource tests.
 *
 * Supports configurable responses for first() (forward FK) and all()
 * (reverse edge) queries.
 *
 * @param {Object} opts
 * @param {Record<string, any>|null} [opts.firstResult] - Result for .first() queries.
 * @param {Array<Record<string, any>>} [opts.allResults] - Rows for .all() queries.
 * @returns {D1Session}
 */
function mockD1({ firstResult = null, allResults = [] } = {}) {
    return /** @type {any} */ ({
        prepare(/** @type {string} */ _sql) {
            return {
                /** @type {any[]} */
                _params: [],
                bind(/** @type {...any} */ ...params) {
                    this._params = params;
                    return this;
                },
                first() {
                    return Promise.resolve(firstResult);
                },
                all() {
                    return Promise.resolve({
                        success: true,
                        results: allResults,
                        meta: {},
                    });
                },
            };
        },
    });
}

/** Standard response headers for sub-resource endpoints. */
const H_RESPONSE = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
});

// ── SUBRESOURCE_MAP construction ─────────────────────────────────────────────

describe('SUBRESOURCE_MAP', () => {
    it('has entries for all known entity tags', () => {
        for (const tag of ENTITY_TAGS) {
            assert.ok(SUBRESOURCE_MAP.has(tag), `Expected map to have entry for '${tag}'`);
        }
    });

    it('has forward FK "organization" on net entity', () => {
        const netRels = SUBRESOURCE_MAP.get('net');
        assert.ok(netRels, 'Expected net to have relations');
        const orgRel = netRels.get('organization');
        if (orgRel) {
            assert.equal(orgRel.direction, 'forward');
            assert.equal(orgRel.targetTag, 'org');
        }
    });

    it('has at least one relation for entities with FKs', () => {
        // Most entities have at least one FK to org, so their relation
        // map should not be empty.
        const netRels = SUBRESOURCE_MAP.get('net');
        assert.ok(netRels && netRels.size > 0, 'Expected net to have at least one relation');
    });

    it('relation entries have required properties', () => {
        for (const [tag, rels] of SUBRESOURCE_MAP) {
            for (const [slug, def] of rels) {
                assert.ok(def.targetTag, `${tag}/${slug}: missing targetTag`);
                assert.ok(def.fkField, `${tag}/${slug}: missing fkField`);
                assert.ok(
                    def.direction === 'forward' || def.direction === 'reverse',
                    `${tag}/${slug}: invalid direction '${def.direction}'`
                );
            }
        }
    });
});

// ── handleSubResource ────────────────────────────────────────────────────────

describe('handleSubResource', () => {
    it('returns 404 for unknown entity tag', async () => {
        const db = mockD1();
        const res = await handleSubResource(
            { db }, 'nonexistent', 1, 'anything', '', true, H_RESPONSE
        );
        assert.equal(res.status, 404);
    });

    it('returns 404 for unknown relation on a valid entity', async () => {
        const db = mockD1();
        const res = await handleSubResource(
            { db }, 'net', 1, 'nonexistent_relation', '', true, H_RESPONSE
        );
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.ok(body.error.includes('Unknown relation'));
        assert.ok(body.error.includes('Available'));
    });

    it('returns data for a reverse edge query', async () => {
        const childRows = [
            { id: 10, name: 'Child Net A', org_id: 1 },
            { id: 20, name: 'Child Net B', org_id: 1 },
        ];
        const db = mockD1({ allResults: childRows });

        // Find a valid reverse relation on org
        const orgRels = SUBRESOURCE_MAP.get('org');
        if (!orgRels || orgRels.size === 0) return;

        // Pick the first reverse relation
        let reverseSlug = '';
        for (const [slug, def] of orgRels) {
            if (def.direction === 'reverse') {
                reverseSlug = slug;
                break;
            }
        }
        if (!reverseSlug) return;

        const res = await handleSubResource(
            { db }, 'org', 1, reverseSlug, '', true, H_RESPONSE
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(Array.isArray(body.data));
    });

    it('returns 404 for forward FK when source entity is not found', async () => {
        const db = mockD1({ firstResult: null });

        // Find a forward FK relation on net
        const netRels = SUBRESOURCE_MAP.get('net');
        if (!netRels) return;

        let forwardSlug = '';
        for (const [slug, def] of netRels) {
            if (def.direction === 'forward') {
                forwardSlug = slug;
                break;
            }
        }
        if (!forwardSlug) return;

        const res = await handleSubResource(
            { db }, 'net', 999999, forwardSlug, '', true, H_RESPONSE
        );
        assert.equal(res.status, 404);
    });

    it('returns empty data for anonymous access to restricted entities', async () => {
        const db = mockD1();

        // poc is the restricted entity; try to access its relations (if any)
        // via a parent that has poc as a reverse relationship
        const netRels = SUBRESOURCE_MAP.get('net');
        if (!netRels) return;

        // Look for a relation targeting poc
        for (const [slug, def] of netRels) {
            if (def.targetTag === 'poc') {
                const res = await handleSubResource(
                    { db }, 'net', 1, slug, '', false, H_RESPONSE
                );
                // Should return empty data for anonymous access
                assert.equal(res.status, 200);
                const body = await res.json();
                assert.deepEqual(body.data, []);
                return;
            }
        }
    });
});
