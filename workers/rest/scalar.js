/**
 * @fileoverview Scalar API reference page for the REST worker.
 *
 * Serves the static HTML page from frontend/api/rest.html, which
 * includes the PDBFE header bar and loads Scalar from CDN.
 * The HTML is imported as a text module at bundle time.
 */

import SCALAR_HTML from '../../frontend/api/rest.html';

/** Pre-built headers for the HTML response. */
const H_HTML = Object.freeze({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
});

/**
 * Returns the Scalar API reference HTML page as a Response.
 *
 * @returns {Response} HTML response with the Scalar UI.
 */
export function serveScalarUI() {
    return new Response(SCALAR_HTML, { status: 200, headers: H_HTML });
}
