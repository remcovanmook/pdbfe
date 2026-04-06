/**
 * @fileoverview Frontend configuration.
 *
 * Single source of truth for environment-specific settings.
 * Update these values per deployment environment.
 */

/** Origin of the pdbfe-auth worker (no trailing slash). */
export const AUTH_ORIGIN = 'https://pdbfe-auth.remco-vanmook.workers.dev';

/** Origin of the pdbfe-api worker (empty string = same-origin proxy via Pages). */
export const API_ORIGIN = '';
