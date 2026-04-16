/**
 * @fileoverview Zero-bloat internationalization utility.
 * Loads static JSON dictionaries compiled from upstream Django .po files.
 * Supports browser language detection, localStorage override via a footer
 * language selector, and simple {var} interpolation with XSS escaping.
 */

/** @type {Record<string, string>} */
let _dict = {};
let _currentLang = 'en';

/**
 * Available languages, matching the curated set from upstream
 * PeeringDB settings.LANGUAGES. Values are the native names
 * shown in the language selector.
 *
 * @type {Record<string, string>}
 */
export const LANGUAGES = {
    'en': 'English',
    'cs': 'Čeština',
    'de': 'Deutsch',
    'el': 'Ελληνικά',
    'es': 'Español',
    'fr': 'Français',
    'it': 'Italiano',
    'ja': '日本語',
    'lt': 'Lietuvių',
    'pt': 'Português',
    'ro': 'Română',
    'ru': 'Русский',
    'zh-cn': '简体中文',
    'zh-tw': '繁體中文',
};

/**
 * Returns the currently active language code.
 *
 * @returns {string} ISO language code (e.g. 'en', 'pt', 'de').
 */
export function getCurrentLang() {
    return _currentLang;
}

/**
 * Loads a locale dictionary by language code. If the language is English
 * or the fetch fails, the dictionary is cleared (English is the default
 * for all keys).
 *
 * @param {string} lang - ISO language code.
 * @returns {Promise<void>}
 */
async function loadLocale(lang) {
    if (lang === 'en') {
        _dict = {};
        _currentLang = 'en';
        document.documentElement.lang = 'en';
        return;
    }

    try {
        const res = await fetch(`/locales/${lang}.json`, { cache: 'force-cache' });
        if (res.ok) {
            _dict = await res.json();
            _currentLang = lang;
            document.documentElement.lang = lang;
        } else {
            _dict = {};
            _currentLang = 'en';
        }
    } catch (e) {
        console.warn(`[i18n] Failed to load locale ${lang}, falling back to English.`, e);
        _dict = {};
        _currentLang = 'en';
    }
}

/**
 * Initializes the i18n system. Checks localStorage for a saved preference,
 * then falls back to browser language detection, then to English.
 * Only fetches a dictionary if the resolved language is not English.
 *
 * @returns {Promise<void>}
 */
export async function initI18n() {
    const stored = globalThis.localStorage?.getItem('pdbfe-lang') ?? null;

    let lang = 'en';

    if (stored && stored in LANGUAGES) {
        lang = stored;
    } else if (typeof navigator !== 'undefined') {
        const browserLang = navigator.language.slice(0, 2);
        // Check for full code first (zh-cn, zh-tw) then short code
        const fullCode = navigator.language.toLowerCase().replaceAll('_', '-');
        if (fullCode in LANGUAGES) {
            lang = fullCode;
        } else if (browserLang in LANGUAGES) {
            lang = browserLang;
        }
    }

    await loadLocale(lang);
}

/**
 * Switches to a new language. Stores the preference in localStorage,
 * loads the corresponding dictionary, and calls the optional callback
 * so the UI can re-render.
 *
 * Passing 'auto' clears the stored preference and resolves the language
 * from the browser's navigator.language, falling back to English.
 *
 * @param {string} lang - ISO language code from the LANGUAGES map, or 'auto'.
 * @param {function(): void} [onSwitch] - Callback invoked after the
 *     new dictionary is loaded, typically used to re-render the page.
 * @returns {Promise<void>}
 */
export async function setLanguage(lang, onSwitch) {
    if (lang === 'auto') {
        try { localStorage.removeItem('pdbfe-lang'); } catch { /* */ }
        // Re-resolve from browser
        await initI18n();
    } else {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('pdbfe-lang', lang);
        }
        await loadLocale(lang);
    }
    if (onSwitch) onSwitch();
}

/**
 * Translates a given key. Falls back to the key itself if no translation
 * exists. Supports {var} interpolation with XSS-safe escaping of values.
 *
 * @param {string} key - The English string or translation key.
 * @param {Record<string, string|number>} [vars] - Optional variables for interpolation.
 * @returns {string} The translated string.
 */
export function t(key, vars = {}) {
    let str = _dict[key] || key;

    if (Object.keys(vars).length > 0) {
        str = str.replaceAll(/\{(\w+)\}/g, (_, varName) => {
            return varName in vars ? escapeHTML(String(vars[varName])) : `{${varName}}`;
        });
    }

    return str;
}

/**
 * Escapes HTML special characters in a string to prevent XSS
 * during template interpolation.
 *
 * @param {string} str - Raw string.
 * @returns {string} Escaped string.
 */
function escapeHTML(str) {
    return str.replaceAll(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m] || m);
}
