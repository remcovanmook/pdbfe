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
    if (!stored || stored === 'auto') {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    // Validate stored value — purge if corrupted
    try {
        Intl.DateTimeFormat(undefined, { timeZone: stored });
        return stored;
    } catch {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
}

/**
 * Returns the raw stored preference ('auto' or an IANA string).
 * Used to set the correct selected option in UI selectors.
 *
 * @returns {string} The stored preference, or 'auto' if unset.
 */
export function getTimezonePreference() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored || stored === 'auto') return 'auto';
    if (isValidTimezone(stored)) return stored;
    // Corrupted — purge and fall back
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
    return 'auto';
}

/**
 * Validates an IANA timezone identifier by probing Intl.DateTimeFormat.
 * Returns true if the browser recognises the timezone, false otherwise.
 *
 * @param {string} tz - Timezone string to validate.
 * @returns {boolean}
 */
function isValidTimezone(tz) {
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Sets the timezone preference and persists to localStorage.
 * 'auto' removes the stored value so the browser default is used.
 * Invalid timezone strings are rejected — treated as 'auto'.
 *
 * @param {string} tz - 'auto' or an IANA timezone identifier.
 */
export function setTimezone(tz) {
    if (!tz || tz === 'auto') {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
        return;
    }
    if (!isValidTimezone(tz)) {
        console.warn('[tz] Invalid timezone %s, ignoring.', JSON.stringify(tz));
        return;
    }
    try { localStorage.setItem(STORAGE_KEY, tz); } catch { /* */ }
}
