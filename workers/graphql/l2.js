/**
 * @fileoverview L2 cache adapter for GraphQL POST operations.
 *
 * The Cloudflare Cache API only supports GET requests. Since GraphQL
 * operations are typically POST-based, we hash the operation body
 * (query + variables) to produce a deterministic cache key, then
 * store/retrieve via the shared core/l2cache.js module.
 *
 * Key format: gql/{sha256-hex}
 */

import { getL2, putL2 } from '../core/l2cache.js';

/**
 * Generates a deterministic L2 cache key from a GraphQL operation.
 *
 * The POST body properties (query string and variables object) are
 * serialised and hashed with SHA-256 to produce a URL-safe key that
 * can be stored in the GET-only Cache API.
 *
 * @param {string} query - The GraphQL query string.
 * @param {Record<string, any>|undefined} variables - Operation variables.
 * @returns {Promise<string>} Cache key in the form "gql/{hex}".
 */
export async function graphqlCacheKey(query, variables) {
    const payload = JSON.stringify({ query, variables: variables || {} });
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(payload)
    );
    const arr = new Uint8Array(digest);
    let hex = '';
    for (const byte of arr) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return `gql/${hex}`;
}

/**
 * Attempts to read a cached GraphQL response from L2.
 *
 * @param {string} cacheKey - Key from graphqlCacheKey().
 * @returns {Promise<Uint8Array|null>} Cached response bytes, or null on miss.
 */
export async function getGqlL2(cacheKey) {
    return getL2(cacheKey);
}

/**
 * Writes a GraphQL response to L2 cache.
 *
 * @param {string} cacheKey - Key from graphqlCacheKey().
 * @param {Uint8Array} buf - Response payload bytes.
 * @param {number} ttlSeconds - Cache TTL in seconds.
 * @returns {Promise<void>}
 */
export async function putGqlL2(cacheKey, buf, ttlSeconds) {
    return putL2(cacheKey, buf, ttlSeconds);
}
