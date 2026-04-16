/**
 * @fileoverview Shared branding HTML fragments for worker landing pages.
 *
 * Generates <head> includes and a header bar that reference the main
 * PDBFE frontend assets (CSS, fonts) rather than duplicating them
 * inline. This keeps design tokens in a single source of truth.
 *
 * The frontend is served from pdbfe.dev via Cloudflare Pages with
 * aggressive caching, so the cross-origin CSS loads are fast and
 * typically already cached after a first visit.
 */

/**
 * Frontend origin used for asset URLs. All CSS, fonts, and
 * static assets are served from here.
 * @type {string}
 */
const FRONTEND = 'https://pdbfe.dev';

/**
 * Generates <link> tags for the frontend's CSS and font assets.
 * Include in the <head> of any worker HTML page.
 *
 * @returns {string} HTML link elements.
 */
export function brandedHead() {
    return [
        `<link rel="stylesheet" href="${FRONTEND}/third_party/inter/inter.css">`,
        `<link rel="stylesheet" href="${FRONTEND}/css/index.css">`,
    ].join('\n  ');
}

/**
 * Generates a header bar matching the main PDBFE frontend layout.
 * Uses the same .site-header classes from the frontend CSS.
 *
 * The header includes the PDBFE logo, a section label (e.g. "GraphQL"),
 * and navigation links to the other worker endpoints.
 *
 * @param {string} label - Section label displayed next to the logo.
 * @returns {string} HTML fragment for the header bar.
 */
export function brandedHeader(label) {
    return `<header class="site-header" role="banner">
  <div class="site-header__inner">
    <a href="${FRONTEND}/" class="site-logo">PDB<span>FE</span></a>
    <span style="color:var(--text-muted);font-weight:300">|</span>
    <span style="font-size:0.85rem;font-weight:600;color:var(--text-secondary);letter-spacing:0.03em;text-transform:uppercase">${label}</span>
    <nav class="site-header__nav" aria-label="API navigation">
      <a href="https://graphql.pdbfe.dev/" class="header-external-link">GraphQL</a>
      <a href="https://rest.pdbfe.dev/" class="header-external-link">REST Docs</a>
      <a href="${FRONTEND}/about" class="header-external-link">About</a>
    </nav>
  </div>
</header>`;
}
