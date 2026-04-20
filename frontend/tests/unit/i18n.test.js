/**
 * @fileoverview Unit tests for the i18n module.
 * Verifies translation lookup, interpolation, XSS escaping,
 * browser detection fallback, and localStorage persistence.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM/browser stubs for the module
globalThis.document = { documentElement: { lang: 'en' } };
globalThis.localStorage = (() => {
    let store = {};
    return {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
        clear: () => { store = {}; },
    };
})();

/** @param {string} lang */
function setNavigatorLang(lang) {
    Object.defineProperty(globalThis, 'navigator', {
        value: { language: lang },
        writable: true,
        configurable: true,
    });
}
setNavigatorLang('en');

globalThis.fetch = async () => ({ ok: false });

// Import after stubs are set up
const { t, initI18n, setLanguage, getCurrentLang, LANGUAGES } = await import('../../js/i18n.js');

// ── t() function ─────────────────────────────────────────────────────────────

describe('t() — translation lookup', () => {
    it('returns the key unchanged when no dictionary is loaded', () => {
        assert.equal(t('Hello'), 'Hello');
    });

    it('returns the key unchanged for unknown keys', () => {
        assert.equal(t('never_translated_key'), 'never_translated_key');
    });
});

describe('t() — interpolation', () => {
    it('replaces {var} placeholders with values', () => {
        // Without a loaded dictionary, t() still does interpolation on the key
        assert.equal(t('Hello {name}', { name: 'World' }), 'Hello World');
    });

    it('replaces multiple placeholders', () => {
        assert.equal(
            t('{a} and {b}', { a: 'foo', b: 'bar' }),
            'foo and bar'
        );
    });

    it('leaves unknown placeholders intact', () => {
        assert.equal(t('{known} {unknown}', { known: 'X' }), 'X {unknown}');
    });
});

describe('t() — XSS escaping', () => {
    it('escapes HTML in interpolated values', () => {
        const result = t('Hello {name}', { name: '<script>alert(1)</script>' });
        assert.ok(!result.includes('<script>'));
        assert.ok(result.includes('&lt;script&gt;'));
    });

    it('escapes ampersands in interpolated values', () => {
        const result = t('{x}', { x: 'a&b' });
        assert.equal(result, 'a&amp;b');
    });

    it('escapes quotes in interpolated values', () => {
        const result = t('{x}', { x: 'a"b' });
        assert.ok(result.includes('&quot;'));
    });
});

// ── initI18n ─────────────────────────────────────────────────────────────────

describe('initI18n', () => {
    beforeEach(() => {
        localStorage.clear();
        setNavigatorLang('en');
    });

    it('does not fetch when browser language is English', async () => {
        let fetched = false;
        globalThis.fetch = async () => { fetched = true; return { ok: false }; };

        await initI18n();
        assert.equal(fetched, false);
        assert.equal(getCurrentLang(), 'en');
    });

    it('fetches locale JSON when browser language is non-English', async () => {
        setNavigatorLang('pt');
        let fetchedUrl = '';
        globalThis.fetch = async (url) => {
            fetchedUrl = url;
            return {
                ok: true,
                json: async () => ({ 'Hello': 'Olá' }),
            };
        };

        await initI18n();
        assert.equal(fetchedUrl, '/locales/pt.json');
        assert.equal(getCurrentLang(), 'pt');
        assert.equal(t('Hello'), 'Olá');
    });

    it('uses localStorage preference over browser language', async () => {
        localStorage.setItem('pdbfe-lang', 'de');
        setNavigatorLang('fr');
        globalThis.fetch = async (url) => ({
            ok: true,
            json: async () => ({ 'Hello': 'Hallo' }),
        });

        await initI18n();
        assert.equal(getCurrentLang(), 'de');
        assert.equal(t('Hello'), 'Hallo');
    });

    it('falls back to English on fetch failure', async () => {
        setNavigatorLang('ja');
        globalThis.fetch = async () => { throw new Error('network error'); };

        await initI18n();
        assert.equal(getCurrentLang(), 'en');
        assert.equal(t('Hello'), 'Hello');
    });
});

// ── setLanguage ──────────────────────────────────────────────────────────────

describe('setLanguage', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('stores preference in localStorage', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({ 'Yes': 'Sí' }),
        });

        await setLanguage('es');
        assert.equal(localStorage.getItem('pdbfe-lang'), 'es');
        assert.equal(getCurrentLang(), 'es');
        assert.equal(t('Yes'), 'Sí');
    });

    it('calls the onSwitch callback after loading', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({}),
        });

        let called = false;
        await setLanguage('fr', () => { called = true; });
        assert.equal(called, true);
    });

    it('switches back to English and clears dictionary', async () => {
        // First load a non-English locale
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({ 'Hello': 'Bonjour' }),
        });
        await setLanguage('fr');
        assert.equal(t('Hello'), 'Bonjour');

        // Switch back to English
        await setLanguage('en');
        assert.equal(getCurrentLang(), 'en');
        assert.equal(t('Hello'), 'Hello');
    });
});

// ── LANGUAGES map ────────────────────────────────────────────────────────────

describe('LANGUAGES', () => {
    it('contains the curated upstream language set', () => {
        const expected = [
            'en', 'cs', 'de', 'el', 'es', 'fr', 'it',
            'ja', 'lt', 'pt', 'ro', 'ru', 'zh-cn', 'zh-tw',
        ];
        for (const code of expected) {
            assert.ok(code in LANGUAGES, `Missing language: ${code}`);
        }
    });

    it('has native name strings as values', () => {
        for (const [code, name] of Object.entries(LANGUAGES)) {
            assert.equal(typeof name, 'string', `Language ${code} should have string name`);
            assert.ok(name.length > 0, `Language ${code} should have non-empty name`);
        }
    });
});
