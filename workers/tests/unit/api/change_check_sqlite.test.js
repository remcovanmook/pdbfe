/**
 * @fileoverview If-Modified-Since on detail requests never confirms a
 * changed response: the API's change check (api/depth.js changeCheckSql)
 * against the rows the sync recorded (sync/row_changes.js), on SQLite.
 *
 * A seeded graph with every entity type is rendered at depth 0, 1 and 2 for
 * every object, a single upstream change (update, delete, hide from
 * anonymous callers, move to another parent) is synced, and everything is
 * rendered again. Then every detail is requested with an If-Modified-Since
 * from before the change: a response that differs must get a 200, never a
 * 304. This is the guard against the expansion (planExpansion) and the
 * change check drifting apart. Unchanged responses must mostly get 304s, so
 * a check that always says "changed" does not pass either.
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';
import { syncEntity } from '../../../sync/index.js';
import { upwardFkColumns } from '../../../sync/row_changes.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');

const TS = '2026-01-01T00:00:00Z';
const realFetch = globalThis.fetch;
let requestCount = 0;

/**
 * The seeded graph: [tag, id, columns]. Every relationship, join and
 * through set in the registry has at least one row on each side, and every
 * upward FK has a second parent to move to. Rows joined to each other sit
 * under different orgs, so a response that shows one through the other
 * is not also covered by a shared parent.
 * @type {Array<[string, number, Record<string, any>]>}
 */
const SEED = [
    ['org', 1, { name: 'Org 1' }],
    ['org', 2, { name: 'Org 2' }],
    ['org', 3, { name: 'Org 3' }],
    ['campus', 5, { org_id: 1, name: 'Campus 5' }],
    ['campus', 6, { org_id: 2, name: 'Campus 6' }],
    ['fac', 10, { org_id: 2, campus_id: 5, name: 'Fac 10', city: 'Amsterdam', country: 'NL' }],
    ['fac', 11, { org_id: 3, campus_id: null, name: 'Fac 11', city: 'Frankfurt', country: 'DE' }],
    ['carrier', 20, { org_id: 3, name: 'Carrier 20' }],
    ['carrier', 22, { org_id: 2, name: 'Carrier 22' }],
    ['carrierfac', 21, { carrier_id: 20, fac_id: 10 }],
    ['ix', 30, { org_id: 3, name: 'IX 30' }],
    ['ix', 31, { org_id: 1, name: 'IX 31' }],
    ['ixfac', 32, { ix_id: 30, fac_id: 10 }],
    ['ixfac', 33, { ix_id: 31, fac_id: 11 }],
    ['ixlan', 40, { ix_id: 30, name: 'LAN 40' }],
    ['ixlan', 41, { ix_id: 31, name: 'LAN 41' }],
    ['ixpfx', 42, { ixlan_id: 40, prefix: '192.0.2.0/24', protocol: 'IPv4' }],
    ['net', 100, { org_id: 1, name: 'Net 100', asn: 64100 }],
    ['net', 101, { org_id: 2, name: 'Net 101', asn: 64101 }],
    ['net', 102, { org_id: 2, name: 'Net 102', asn: 64102 }],
    ['poc', 110, { net_id: 100, name: 'Poc 110', visible: 'Public', role: 'NOC' }],
    ['poc', 111, { net_id: 101, name: 'Poc 111', visible: 'Public', role: 'NOC' }],
    ['netfac', 120, { net_id: 100, fac_id: 10, local_asn: 64100 }],
    ['netfac', 121, { net_id: 101, fac_id: 11, local_asn: 64101 }],
    ['netixlan', 130, { net_id: 100, ixlan_id: 40, net_side_id: 10, ix_side_id: 10, asn: 64100, ipaddr4: '192.0.2.1', speed: 10000 }],
    ['netixlan', 131, { net_id: 101, ixlan_id: 40, net_side_id: null, ix_side_id: 11, asn: 64101, ipaddr4: '192.0.2.2', speed: 10000 }],
    ['netixlan', 132, { net_id: 102, ixlan_id: 41, net_side_id: 11, ix_side_id: null, asn: 64102, ipaddr4: '192.0.2.3', speed: 10000 }],
];

/** Second parent per upward FK column, for the move scenarios. */
const MOVE_TO = /** @type {Record<string, number>} */ ({
    org_id: 2, campus_id: 6, fac_id: 11, carrier_id: 22, ix_id: 31, ixlan_id: 41, net_id: 102, net_side_id: 11, ix_side_id: 11,
});

/** @param {import('node:sqlite').DatabaseSync} sqlite */
function seed(sqlite) {
    for (const [tag, id, cols] of SEED) {
        const entity = ENTITIES[tag];
        const info = /** @type {any[]} */ (sqlite.prepare(`PRAGMA table_info("${entity.table}")`).all());
        /** @type {Record<string, any>} */
        const row = { id, status: 'ok', created: TS, updated: TS, ...cols };
        for (const c of info) {
            if (c.name in row) continue;
            if (entity._jsonColumns?.has(c.name)) row[c.name] = '[]';
            else if (c.notnull && c.dflt_value === null) row[c.name] = /INT|BOOL|REAL|NUM/i.test(c.type) ? 0 : '';
        }
        const keys = Object.keys(row);
        sqlite.prepare(`INSERT INTO "${entity.table}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
            .run(...keys.map(k => row[k]));
    }
    for (const tag of Object.keys(ENTITIES)) {
        sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES (?, 1700000000, 1, '', 1700000000)`).run(tag);
    }
}

/**
 * Every detail response, keyed `tag/id?depth=d` → status and body, or (with
 * `ims`) the status of a conditional request.
 * @param {any} env
 * @param {number} [ims] - If-Modified-Since, epoch seconds.
 * @returns {Promise<Map<string, string>>}
 */
async function renderAll(env, ims) {
    purgeAllCaches();
    /** @type {Map<string, string>} */
    const out = new Map();
    for (const [tag, id] of SEED) {
        for (const depth of [0, 1, 2]) {
            const key = `${tag}/${id}?depth=${depth}`;
            // A fresh client address per request: the anonymous rate limit
            // would otherwise answer 429 long before the scenarios are done.
            const n = ++requestCount;
            /** @type {Record<string, string>} */
            const headers = { 'cf-connecting-ip': `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}` };
            if (ims !== undefined) headers['If-Modified-Since'] = new Date(ims * 1000).toUTCString();
            const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${key}`, { headers }), env, mockCtx);
            out.set(key, ims === undefined ? `${res.status} ${await res.text()}` : String(res.status));
        }
    }
    return out;
}

/**
 * Columns other rows show of `tag` through joinColumns, plus name.
 * @param {string} tag
 * @returns {Set<string>}
 */
function joinedColumns(tag) {
    const table = ENTITIES[tag].table;
    const cols = new Set(['name']);
    for (const e of Object.values(ENTITIES)) {
        for (const j of [...(e.joinColumns || []), ...e.relationships.flatMap(r => r.joinColumns || [])]) {
            if (j.table === table) for (const c of Object.keys(j.columns)) cols.add(c);
        }
    }
    return cols;
}

/**
 * Scenarios: every object updated (updated + every joined column), deleted,
 * hidden from anonymous callers (restricted entities), and moved along each
 * upward FK it has.
 * @returns {Array<{name: string, tag: string, id: number, change: (row: Record<string, any>) => void}>}
 */
function scenarios() {
    const list = [];
    for (const [tag, id, cols] of SEED) {
        list.push({
            name: `update ${tag}/${id}`, tag, id,
            change: (/** @type {Record<string, any>} */ row) => {
                row.updated = '2026-10-22T12:00:00Z';
                for (const c of joinedColumns(tag)) if (c in row && typeof row[c] === 'string') row[c] = `${row[c]} (changed)`;
            },
        });
        list.push({ name: `delete ${tag}/${id}`, tag, id, change: (/** @type {Record<string, any>} */ row) => { row.status = 'deleted'; } });
        const anon = ENTITIES[tag]._anonFilter;
        if (anon) {
            list.push({ name: `hide ${tag}/${id} from anonymous callers`, tag, id, change: (/** @type {Record<string, any>} */ row) => { row[anon.field] = 'Users'; } });
        }
        for (const fk of upwardFkColumns(tag)) {
            if (!(fk in cols) || cols[fk] === MOVE_TO[fk]) continue;
            list.push({ name: `move ${tag}/${id}.${fk} → ${MOVE_TO[fk]}`, tag, id, change: (/** @type {Record<string, any>} */ row) => { row[fk] = MOVE_TO[fk]; } });
        }
    }
    return list;
}

before(() => { mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T12:00:00Z') }); });
after(() => { globalThis.fetch = realFetch; mock.timers.reset(); });

let confirmedUnchanged = 0;
let unchanged = 0;

describe('If-Modified-Since never confirms a changed detail response', () => {
    for (const sc of scenarios()) {
        it(sc.name, async () => {
            const { sqlite, db } = createSqliteD1();
            seed(sqlite);
            const env = envFor(db);
            mock.timers.tick(60_000);
            const t0 = Math.floor(Date.now() / 1000);
            const before = await renderAll(env);

            mock.timers.tick(60_000);
            const entity = ENTITIES[sc.tag];
            const row = /** @type {Record<string, any>} */ (sqlite.prepare(`SELECT * FROM "${entity.table}" WHERE id = ?`).get(sc.id));
            sc.change(row);
            globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ data: [row] })));
            const result = await syncEntity(db, sc.tag, entity, '', undefined);
            globalThis.fetch = realFetch;
            assert.ok(!result.error, result.error);

            // Past the 15 s poll interval: this render's poll brings the
            // isolate's entity versions up to date (the per-entity check).
            mock.timers.tick(16_000);
            const after = await renderAll(env);
            const statuses = await renderAll(env, t0);

            const missed = [];
            let changed = 0;
            for (const [key, body] of after) {
                if (before.get(key) !== body) {
                    changed++;
                    if (statuses.get(key) === '304') missed.push(key);
                } else if (body.startsWith('200')) {
                    unchanged++;
                    if (statuses.get(key) === '304') confirmedUnchanged++;
                }
            }
            assert.ok(changed > 0, 'the change is visible in at least one response');
            assert.deepEqual(missed, [], `changed but answered 304:\n  ${missed.join('\n  ')}`);
        });
    }

    it('unchanged responses mostly get a 304', (t) => {
        t.diagnostic(`${confirmedUnchanged} of ${unchanged} unchanged responses got a 304`);
        assert.ok(confirmedUnchanged / unchanged > 0.5, `${confirmedUnchanged} of ${unchanged} unchanged responses got a 304`);
    });
});
