/**
 * @fileoverview Allowed values for the user preferences (language, theme,
 * timezone), used to fill the footer and account-page selectors.
 *
 * These ship with the frontend instead of being fetched from the auth
 * worker: every value needs frontend support anyway (a locale file, a
 * theme), and a fetch would put a D1 round trip on every page load,
 * anonymous visitors included. The auth worker's preference_options table
 * still validates saved preferences. tests/unit/preference-options.test.js
 * keeps the two in step with the seed in database/users/.
 */

import { LANGUAGES } from './i18n.js';

/**
 * IANA timezones offered in the timezone selector, in display order
 * (west to east), after 'auto'.
 * @type {readonly string[]}
 */
const TIMEZONES = Object.freeze([
    'Pacific/Honolulu',
    'America/Anchorage',
    'America/Los_Angeles',
    'America/Denver',
    'America/Chicago',
    'America/New_York',
    'America/Sao_Paulo',
    'Atlantic/Reykjavik',
    'UTC',
    'Europe/London',
    'Europe/Amsterdam',
    'Europe/Berlin',
    'Europe/Paris',
    'Europe/Helsinki',
    'Europe/Istanbul',
    'Europe/Moscow',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Australia/Perth',
    'Australia/Sydney',
    'Pacific/Auckland',
]);

/**
 * Allowed values per preference key. 'auto' comes first in each list.
 * @type {Readonly<{language: readonly string[], theme: readonly string[], timezone: readonly string[]}>}
 */
export const PREFERENCE_OPTIONS = Object.freeze({
    language: Object.freeze(['auto', ...Object.keys(LANGUAGES)]),
    theme: Object.freeze(['auto', 'dark', 'light']),
    timezone: Object.freeze(['auto', ...TIMEZONES]),
});
