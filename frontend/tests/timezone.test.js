/**
 * @fileoverview Unit tests for the timezone module.
 *
 * Tests getTimezone(), getTimezonePreference(), and setTimezone()
 * with a minimal localStorage mock. The Intl.DateTimeFormat API is
 * available natively in Node.js, so no polyfill is needed.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** @type {Map<string, string>} */
let store;

/**
 * Installs a minimal localStorage mock backed by a Map.
 * Cleared before each test.
 */
function mockLocalStorage() {
    store = new Map();
    globalThis.localStorage = /** @type {any} */ ({
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    });
}

describe('getTimezone', () => {
    beforeEach(() => mockLocalStorage());

    it('returns the browser timezone when no preference is stored', async () => {
        const { getTimezone } = await import('../js/timezone.js');
        const tz = getTimezone();
        // Node.js has Intl support — result should be a valid IANA string
        assert.equal(typeof tz, 'string');
        assert.ok(tz.length > 0, 'Should return a non-empty timezone');
        assert.ok(tz.includes('/'), `Expected IANA format (e.g. "Region/City"), got "${tz}"`);
    });

    it('returns the browser timezone when "auto" is stored', async () => {
        store.set('pdbfe-tz', 'auto');
        const { getTimezone } = await import('../js/timezone.js');
        const tz = getTimezone();
        assert.ok(tz.includes('/'), 'auto should resolve to IANA timezone');
    });

    it('returns a valid stored timezone', async () => {
        store.set('pdbfe-tz', 'Europe/Amsterdam');
        const { getTimezone } = await import('../js/timezone.js');
        const tz = getTimezone();
        assert.equal(tz, 'Europe/Amsterdam');
    });

    it('purges and falls back if stored timezone is invalid', async () => {
        store.set('pdbfe-tz', 'Invalid/Garbage');
        const { getTimezone } = await import('../js/timezone.js');
        const tz = getTimezone();
        // Should have cleared the invalid entry
        assert.equal(store.has('pdbfe-tz'), false, 'Invalid timezone should be purged');
        assert.ok(tz.includes('/'), 'Should fall back to browser timezone');
    });
});

describe('getTimezonePreference', () => {
    beforeEach(() => mockLocalStorage());

    it('returns "auto" when nothing is stored', async () => {
        const { getTimezonePreference } = await import('../js/timezone.js');
        assert.equal(getTimezonePreference(), 'auto');
    });

    it('returns "auto" when "auto" is stored', async () => {
        store.set('pdbfe-tz', 'auto');
        const { getTimezonePreference } = await import('../js/timezone.js');
        assert.equal(getTimezonePreference(), 'auto');
    });

    it('returns the stored timezone when valid', async () => {
        store.set('pdbfe-tz', 'US/Eastern');
        const { getTimezonePreference } = await import('../js/timezone.js');
        assert.equal(getTimezonePreference(), 'US/Eastern');
    });

    it('returns "auto" and purges when stored timezone is invalid', async () => {
        store.set('pdbfe-tz', 'Not/Real');
        const { getTimezonePreference } = await import('../js/timezone.js');
        assert.equal(getTimezonePreference(), 'auto');
        assert.equal(store.has('pdbfe-tz'), false);
    });
});

describe('setTimezone', () => {
    beforeEach(() => mockLocalStorage());

    it('stores a valid IANA timezone', async () => {
        const { setTimezone } = await import('../js/timezone.js');
        setTimezone('Asia/Tokyo');
        assert.equal(store.get('pdbfe-tz'), 'Asia/Tokyo');
    });

    it('removes the key when set to "auto"', async () => {
        store.set('pdbfe-tz', 'Europe/London');
        const { setTimezone } = await import('../js/timezone.js');
        setTimezone('auto');
        assert.equal(store.has('pdbfe-tz'), false);
    });

    it('removes the key for empty/null input', async () => {
        store.set('pdbfe-tz', 'Europe/London');
        const { setTimezone } = await import('../js/timezone.js');
        setTimezone('');
        assert.equal(store.has('pdbfe-tz'), false);
    });

    it('ignores invalid timezone strings', async () => {
        const { setTimezone } = await import('../js/timezone.js');
        setTimezone('Fake/Zone');
        assert.equal(store.has('pdbfe-tz'), false, 'Invalid timezone should not be stored');
    });
});
