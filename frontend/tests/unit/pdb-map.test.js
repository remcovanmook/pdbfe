/**
 * @fileoverview Unit tests for loadLeaflet() and preconnectTiles() in
 * components/pdb-map.js: Leaflet's stylesheet and script are added once, on
 * first use, and a failed load is retried by the next map; the tile server
 * gets one preconnect, when a map is first mounted.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDOM } from '../helpers/mock-dom.js';

createMockDOM();
globalThis.HTMLElement ??= /** @type {any} */ (class {});

/**
 * A fresh copy of the module per test: loadLeaflet() remembers a load for
 * the page's lifetime, which is the point, but tests need a clean start.
 */
let copy = 0;
const freshModule = async () => import(`../../js/components/pdb-map.js?copy=${++copy}`);
const freshLoadLeaflet = async () => (await freshModule()).loadLeaflet;

/** Elements appended to <head>; `outcome` decides whether each load succeeds. */
let appended = /** @type {any[]} */ ([]);
let outcome = 'load';

beforeEach(() => {
    appended = [];
    outcome = 'load';
    delete (/** @type {any} */ (globalThis)).L;
    globalThis.document.createElement = /** @type {any} */ ((tag) => {
        /** @type {Record<string, Function>} */
        const listeners = {};
        return { tagName: tag.toUpperCase(), addEventListener: (type, fn) => { listeners[type] = fn; }, _fire: (type) => listeners[type]?.() };
    });
    globalThis.document.head.appendChild = /** @type {any} */ ((el) => {
        appended.push(el);
        queueMicrotask(() => el._fire(outcome));
        return el;
    });
});

describe('loadLeaflet', () => {
    it('adds the stylesheet and the script once, however many maps ask', async () => {
        const loadLeaflet = await freshLoadLeaflet();
        await Promise.all([loadLeaflet(), loadLeaflet(), loadLeaflet()]);
        assert.deepEqual(appended.map((e) => e.tagName), ['LINK', 'SCRIPT']);
        assert.equal(appended[0].rel, 'stylesheet');
        assert.equal(appended[0].href, '/third_party/leaflet/leaflet.css');
        assert.equal(appended[1].src, '/third_party/leaflet/leaflet.js');
    });

    it('does nothing when Leaflet is already on the page', async () => {
        const loadLeaflet = await freshLoadLeaflet();
        /** @type {any} */ (globalThis).L = {};
        await loadLeaflet();
        assert.equal(appended.length, 0);
    });

    it('rejects a failed load and tries again on the next call', async () => {
        const loadLeaflet = await freshLoadLeaflet();
        outcome = 'error';
        await assert.rejects(loadLeaflet(), /failed to load/);
        outcome = 'load';
        await loadLeaflet();
        assert.equal(appended.length, 4, 'a second pair of elements for the retry');
    });
});

describe('preconnectTiles', () => {
    it('adds one preconnect to the tile server, without crossorigin', async () => {
        const { preconnectTiles } = await freshModule();
        preconnectTiles();
        preconnectTiles();
        assert.equal(appended.length, 1);
        assert.equal(appended[0].tagName, 'LINK');
        assert.equal(appended[0].rel, 'preconnect');
        assert.equal(appended[0].href, 'https://tile.openstreetmap.org');
        assert.equal(appended[0].crossOrigin, undefined, 'tiles are plain image requests');
    });
});
