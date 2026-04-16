/**
 * @fileoverview Scalar API reference page for the REST worker.
 *
 * Returns a static HTML page that loads the Scalar API reference
 * library from CDN and points it at the local /openapi.json endpoint.
 * No build step required — the HTML is a template string.
 */

/**
 * HTML page that embeds the Scalar API reference UI.
 * Loads @scalar/api-reference from jsDelivr CDN and initialises it
 * with the co-located /openapi.json spec.
 * @type {string}
 */
const SCALAR_HTML = `<!doctype html>
<html>
<head>
  <title>PeeringDB REST API — PDBFE</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Interactive API documentation for the PeeringDB REST API." />
</head>
<body>
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
