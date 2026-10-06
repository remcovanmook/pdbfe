/**
 * @fileoverview ?page / ?per_page (upstream page-number pagination), end to
 * end through the api worker on real SQLite. Expected values mirror what
 * www.peeringdb.com returns for the same request shapes (probed 2026-10-07).
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');
const { default: restWorker } = await import('../../../rest/index.js');
const { purgeAllCaches } = await import('../../../api/cache.js');
const { pageLink, parsePageNumber, parsePerPage } = await import('../../../api/handlers/paged.js');

const TS = '2026-01-01T00:00:00Z';
const API = 'https://api.pdbfe.dev/api';
/** @type {any} */
let env;

before(() => {
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    const ix = sqlite.prepare(`INSERT INTO "peeringdb_ix" (id, org_id, name, country, social_media, status, created, updated) VALUES (?, 1, ?, ?, '[]', 'ok', '${TS}', '${TS}')`);
    // ids 1..7: NL, NL, DE, NL, NL, DE, NL
    const countries = ['NL', 'NL', 'DE', 'NL', 'NL', 'DE', 'NL'];
    for (let i = 1; i <= 7; i++) ix.run(i, `IX ${i}`, countries[i - 1]);
    env = envFor(db);
});

beforeEach(() => purgeAllCaches());

/** @param {string} path */
async function get(path) {
    const res = await apiWorker.fetch(new Request(`${API}/${path}`), env, mockCtx);
    return { status: res.status, body: await res.json() };
}

const ids = (/** @type {any} */ body) => body.data.map((/** @type {any} */ r) => r.id);

describe('page / per_page', () => {
    it('first page with links', async () => {
        const { status, body } = await get('ix?page=1&per_page=2');
        assert.equal(status, 200);
        assert.deepEqual(ids(body), [1, 2]);
        assert.deepEqual(body.meta.pagination, {
            count: 7, has_next: true, has_previous: false,
            next: `${API}/ix?page=2&per_page=2`, previous: null,
            page: 1, per_page: 2, total_pages: 4,
        });
    });

    it('middle page keeps other params sorted; previous of page 2 drops page', async () => {
        const { body } = await get('ix?page=2&per_page=2&country=NL');
        assert.deepEqual(ids(body), [4, 5]);
        assert.equal(body.meta.pagination.count, 5);
        assert.equal(body.meta.pagination.next, `${API}/ix?country=NL&page=3&per_page=2`);
        assert.equal(body.meta.pagination.previous, `${API}/ix?country=NL&per_page=2`);
    });

    it('last page has no next', async () => {
        const { body } = await get('ix?page=4&per_page=2');
        assert.deepEqual(ids(body), [7]);
        assert.equal(body.meta.pagination.has_next, false);
        assert.equal(body.meta.pagination.next, null);
        assert.equal(body.meta.pagination.previous, `${API}/ix?page=3&per_page=2`);
    });

    for (const pp of ['0', 'abc', '-5', '251', '1000']) {
        it(`per_page=${pp} falls back to 250`, async () => {
            const { status, body } = await get(`ix?page=1&per_page=${pp}`);
            assert.equal(status, 200);
            assert.equal(body.meta.pagination.per_page, 250);
            assert.equal(body.data.length, 7);
        });
    }

    for (const p of ['0', '-1', 'abc', '', '2', '99']) {
        it(`page=${p} is 404 Invalid page.`, async () => {
            const { status, body } = await get(`ix?page=${p}`);
            assert.equal(status, 404);
            assert.match(JSON.stringify(body), /Invalid page\./);
        });
    }

    it('page 1 of an empty result is valid; page 2 is not', async () => {
        const first = await get('ix?country=XX&page=1');
        assert.equal(first.status, 200);
        assert.deepEqual(first.body.data, []);
        assert.deepEqual(first.body.meta.pagination, {
            count: 0, has_next: false, has_previous: false, next: null, previous: null,
            page: 1, per_page: 250, total_pages: 1,
        });
        assert.equal((await get('ix?country=XX&page=2')).status, 404);
    });

    it('limit/skip define the set; pages are cut from it', async () => {
        const { body } = await get('ix?page=2&per_page=2&limit=5&skip=1');
        assert.deepEqual(ids(body), [4, 5]);
        assert.equal(body.meta.pagination.count, 5);
        assert.equal(body.meta.pagination.total_pages, 3);
        assert.equal(body.meta.pagination.next, `${API}/ix?limit=5&page=3&per_page=2&skip=1`);
        assert.equal(body.meta.pagination.previous, `${API}/ix?limit=5&per_page=2&skip=1`);
    });

    it('page with limit=0 paginates the full set (not count mode)', async () => {
        const { body } = await get('ix?page=1&per_page=2&limit=0');
        assert.deepEqual(ids(body), [1, 2]);
        assert.equal(body.meta.pagination.count, 7);
    });

    it('per_page alone is ignored: full list, no pagination meta', async () => {
        const { status, body } = await get('ix?per_page=2');
        assert.equal(status, 200);
        assert.equal(body.data.length, 7);
        assert.deepEqual(body.meta, {});
    });

    it('works with depth', async () => {
        const { status, body } = await get('ix?page=2&per_page=3&depth=1');
        assert.equal(status, 200);
        assert.deepEqual(ids(body), [4, 5, 6]);
        assert.ok(Array.isArray(body.data[0].ixlan_set));
        assert.equal(body.meta.pagination.total_pages, 3);
    });

    it('works with the .json suffix', async () => {
        const { body } = await get('ix.json?page=1&per_page=3');
        assert.deepEqual(ids(body), [1, 2, 3]);
        assert.equal(body.meta.pagination.next, `${API}/ix.json?page=2&per_page=3`);
    });

    it('detail requests ignore page', async () => {
        const { status, body } = await get('ix/3?page=5');
        assert.equal(status, 200);
        assert.deepEqual(ids(body), [3]);
        assert.deepEqual(body.meta, {});
    });

    it('rest rejects page/per_page with 400', async () => {
        const res = await restWorker.fetch(new Request('https://rest.pdbfe.dev/v1/ix?page=1'), env, mockCtx);
        assert.equal(res.status, 400);
    });
});

describe('paged.js helpers', () => {
    it('parsePageNumber', () => {
        assert.equal(parsePageNumber('1'), 1);
        assert.equal(parsePageNumber('12'), 12);
        for (const bad of ['0', '-1', '1.5', 'abc', '']) assert.equal(parsePageNumber(bad), null, bad);
    });
    it('parsePerPage', () => {
        assert.equal(parsePerPage(null), 250);
        assert.equal(parsePerPage('100'), 100);
        assert.equal(parsePerPage('250'), 250);
        for (const bad of ['0', '251', 'x', '-3', '']) assert.equal(parsePerPage(bad), 250, bad);
    });
    it('pageLink sorts by key, keeps raw values and duplicates, drops page for page 1', () => {
        const base = 'https://api.pdbfe.dev/api/net';
        assert.equal(pageLink(base, 'page=3&per_page=0&asn__in=1,2&name=a%20b', 2), `${base}?asn__in=1,2&name=a%20b&page=2&per_page=0`);
        assert.equal(pageLink(base, 'page=2', 1), base);
        assert.equal(pageLink(base, 'x=1&x=2&page=2', 3), `${base}?page=3&x=1&x=2`);
    });
});
