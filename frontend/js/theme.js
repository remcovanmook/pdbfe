/**
 * @fileoverview Theme management — light / dark mode toggle.
 *
 * Persists the user's choice in localStorage under 'pdbfe-theme'.
 * The theme is applied by setting data-theme="light" or data-theme="dark"
 * on the document root element. CSS custom properties in index.css
 * respond to this attribute.
 *
 * The default is 'dark' (no data-theme attribute = dark).
 * Server-side preferences can provide a default for new browsers
 * (same pattern as the language preference).
 */

/** @type {string} localStorage key for theme preference. */
const STORAGE_KEY = 'pdbfe-theme';

/** @type {ReadonlySet<string>} Valid theme values. */
const VALID_THEMES = new Set(['dark', 'light']);

/**
 * Returns the currently active theme.
 *
 * @returns {string} 'dark' or 'light'.
 */
export function getTheme() {
    return document.documentElement.dataset.theme || 'dark';
}

/**
 * Applies a theme and persists the choice to localStorage.
 *
 * @param {string} theme - 'dark' or 'light'.
 */
export function setTheme(theme) {
    if (!VALID_THEMES.has(theme)) return;

    if (theme === 'dark') {
        delete document.documentElement.dataset.theme;
    } else {
        document.documentElement.dataset.theme = theme;
    }

    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // localStorage unavailable — apply in-memory only
    }
}

/**
 * Initialises the theme from localStorage or OS preference.
 * Called once at boot before first render.
 */
export function initTheme() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_THEMES.has(stored)) {
        setTheme(stored);
        return;
    }

    // Respect OS preference if no explicit choice was made
    if (globalThis.matchMedia?.('(prefers-color-scheme: light)').matches) {
        // Apply but don't persist — let the user make an explicit choice
        document.documentElement.dataset.theme = 'light';
    }
}
