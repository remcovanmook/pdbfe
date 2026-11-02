/**
 * @fileoverview User revalidation against PeeringDB (auth/revalidate.js)
 * and the login hook that stores the refresh token (handlers/oauth.js), on
 * the real users schema with an in-memory KV and a mocked auth.peeringdb.com.
 *
 * Valid users keep access and get their sessions' profile refreshed;
 * users PeeringDB refuses (invalid_grant, profile refused, no longer
 * verified) lose their sessions and API keys; any other failure changes
 * nothing.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from '../../lib/sqlite_d1.js';
import { runRevalidation } from '../../../auth/revalidate.js';
import { encryptToken, decryptToken } from '../../../auth/tokens.js';
import { handleAuth } from '../../../auth/handlers/oauth.js';

const USERS_SCHEMA = readFileSync(new URL('../../../../database/users/schema.sql', import.meta.url), 'utf8');
const MIGRATION_0004 = readFileSync(new URL('../../../../database/users/0004_user_revalidation.sql', import.meta.url), 'utf8');
const KEY = 'ab'.repeat(32);
const NOW = '2026-11-02T12:00:00.000Z';

/** In-memory KV with the list/metadata/expiration subset the code uses. */
function memoryKV() {
    /** @type {Map<string, {value: string, metadata?: any, expiration?: number}>} */
    const store = new Map();
    return {
        store,
        async get(/** @type {string} */ k, /** @type {any} */ opts) {
            const e = store.get(k);
            if (!e) return null;
            return opts?.type === 'json' ? JSON.parse(e.value) : e.value;
        },
        async put(/** @type {string} */ k, /** @type {string} */ value, /** @type {any} */ opts = {}) {
            const expiration = opts.expiration ?? (opts.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : undefined);
            store.set(k, { value, metadata: opts.metadata, expiration });
        },
        async delete(/** @type {string} */ k) { store.delete(k); },
        async list(/** @type {{prefix: string}} */ { prefix }) {
            return {
                keys: [...store].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata, expiration: e.expiration })),
                list_complete: true,
            };
        },
    };
}

/**
 * Mock auth.peeringdb.com. `users` maps a refresh token to the user it
 * belongs to; each refresh rotates it (`<old>+`).
 * @param {Record<string, {profile?: Record<string, any>, refresh?: number, refreshError?: string, profileStatus?: number}>} users
 */
function peeringDb(users) {
    /** @type {Map<string, string>} access token → refresh token it came from */
    const access = new Map();
    return /** @type {any} */ (async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
        if (url.endsWith('/oauth2/token/')) {
            const body = new URLSearchParams(/** @type {string} */ (init.body));
            const rt = /** @type {string} */ (body.get('refresh_token'));
            const u = users[rt];
            if (!u || u.refreshError) return Response.json({ error: u?.refreshError ?? 'invalid_grant' }, { status: u?.refresh ?? 400 });
            if (u.refresh && u.refresh >= 500) return new Response('upstream down', { status: u.refresh });
            access.set(`at-${rt}`, rt);
            users[`${rt}+`] = u; // rotated
            return Response.json({ access_token: `at-${rt}`, refresh_token: `${rt}+` });
        }
        const rt = access.get(String(new Headers(init.headers).get('Authorization')).replace('Bearer ', ''));
        const u = rt ? users[rt] : undefined;
        if (!u) return new Response('', { status: 401 });
        if (u.profileStatus) return new Response('', { status: u.profileStatus });
        return Response.json(u.profile);
    });
}

const profile = (/** @type {number} */ id, extra = {}) => ({ id, name: `User ${id}`, given_name: 'U', family_name: String(id), email: `u${id}@example.com`, verified_user: true, verified_email: true, networks: [{ id: 1, asn: 64500, name: 'Net', perms: 15 }], ...extra });

/** @type {any} */ let env;
/** @type {import('node:sqlite').DatabaseSync} */ let sqlite;
/** @type {ReturnType<typeof memoryKV>} */ let kv;

/**
 * Seeds a user with a stored token, an API key and a session.
 * @param {number} id @param {string} token
 */
async function seedUser(id, token) {
    sqlite.prepare(`INSERT INTO users (id, name, email, preferences, created_at, updated_at, refresh_token) VALUES (?, ?, '', '{}', ?, ?, ?)`)
        .run(id, `User ${id}`, NOW, NOW, await encryptToken(KEY, token));
    sqlite.prepare(`INSERT INTO api_keys (key_id, user_id, label, prefix, hash, created_at, expires_at) VALUES (?, ?, 'k', 'abcd', ?, ?, NULL)`)
        .run(`key${id}`, id, `hash${id}`, NOW);
    await kv.put(`session:s${id}`, JSON.stringify({ id, name: `User ${id}`, networks: [], created_at: NOW }), { expiration: 1900000000, metadata: { uid: id } });
}

const userRow = (/** @type {number} */ id) => /** @type {any} */ (sqlite.prepare('SELECT refresh_token, validated_at FROM users WHERE id = ?').get(id));
const keyExpiry = (/** @type {number} */ id) => /** @type {any} */ (sqlite.prepare('SELECT expires_at FROM api_keys WHERE user_id = ?').get(id)).expires_at;

beforeEach(() => {
    const d1 = createSqliteD1({ schema: USERS_SCHEMA });
    sqlite = d1.sqlite;
    kv = memoryKV();
    env = {
        USERDB: d1.db, SESSIONS: kv, TOKEN_ENCRYPTION_KEY: KEY,
        OAUTH_CLIENT_ID: 'cid', OAUTH_CLIENT_SECRET: 'cs', PEERINGDB_API_KEY: 'pk',
        FRONTEND_ORIGIN: 'https://pdbfe.dev', OAUTH_REDIRECT_URI: 'https://auth.pdbfe.dev/auth/callback',
    };
});

describe('revalidation', () => {
    it('keeps a valid user, rotates the token and refreshes their sessions', async () => {
        await seedUser(1, 'rt1');
        const report = await runRevalidation(env, { pauseMs: 0, fetchImpl: peeringDb({ rt1: { profile: profile(1) } }) });
        assert.deepEqual(report, { checked: 1, valid: 1, invalidated: [], skipped: 0, errors: [] });
        assert.equal(await decryptToken(KEY, userRow(1).refresh_token), 'rt1+', 'rotated token stored');
        assert.ok(userRow(1).validated_at);
        const s = /** @type {any} */ (kv.store.get('session:s1'));
        assert.deepEqual(JSON.parse(s.value).networks, [{ id: 1, asn: 64500, name: 'Net', perms: 15 }]);
        assert.equal(JSON.parse(s.value).created_at, NOW, 'original created_at kept');
        assert.equal(s.expiration, 1900000000, 'session expiry kept');
        assert.equal(keyExpiry(1), null);
    });

    it('invalidates a user whose refresh PeeringDB refuses (closed account, consent withdrawn)', async () => {
        await seedUser(2, 'rt2');
        await seedUser(3, 'rt3');
        const report = await runRevalidation(env, { pauseMs: 0, fetchImpl: peeringDb({ rt3: { profile: profile(3) } }) });
        assert.deepEqual(report.invalidated, [2]);
        assert.equal(kv.store.has('session:s2'), false, 'sessions ended');
        assert.ok(keyExpiry(2) <= new Date().toISOString(), 'API key expired');
        assert.equal(userRow(2).refresh_token, null);
        assert.equal(kv.store.has('session:s3'), true, 'other users untouched');
        assert.equal(keyExpiry(3), null);
    });

    it('invalidates a user who is no longer verified, or whose profile is refused', async () => {
        await seedUser(4, 'rt4');
        await seedUser(5, 'rt5');
        const report = await runRevalidation(env, { pauseMs: 0, fetchImpl: peeringDb({
            rt4: { profile: profile(4, { verified_user: false, networks: [] }) },
            rt5: { profile: profile(5), profileStatus: 403 },
        }) });
        assert.deepEqual(report.invalidated.sort(), [4, 5]);
    });

    it('changes nothing when PeeringDB or our config fails', async () => {
        await seedUser(6, 'rt6');
        await seedUser(7, 'rt7');
        await seedUser(8, 'rt8');
        const before = userRow(6).refresh_token;
        const report = await runRevalidation(env, { pauseMs: 0, fetchImpl: peeringDb({
            rt6: { refresh: 503 },
            rt7: { refresh: 401, refreshError: 'invalid_client' },
            rt8: { profile: profile(8), profileStatus: 500 },
        }) });
        assert.equal(report.invalidated.length, 0);
        assert.equal(report.skipped, 3);
        assert.equal(userRow(6).refresh_token, before);
        for (const id of [6, 7, 8]) {
            assert.equal(kv.store.has(`session:s${id}`), true);
            assert.equal(keyExpiry(id), null);
        }
    });

    it('skips a token that will not decrypt (key changed) rather than revoking', async () => {
        await seedUser(9, 'rt9');
        env.TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
        const report = await runRevalidation(env, { pauseMs: 0, fetchImpl: peeringDb({}) });
        assert.equal(report.skipped, 1);
        assert.equal(report.invalidated.length, 0);
        assert.equal(kv.store.has('session:s9'), true);
    });

    it('finds sessions written before the uid metadata existed', async () => {
        await seedUser(10, 'rt10');
        await kv.put('session:old10', JSON.stringify({ id: 10, created_at: NOW }), { expiration: 1900000000 });
        await runRevalidation(env, { pauseMs: 0, fetchImpl: peeringDb({}) });
        assert.equal(kv.store.has('session:old10'), false);
    });

    it('does nothing without TOKEN_ENCRYPTION_KEY', async () => {
        await seedUser(11, 'rt11');
        delete env.TOKEN_ENCRYPTION_KEY;
        let calls = 0;
        const report = await runRevalidation(env, { pauseMs: 0, fetchImpl: /** @type {any} */ (async () => { calls++; return new Response(''); }) });
        assert.equal(report.checked, 0);
        assert.equal(calls, 0);
    });
});

describe('login stores the refresh token', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    /** @param {Record<string, any>} tokenResponse */
    async function login(tokenResponse) {
        globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url) => String(url).includes('oauth2/token')
            ? Response.json(tokenResponse)
            : Response.json(profile(42)));
        const req = new Request('https://auth.pdbfe.dev/auth/callback?code=C&state=S', {
            headers: { Cookie: 'pdbfe_oauth_state=S; pdbfe_oauth_return=https%3A%2F%2Fpdbfe.dev' },
        });
        const res = await handleAuth(req, env, '/auth/callback');
        assert.equal(res.status, 302);
        assert.ok(String(res.headers.get('Location')).includes('code='), 'login succeeded');
    }

    it('encrypts and stores it, and tags the session with the user id', async () => {
        await login({ access_token: 'at', refresh_token: 'secret-rt' });
        const row = userRow(42);
        assert.ok(row.refresh_token && !row.refresh_token.includes('secret-rt'), 'stored encrypted');
        assert.equal(await decryptToken(KEY, row.refresh_token), 'secret-rt');
        const session = [...kv.store].find(([k]) => k.startsWith('session:'));
        assert.deepEqual(session?.[1].metadata, { uid: 42 });
    });

    it('logs in without storing anything when there is no token or no key', async () => {
        await login({ access_token: 'at' });
        assert.equal(userRow(42).refresh_token, null);
        delete env.TOKEN_ENCRYPTION_KEY;
        await login({ access_token: 'at', refresh_token: 'rt' });
        assert.equal(userRow(42).refresh_token, null);
    });
});


describe('migration 0004', () => {
    it('adds refresh_token and validated_at to an existing users table', () => {
        const pre = USERS_SCHEMA
            .replace(/updated_at  TEXT    NOT NULL,(.*)\n/, 'updated_at  TEXT    NOT NULL\n')
            .replace(/^\s*refresh_token TEXT,.*\n/m, '')
            .replace(/^\s*validated_at  TEXT .*\n/m, '');
        assert.ok(!pre.includes('refresh_token') && !pre.includes('validated_at'), 'test setup: columns removed');
        const { sqlite: db } = createSqliteD1({ schema: pre });
        db.exec(`INSERT INTO users (id, name, email, preferences, created_at, updated_at) VALUES (1, 'U', '', '{}', 'x', 'x')`);
        db.exec(MIGRATION_0004);
        assert.deepEqual({ .../** @type {any} */ (db.prepare('SELECT refresh_token, validated_at FROM users').get()) }, { refresh_token: null, validated_at: null });
    });
});
