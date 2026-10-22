/**
 * @fileoverview _row_changes marks every detail response a sync changes
 * (sync/row_changes.js), checked against the real API worker on SQLite.
 *
 * A seeded graph with every entity type is rendered at depth 0, 1 and 2 for
 * every object, a single upstream change (update, delete, or move to another
 * parent) is synced, and everything is rendered again. Every response that
 * differs must have a mark at that depth. This is the guard against
 * api/depth.js and the marking rules drifting apart.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';
import { syncEntity } from '../../../sync/index.js';
import { pruneRowChanges, ROW_CHANGES_RETENTION_S, upwardFkColumns } from '../../../sync/row_changes.js';

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
 * under different orgs: under a shared org the grandparent rule would mark
 * them anyway and hide a missing set-join rule.
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
 * Every detail response, keyed `tag/id?depth=d`.
 * @param {any} env
 * @returns {Promise<Map<string, string>>}
 */
async function renderAll(env) {
    purgeAllCaches();
    /** @type {Map<string, string>} */
    const out = new Map();
    for (const [tag, id] of SEED) {
        for (const depth of [0, 1, 2]) {
            const key = `${tag}/${id}?depth=${depth}`;
            // A fresh client address per request: the anonymous rate limit
            // would otherwise answer 429 long before the scenarios are done.
            const n = ++requestCount;
            const headers = { 'cf-connecting-ip': `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}` };
            const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${key}`, { headers }), env, mockCtx);
            out.set(key, `${res.status} ${await res.text()}`);
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

after(() => { globalThis.fetch = realFetch; });

describe('_row_changes covers every changed detail response', () => {
    for (const sc of scenarios()) {
        it(sc.name, async () => {
            const { sqlite, db } = createSqliteD1();
            seed(sqlite);
            const env = envFor(db);
            const before = await renderAll(env);

            const entity = ENTITIES[sc.tag];
            const row = /** @type {Record<string, any>} */ (sqlite.prepare(`SELECT * FROM "${entity.table}" WHERE id = ?`).get(sc.id));
            sc.change(row);
            globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ data: [row] })));
            const result = await syncEntity(db, sc.tag, entity, '', undefined);
            globalThis.fetch = realFetch;
            assert.ok(!result.error, result.error);

            const after = await renderAll(env);
            const marks = new Map(/** @type {any[]} */ (sqlite.prepare('SELECT * FROM "_row_changes"').all())
                .map(m => [`${m.entity}/${m.id}`, m]));

            const missed = [];
            let changed = 0;
            for (const [key, body] of after) {
                if (before.get(key) === body) continue;
                changed++;
                const [obj, q] = key.split('?depth=');
                if (!(marks.get(obj)?.[`d${q}_at`] > 0)) missed.push(key);
            }
            assert.ok(changed > 0, 'the change is visible in at least one response');
            assert.deepEqual(missed, [], `changed but not marked:\n  ${missed.join('\n  ')}`);
        });
    }
});

describe('_row_changes bookkeeping', () => {
    it('marks are cumulative over depth and never move back', async () => {
        const { sqlite, db } = createSqliteD1();
        seed(sqlite);
        const row = /** @type {Record<string, any>} */ (sqlite.prepare('SELECT * FROM "peeringdb_network" WHERE id = 100').get());
        row.name = 'Renamed';
        globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ data: [row] })));
        await syncEntity(db, 'net', ENTITIES.net, '', undefined);
        globalThis.fetch = realFetch;
        for (const m of /** @type {any[]} */ (sqlite.prepare('SELECT * FROM "_row_changes"').all())) {
            assert.ok(m.d0_at <= m.d1_at && m.d1_at <= m.d2_at && m.d2_at > 0, JSON.stringify(m));
        }
        const own = /** @type {any} */ (sqlite.prepare(`SELECT * FROM "_row_changes" WHERE entity = 'net' AND id = 100`).get());
        assert.ok(own.d0_at > 0);

        sqlite.prepare(`UPDATE "_row_changes" SET d0_at = d0_at + 1000, d1_at = d1_at + 1000, d2_at = d2_at + 1000 WHERE entity = 'net' AND id = 100`).run();
        globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify({ data: [row] })));
        await syncEntity(db, 'net', ENTITIES.net, '', undefined);
        globalThis.fetch = realFetch;
        const again = /** @type {any} */ (sqlite.prepare(`SELECT * FROM "_row_changes" WHERE entity = 'net' AND id = 100`).get());
        assert.equal(again.d0_at, own.d0_at + 1000);
    });

    it('a failed sync fetch records nothing', async () => {
        const { sqlite, db } = createSqliteD1();
        seed(sqlite);
        globalThis.fetch = /** @type {any} */ (async () => new Response('boom', { status: 500 }));
        await syncEntity(db, 'net', ENTITIES.net, '', undefined);
        globalThis.fetch = realFetch;
        assert.equal(/** @type {any} */ (sqlite.prepare('SELECT COUNT(*) AS n FROM "_row_changes"').get()).n, 0);
    });

    it('pruning drops entries older than the retention window only', async () => {
        const { sqlite, db } = createSqliteD1();
        const now = 1_800_000_000;
        sqlite.prepare(`INSERT INTO "_row_changes" (entity, id, d0_at, d1_at, d2_at) VALUES ('net', 1, 0, 0, ?), ('net', 2, 0, 0, ?)`)
            .run(now - ROW_CHANGES_RETENTION_S - 1, now - ROW_CHANGES_RETENTION_S + 1);
        await pruneRowChanges(db, now);
        assert.deepEqual(/** @type {any[]} */ (sqlite.prepare('SELECT id FROM "_row_changes"').all()).map(r => r.id), [2]);
    });
});
