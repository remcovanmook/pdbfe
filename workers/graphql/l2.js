/**
 * @fileoverview Cache key generation for GraphQL POST operations.
 *
 * The Cloudflare Cache API only supports GET requests. Since GraphQL
 * operations are typically POST-based, we hash the operation body
 * (query + variables) to produce a deterministic cache key, then
 * store/retrieve via the shared core/l2cache.js module.
 *
 * L2 get/put is handled by core/pipeline.js (via core/swr.js) — this
 * module only provides the key generation logic.
 *
 * Key format: gql/{sha256-hex}
 */

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
