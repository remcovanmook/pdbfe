/**
 * @fileoverview Weekly health check & repair (sync/health.js) on real SQLite
 * with a mocked upstream: repairs drift in both directions, refuses
 * suspicious mass deletions, never acts on an empty or failed upstream list,
 * refreshes rows whose upstream `updated` is newer than the mirror's,
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
/** @type {string[]} */ let requests;

/** @param {number[]} ids */
function seedNets(ids) {
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    const net = sqlite.prepare(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (?, 1, ?, ?, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    for (const id of ids) net.run(id, `Net ${id}`, 64000 + id);
    sqlite.prepare(`INSERT INTO "_sync_meta" (entity, last_sync, row_count, updated_at, last_modified_at) VALUES ('net', 1700000000, ?, '', 0)`).run(ids.length);
}

/**
 * Mock upstream: `?fields=id,updated` lists `upIds` (updated from `upUpdated`,
 * default TS); `?id__in=` returns those ids as full rows, named after their
 * updated value so a refresh is visible in the table.
 * @param {number[]|null} upIds - null → HTTP 500
 * @param {Record<number, string>} [upUpdated] - Per-id upstream `updated`.
 */
function upstreamMock(upIds, upUpdated = {}) {
    const updatedOf = (/** @type {number} */ id) => upUpdated[id] ?? TS;
    return /** @type {any} */ (async (/** @type {string} */ url) => {
        requests.push(url);
        if (upIds === null) return new Response('boom', { status: 500 });
        const u = new URL(url);
        if (u.searchParams.get('fields') === 'id,updated') {
            return new Response(JSON.stringify({ data: upIds.map((id) => ({ id, updated: updatedOf(id) })) }));
        }
        const ids = (u.searchParams.get('id__in') || '').split(',').map(Number);
        return new Response(JSON.stringify({ data: ids.map((id) => ({
            id, org_id: 1, name: `Net ${id} @${updatedOf(id)}`, asn: 64000 + id, social_media: [], info_types: [], status: 'ok', created: TS, updated: updatedOf(id),
        })) }));
    });
}

const run = (/** @type {number[]|null} */ upIds, /** @type {Record<number, string>} */ upUpdated = {}) => runHealthCheck(
    /** @type {any} */ ({ PDB: db, QUEUE: { sendBatch: async (/** @type {any[]} */ m) => { sent.push(...m); } } }),
    { pauseMs: 0, fetchImpl: upstreamMock(upIds, upUpdated), tags: ['net'] },
);
const netName = (/** @type {number} */ id) => /** @type {any} */ (sqlite.prepare('SELECT name FROM "peeringdb_network" WHERE id = ?').get(id)).name;
const netIds = () => sqlite.prepare('SELECT id FROM "peeringdb_network" ORDER BY id').all().map((/** @type {any} */ r) => r.id);
const rowCount = () => /** @type {any} */ (sqlite.prepare(`SELECT row_count FROM "_sync_meta" WHERE entity = 'net'`).get()).row_count;
const runs = () => sqlite.prepare('SELECT repaired, errors, alerts, report FROM "_health_runs" ORDER BY id').all();

beforeEach(() => { ({ db, sqlite } = createSqliteD1()); sent = []; requests = []; });

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
        assert.equal(requests.length, 1, 'only the id,updated list — nothing to fetch');
    });
});

describe('outdated rows (upstream updated newer than ours)', () => {
    const LATER = '2026-04-08T22:46:00Z';

    it('refetches and upserts them, reported as refreshed (not inserted)', async () => {
        seedNets([1, 2, 3]);
        const report = await run([1, 2, 3, 4], { 2: LATER });
        const t = report.tables[0];
        assert.equal(t.action, 'repaired');
        assert.equal(t.outdated, 1);
        assert.deepEqual(t.refreshed, [2]);
        assert.deepEqual(t.inserted, [4]);
        assert.equal(netName(2), `Net 2 @${LATER}`);
        assert.equal(netName(1), 'Net 1', 'up-to-date rows are not rewritten');
        assert.equal(report.repaired, 1);
    });

    it('leaves rows alone when ours is as new or newer', async () => {
        seedNets([1, 2]);
        const report = await run([1, 2], { 1: TS, 2: '2025-06-01T00:00:00Z' });
        assert.equal(report.tables[0].action, 'ok');
        assert.equal(report.tables[0].outdated, 0);
        assert.equal(requests.length, 1);
    });

    it('never refetches on an unparseable upstream updated', async () => {
        seedNets([1, 2]);
        const report = await run([1, 2], { 2: 'not-a-date' });
        assert.equal(report.tables[0].outdated, 0);
        assert.equal(requests.length, 1);
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
        assert.ok(urls.length > 0 && urls.every((u) => u.includes('fields=id,updated')), 'only id-list requests (health check)');
        assert.equal(runs().length, 1, 'one report row recorded');
    });
});
