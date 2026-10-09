/**
 * @fileoverview Shared (auth-independent) vs auth-sensitive responses,
 * end to end through the api and rest workers on real SQLite.
 *
 * Auth-independent responses are served `public` with no
 * `Vary: Authorization`, so at the Cloudflare edge one object serves every
 * caller and the Worker does not run on a hit. That is only safe if no such
 * response can ever contain a non-Public contact. For a matrix of routes
 * this suite sends an authenticated request (session Bearer token) followed
 * by an anonymous one and checks:
 *
 *   - shared routes: both responses public, no Vary, no X-Auth-Status /
 *     X-Auth-Id / internal marker, identical bodies;
 *   - sensitive routes: authenticated response private (and actually
 *     contains non-Public contacts), anonymous response sees only Public;
 *   - invariant on every response: a body with a non-Public contact is
 *     never `public`.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, mockCtx } from '../../lib/sqlite_d1.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { default: restWorker } = await import('../../../rest/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');
const { purgeRestCache } = await import('../../../rest/cache.js');
const { SHARED_MARKER } = await import('../../../core/http.js');

const TS = '2026-01-01T00:00:00Z';
const SID = 'a'.repeat(64);
/** Seeded contacts: id 1 Public, 2 Users, 3 Private. */
const PUBLIC_POC_IDS = new Set([1]);

/** @type {any} */
let env;

before(() => {
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, irr_as_set, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (1, 1, 'Net', 64500, 'AS-NET', '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`INSERT INTO "peeringdb_facility" (id, org_id, name, social_media, available_voltage_services, status, created, updated) VALUES (1, 1, 'Fac', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`INSERT INTO "peeringdb_network_facility" (id, net_id, fac_id, local_asn, status, created, updated) VALUES (1, 1, 1, 64500, 'ok', '${TS}', '${TS}')`);
    const poc = sqlite.prepare(`INSERT INTO "peeringdb_network_contact" (id, net_id, role, visible, name, phone, email, url, status, created, updated) VALUES (?, 1, 'NOC', ?, 'n', '', 'e@example.net', '', 'ok', '${TS}', '${TS}')`);
    poc.run(1, 'Public');
    poc.run(2, 'Users');
    poc.run(3, 'Private');
    const sessions = {
        get: async (/** @type {string} */ key) => (key === `session:${SID}` ? { id: 42, name: 'Test', given_name: 'T', family_name: 'U', email: 't@example.net' } : null),
        put: async () => {}, delete: async () => {},
    };
    env = { PDB: db, SESSIONS: sessions, ADMIN_SECRET: 'x', PDBFE_VERSION: '0.0.0' };
});

beforeEach(() => { purgeAllCaches(); purgeRestCache(); });

/**
 * @param {any} worker
 * @param {string} url
 * @param {boolean} authed
 */
async function get(worker, url, authed) {
    const headers = authed ? { Authorization: `Bearer ${SID}` } : {};
    const res = await worker.fetch(new Request(url, { headers }), env, mockCtx);
    const text = await res.text();
    return { res, text, body: res.ok ? JSON.parse(text) : null };
}

/**
 * Visibility of every contact in a body: objects with `visible`, plus
 * depth=1 `poc_set` id arrays (ids other than the Public one count as
 * non-Public).
 * @param {any} body @returns {string[]}
 */
function visibilities(body) {
    /** @type {string[]} */
    const out = [];
    const walk = (/** @type {any} */ n) => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === 'object') {
            if ('visible' in n) out.push(n.visible);
            for (const [k, v] of Object.entries(n)) {
                if (k === 'poc_set' && Array.isArray(v)) {
                    for (const c of v) if (typeof c === 'number') out.push(PUBLIC_POC_IDS.has(c) ? 'Public' : 'Hidden');
                }
                walk(v);
            }
        }
    };
    walk(body);
    return out;
}

/** Invariant: a body carrying any non-Public contact must not be shareable. */
function assertNoPublicLeak(/** @type {{res: Response, body: any}} */ r, /** @type {string} */ label) {
    if (visibilities(r.body).some(v => v !== 'Public')) {
        assert.ok(r.res.headers.get('Cache-Control')?.startsWith('private'), `${label}: non-Public contact in a non-private response`);
    }
}

const API = 'https://api.pdbfe.dev';
const REST = 'https://rest.pdbfe.dev';

const SHARED = [
    [apiWorker, `${API}/api/net`],
    [apiWorker, `${API}/api/net/1`],
    [apiWorker, `${API}/api/net.json?asn=64500`],
    [apiWorker, `${API}/api/netfac?net_id=1`],
    [apiWorker, `${API}/api/fac?depth=1`],
    [apiWorker, `${API}/api/org/1?depth=2`],
    [apiWorker, `${API}/api/fac/1?depth=2`],          // parent org at depth 1 (sets as ids): nothing restricted
    [apiWorker, `${API}/api/netfac/1?depth=1`],       // parent net at depth 0: no poc_set
    [apiWorker, `${API}/api/netfac?net_id=1&depth=2`], // lists expand org only
    [apiWorker, `${API}/api/as_set/64500`],
    [restWorker, `${REST}/v1/net`],
    [restWorker, `${REST}/v1/net/1`],
    [restWorker, `${REST}/v1/org/1/networks`],
    [restWorker, `${REST}/v1/net/1/network-facilities`],
];

const SENSITIVE = [
    [apiWorker, `${API}/api/poc`],
    [apiWorker, `${API}/api/poc/2`],
    [apiWorker, `${API}/api/poc?net_id=1`],
    [apiWorker, `${API}/api/net/1?depth=1`],
    [apiWorker, `${API}/api/net/1?depth=2`],
    [apiWorker, `${API}/api/net?depth=2`],
    [apiWorker, `${API}/api/netfac/1?depth=2`],       // parent net at depth 1 → net.poc_set
    [restWorker, `${REST}/v1/poc`],
    [restWorker, `${REST}/v1/net/1?depth=2`],
    [restWorker, `${REST}/v1/net?depth=2`],
    [restWorker, `${REST}/v1/net/1/contacts`],
    [restWorker, `${REST}/v1/poc/2/networks`],
];

describe('shared (auth-independent) responses', () => {
    for (const [worker, url] of SHARED) {
        it(`${url.replace(/^https:\/\//, '')} — one public object for every caller`, async () => {
            const auth = await get(worker, url, true);
            const anon = await get(worker, url, false);
            for (const [label, r] of /** @type {const} */ ([['auth', auth], ['anon', anon]])) {
                assert.equal(r.res.status, 200, `${label} ${r.text}`);
                assert.ok(r.res.headers.get('Cache-Control')?.startsWith('public'), `${label} Cache-Control`);
                assert.equal(r.res.headers.get('Vary'), null, `${label} Vary`);
                assert.equal(r.res.headers.get('X-Auth-Status'), null, `${label} X-Auth-Status`);
                assert.equal(r.res.headers.get('X-Auth-Id'), null, `${label} X-Auth-Id`);
                assert.equal(r.res.headers.get(SHARED_MARKER), null, `${label} internal marker leaked`);
                assertNoPublicLeak(r, label);
            }
            assert.equal(auth.text, anon.text, 'identical bodies');
        });
    }
});

describe('auth-sensitive responses', () => {
    for (const [worker, url] of SENSITIVE) {
        it(`${url.replace(/^https:\/\//, '')} — partitioned by auth state`, async () => {
            const auth = await get(worker, url, true);
            const anon = await get(worker, url, false);

            assert.equal(auth.res.status, 200, auth.text);
            assert.ok(auth.res.headers.get('Cache-Control')?.startsWith('private'), 'auth Cache-Control private');
            assert.equal(auth.res.headers.get('X-Auth-Status'), 'authenticated');
            assert.equal(anon.res.headers.get('X-Auth-Status'), 'unauthenticated');
            if (anon.res.ok) {
                assert.equal(anon.res.headers.get('Vary'), 'Authorization', 'anon variant keyed apart from auth');
            } else {
                // e.g. a non-Public id → 404 for anon: must not be storable either
                assert.equal(anon.res.headers.get('Cache-Control'), 'no-store', 'anon error response not cacheable');
            }

            // The seed gives every sensitive route a different auth vs anon
            // view; if they match, the route isn't exercising restricted data.
            assert.notEqual(auth.text, anon.text, 'auth and anon views should differ');
            assert.deepEqual([...new Set(visibilities(anon.body))].filter(v => v !== 'Public'), [], 'anon sees only Public');
            assertNoPublicLeak(auth, 'auth');
            assertNoPublicLeak(anon, 'anon');
        });
    }
});

describe('isAuthSensitive / isRelationAuthSensitive', async () => {
    const { isAuthSensitive, isRelationAuthSensitive } = await import('../../../api/auth_scope.js');

    it('restricted entity is sensitive at any depth', () => {
        assert.equal(isAuthSensitive('poc', 0, []), true);
    });
    it('net is shared at depth 0 and sensitive at depth 1/2 (poc_set)', () => {
        assert.equal(isAuthSensitive('net', 0, []), false);
        assert.equal(isAuthSensitive('net', 1, []), true);
        assert.equal(isAuthSensitive('net', 2, []), true);
    });
    it('detail views follow parent expansion; lists do not', () => {
        // netixlan / ixpfx detail at depth≥1 carry an ixlan object (gated column)
        assert.equal(isAuthSensitive('netixlan', 1, [], true), true);
        assert.equal(isAuthSensitive('ixpfx', 1, [], true), true);
        // netfac detail at depth 2 carries net serialised at depth 1 → poc_set
        assert.equal(isAuthSensitive('netfac', 1, [], true), false);
        assert.equal(isAuthSensitive('netfac', 2, [], true), true);
        // depth is capped at 2
        assert.equal(isAuthSensitive('netfac', 5, [], true), true);
        // nothing restricted reachable
        for (const tag of ['org', 'campus', 'fac', 'carrier', 'carrierfac']) {
            assert.equal(isAuthSensitive(tag, 2, [], true), false, tag);
        }
        // lists unchanged
        assert.equal(isAuthSensitive('netixlan', 1, []), false);
        assert.equal(isAuthSensitive('netfac', 2, []), false);
    });
    it('entities without a restricted child set stay shared at depth 2', () => {
        for (const tag of ['org', 'fac', 'netixlan', 'netfac', 'carrier', 'campus']) {
            assert.equal(isAuthSensitive(tag, 2, []), false, tag);
        }
    });
    it('ixlan (visibility-gated member-list URL) is sensitive; ix is sensitive at depth>0', () => {
        assert.equal(isAuthSensitive('ixlan', 0, []), true);
        assert.equal(isAuthSensitive('ix', 0, []), false);
        assert.equal(isAuthSensitive('ix', 2, []), true);
        assert.equal(isAuthSensitive('ixpfx', 0, [{ field: 'ixf_ixp_member_list_url', op: 'contains', value: 'x', entity: 'ixlan' }]), true);
        assert.equal(isRelationAuthSensitive('ix', 'ixlan'), true);
    });
    it('a cross-entity filter into a restricted or unknown entity is sensitive', () => {
        assert.equal(isAuthSensitive('net', 0, [{ field: 'role', op: 'eq', value: 'NOC', entity: 'poc' }]), true);
        assert.equal(isAuthSensitive('net', 0, [{ field: 'x', op: 'eq', value: '1', entity: 'nope' }]), true);
        assert.equal(isAuthSensitive('ixfac', 0, [{ field: 'country', op: 'eq', value: 'DE', entity: 'fac' }]), false);
    });
    it('unknown entity is sensitive (conservative)', () => {
        assert.equal(isAuthSensitive('nope', 0, []), true);
    });
    it('relations are sensitive when either end is restricted or unknown', () => {
        assert.equal(isRelationAuthSensitive('net', 'poc'), true);
        assert.equal(isRelationAuthSensitive('poc', 'net'), true);
        assert.equal(isRelationAuthSensitive('org', 'net'), false);
        assert.equal(isRelationAuthSensitive('net', undefined), true);
    });
});
