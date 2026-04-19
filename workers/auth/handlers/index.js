/**
 * @fileoverview Re-exports for auth handler modules.
 *
 * Handler logic is split into focused modules:
 *   oauth.js      — handleAuth (login, callback, logout, me, preflight)
 *   profile.js    — handlePreferences, handleProfile
 *   keys.js       — handleKeys
 *   favorites.js  — handleFavorites
 */

export { handleAuth } from './oauth.js';
export { handlePreferences, handleProfile } from './profile.js';
export { handleKeys } from './keys.js';
export { handleFavorites } from './favorites.js';
