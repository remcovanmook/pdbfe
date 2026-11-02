/**
 * @fileoverview Encryption at rest for stored OAuth refresh tokens.
 *
 * A refresh token lets its holder mint access tokens for the user's
 * PeeringDB profile, so it is never stored in clear. AES-256-GCM with a
 * random 96-bit IV per value, keyed by the TOKEN_ENCRYPTION_KEY worker
 * secret (64 hex chars). Stored form: `v1.<iv base64>.<ciphertext base64>`.
 */

/** @type {Map<string, Promise<CryptoKey>>} Imported keys by secret value. */
const keyCache = new Map();

/**
 * Imports the AES-GCM key from its hex form (cached per isolate).
 *
 * @param {string} hex - 64 hex characters.
 * @returns {Promise<CryptoKey>}
 */
function importKey(hex) {
    let key = keyCache.get(hex);
    if (!key) {
        if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters');
        const raw = new Uint8Array(32);
        for (let i = 0; i < 32; i++) raw[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
        keyCache.set(hex, key);
    }
    return key;
}

/** @param {Uint8Array} bytes */
const toB64 = (bytes) => btoa(String.fromCodePoint(...bytes));
/** @param {string} b64 */
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => /** @type {number} */ (c.codePointAt(0)));

/**
 * Encrypts a token for storage.
 *
 * @param {string} keyHex - TOKEN_ENCRYPTION_KEY.
 * @param {string} token - Clear-text token.
 * @returns {Promise<string>} `v1.<iv>.<ciphertext>`.
 */
export async function encryptToken(keyHex, token) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(keyHex), new TextEncoder().encode(token)));
    return `v1.${toB64(iv)}.${toB64(ct)}`;
}

/**
 * Decrypts a stored token. Throws on a wrong key or tampered value, so a
 * key mix-up can never be mistaken for a revoked token.
 *
 * @param {string} keyHex - TOKEN_ENCRYPTION_KEY.
 * @param {string} stored - Value from encryptToken.
 * @returns {Promise<string>} Clear-text token.
 */
export async function decryptToken(keyHex, stored) {
    const [v, iv, ct] = stored.split('.');
    if (v !== 'v1' || !iv || !ct) throw new Error('unrecognised stored token format');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await importKey(keyHex), fromB64(ct));
    return new TextDecoder().decode(pt);
}
