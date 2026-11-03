/**
 * @fileoverview Keeps _redirects in step with the router.
 *
 * Pages answers 404 for any path _redirects does not list, so a route added to
 * boot.js but not to _redirects would work in the SPA and fail on a reload.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const shape = (path) => path.replace(/:[^/]+/g, ':id');

describe('_redirects', () => {
    it('lists exactly the routes registered in boot.js', () => {
        const routes = [...read('js/boot.js').matchAll(/add(?:Lazy)?Route\('([^']+)'/g)]
            .map((m) => shape(m[1]))
            .filter((route) => route !== '/');
        const rules = read('_redirects').split('\n')
            .filter((line) => line && !line.startsWith('#'))
            .map((line) => line.split(/\s+/));
        assert.ok(routes.length > 0);
        assert.deepEqual(rules.map(([source]) => source).sort(), routes.sort());
        for (const [source, target, status] of rules) {
            assert.deepEqual([target, status], ['/', '200'], source);
        }
    });
});
