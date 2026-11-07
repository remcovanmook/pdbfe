/**
 * @fileoverview The request gate (core/gate.js) end to end through the API
 * worker on SQLite: a request with an API key is served as authenticated
 * while the key is verified alongside, and only leaves when the key holds.
 * An invalid key gets a 401, never the data: in particular never the
 * restricted poc rows (visible=Users) an authenticated request may see. A
 * Bearer session that does not hold is served anonymously, as before.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';
import { hashKey } from '../../../core/auth.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');

const USERS_SCHEMA = readFileSync(new URL('../../../../database/users/schema.sql', import.meta.url), 'utf8');
const TS = '2026-01-01T00:00:00Z';
const VALID_KEY = 'pdbfe.' + 'a1'.repeat(16);
const EXPIRED_KEY = 'pdbfe.' + 'b2'.repeat(16);
const UNKNOWN_KEY = 'pdbfe.' + 'c3'.repeat(16);
const SID = 'd4'.repeat(32);

/** @type {any} */
let env;

before(async () => {
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (100, 1, 'Net', 64500, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    const poc = sqlite.prepare(`INSERT INTO "peeringdb_network_contact" (id, net_id, role, visible, name, status, created, updated) VALUES (?, 100, 'NOC', ?, ?, 'ok', '${TS}', '${TS}')`);
    poc.run(1, 'Public', 'Public NOC');
    poc.run(2, 'Users', 'Users NOC');

    const users = createSqliteD1({ schema: USERS_SCHEMA });
    users.sqlite.exec(`INSERT INTO users (id, name, created_at, updated_at) VALUES (7, 'Key owner', '${TS}', '${TS}'), (8, 'Expired owner', '${TS}', '${TS}')`);
    const key =users.sqlite.prepare(`INSERT INTO api_keys (key_id, user_id, prefix, hash, created_at, expires_at) VALUES (?, ?, ?, ?, '${TS}', ?)`);
    key.run('a1a1a1a1', 7, 'a1a1', await hashKey(VALID_KEY), null);
    key.run('b2b2b2b2', 8, 'b2b2', await hashKey(EXPIRED_KEY), '2026-02-01T00:00:00.000Z');

    env = {
        ...envFor(db),
        USERDB: users.db,
        SESSIONS: { get: async (/** @type {string} */ k) => (k === `session:${SID}` ? { id: 9, name: 'S', email: 's@example.com', networks: [] } : null) },
    };
});

beforeEach(() => purgeAllCaches());

/**
 * @param {string} path
 * @param {string} [authorization]
 * @param {any} [extraEnv]
 */
async function get(path, authorization, extraEnv = {}) {
    const headers = authorization ? { Authorization: authorization } : undefined;
    const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/${path}`, { headers }), { ...env, ...extraEnv }, mockCtx);
    return { status: res.status, headers: res.headers, body: await res.json() };
}

const names = (/** @type {any} */ body) => body.data.map((/** @type {any} */ r) => r.name);

describe('API key verified alongside the request; session first', () => {
    it('anonymous: public contacts only', async () => {
        const res = await get('poc?net_id=100');
        assert.equal(res.status, 200);
        assert.deepEqual(names(res.body), ['Public NOC']);
    });

    it('valid key: restricted contacts, X-Auth-Id', async () => {
        const res = await get('poc?net_id=100', `Api-Key ${VALID_KEY}`);
        assert.equal(res.status, 200);
        assert.deepEqual(names(res.body), ['Public NOC', 'Users NOC']);
        assert.equal(res.headers.get('X-Auth-Id'), 'u7');
        assert.match(String(res.headers.get('Server-Timing')), /auth;dur=\d+/);
    });

    it('valid session: restricted contacts', async () => {
        const res = await get('poc?net_id=100', `Bearer ${SID}`);
        assert.equal(res.status, 200);
        assert.deepEqual(names(res.body), ['Public NOC', 'Users NOC']);
    });

    for (const [label, auth] of [['unknown key', `Api-Key ${UNKNOWN_KEY}`], ['expired key', `Api-Key ${EXPIRED_KEY}`]]) {
        it(`${label}: 401 and no data, on restricted and public shapes`, async () => {
            for (const path of ['poc?net_id=100', 'net/100']) {
                const res = await get(path, auth);
                assert.equal(res.status, 401, `${label} ${path}`);
                assert.equal(res.body.data, undefined);
            }
        });
    }

    it('unknown session: served anonymously, public contacts only', async () => {
        const res = await get('poc?net_id=100', `Bearer ${'e5'.repeat(32)}`);
        assert.equal(res.status, 200);
        assert.deepEqual(names(res.body), ['Public NOC']);
        assert.equal(res.headers.get('X-Auth-Id'), null);
    });

    it('expired key: the 401 says it expired', async () => {
        const res = await get('net/100', `Api-Key ${EXPIRED_KEY}`);
        assert.match(JSON.stringify(res.body), /expired/);
    });

    it('upstream PeeringDB key: 403 before any work', async () => {
        const res = await get('net/100', 'Api-Key 0123456789abcdef');
        assert.equal(res.status, 403);
    });

    it('a shared (public) shape with a valid key carries nothing about the caller', async () => {
        const res = await get('net/100', `Api-Key ${VALID_KEY}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('X-Auth-Id'), null);
    });
});

describe('rate-limit bindings', () => {
    /** @param {boolean} success */
    const binding = (success) => ({ /** @type {string[]} */ keys: [], async limit(/** @type {{key: string}} */ o) { this.keys.push(o.key); return { success }; } });

    it('over the limit: 429 before the request is served', async () => {
        const res = await get('net/100', undefined, { RL_ANON: binding(false) });
        assert.equal(res.status, 429);
    });

    it('an unknown session counts on RL_ANON by IP, not on a bucket of its own', async () => {
        const RL_AUTH = binding(true), RL_ANON = binding(true);
        await get('net/100', `Bearer ${'e5'.repeat(32)}`, { RL_AUTH, RL_ANON });
        assert.deepEqual(RL_AUTH.keys, []);
        assert.equal(RL_ANON.keys.length, 1);
    });

    it('a key counts on RL_AUTH, keyed by the key', async () => {
        const RL_AUTH = binding(true), RL_ANON = binding(false);
        const res = await get('net/100', `Api-Key ${VALID_KEY}`, { RL_AUTH, RL_ANON });
        assert.equal(res.status, 200);
        assert.deepEqual(RL_AUTH.keys, [VALID_KEY]);
        assert.deepEqual(RL_ANON.keys, []);
    });
});
