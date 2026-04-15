/**
 * @fileoverview Timezone preference management.
 *
 * Persists the user's timezone choice in localStorage under 'pdbfe-tz'.
 * All time-rendering functions in render.js use getTimezone() to
 * determine which IANA timezone to format dates in.
 *
 * Three modes:
 *   - 'auto'  — use the browser/OS timezone (default)
 *   - Any IANA timezone string (e.g. 'Europe/Amsterdam', 'US/Eastern')
 */

/** @type {string} localStorage key for timezone preference. */
const STORAGE_KEY = 'pdbfe-tz';

/**
 * Returns the active IANA timezone string.
 * 'auto' resolves to the browser's timezone via Intl.
 *
 * @returns {string} IANA timezone identifier.
 */
export function getTimezone() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored !== 'auto') return stored;
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Returns the raw stored preference ('auto' or an IANA string).
 * Used to set the correct selected option in UI selectors.
 *
 * @returns {string} The stored preference, or 'auto' if unset.
 */
export function getTimezonePreference() {
    return localStorage.getItem(STORAGE_KEY) || 'auto';
}

/**
 * Sets the timezone preference and persists to localStorage.
 * 'auto' removes the stored value so the browser default is used.
 *
 * @param {string} tz - 'auto' or an IANA timezone identifier.
 */
export function setTimezone(tz) {
    if (tz === 'auto') {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
    } else {
        try { localStorage.setItem(STORAGE_KEY, tz); } catch { /* */ }
    }
}
