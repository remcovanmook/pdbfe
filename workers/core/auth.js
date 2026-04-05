/**
 * @fileoverview Authentication utilities for the PeeringDB API worker.
 *
 * Provides API key extraction from the Authorization header and a
 * stub validation function. The validation stub always returns false —
 * when authentication is needed in the future, replace the body of
 * verifyApiKey() with a KV lookup or upstream proxy check.
 *
 * PeeringDB convention: `Authorization: Api-Key <key>`
 */

/**
 * Extracts an API key from the request's Authorization header.
 * Supports the PeeringDB header format: `Api-Key <key>`.
 *
 * Returns the key string if present and correctly formatted,
 * or null if the header is missing, empty, or uses an
 * unrecognised scheme.
 *
 * @param {Request} request - The inbound HTTP request.
 * @returns {string|null} The extracted API key, or null.
 */
export function extractApiKey(request) {
    const header = request.headers.get('Authorization');
    if (!header) return null;

    // PeeringDB uses "Api-Key <key>" (case-insensitive prefix)
    const prefix = 'api-key ';
    if (!header.toLowerCase().startsWith(prefix)) return null;

    const key = header.slice(prefix.length).trim();
    return key.length > 0 ? key : null;
}

/**
 * Validates an API key. Stub — always returns false.
 *
 * When authentication is needed, replace this with:
 *   - A KV namespace lookup (door #2), or
 *   - An upstream PeeringDB proxy check with per-isolate caching.
 *
 * @param {string} _apiKey - The API key to validate (unused).
 * @returns {boolean} Whether the key is valid. Always false for now.
 */
export function verifyApiKey(_apiKey) {
    return false;
}
