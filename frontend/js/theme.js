/**
 * @fileoverview Theme management — light / dark / auto mode toggle.
 *
 * Persists the user's choice in localStorage under 'pdbfe-theme'.
 * The theme is applied by setting data-theme="light" on the document
 * root element. CSS custom properties in index.css respond to this
 * attribute. Absence of the attribute = dark theme.
 *
 * Three modes:
 *   - 'dark'  — force dark
 *   - 'light' — force light
 *   - 'auto'  — follow OS prefers-color-scheme (default)
 *
 * Server-side preferences can provide a default for new browsers
 * (same pattern as the language preference).
 */

/** @type {string} localStorage key for theme preference. */
const STORAGE_KEY = 'pdbfe-theme';

/** @type {ReadonlySet<string>} Valid stored theme values. */
const VALID_THEMES = new Set(['dark', 'light', 'auto']);

/**
 * Resolves the effective visual theme based on OS preference.
 *
 * @returns {'dark'|'light'}
 */
function resolveOsTheme() {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
}

/**
 * Applies a resolved theme to the document root.
 *
 * @param {'dark'|'light'} resolved - The visual theme to apply.
 */
function applyTheme(resolved) {
    if (resolved === 'light') {
        document.documentElement.dataset.theme = 'light';
    } else {
        delete document.documentElement.dataset.theme;
    }
}

/**
 * Returns the stored theme preference.
 *
 * @returns {string} 'dark', 'light', or 'auto'.
 */
export function getTheme() {
    return localStorage.getItem(STORAGE_KEY) || 'auto';
}

/**
 * Sets the theme preference and applies it immediately.
 * 'auto' clears the stored preference and falls back to the OS setting.
 *
 * @param {string} theme - 'dark', 'light', or 'auto'.
 */
export function setTheme(theme) {
    if (!VALID_THEMES.has(theme)) return;

    if (theme === 'auto') {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
        applyTheme(resolveOsTheme());
    } else {
        try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* */ }
        applyTheme(/** @type {'dark'|'light'} */ (theme));
    }
}

/**
 * Initialises the theme from localStorage or OS preference.
 * Called once at boot before first render.
 */
export function initTheme() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (stored === 'dark' || stored === 'light')) {
        applyTheme(stored);
        return;
    }
    // 'auto' or no preference — follow OS
    applyTheme(resolveOsTheme());
}
