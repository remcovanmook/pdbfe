/**
 * @fileoverview Shared branding HTML fragment for worker landing pages.
 *
 * Provides a header bar that matches the main PDBFE frontend design
 * (Inter font, dark surface, accent colour). Injected at the top of
 * the Scalar and GraphiQL pages for consistent branding across all
 * worker endpoints.
 */

/**
 * Inline CSS for the branded header bar.
 * Uses the same design tokens as the frontend (hardcoded here since
 * the workers don't load the frontend stylesheet).
 * @type {string}
 */
const BRAND_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  .pdbfe-bar {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: hsl(220 14% 12%);
    border-bottom: 1px solid hsl(220 10% 22%);
    padding: 0 1.5rem;
    height: 48px;
    display: flex;
    align-items: center;
    gap: 1rem;
    z-index: 1000;
    position: relative;
  }
  .pdbfe-bar__logo {
    font-size: 1.125rem;
    font-weight: 700;
    color: hsl(220 14% 90%);
    text-decoration: none;
    letter-spacing: -0.02em;
  }
  .pdbfe-bar__logo span {
    color: hsl(200 80% 55%);
  }
  .pdbfe-bar__sep {
    color: hsl(220 10% 35%);
    font-weight: 300;
  }
  .pdbfe-bar__label {
    font-size: 0.85rem;
    font-weight: 600;
    color: hsl(220 10% 62%);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .pdbfe-bar__nav {
    margin-left: auto;
    display: flex;
    gap: 1rem;
  }
  .pdbfe-bar__link {
    font-size: 0.8rem;
    color: hsl(220 10% 62%);
    text-decoration: none;
    transition: color 0.15s;
  }
  .pdbfe-bar__link:hover {
    color: hsl(200 80% 65%);
  }
`;

/**
 * Generates the branded header bar HTML for a worker page.
 *
 * @param {string} label - Section label (e.g. "GraphQL", "REST API").
 * @returns {string} HTML fragment: <style> + <header> elements.
 */
export function brandedHeader(label) {
    return `<style>${BRAND_CSS}</style>
<header class="pdbfe-bar">
  <a href="https://pdbfe.dev/" class="pdbfe-bar__logo">PDB<span>FE</span></a>
  <span class="pdbfe-bar__sep">|</span>
  <span class="pdbfe-bar__label">${label}</span>
  <nav class="pdbfe-bar__nav">
    <a href="https://graphql.pdbfe.dev/" class="pdbfe-bar__link">GraphQL</a>
    <a href="https://rest.pdbfe.dev/" class="pdbfe-bar__link">REST Docs</a>
    <a href="https://pdbfe.dev/about" class="pdbfe-bar__link">About</a>
  </nav>
</header>`;
}
