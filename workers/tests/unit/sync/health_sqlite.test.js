/**
 * @fileoverview Weekly health check & repair (sync/health.js) on real SQLite
 * with a mocked upstream: repairs drift in both directions, refuses
 * suspicious mass deletions, never acts on an empty or failed upstream list,
 * records a report row, publishes queue messages for repaired rows.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1 } from '../../lib/sqlite_d1.js';
import { runHealthCheck, STALE_ABS } from '../../../sync/health.js';

const TS = '2026-01-01T00:00:00Z';

/** @type {any} */ let db;
/** @type {import('node:sqlite').DatabaseSync} */ let sqlite;
/** @type {any[]} */ let sent;

/** @param {number[]} ids */
function seedNets(ids) {
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    for (const id of ids) net.run(id, `Net ${id}`, 64000 + id);
    sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES ('net', 1700000000, ?, '', 0)`).run(ids.length);
}

/**
 * Mock upstream: `?fields=id` lists `upIds`; `?id__in=` returns those ids as full rows.
 * @param {number[]|null} upIds - null → HTTP 500
 */
function upstreamMock(upIds) {
    return /** @type {any} */ (async (/** @type {string} */ url) => {
        if (upIds === null) return new Response('boom', { status: 500 });
        const u = new URL(url);
        if (u.searchParams.get('fields') === 'id') {
            return new Response(JSON.stringify({ data: upIds.map((id) => ({ id })) }));
        }
        const ids = (u.searchParams.get('id__in') || '').split(',').map(Number);
        return new Response(JSON.stringify({ data: ids.map((id) => ({
            id, org_id: 1, name: `Net ${id}`, asn: 64000 + id, social_media: [], info_types: [], status: 'ok', created: TS, updated: TS,
        })) }));
    });
}

const run = (/** @type {number[]|null} */ upIds) => runHealthCheck(
    /** @type {any} */ ({ PDB: db, QUEUE: { sendBatch: async (/** @type {any[]} */ m) => { sent.push(...m); } } }),
    { pauseMs: 0, fetchImpl: upstreamMock(upIds), tags: ['net'] },
);
const netIds = () => sqlite.prepare('SELECT id FROM "peeringdb_network" ORDER BY id').all().map((/** @type {any} */ r) => r.id);
const rowCount = () => /** @type {any} */ (sqlite.prepare(`SELECT row_count FROM "_sync_meta" WHERE entity = 'net'`).get()).row_count;
const runs = () => sqlite.prepare('SELECT repaired, errors, alerts, report FROM "_health_runs" ORDER BY id').all();

beforeEach(() => { ({ db, sqlite } = createSqliteD1()); sent = []; });

describe('repair', () => {
    it('deletes stale rows, fetches missing ones, recounts, records the run', async () => {
        seedNets([1, 2, 3, 4, 5, 11]);                 // 11 is gone upstream
        const report = await run([1, 2, 3, 4, 5, 12]); // 12 never reached the mirror
        const t = report.tables[0];
        assert.equal(t.action, 'repaired');
        assert.deepEqual(t.deleted, [11]);
        assert.deepEqual(t.inserted, [12]);
        assert.deepEqual(netIds(), [1, 2, 3, 4, 5, 12]);
        assert.equal(rowCount(), 6);
        const [rec] = runs();
        assert.equal(/** @type {any} */ (rec).repaired, 1);
        assert.deepEqual(JSON.parse(/** @type {any} */ (rec).report).tables[0].deleted, [11]);
    });

    it('publishes delete and embed messages for repaired rows', async () => {
        seedNets([1, 2, 11]);
        await run([1, 2, 12]);
        const actions = sent.map((m) => `${m.body.action}:${m.body.id}`).sort();
        assert.ok(actions.includes('delete:11'), JSON.stringify(actions));
        assert.ok(actions.includes('embed:12'), JSON.stringify(actions));
    });

    it('a clean mirror is reported clean and left untouched', async () => {
        seedNets([1, 2, 3]);
        const report = await run([1, 2, 3]);
        assert.equal(report.tables[0].action, 'ok');
        assert.equal(report.repaired, 0);
        assert.deepEqual(netIds(), [1, 2, 3]);
    });
});

describe('guards', () => {
    it('refuses to delete more than the safety limit (alert, no deletes)', async () => {
        const ids = Array.from({ length: STALE_ABS * 3 }, (_, i) => i + 1);
        seedNets(ids);
        const report = await run(ids.slice(0, STALE_ABS));  // 2×STALE_ABS would be "stale"
        const t = report.tables[0];
        assert.equal(t.deleted.length, 0);
        assert.equal(t.alerts.length, 1);
        assert.equal(netIds().length, ids.length);
        assert.equal(report.alerts, 1);
    });

    it('an empty upstream list is an error and deletes nothing', async () => {
        seedNets([1, 2, 3]);
        const report = await run([]);
        assert.equal(report.tables[0].action, 'error');
        assert.deepEqual(netIds(), [1, 2, 3]);
        assert.equal(report.errors, 1);
    });

    it('an upstream HTTP error is an error and deletes nothing', async () => {
        seedNets([1, 2, 3]);
        const report = await run(null);
        assert.equal(report.tables[0].action, 'error');
        assert.match(String(report.tables[0].error), /HTTP 500/);
        assert.deepEqual(netIds(), [1, 2, 3]);
    });
});

describe('weekly cron wiring', async () => {
    const { readFileSync } = await import('node:fs');
    const { default: worker, HEALTH_CRON } = await import('../../../sync/index.js');

    it('HEALTH_CRON uses Cloudflare day-of-week syntax (1-7 or SUN-SAT, never 0)', () => {
        const dow = HEALTH_CRON.trim().split(/\s+/)[4];
        assert.match(dow, /^([1-7]|SUN|MON|TUE|WED|THU|FRI|SAT)$/, `day-of-week "${dow}" — Cloudflare rejects 0`);
    });

    it('HEALTH_CRON is one of the sync worker crons', () => {
        const toml = readFileSync(new URL('../../../wrangler-sync.toml.example', import.meta.url), 'utf8');
        assert.ok(toml.includes(`"${HEALTH_CRON}"`), `${HEALTH_CRON} not in wrangler-sync.toml.example crons`);
    });

    it('scheduled() with HEALTH_CRON runs the health check, not a sync', async () => {
        seedNets([1, 2, 3]);
        const realFetch = globalThis.fetch;
        /** @type {string[]} */
        const urls = [];
        globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => { urls.push(url); return new Response(JSON.stringify({ data: [] })); });
        try {
            await worker.scheduled(/** @type {any} */ ({ cron: HEALTH_CRON }), /** @type {any} */ ({ PDB: db }), /** @type {any} */ ({}));
        } finally {
            globalThis.fetch = realFetch;
        }
        assert.ok(urls.length > 0 && urls.every((u) => u.includes('fields=id')), 'only id-list requests (health check)');
        assert.equal(runs().length, 1, 'one report row recorded');
    });
});
