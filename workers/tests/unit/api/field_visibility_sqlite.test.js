/**
 * @fileoverview Guard: ixlan.ixf_ixp_member_list_url is served only per its
 * row's ixf_ixp_member_list_url_visible (anonymous → Public, authenticated →
 * Public/Users, Private → never), on every path, against real SQLite.
 *
 * Found by the upstream comparison benchmark: the mirror served Users-only
 * IX-F member export URLs to anonymous callers via /api/ixlan and
 * ix?depth=2, where upstream omits the field.
 *
 * The core assertion is on raw response bodies: an anonymous body must
 * never contain the Users/Private URLs, an authenticated one never the
 * Private URL — whatever the route, depth, fields=, filter or sort.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, mockCtx } from '../../lib/sqlite_d1.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { default: restWorker } = await import('../../../rest/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');
const { purgeRestCache } = await import('../../../rest/cache.js');
const { resolvers } = await import('../../../../extracted/graphql-resolvers.js');

const TS = '2026-01-01T00:00:00Z';
const SID = 'b'.repeat(64);
const URL_PUBLIC = 'https://example.net/ixf-public.json';
const URL_USERS = 'https://example.net/ixf-users.json';
const URL_PRIVATE = 'https://example.net/ixf-private.json';

/** @type {any} */
let env;

before(() => {
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    const ix = sqlite.prepare(`INSERT INTO "peeringdb_ix" (id, org_id, name, social_media, status, created, updated) VALUES (?, 1, ?, '[]', 'ok', '${TS}', '${TS}')`);
    const ixlan = sqlite.prepare(`INSERT INTO "peeringdb_ixlan" (id, ix_id, name, ixf_ixp_member_list_url, ixf_ixp_member_list_url_visible, status, created, updated) VALUES (?, ?, '', ?, ?, 'ok', '${TS}', '${TS}')`);
    const ixpfx = sqlite.prepare(`INSERT INTO "peeringdb_ixlan_prefix" (id, ixlan_id, protocol, prefix, status, created, updated) VALUES (?, ?, 'IPv4', ?, 'ok', '${TS}', '${TS}')`);
    const rows = [[1, URL_PUBLIC, 'Public'], [2, URL_USERS, 'Users'], [3, URL_PRIVATE, 'Private']];
    for (const [id, url, vis] of rows) {
        ix.run(id, `IX ${id}`);
        ixlan.run(id, id, url, vis);
        ixpfx.run(id, id, `192.0.2.${id}/32`);
    }
    const sessions = {
        get: async (/** @type {string} */ key) => (key === `session:${SID}` ? { id: 7, name: 'T', given_name: 'T', family_name: 'U', email: 't@example.net' } : null),
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
    const res = await worker.fetch(new Request(url, { headers: authed ? { Authorization: `Bearer ${SID}` } : {} }), env, mockCtx);
    const text = await res.text();
    return { status: res.status, text, body: res.ok ? JSON.parse(text) : null, cc: res.headers.get('Cache-Control') };
}

/** Raw-body invariant per auth state. */
function assertNoHiddenUrls(/** @type {string} */ text, /** @type {boolean} */ authed, /** @type {string} */ label) {
    assert.ok(!text.includes(URL_PRIVATE), `${label}: Private URL leaked`);
    if (!authed) assert.ok(!text.includes(URL_USERS), `${label}: Users URL leaked to anonymous`);
}

const API = 'https://api.pdbfe.dev/api';
const REST = 'https://rest.pdbfe.dev/v1';

const ROUTES = [
    [apiWorker, `${API}/ixlan`],
    [apiWorker, `${API}/ixlan/2`],
    [apiWorker, `${API}/ixlan/3`],
    [apiWorker, `${API}/ixlan?depth=1`],
    [apiWorker, `${API}/ixlan?fields=id,ixf_ixp_member_list_url`],
    [apiWorker, `${API}/ixlan?ix_id=2`],
    [apiWorker, `${API}/ix/2?depth=2`],
    [apiWorker, `${API}/ix?depth=2`],
    [apiWorker, `${API}/ixlan?page=1&per_page=10`],
    [apiWorker, `${API}/ixlan?sort=ixf_ixp_member_list_url`],
    [restWorker, `${REST}/ixlan`],
    [restWorker, `${REST}/ixlan/2`],
    [restWorker, `${REST}/ix/2?depth=2`],
    [restWorker, `${REST}/ix/2/exchange-lans`],
];

describe('member-list URL never leaks past its visibility', () => {
    for (const [worker, url] of ROUTES) {
        for (const authed of [false, true]) {
            it(`${authed ? 'auth' : 'anon'} ${url.replace('https://', '')}`, async () => {
                const r = await get(worker, url, authed);
                assert.equal(r.status, 200, r.text);
                assertNoHiddenUrls(r.text, authed, url);
                if (authed) assert.ok(r.cc?.startsWith('private'), 'auth response must not be shared');
            });
        }
    }

    it('anonymous sees the Public URL; authenticated also sees Users', async () => {
        const anon = (await get(apiWorker, `${API}/ixlan`, false)).body.data;
        const auth = (await get(apiWorker, `${API}/ixlan`, true)).body.data;
        assert.deepEqual(anon.map((/** @type {any} */ r) => r.ixf_ixp_member_list_url ?? null), [URL_PUBLIC, null, null]);
        assert.deepEqual(auth.map((/** @type {any} */ r) => r.ixf_ixp_member_list_url ?? null), [URL_PUBLIC, URL_USERS, null]);
        // hidden values are omitted entirely, as upstream does
        assert.equal('ixf_ixp_member_list_url' in anon[1], false);
        assert.equal(anon[1].ixf_ixp_member_list_url_visible, 'Users');
    });
});

describe('filters and sorts on the URL see only visible values', () => {
    const cases = [
        ['ixlan?ixf_ixp_member_list_url__contains=users', 0, 1],
        ['ixlan?ixf_ixp_member_list_url__contains=private', 0, 0],
        [`ixlan?ixf_ixp_member_list_url=${encodeURIComponent(URL_USERS)}`, 0, 1],
        ['ixlan?ixf_ixp_member_list_url__startswith=https', 1, 2],
        ['ixpfx?ixlan__ixf_ixp_member_list_url__contains=users', 0, 1],
        ['ixpfx?ixlan__ixf_ixp_member_list_url__contains=private', 0, 0],
    ];
    for (const [path, anonRows, authRows] of cases) {
        it(`${path} → anon ${anonRows} / auth ${authRows}`, async () => {
            const anon = await get(apiWorker, `${API}/${path}`, false);
            const auth = await get(apiWorker, `${API}/${path}`, true);
            assert.equal(anon.status, 200, anon.text);
            assert.equal(anon.body.data.length, anonRows, 'anon');
            assert.equal(auth.body.data.length, authRows, 'auth');
        });
    }

    it('sort by the URL orders hidden values as null (no ordering oracle)', async () => {
        const anon = (await get(apiWorker, `${API}/ixlan?sort=ixf_ixp_member_list_url`, false)).body.data;
        const auth = (await get(apiWorker, `${API}/ixlan?sort=ixf_ixp_member_list_url`, true)).body.data;
        assert.deepEqual(anon.map((/** @type {any} */ r) => r.id), [2, 3, 1]);
        assert.deepEqual(auth.map((/** @type {any} */ r) => r.id), [3, 1, 2]);
    });
});

describe('GraphQL resolvers', () => {
    const gctx = (/** @type {boolean} */ authenticated) => ({ db: env.PDB, authenticated });

    for (const authed of [false, true]) {
        it(`${authed ? 'auth' : 'anon'} exchangeLans / exchangeLan / Exchange.exchangeLans`, async () => {
            const list = await resolvers.Query.exchangeLans(null, { where: {} }, gctx(authed));
            const one = await resolvers.Query.exchangeLan(null, { id: 2 }, gctx(authed));
            const nested = await resolvers.Exchange.exchangeLans({ id: 2 }, {}, gctx(authed));
            const text = JSON.stringify([list, one, nested]);
            assertNoHiddenUrls(text, authed, 'graphql');
            assert.equal(one.ixf_ixp_member_list_url ?? null, authed ? URL_USERS : null);
        });
    }
});
