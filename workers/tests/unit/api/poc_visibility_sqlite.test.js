/**
 * @fileoverview End-to-end poc visibility guard against a real SQLite engine.
 *
 * The anonymous poc gates in the api/rest handlers and GraphQL resolvers
 * were removed in favour of the single WHERE-builder pin in api/query.js
 * (anonymous callers only ever see visible=Public). The other unit tests
 * mock D1 and cannot execute SQL, so this suite loads extracted/schema.sql
 * into node:sqlite, seeds contacts of every visibility, and drives every
 * route shape anonymously. Any non-Public row in a response fails the suite.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

// The rest worker imports non-JS assets the way wrangler bundles them:
// openapi.json without an import attribute, .html/.css as text, fonts as
// binary data. Node refuses all three, so this loader supplies the JSON
// attribute and serves other assets as a default export (string for text,
// ArrayBuffer for binary), letting the rest worker be imported here.
register('data:text/javascript,' + encodeURIComponent(`
    import { readFileSync } from 'node:fs';
    const TEXT = ['.html', '.css', '.txt', '.md', '.svg'];
    export async function load(url, context, next) {
        if (!url.startsWith('file:') || /\\.[cm]?js$/.test(url)) return next(url, context);
        if (url.endsWith('.json')) {
            return next(url, { ...context, importAttributes: { type: 'json' } });
        }
        const buf = readFileSync(new URL(url));
        const source = TEXT.some(ext => url.endsWith(ext))
            ? 'export default ' + JSON.stringify(buf.toString('utf8'))
            : 'export default Uint8Array.from(atob(' + JSON.stringify(buf.toString('base64')) + '), c => c.charCodeAt(0)).buffer';
        return { format: 'module', source, shortCircuit: true };
    }
`));

const { default: apiWorker } = await import('../../../api/index.js');
const { default: restWorker } = await import('../../../rest/index.js');

const SCHEMA = readFileSync(new URL('../../../../extracted/schema.sql', import.meta.url), 'utf8');

/** Seeded contacts: one per visibility level, all on net 1, all status=ok. */
const CONTACTS = [
    { id: 1, visible: 'Public', role: 'NOC' },
    { id: 2, visible: 'Users', role: 'NOC' },
    { id: 3, visible: 'Private', role: 'NOC' },
];
const PUBLIC_IDS = [1];

/**
 * Wraps a node:sqlite database in the subset of the D1 API the workers use.
 *
 * @param {DatabaseSync} sqlite - Seeded in-memory database.
 * @returns {any} D1-compatible binding.
 */
function d1(sqlite) {
    const prepare = (/** @type {string} */ sql) => {
        const stmt = sqlite.prepare(sql);
        /** @param {any[]} args */
        const bound = (args) => ({
            all: async () => ({ results: stmt.all(...args), success: true, meta: {} }),
            first: async () => stmt.get(...args) ?? null,
            run: async () => { stmt.run(...args); return { success: true, meta: {}, results: [] }; },
        });
        return { ...bound([]), bind: (/** @type {any[]} */ ...args) => bound(args) };
    };
    return {
        withSession() { return this; },
        prepare,
        batch: async (/** @type {any[]} */ stmts) => Promise.all(stmts.map(s => s.all())),
    };
}

/** @returns {any} KV mock with no sessions (every caller is anonymous). */
function kv() {
    return { get: async () => null, put: async () => {}, delete: async () => {} };
}

const ctx = /** @type {any} */ ({ waitUntil(p) { p.catch(() => {}); }, passThroughOnException() {} });

/** @type {any} */
let env;

/**
 * Collects every object carrying a `visible` field anywhere in a payload,
 * so nested poc_set / contacts arrays are checked as well as top-level rows.
 *
 * @param {any} node - Parsed JSON value.
 * @param {any[]} [out] - Accumulator.
 * @returns {any[]} Objects with a `visible` property.
 */
function withVisible(node, out = []) {
    if (Array.isArray(node)) {
        for (const n of node) withVisible(n, out);
    } else if (node && typeof node === 'object') {
        if ('visible' in node) out.push(node);
        for (const v of Object.values(node)) withVisible(v, out);
    }
    return out;
}

/**
 * Asserts a response leaks no non-Public contact.
 *
 * @param {any} body - Parsed response body.
 * @param {string} label - Route label for messages.
 * @returns {any[]} The contacts found.
 */
function assertOnlyPublic(body, label) {
    const contacts = withVisible(body);
    for (const c of contacts) {
        assert.equal(c.visible, 'Public', `${label} leaked poc ${c.id} (visible=${c.visible})`);
    }
    return contacts;
}

before(() => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(SCHEMA);
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, status, created, updated) VALUES (1, 'Org', 'ok', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    sqlite.exec(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, status, created, updated) VALUES (1, 1, 'Net', 64500, 'ok', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    const ins = sqlite.prepare(`INSERT INTO "peeringdb_network_contact" (id, net_id, role, visible, name, phone, email, url, status, created, updated) VALUES (?, 1, ?, ?, 'n', '', 'e@example.net', '', 'ok', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    for (const c of CONTACTS) ins.run(c.id, c.role, c.visible);
    env = { PDB: d1(sqlite), SESSIONS: kv(), ADMIN_SECRET: 'x', PDBFE_VERSION: '0.0.0' };
});

describe('anonymous poc visibility — api worker', () => {
    const lists = ['/api/poc', '/api/poc?net_id=1', '/api/poc?role=NOC', '/api/poc?visible=Users', '/api/poc?visible=Private', '/api/poc?limit=1'];
    for (const path of lists) {
        it(`${path} returns only public contacts`, async () => {
            const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev${path}`), env, ctx);
            assert.equal(res.status, 200);
            const contacts = assertOnlyPublic(await res.json(), path);
            assert.deepEqual(contacts.map(c => c.id), PUBLIC_IDS, `${path} should return the public contact`);
        });
    }

    it('/api/poc/{public id} returns the contact', async () => {
        const res = await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/poc/1'), env, ctx);
        assert.equal(res.status, 200);
        assert.deepEqual(assertOnlyPublic(await res.json(), 'detail').map(c => c.id), [1]);
    });

    for (const id of [2, 3]) {
        it(`/api/poc/${id} (non-public) returns 404`, async () => {
            const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev/api/poc/${id}`), env, ctx);
            assert.equal(res.status, 404);
        });
    }

    for (const path of ['/api/net/1?depth=1', '/api/net/1?depth=2', '/api/net?depth=2']) {
        it(`${path} nests only public contacts`, async () => {
            const res = await apiWorker.fetch(new Request(`https://api.pdbfe.dev${path}`), env, ctx);
            assert.equal(res.status, 200);
            assertOnlyPublic(await res.json(), path);
        });
    }
});

describe('anonymous poc visibility — rest worker', () => {
    for (const path of ['/v1/poc', '/v1/poc?net_id=1', '/v1/poc?visible=Users', '/v1/net/1/contacts']) {
        it(`${path} returns only public contacts`, async () => {
            const res = await restWorker.fetch(new Request(`https://rest.pdbfe.dev${path}`), env, ctx);
            assert.equal(res.status, 200);
            const contacts = assertOnlyPublic(await res.json(), path);
            assert.deepEqual(contacts.map(c => c.id), PUBLIC_IDS, `${path} should return the public contact`);
        });
    }

    for (const id of [2, 3]) {
        it(`/v1/poc/${id} (non-public) returns no data`, async () => {
            const res = await restWorker.fetch(new Request(`https://rest.pdbfe.dev/v1/poc/${id}`), env, ctx);
            const body = res.status === 200 ? await res.json() : { data: [] };
            assert.deepEqual(body.data, []);
        });
    }
});

describe('poc visibility — graphql resolvers', () => {
    /** @type {any} */
    let resolvers;
    before(async () => {
        ({ resolvers } = await import('../../../../extracted/graphql-resolvers.js'));
    });

    /** @param {boolean} authenticated */
    const gctx = (authenticated) => ({ db: env.PDB, authenticated });

    it('anon pocs list returns only public contacts', async () => {
        const rows = await resolvers.Query.pocs(null, { where: {} }, gctx(false));
        assert.deepEqual(rows.map((/** @type {any} */ r) => r.id), PUBLIC_IDS);
    });

    it('anon pocs list ignores a spoofed visible filter', async () => {
        const rows = await resolvers.Query.pocs(null, { where: { visible: 'Users' } }, gctx(false));
        assert.deepEqual(rows.map((/** @type {any} */ r) => r.id), PUBLIC_IDS);
    });

    it('anon poc detail resolves public, nulls non-public', async () => {
        assert.equal((await resolvers.Query.poc(null, { id: 1 }, gctx(false)))?.id, 1);
        assert.equal(await resolvers.Query.poc(null, { id: 2 }, gctx(false)), null);
        assert.equal(await resolvers.Query.poc(null, { id: 3 }, gctx(false)), null);
    });

    it('anon pocsConnection counts and pages only public contacts', async () => {
        const conn = await resolvers.Query.pocsConnection(null, { where: {} }, gctx(false));
        assert.equal(conn.totalCount, 1);
        assert.deepEqual(conn.edges.map((/** @type {any} */ e) => e.node.id), PUBLIC_IDS);
    });

    it('anon Network.pointsOfContact returns only public contacts', async () => {
        const rows = await resolvers.Network.pointsOfContact({ id: 1 }, {}, gctx(false));
        assert.deepEqual(rows.map((/** @type {any} */ r) => r.id), PUBLIC_IDS);
    });

    it('authenticated pocs list, detail and connection see every visibility', async () => {
        const all = CONTACTS.map(c => c.id);
        const rows = await resolvers.Query.pocs(null, { where: {} }, gctx(true));
        assert.deepEqual(rows.map((/** @type {any} */ r) => r.id), all);
        assert.equal((await resolvers.Query.poc(null, { id: 2 }, gctx(true)))?.id, 2);
        const conn = await resolvers.Query.pocsConnection(null, { where: {} }, gctx(true));
        assert.equal(conn.totalCount, all.length);
        const nested = await resolvers.Network.pointsOfContact({ id: 1 }, {}, gctx(true));
        assert.deepEqual(nested.map((/** @type {any} */ r) => r.id), all);
    });
});
