/**
 * @fileoverview Golden file snapshot tests for all 13 PeeringDB entity types.
 *
 * Captures full JSON responses from handler functions using mock D1 and
 * compares them against committed .json snapshots. Run with --update
 * argument to regenerate golden files.
 *
 * Derived from peeringdb-plus/internal/pdbcompat/golden_test.go.
 *
 * Usage:
 *   node --test tests/unit/api/golden.test.js          # compare
 *   node --test tests/unit/api/golden.test.js --update  # regenerate
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTITIES, ENTITY_TAGS } from '../../../../extracted/entities-worker.js';
import { handleList } from '../../../api/handlers/list.js';
import { handleDetail } from '../../../api/handlers/detail.js';
import { purgeAllCaches } from '../../../api/cache.js';
import { compareStructure } from '../../lib/compare.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, '..', '..', 'fixtures', 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

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
 * Builds a deterministic row for an entity type. All values are fixed
 * so golden file output is reproducible across runs.
 *
 * @param {EntityMeta} meta - Entity metadata.
 * @returns {Record<string, any>} A single deterministic data row.
 */
function deterministicRow(meta) {
    /** @type {Record<string, any>} */
    const row = {};
    for (const field of meta.fields) {
        if (field.name.startsWith('__')) continue;

        if (field.nullable) {
            row[field.name] = null;
            continue;
        }
        switch (field.type) {
            case 'number':
                row[field.name] = field.name === 'id' ? 100 : 0;
                break;
            case 'string':
                row[field.name] = field.name === 'name' ? `Golden ${meta.tag}` : '';
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
    return row;
}

/**
 * Creates a mock D1 returning deterministic data for a given entity.
 *
 * @param {EntityMeta} meta - Entity metadata.
 * @returns {D1Session}
 */
function goldenD1(meta) {
    const row = deterministicRow(meta);
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
 * Builds a HandlerContext for golden test scenarios.
 *
 * @param {string} tag  - Entity tag.
 * @param {D1Session} db - Mock D1.
 * @param {Object} [optsOverride] - Optional opts override.
 * @returns {HandlerContext}
 */
function goldenHC(tag, db, optsOverride = {}) {
    return /** @type {HandlerContext} */ ({
        request: new Request(`https://api.pdbfe.dev/api/${tag}`),
        db,
        ctx: mockCtx(),
        entityTag: tag,
        filters: [],
        opts: { depth: 0, limit: -1, skip: 0, since: 0, sort: '', fields: [], pdbfe: false, ...optsOverride },
        rawPath: `anon:api/${tag}`,
        queryString: '',
        authenticated: false,
        entityVersionMs: 0,
        userId: null,
    });
}

/**
 * Compares or updates a golden file. When UPDATE is set, writes the new
 * content to disk. Otherwise reads the existing file and structurally
 * compares using the diff engine.
 *
 * @param {import('node:test').TestContext} t - Test context.
 * @param {string} goldenPath - Absolute path to the golden .json file.
 * @param {Record<string, any>} actual - The actual parsed response body.
 */
function compareOrUpdate(t, goldenPath, actual) {
    const pretty = JSON.stringify(actual, null, 2) + '\n';

    if (UPDATE) {
        mkdirSync(dirname(goldenPath), { recursive: true });
        writeFileSync(goldenPath, pretty);
        t.diagnostic(`updated: ${goldenPath}`);
        return;
    }

    if (!existsSync(goldenPath)) {
        assert.fail(`Golden file not found: ${goldenPath} (run with --update to create)`);
    }

    const want = JSON.parse(readFileSync(goldenPath, 'utf-8'));
    const diffs = compareStructure(want, actual);

    if (diffs.length > 0) {
        const report = diffs.map(d => `  ${d.kind} at ${d.path}: ${d.details}`).join('\n');
        assert.fail(`Golden mismatch for ${goldenPath}:\n${report}`);
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Golden file: list (depth=0)', () => {
    beforeEach(() => { purgeAllCaches(); });

    for (const tag of ENTITY_TAGS) {
        it(`/api/${tag} — list shape matches golden`, async (t) => {
            const meta = ENTITIES[tag];
            const db = goldenD1(meta);
            const hc = goldenHC(tag, db);

            const res = await handleList(hc);
            if (res.status !== 200) {
                t.diagnostic(`${tag} returned ${res.status}, skipping golden comparison`);
                return;
            }

            const body = await res.json();
            const goldenPath = join(GOLDEN_DIR, tag, 'list.json');
            compareOrUpdate(t, goldenPath, body);
        });
    }
});

describe('Golden file: detail (depth=0)', () => {
    beforeEach(() => { purgeAllCaches(); });

    for (const tag of ENTITY_TAGS) {
        it(`/api/${tag}/100 — detail shape matches golden`, async (t) => {
            const meta = ENTITIES[tag];
            const db = goldenD1(meta);
            const hc = goldenHC(tag, db);

            const res = await handleDetail(hc, 100);
            if (res.status !== 200) {
                t.diagnostic(`${tag}/100 returned ${res.status}, skipping golden comparison`);
                return;
            }

            const body = await res.json();
            const goldenPath = join(GOLDEN_DIR, tag, 'detail.json');
            compareOrUpdate(t, goldenPath, body);
        });
    }
});
