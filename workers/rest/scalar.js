/**
 * @fileoverview Scalar API reference page for the REST worker.
 *
 * Returns a static HTML page that loads the Scalar API reference
 * library from CDN and points it at the local /openapi.json endpoint.
 * Includes the PDBFE frontend CSS and branded header bar for visual
 * consistency with the main frontend.
 */

import { brandedHead, brandedHeader } from '../core/branding.js';

/**
 * HTML page that embeds the Scalar API reference UI.
 * Links the frontend CSS via brandedHead() and includes the PDBFE
 * header bar via brandedHeader(). Scalar is loaded from jsDelivr CDN
 * and initialised against the co-located /openapi.json spec.
 * @type {string}
 */
const SCALAR_HTML = `<!doctype html>
<html>
<head>
  <title>REST API — PDBFE</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Interactive API documentation for the PeeringDB REST API." />
  ${brandedHead()}
</head>
<body style="margin:0">
  ${brandedHeader('REST API')}
  <div id="api-reference"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference('#api-reference', {
      url: '/openapi.json',
      theme: 'kepler',
    })
  </script>
</body>
</html>`;

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
