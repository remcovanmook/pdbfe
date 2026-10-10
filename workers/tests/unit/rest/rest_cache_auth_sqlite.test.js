/**
 * @fileoverview Regression: REST L1 cache keys must be partitioned by
 * auth state.
 *
 * The rest list/detail handlers keyed their cache on path + query only, so
 * an authenticated response (poc_set with Users/Private contacts at depth>0,
 * or a /v1/poc list) was replayed to the next anonymous caller for the same
 * URL. These tests run the handlers against real SQLite: an authenticated
 * request first (filling the cache), then the anonymous one, which must
 * still see only Public contacts.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, mockCtx } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';
import { H_API_AUTH, H_API_ANON } from '../../../api/http.js';
import { handleListRequest } from '../../../rest/handlers/list.js';
import { handleDetail } from '../../../rest/handlers/detail.js';
import { purgeRestCache } from '../../../rest/cache.js';

const TS = '2026-01-01T00:00:00Z';
/** @type {any} */
let db;

before(() => {
    purgeRestCache();
    const d = createSqliteD1();
    d.sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    d.sqlite.exec(`INSERT INTO "peeringdb_network" (id, org_id, name, asn, social_media, info_types, ixp_update_exclude, status, created, updated) VALUES (1, 1, 'Net', 64500, '[]', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    const ins = d.sqlite.prepare(`INSERT INTO "peeringdb_network_contact" (id, net_id, role, visible, name, phone, email, url, status, created, updated) VALUES (?, 1, 'NOC', ?, 'n', '', 'e@example.net', '', 'ok', '${TS}', '${TS}')`);
    ins.run(1, 'Public');
    ins.run(2, 'Users');
    ins.run(3, 'Private');
    db = d.db;
});

/**
 * Builds the rest query context for one auth state.
 * @param {string} entityTag
 * @param {boolean} authenticated
 * @param {string} queryString
 */
const qc = (entityTag, authenticated, queryString) => ({
    db, ctx: mockCtx, entityTag, authenticated, queryString,
    hResponse: authenticated ? H_API_AUTH : H_API_ANON,
    // these routes are auth-sensitive, so the router partitions by auth state
    cachePrefix: authenticated ? 'auth' : 'anon',
});

/** @param {boolean} authenticated @param {number} depth */
const opts = (authenticated, depth) => ({ depth, limit: 0, skip: 0, since: 0, sort: '', fields: [], pdbfe: false, authenticated });

/** @param {any} body */
const visibilities = (body) => {
    /** @type {string[]} */
    const out = [];
    const walk = (/** @type {any} */ n) => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === 'object') {
            if ('visible' in n) out.push(n.visible);
            Object.values(n).forEach(walk);
        }
    };
    walk(body);
    return out.sort();
};

describe('rest cache is partitioned by auth state', () => {
    it('detail net?depth=2: anonymous after authenticated sees only Public contacts', async () => {
        const req = new Request('https://rest.pdbfe.dev/v1/net/1?depth=2');
        const authRes = await handleDetail(req, ENTITIES.net, 1, opts(true, 2), qc('net', true, 'depth=2'));
        assert.deepEqual(visibilities(await authRes.json()), ['Private', 'Public', 'Users']);

        const anonRes = await handleDetail(req, ENTITIES.net, 1, opts(false, 2), qc('net', false, 'depth=2'));
        assert.deepEqual(visibilities(await anonRes.json()), ['Public']);
    });

    it('list v1/poc: anonymous after authenticated sees only Public contacts', async () => {
        const req = new Request('https://rest.pdbfe.dev/v1/poc');
        const authRes = await handleListRequest(req, ENTITIES.poc, [], opts(true, 0), 'v1/poc', qc('poc', true, ''));
        assert.deepEqual(visibilities(await authRes.json()), ['Private', 'Public', 'Users']);

        const anonRes = await handleListRequest(req, ENTITIES.poc, [], opts(false, 0), 'v1/poc', qc('poc', false, ''));
        assert.deepEqual(visibilities(await anonRes.json()), ['Public']);
    });

    it('list v1/net?depth=2: anonymous after authenticated sees only Public contacts', async () => {
        const req = new Request('https://rest.pdbfe.dev/v1/net?depth=2');
        await handleListRequest(req, ENTITIES.net, [], opts(true, 2), 'v1/net', qc('net', true, 'depth=2'));
        const anonRes = await handleListRequest(req, ENTITIES.net, [], opts(false, 2), 'v1/net', qc('net', false, 'depth=2'));
        assert.deepEqual(visibilities(await anonRes.json()), ['Public']);
    });
});
