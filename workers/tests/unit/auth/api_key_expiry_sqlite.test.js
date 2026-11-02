/**
 * @fileoverview API key expiry and rotation against the real users schema
 * (database/users/schema.sql) on SQLite.
 *
 * Covers the create → verify → rotate → grace → expiry lifecycle end to
 * end: the auth worker's key handlers (auth/handlers/keys.js) write the
 * rows, and the API workers' check (core/auth.js verifyApiKey and
 * resolveAuth) reads them. Time is driven with mocked timers so the
 * 365-day default, the 7-day rotation grace and the per-isolate cache's
 * handling of an expiry can be stepped through.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from '../../lib/sqlite_d1.js';
import { handleKeys, parseExpiryDays } from '../../../auth/handlers/keys.js';
import { verifyApiKey, resolveAuth } from '../../../core/auth.js';

const USERS_SCHEMA = readFileSync(new URL('../../../../database/users/schema.sql', import.meta.url), 'utf8');
const MIGRATION_0003 = readFileSync(new URL('../../../../database/users/0003_api_key_expiry.sql', import.meta.url), 'utf8');

const DAY = 86400 * 1000;
const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const SID = 'ab'.repeat(32);
const OTHER_SID = 'cd'.repeat(32);

/** Sessions for two users; anything else is unknown. */
const SESSIONS = /** @type {any} */ ({
    get: async (/** @type {string} */ key) => ({
        [`session:${SID}`]: { id: 42, name: 'Test User', email: 'test@example.com', networks: [] },
        [`session:${OTHER_SID}`]: { id: 43, name: 'Other User', email: 'other@example.com', networks: [] },
    })[key] ?? null,
});

/** @type {any} */
let env;

/**
 * Calls the key handlers like the auth worker's router does.
 *
 * @param {string} subPath - Path after /account/keys.
 * @param {{method?: string, body?: any, auth?: string}} [opts]
 * @returns {Promise<{status: number, body: any}>}
 */
async function keys(subPath, { method = 'GET', body, auth = `Bearer ${SID}` } = {}) {
    const req = new Request(`https://auth.pdbfe.dev/account/keys${subPath}`, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handleKeys(req, env, subPath);
    return { status: res.status, body: await res.json() };
}

/** @param {string} key */
const apiRequest = (key) => new Request('https://api.pdbfe.dev/api/net/1', { headers: { Authorization: `Api-Key ${key}` } });

beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: T0 });
    env = { FRONTEND_ORIGIN: 'https://pdbfe.dev', SESSIONS, USERDB: createSqliteD1({ schema: USERS_SCHEMA }).db };
});

afterEach(() => mock.timers.reset());

describe('parseExpiryDays', () => {
    it('defaults to 365 days, maps null and 0 to never, and rejects the rest', () => {
        assert.deepEqual(parseExpiryDays(undefined), { ok: true, days: 365 });
        assert.deepEqual(parseExpiryDays(null), { ok: true, days: null });
        assert.deepEqual(parseExpiryDays(0), { ok: true, days: null });
        assert.deepEqual(parseExpiryDays(30), { ok: true, days: 30 });
        assert.deepEqual(parseExpiryDays(3650), { ok: true, days: 3650 });
        for (const bad of [-1, 1.5, 3651, '30', true]) assert.deepEqual(parseExpiryDays(bad), { ok: false }, String(bad));
    });
});

describe('creating keys with an expiry', () => {
    it('gives new keys a 365-day lifetime by default and lists it', async () => {
        const { status, body } = await keys('', { method: 'POST', body: { label: 'ci' } });
        assert.equal(status, 201);
        assert.equal(body.expires_at, new Date(T0 + 365 * DAY).toISOString());

        const list = await keys('');
        assert.equal(list.body.keys[0].expires_at, body.expires_at);
    });

    it('creates a never-expiring key on request, and rejects a bad lifetime', async () => {
        const never = await keys('', { method: 'POST', body: { expires_in_days: null } });
        assert.equal(never.status, 201);
        assert.equal(never.body.expires_at, null);

        const bad = await keys('', { method: 'POST', body: { expires_in_days: 99999 } });
        assert.equal(bad.status, 400);
    });

    it('does not count expired keys toward the per-user limit', async () => {
        for (let i = 0; i < 5; i++) assert.equal((await keys('', { method: 'POST', body: { expires_in_days: 1 } })).status, 201);
        assert.equal((await keys('', { method: 'POST', body: {} })).status, 400, 'limit reached while all five are live');

        mock.timers.setTime(T0 + 2 * DAY);
        assert.equal((await keys('', { method: 'POST', body: {} })).status, 201, 'expired keys free up the limit');
    });
});

describe('verifying keys at point of use', () => {
    it('accepts a key until it expires, then refuses it with its expiry', async () => {
        const { body } = await keys('', { method: 'POST', body: { expires_in_days: 30 } });

        assert.deepEqual(await verifyApiKey(env.USERDB, body.key), { valid: true, userId: 42, expiresAt: body.expires_at });

        // Still inside the 5-minute cache window from the call above: the
        // cached entry must not outlive the key.
        mock.timers.setTime(Date.parse(body.expires_at));
        assert.deepEqual(await verifyApiKey(env.USERDB, body.key), { valid: false, userId: null, expiresAt: body.expires_at });
    });

    it('rejects an expired key in resolveAuth instead of falling back to anonymous', async () => {
        const { body } = await keys('', { method: 'POST', body: { expires_in_days: 1 } });
        mock.timers.setTime(T0 + 2 * DAY);

        const auth = await resolveAuth(apiRequest(body.key), env);
        assert.equal(auth.authenticated, false);
        assert.match(String(auth.rejection), new RegExp(`expired at ${body.expires_at}`));
    });
});

describe('rotating keys', () => {
    it('issues a replacement with the same label and lifetime and gives the old key 7 days', async () => {
        const old = (await keys('', { method: 'POST', body: { label: 'ci', expires_in_days: 90 } })).body;

        mock.timers.setTime(T0 + 85 * DAY);
        const { status, body } = await keys(`/${old.key_id}/rotate`, { method: 'POST' });
        assert.equal(status, 201);
        assert.equal(body.label, 'ci');
        assert.notEqual(body.key, old.key);
        assert.equal(body.expires_at, new Date(T0 + 175 * DAY).toISOString(), 'new key gets the old 90-day lifetime from now');
        assert.deepEqual(body.rotated, { key_id: old.key_id, expires_at: old.expires_at }, 'old key ends at its own expiry (day 90), before the grace would (day 92)');

        mock.timers.setTime(T0 + 89 * DAY);
        assert.equal((await verifyApiKey(env.USERDB, old.key)).valid, true);
        mock.timers.setTime(T0 + 91 * DAY);
        assert.equal((await resolveAuth(apiRequest(old.key), env)).authenticated, false);
        assert.equal((await resolveAuth(apiRequest(body.key), env)).authenticated, true);
    });

    it('keeps a never-expiring key never-expiring and expires the old one after the grace', async () => {
        const old = (await keys('', { method: 'POST', body: { expires_in_days: null } })).body;
        const { body } = await keys(`/${old.key_id}/rotate`, { method: 'POST' });
        assert.equal(body.expires_at, null);
        assert.equal(body.rotated.expires_at, new Date(T0 + 7 * DAY).toISOString());

        mock.timers.setTime(T0 + 7 * DAY);
        assert.equal((await verifyApiKey(env.USERDB, old.key)).valid, false);
        assert.equal((await verifyApiKey(env.USERDB, body.key)).valid, true);
    });

    it('lets a key rotate itself, but not another key', async () => {
        const a = (await keys('', { method: 'POST', body: {} })).body;
        const b = (await keys('', { method: 'POST', body: {} })).body;

        const self = await keys(`/${a.key_id}/rotate`, { method: 'POST', auth: `Api-Key ${a.key}` });
        assert.equal(self.status, 201);
        assert.equal(self.body.rotated.key_id, a.key_id);

        const other = await keys(`/${b.key_id}/rotate`, { method: 'POST', auth: `Api-Key ${a.key}` });
        assert.equal(other.status, 403);
    });

    it("refuses expired keys and other users' keys, and works at the key limit", async () => {
        const mine = (await keys('', { method: 'POST', body: { expires_in_days: 1 } })).body;
        for (let i = 0; i < 4; i++) await keys('', { method: 'POST', body: {} });

        assert.equal((await keys(`/${mine.key_id}/rotate`, { method: 'POST', auth: `Bearer ${OTHER_SID}` })).status, 404);
        assert.equal((await keys(`/${mine.key_id}/rotate`, { method: 'POST' })).status, 201, 'rotation is allowed with five live keys');

        mock.timers.setTime(T0 + 2 * DAY);
        assert.equal((await keys(`/${mine.key_id}/rotate`, { method: 'POST' })).status, 400);
    });

    it('rejects other methods and malformed item paths', async () => {
        assert.equal((await keys('/abc/rotate')).status, 405);
        assert.equal((await keys('/abc/other', { method: 'POST' })).status, 400);
    });
});

describe('migration 0003', () => {
    it('adds expires_at to an existing api_keys table, leaving old keys never-expiring', async () => {
        const preSchema = USERS_SCHEMA.replace(/^\s*expires_at TEXT,.*\n/m, '');
        assert.ok(!preSchema.includes('expires_at'), 'test setup: column removed from the pre-0003 schema');
        const { sqlite, db } = createSqliteD1({ schema: preSchema });
        sqlite.exec(`INSERT INTO users (id, name, email, preferences, created_at, updated_at) VALUES (42, 'Test User', '', '{}', 'x', 'x');
                     INSERT INTO api_keys (key_id, user_id, label, prefix, hash, created_at) VALUES ('k1', 42, 'old', 'abcd', 'h1', 'x');`);

        sqlite.exec(MIGRATION_0003);
        assert.deepEqual({ ...sqlite.prepare('SELECT expires_at FROM api_keys').get() }, { expires_at: null });

        env.USERDB = db;
        const created = await keys('', { method: 'POST', body: {} });
        assert.equal(created.status, 201, 'handlers work on the migrated table');
    });
});
