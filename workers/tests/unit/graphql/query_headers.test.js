/**
 * @fileoverview Cache headers on GraphQL query results (graphql/handlers/query.js):
 * valid until the next sync, private for authenticated callers.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleQuery, handleUncached } from '../../../graphql/handlers/query.js';
import { purgeGqlCache } from '../../../graphql/cache.js';

const db = /** @type {any} */ ({});
const ctx = /** @type {any} */ ({ waitUntil() {}, passThroughOnException() {} });
const ALIGNED = /^(public|private), max-age=\d+, stale-while-revalidate=\d+$/;

/** @param {string} query */
const post = (query) => new Request('https://graphql.pdbfe.dev/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
});

describe('GraphQL result Cache-Control', () => {
    beforeEach(() => purgeGqlCache());

    it('anonymous POST: public until the next sync, varying on Authorization', async () => {
        const res = /** @type {Response} */ (await handleQuery(post('{__typename}'), db, ctx, false));
        assert.equal(res.status, 200);
        assert.match(res.headers.get('Cache-Control') ?? '', ALIGNED);
        assert.ok(res.headers.get('Cache-Control')?.startsWith('public'));
        assert.equal(res.headers.get('Vary'), 'Authorization');
    });

    it('authenticated POST: private', async () => {
        const res = /** @type {Response} */ (await handleQuery(post('{__typename}'), db, ctx, true));
        assert.ok(res.headers.get('Cache-Control')?.startsWith('private, max-age='));
    });

    it('GET query: the same headers', async () => {
        const res = await handleUncached(new Request('https://graphql.pdbfe.dev/?query=%7B__typename%7D'), db, false);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('Cache-Control') ?? '', ALIGNED);
        assert.deepEqual(await res.json(), { data: { __typename: 'Query' } });
    });
});
