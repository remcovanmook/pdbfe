/**
 * @fileoverview Static asset handler for the GraphQL worker.
 *
 * Serves the branded GraphiQL HTML page and bundled font assets.
 * All assets are imported at build time and served from memory —
 * no filesystem or origin fetch needed.
 */

import GRAPHIQL_HTML from '../../../frontend/api/graphql.html';
import INTER_CSS from '../../../frontend/third_party/inter/inter.css';
import INTER_LATIN from '../../../frontend/third_party/inter/inter-latin.woff2';
import INTER_LATIN_EXT from '../../../frontend/third_party/inter/inter-latin-ext.woff2';

/**
 * Font asset map. Keys are path segments matching the request URL.
 * @type {Readonly<Record<string, {buf: any, type: string}>>}
 */
const STATIC_ASSETS = Object.freeze({
    'third_party/inter/inter.css': { buf: INTER_CSS, type: 'text/css; charset=utf-8' },
    'third_party/inter/inter-latin.woff2': { buf: INTER_LATIN, type: 'font/woff2' },
    'third_party/inter/inter-latin-ext.woff2': { buf: INTER_LATIN_EXT, type: 'font/woff2' },
});

/** Pre-built headers for the GraphiQL HTML page. */
const H_GRAPHIQL = Object.freeze({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
});

/**
 * Checks whether a request is a browser navigation (GET with Accept: text/html).
 *
 * @param {Request} request - The inbound request.
 * @returns {boolean} True if this looks like a browser navigation.
 */
function isBrowserGet(request) {
    if (request.method !== 'GET') return false;
    const accept = request.headers.get('Accept') || '';
    return accept.includes('text/html');
}

/**
 * Attempts to serve a static asset for the given path.
 * Returns null if the path doesn't match any known asset.
 *
 * Handles:
 *   - Root or /graphql → branded GraphiQL HTML (browser navigations only)
 *   - Font CSS and WOFF2 files
 *
 * @param {Request} request - The inbound request.
 * @param {string} rawPath - URL path without leading slash.
 * @returns {Response|null} Static response, or null if not a static path.
 */
export function serveStaticAsset(request, rawPath) {
    // Browser navigation → branded GraphiQL page
    if ((rawPath === '' || rawPath === 'graphql') && isBrowserGet(request)) {
        return new Response(GRAPHIQL_HTML, { status: 200, headers: H_GRAPHIQL });
    }

    // Font/CSS assets
    if (STATIC_ASSETS[rawPath]) {
        const asset = STATIC_ASSETS[rawPath];
        return new Response(asset.buf, {
            status: 200,
            headers: {
                'Content-Type': asset.type,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }

    return null;
}
