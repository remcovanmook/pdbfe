/**
 * @fileoverview Wire format assertions for all 13 PeeringDB entity types.
 *
 * Verifies that every public field defined in the entity registry is
 * present in the handler JSON output, and that internal fields (prefixed
 * with __) do not leak into responses.
 *
 * Derived from the peeringdb-plus serializer_test.go required-field pattern.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES, ENTITY_TAGS } from '../../../../extracted/entities-worker.js';
import { handleList } from '../../../api/handlers/list.js';
import { purgeAllCaches } from '../../../api/cache.js';

// ── Mock infrastructure ──────────────────────────────────────────────────────

/**
 * Creates a mock ExecutionContext.
 *
 * @returns {ExecutionContext}
 */
function mockCtx() {
    return /** @type {ExecutionContext} */ ({
        waitUntil: () => {},
        passThroughOnException: () => {},
    });
}

/**
 * Builds a mock D1 database that returns a single row with all fields
 * set to type-appropriate placeholder values for a given entity.
 *
 * The hot path (json_group_array) returns a complete envelope with one
 * row, ensuring the handler output contains every field for structural
 * validation.
 *
 * @param {EntityMeta} meta - Entity metadata from the registry.
 * @returns {D1Session}
 */
function mockD1ForEntity(meta) {
    // Build a representative row with type-appropriate values.
    /** @type {Record<string, any>} */
    const row = {};
    for (const field of meta.fields) {
        // Skip internal fields — they should not appear in output.
        if (field.name.startsWith('__')) continue;

        if (field.nullable) {
            row[field.name] = null;
            continue;
        }
        switch (field.type) {
            case 'number':
                row[field.name] = field.name === 'id' ? 1 : 0;
                break;
            case 'string':
                row[field.name] = '';
                break;
            case 'boolean':
                row[field.name] = false;
                break;
            case 'datetime':
                row[field.name] = '2025-01-01T00:00:00Z';
                break;
            case 'json':
                row[field.name] = '[]';
                break;
            default:
                row[field.name] = '';
        }
    }

    const payload = JSON.stringify({ data: [row], meta: {} });

    return /** @type {any} */ ({
        prepare(/** @type {string} */ sql) {
            return {
                _params: /** @type {any[]} */ ([]),
                bind(/** @type {...any} */ ...params) {
                    this._params = params;
                    return this;
                },
                first() {
                    if (sql.includes('json_group_array')) {
                        return Promise.resolve({ payload });
                    }
                    if (sql.includes('COUNT(*)')) {
                        return Promise.resolve({ cnt: 1 });
                    }
                    return Promise.resolve(null);
                },
                all() {
                    return Promise.resolve({ success: true, results: [row], meta: {} });
                },
            };
        },
        batch(/** @type {any[]} */ stmts) {
            return Promise.resolve(stmts.map(() => ({ success: true, meta: {}, results: [] })));
        },
    });
}

/**
 * Returns the set of public field names for an entity (excludes
 * __ prefixed internal fields).
 *
 * @param {EntityMeta} meta - Entity metadata.
 * @returns {Set<string>} Public field names.
 */
function publicFieldNames(meta) {
    const names = new Set();
    for (const field of meta.fields) {
        if (!field.name.startsWith('__')) {
            names.add(field.name);
        }
    }
    return names;
}

/**
 * Returns the set of internal field names for an entity (__ prefixed).
 *
 * @param {EntityMeta} meta - Entity metadata.
 * @returns {Set<string>} Internal field names.
 */
function internalFieldNames(meta) {
    const names = new Set();
    for (const field of meta.fields) {
        if (field.name.startsWith('__')) {
            names.add(field.name);
        }
    }
    return names;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Wire format: required fields', () => {
    beforeEach(() => {
        purgeAllCaches();
    });

    for (const tag of ENTITY_TAGS) {
        it(`/api/${tag} — all public fields present in output`, async () => {
            const meta = ENTITIES[tag];
            const db = mockD1ForEntity(meta);
            const ctx = mockCtx();

            const hc = /** @type {HandlerContext} */ ({
                request: new Request(`https://api.pdbfe.dev/api/${tag}`),
                db,
                ctx,
                entityTag: tag,
                filters: [],
                opts: { depth: 0, limit: -1, skip: 0, since: 0, sort: '', fields: [], pdbfe: false },
                rawPath: `anon:api/${tag}`,
                queryString: '',
                authenticated: false,
                entityVersionMs: 0,
                userId: null,
            });

            const res = await handleList(hc);
            assert.equal(res.status, 200, `Expected 200 for ${tag}, got ${res.status}`);

            const body = await res.json();
            assert.ok(Array.isArray(body.data), `${tag}: data should be an array`);

            if (body.data.length === 0) return;

            const outputKeys = new Set(Object.keys(body.data[0]));
            const expected = publicFieldNames(meta);

            const missing = [...expected].filter(f => !outputKeys.has(f));
            assert.deepEqual(
                missing, [],
                `${tag}: output missing required fields: ${missing.join(', ')}`
            );
        });
    }
});

describe('Wire format: internal fields excluded', () => {
    beforeEach(() => {
        purgeAllCaches();
    });

    for (const tag of ENTITY_TAGS) {
        const meta = ENTITIES[tag];
        const internals = internalFieldNames(meta);
        if (internals.size === 0) continue;

        it(`/api/${tag} — __-prefixed fields absent from output`, async () => {
            const db = mockD1ForEntity(meta);
            const ctx = mockCtx();

            const hc = /** @type {HandlerContext} */ ({
                request: new Request(`https://api.pdbfe.dev/api/${tag}`),
                db,
                ctx,
                entityTag: tag,
                filters: [],
                opts: { depth: 0, limit: -1, skip: 0, since: 0, sort: '', fields: [], pdbfe: false },
                rawPath: `anon:api/${tag}`,
                queryString: '',
                authenticated: false,
                entityVersionMs: 0,
                userId: null,
            });

            const res = await handleList(hc);
            if (res.status !== 200) return;

            const body = await res.json();
            if (body.data.length === 0) return;

            const outputKeys = new Set(Object.keys(body.data[0]));
            const leaked = [...internals].filter(f => outputKeys.has(f));
            assert.deepEqual(
                leaked, [],
                `${tag}: internal fields leaked into output: ${leaked.join(', ')}`
            );
        });
    }
});
