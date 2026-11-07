/**
 * @fileoverview core/gate.js: identifying the caller, the Workers
 * rate-limit binding, deferred verification and settling the response.
 * End-to-end behaviour through the API worker: tests/unit/api/gate_sqlite.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { identifyCaller, rateLimited, startVerification, settle, normaliseIP } from '../../../core/gate.js';

/** @param {Record<string, string>} [headers] */
const req = (headers = {}) => new Request('https://api.pdbfe.dev/api/net', { headers });

/**
 * A rate-limit binding that records the keys it saw.
 * @param {boolean} success
 */
function limiter(success) {
    /** @type {string[]} */
    const keys = [];
    return { keys, limit: async (/** @type {{key: string}} */ o) => { keys.push(o.key); return { success }; } };
}

const error = (/** @type {number} */ status, /** @type {string} */ message) => new Response(JSON.stringify({ message }), { status });

const SID = 'ab'.repeat(32);
/** A SESSIONS KV with one session; it counts its reads. */
const sessions = () => ({ reads: 0, async get(/** @type {string} */ k) { this.reads++; return k === `session:${SID}` ? { id: 5 } : null; } });
/** A USERDB that must not be touched. */
const noDb = { prepare() { throw new Error('D1 touched'); } };

describe('identifyCaller', () => {
    it('no credential: anonymous', async () => {
        assert.equal((await identifyCaller(req(), { SESSIONS: sessions() })).identity, null);
    });
    it('a pdbfe API key is the identity, unverified, with no lookup', async () => {
        const kv = sessions();
        const caller = await identifyCaller(req({ Authorization: 'Api-Key pdbfe.abc' }), { SESSIONS: kv, USERDB: noDb });
        assert.equal(caller.identity, 'pdbfe.abc');
        assert.equal(caller.apiKey, 'pdbfe.abc');
        assert.equal(kv.reads, 0);
    });
    it('an upstream PeeringDB key is refused without any lookup', async () => {
        const caller = await identifyCaller(req({ Authorization: 'Api-Key abcdef' }), { SESSIONS: sessions(), USERDB: noDb });
        assert.equal(caller.identity, null);
        assert.match(String(caller.rejection), /PeeringDB API keys are not valid/);
    });
    it('a valid Bearer session: identity and user known now', async () => {
        const caller = await identifyCaller(req({ Authorization: `Bearer ${SID}` }), { SESSIONS: sessions() });
        assert.equal(caller.identity, SID);
        assert.equal(caller.userId, 5);
        assert.equal(caller.apiKey, null);
    });
    it('a session that does not hold: anonymous, not refused', async () => {
        const caller = await identifyCaller(req({ Authorization: `Bearer ${'cd'.repeat(32)}` }), { SESSIONS: sessions() });
        assert.equal(caller.identity, null);
        assert.equal(caller.rejection, null);
    });
});

describe('rateLimited', () => {
    const caller = (/** @type {string|null} */ identity) => ({ identity, apiKey: null, userId: null, ms: null, rejection: null });

    it('keys RL_AUTH by the identity and RL_ANON by the IPv6 /64', async () => {
        const env = { RL_AUTH: limiter(true), RL_ANON: limiter(false) };
        assert.equal(await rateLimited(env, req(), caller('pdbfe.k')), false);
        assert.deepEqual(env.RL_AUTH.keys, ['pdbfe.k']);
        const anon = req({ 'cf-connecting-ip': '2001:db8:1:2:3:4:5:6' });
        assert.equal(await rateLimited(env, anon, caller(null)), true);
        assert.deepEqual(env.RL_ANON.keys, ['2001:db8:1:2']);
    });
    it('no binding (tests, local dev): never limited', async () => {
        assert.equal(await rateLimited({}, req(), caller(null)), false);
    });
});

describe('startVerification and settle', () => {
    const authed = () => new Response('{}', { headers: { 'X-Auth-Status': 'authenticated', 'Server-Timing': 'cache;desc="MISS"' } });
    const keyCaller = { identity: 'pdbfe.k', apiKey: 'pdbfe.k', userId: null, ms: null, rejection: null };

    it('no key to verify: the response leaves as it is', async () => {
        const anon = { identity: null, apiKey: null, userId: null, ms: null, rejection: null };
        assert.equal(startVerification({ USERDB: /** @type {any} */ (noDb) }, anon), null);
        const res = new Response('{}');
        assert.equal(await settle(res, anon, null, error), res);
    });
    it('a key that does not hold: 401 with its reason, never the response', async () => {
        const res = await settle(authed(), keyCaller, Promise.resolve({ valid: false, userId: null, rejection: 'This API key expired', ms: 3 }), error);
        assert.equal(res.status, 401);
        assert.match((await res.json()).message, /expired/);
    });
    it('verified key: X-Auth-Id and auth timing on a private response', async () => {
        const res = await settle(authed(), keyCaller, Promise.resolve({ valid: true, userId: 7, rejection: null, ms: 12 }), error);
        assert.equal(res.headers.get('X-Auth-Id'), 'u7');
        assert.equal(res.headers.get('Server-Timing'), 'cache;desc="MISS", auth;dur=12');
    });
    it('session: its user from identifyCaller, no verification', async () => {
        const res = await settle(authed(), { identity: SID, apiKey: null, userId: 5, ms: 2, rejection: null }, null, error);
        assert.equal(res.headers.get('X-Auth-Id'), 'u5');
        assert.equal(res.headers.get('Server-Timing'), 'cache;desc="MISS", auth;dur=2');
    });
    it('a shared (public) response carries nothing about the caller', async () => {
        const shared = new Response('{}', { headers: { 'Cache-Control': 'public' } });
        const res = await settle(shared, keyCaller, Promise.resolve({ valid: true, userId: 7, rejection: null, ms: 12 }), error);
        assert.equal(res, shared);
        assert.equal(res.headers.get('X-Auth-Id'), null);
    });
});

describe('normaliseIP', () => {
    it('should pass through IPv4 addresses unchanged', () => {
        assert.equal(normaliseIP('192.168.1.1'), '192.168.1.1');
        assert.equal(normaliseIP('10.0.0.1'), '10.0.0.1');
    });

    it('should truncate full IPv6 to /64 prefix', () => {
        assert.equal(
            normaliseIP('2001:0db8:85a3:0000:0000:8a2e:0370:7334'),
            '2001:0db8:85a3:0000'
        );
    });

    it('should group addresses in the same /64 together', () => {
        const a = normaliseIP('2001:db8:85a3:0:1::1');
        const b = normaliseIP('2001:db8:85a3:0:ffff::9999');
        assert.equal(a, b, 'same /64 should produce same key');
    });

    it('should handle :: compressed notation', () => {
        // 2001:db8::1 expands to 2001:db8:0:0:0:0:0:1
        assert.equal(normaliseIP('2001:db8::1'), '2001:db8:0:0');
    });

    it('should handle leading :: (loopback)', () => {
        // ::1 expands to 0:0:0:0:0:0:0:1
        assert.equal(normaliseIP('::1'), '0:0:0:0');
    });

    it('should handle trailing ::', () => {
        // 2001:db8:: expands to 2001:db8:0:0:0:0:0:0
        assert.equal(normaliseIP('2001:db8::'), '2001:db8:0:0');
    });

    it('should handle :: in the middle with groups on both sides', () => {
        // fe80::1:2 expands to fe80:0:0:0:0:0:1:2
        assert.equal(normaliseIP('fe80::1:2'), 'fe80:0:0:0');
    });

    it('returns "unknown" for a missing/empty IP instead of throwing', () => {
        assert.equal(normaliseIP(''), 'unknown');
        assert.equal(normaliseIP(/** @type {any} */ (undefined)), 'unknown');
        assert.equal(normaliseIP(/** @type {any} */ (null)), 'unknown');
    });

    it('should pass through unknown as-is', () => {
        assert.equal(normaliseIP('unknown'), 'unknown');
    });
});
