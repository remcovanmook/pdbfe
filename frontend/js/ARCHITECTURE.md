# Frontend Rendering Architecture

## Overview

The PeeringDB frontend uses a **DOM-first rendering pipeline** based on native
Web Components and `<template>` cloning. All user-supplied data is rendered via
`textContent` assignment, making XSS structurally impossible at the framework
level.

## Technology

- **Web Components** — Custom Elements (`<pdb-table>`, `<pdb-field-group>`,
  `<pdb-stats-bar>`) registered via `customElements.define()`.
- **`<template>` elements** — Defined in `index.html`, parsed once by the
  browser, cloned via `cloneNode(true)` for each instance.
- **DocumentFragment** — Used for batch DOM writes (single reflow).
- **No build step** — All modules are ES2022+ loaded via `<script type="module">`.

## Component Hierarchy

```
boot.js
├── components/pdb-table.js      → <pdb-table> custom element
├── components/pdb-field-group.js → <pdb-field-group> custom element
├── components/pdb-stats-bar.js  → <pdb-stats-bar> custom element
├── router.js                    → SPA routing, history API
├── render.js                    → DOM builders + formatting helpers
│   ├── createField()            → Info field (template clone)
│   │   ├── opts.email           → mailto: link
│   │   ├── opts.map             → Google Maps link
│   │   └── opts.date            → Formatted date
│   ├── createFieldGroup()       → Field group (template clone)
│   ├── createLink()             → SPA <a> element
│   ├── createStatsBar()         → Stats bar (template clone)
│   ├── createBool()             → Yes/No badge
│   ├── createLoading()          → Loading spinner
│   ├── createError()            → Error message
│   ├── createEmptyState()       → Empty state message
│   ├── createDetailLayout()     → Page layout grid
│   ├── createFavoriteButton()   → Star toggle (auth or localStorage)
│   └── formatSpeed()            → Mbps → G/T with 1-decimal rounding
└── pages/
    ├── net.js, ix.js, fac.js, org.js, carrier.js, campus.js
    │   → Entity detail pages using createDetailLayout + <pdb-table>
    ├── home.js     → Homepage with favorites + recent updates grid
    ├── search.js   → Search results using createLink
    ├── about.js    → Fetches /content/about.md, renders via renderMarkdown
    ├── account.js  → Profile, preferences, favorites, API key management
    ├── asn.js      → ASN → network redirect
    └── compare.js  → Side-by-side entity property comparison view

## API Documentation Pages

In addition to the SPA, the frontend provides two statically-shipped HTML documents designed explicitly to host interactive API tools decoupled from the SPA lifecycle.

- **`api/graphql.html`**: Bundles the GraphiQL explorer (React ecosystem) into a single page.
- **`api/rest.html`**: Bundles the Scalar API client (Vue.js ecosystem) into a single page. 

These are served unmodified directly from the `graphql.pdbfe.dev` and `rest.pdbfe.dev` root edge routes. They inline CSS properties and rely on edge-cached fonts through Google's CDN to ensure layout rendering operates unimpeded despite overlapping Cloudflare Access restrictions.
```

## Data Flow

```
API response (JSON)
    ↓
Page handler (pages/*.js)
    ↓
createField(label, value)   → textContent assignment (XSS-safe)
createLink(type, id, label) → textContent assignment (XSS-safe)
<pdb-table>.configure(...)  → cellRenderer returns DOM Nodes
    ↓
app.replaceChildren(fragment)  → Single DOM mutation
```

## <pdb-table> Internals

The table component uses **slice-based paging**:

1. Full dataset lives in `_processedRows` (JS array).
2. On sort/filter/page change, only the visible slice is rendered into `<tbody>`.
3. DOM always holds exactly one page of `<tr>` nodes.
4. Scales to 10k+ rows without performance degradation.

Sort direction and filter state are tracked as instance properties.
The `cellRenderer` callback returns DOM Nodes (not HTML strings).

Additional features:
- **Column visibility toggle**: ⚙ gear button hides/shows columns (except first)
- **CSV / Markdown export**: copies filtered/sorted data to clipboard
- **Conditional layout**: `table-layout: fixed` only when columns use `width`;
  `maxWidth` works for auto-layout tables

See [components/pdb-table.md](components/pdb-table.md) for the full architecture.

## Templates (index.html)

```html
<template id="tpl-info-field">      → createField()
<template id="tpl-info-group">      → createFieldGroup()
<template id="tpl-stats-item">      → createStatsBar()
<template id="tpl-typeahead-item">  → typeahead dropdown items
```

## Markdown Rendering

The `about.js` page fetches `/content/about.md` at runtime and renders it
through `renderMarkdown()` (from `markdown.js`). Notes fields on entity pages
also use this renderer.

Key features:
- Allowlisted HTML tags, URL protocol validation, `target`/`rel` enforcement
- PeeringDB link rewriting: `peeringdb.com/{net|ix|fac|org|carrier|campus}/{id}`
  links are converted to local SPA routes with `data-link`
- Fenced code blocks, headings, bold/italic, images, lists

## Remaining innerHTML Usage

Only two intentional sites remain — both are `renderMarkdown()` output:

- `render.js:575`: markdown-rendered field values (sanitized by the markdown pipeline)
- `about.js:32`: about page content fetched from `/content/about.md`

The markdown pipeline (`markdown.js`) has its own sanitization: allowlisted HTML tags,
URL protocol validation, and `target`/`rel` enforcement on links.

All other modules use DOM nodes exclusively. `escapeHTML()` is retained
only in `i18n.js` for interpolation value escaping.

## Anti-Patterns & Common Pitfalls

As the codebase matures, please strictly avoid the following identified anti-patterns:

1. **Raw `fetch()` calls to the API**
   - **Bad**: `fetch('/api/net/1')` or `fetch(API_ORIGIN + '/api/...')` 
   - **Good**: `import { fetchEntity } from '../api.js'; fetchEntity('net', 1);`
   - **Why**: Raw fetches completely bypass the centralized configuration inside `api.js`. This breaks cross-origin Cloudflare Pages routing, strips D1 API synchronization state, ignores SWR (Stale-While-Revalidate) local caching (causing extreme network thrashing), and drops edge diagnostic telemetry. *Exception*: Static asset payloads (Markdown, CSS, `i18n` Locales) appropriately use direct `fetch()`.

2. **Hardcoded HTML Cache Busters**
   - **Bad**: Editing foundational layout code in `index.css` without updating the loader.
   - **Good**: Bumping the CSS cache signature `<link rel="stylesheet" href="/css/index.css?v={N}">` inside `frontend/index.html`.
   - **Why**: Cloudflare Pages heavily caches edge assets. If the CSS relies on a hardcoded signature but structural layout classes randomly change, clients will download the new `JS` components but drop layout rules entirely resulting in floating, unstyled UI anomalies.

3. **Mixing Box Models in Flex Row Alignment**
   - **Bad**: Allowing `<button>` and `<a>` siblings inside a `.detail-header` flex-container without neutralizing box-models.
   - **Good**: Adding `display: inline-flex; align-items: center; justify-content: center;` to a shared utility CSS class.
   - **Why**: Anchors and natively styled HTML buttons possess fundamentally different intrinsic heights and centerline layouts. Combining them blindly results in "awkwardly hanging" vertical or horizontal misalignments.

4. **Manual DOM Node Initialization Over Reusable Components**
   - **Bad**: Building massive nested interface hierarchies organically using 20+ sequential lines of `document.createElement()` assignments scattered throughout page logic.
   - **Good**: Encapsulating complex recurring UI forms into dedicated Web Components (`frontend/js/components/`) and formally declaring reusable templates directly aligned with their lifecycle.
   - **Why**: Hardcoding massive DOM structural trees mechanically inside procedural JS heavily tightly couples layout with logic. Migrating complex UI abstractions into native Custom Elements rigorously segregates structure from state, significantly streamlines testing, and yields fully reusable semantic tags.

5. **Dynamic External Resource Loads**
   - **Bad**: Hot-injecting an untracked `<script>` tag or an unvetted `<link>` from a random public CDN organically inside a module component.
   - **Good**: Formally establishing the package physically within `/third_party/` entirely under our repository footprint, embedding it strictly into the `<head>` of `index.html`.
   - **Why**: The PeeringDB frontend adheres to incredibly strict dependency minimalism and privacy boundaries. Unmanaged external loads bypass audit trails, ignore Subresource Integrity guards, inflate dynamic execution risks, and will instantly break the application if the upstream network proxy suddenly degrades.
