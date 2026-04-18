/**
 * @fileoverview Static asset handler for the REST worker.
 *
 * Serves the Scalar API docs UI, OpenAPI spec, and bundled font assets.
 * All assets are imported at build time and served from memory.
 */

import { encoder } from '../../core/http.js';
import openApiSpec from '../../../extracted/openapi.json';
import SCALAR_HTML from '../../../frontend/api/rest.html';
import INTER_CSS from '../../../frontend/third_party/inter/inter.css';
import INTER_LATIN from '../../../frontend/third_party/inter/inter-latin.woff2';
import INTER_LATIN_EXT from '../../../frontend/third_party/inter/inter-latin-ext.woff2';

/** Pre-built headers for the Scalar HTML response. */
const H_HTML = Object.freeze({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
});

/**
 * Returns the Scalar API reference HTML page as a Response.
 *
 * @returns {Response} HTML response with the Scalar UI.
 */
function serveScalarUI() {
    return new Response(SCALAR_HTML, { status: 200, headers: H_HTML });
}

/**
 * Font asset map. Keys are path segments matching the request URL.
 * @type {Readonly<Record<string, {buf: any, type: string}>>}
 */
const STATIC_ASSETS = Object.freeze({
    'third_party/inter/inter.css': { buf: INTER_CSS, type: 'text/css; charset=utf-8' },
    'third_party/inter/inter-latin.woff2': { buf: INTER_LATIN, type: 'font/woff2' },
    'third_party/inter/inter-latin-ext.woff2': { buf: INTER_LATIN_EXT, type: 'font/woff2' },
});

/**
 * Pre-encoded OpenAPI spec served at /openapi.json.
 * Encoded once at module load to avoid repeated serialisation.
 * @type {Uint8Array}
 */
const SPEC_BYTES = encoder.encode(JSON.stringify(openApiSpec)); // ap-ok: module-level precomputation, runs once

/** Headers for the OpenAPI JSON spec response. */
const H_SPEC = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
});

/**
 * Attempts to serve a static asset for the given path.
 * Returns null if the path doesn't match any known asset.
 *
 * Handles:
 *   - Root or /index.html → Scalar API docs UI
 *   - /openapi.json       → OpenAPI 3.1 spec
 *   - Font CSS and WOFF2 files
 *
 * @param {string} rawPath - URL path without leading slash.
 * @returns {Response|null} Static response, or null if not a static path.
 */
export function serveStaticAsset(rawPath) {
    if (rawPath === '' || rawPath === 'index.html') {
        return serveScalarUI();
    }
    if (rawPath === 'openapi.json') {
        return new Response(
            /** @type {BodyInit} */(/** @type {unknown} */ (SPEC_BYTES)),
            { status: 200, headers: H_SPEC }
        );
    }
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
