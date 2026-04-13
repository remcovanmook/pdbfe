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
│   ├── createFieldGroup()       → Field group (template clone)
│   ├── createLink()             → SPA <a> element
│   ├── createStatsBar()         → Stats bar (template clone)
│   ├── createBool()             → Yes/No badge
│   ├── createLoading()          → Loading spinner
│   ├── createError()            → Error message
│   ├── createEmptyState()       → Empty state message
│   └── createDetailLayout()     → Page layout grid
└── pages/
    ├── net.js, ix.js, fac.js, org.js, carrier.js, campus.js
    │   → Entity detail pages using createDetailLayout + <pdb-table>
    ├── home.js     → Homepage with recent updates grid
    ├── search.js   → Search results using createLink
    ├── about.js    → Fetches /content/about.md, renders via renderMarkdown
    ├── account.js  → Profile + API key management (DOM builders for data)
    └── asn.js      → ASN → network redirect
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

## Templates (index.html)

```html
<template id="tpl-info-field">      → createField()
<template id="tpl-info-group">      → createFieldGroup()
<template id="tpl-stats-item">      → createStatsBar()
<template id="tpl-typeahead-item">  → typeahead dropdown items
```

## Markdown Rendering

The `about.js` page fetches `/content/about.md` at runtime and renders it
through `renderMarkdown()` (from `markdown.js`). This is the only place where
`innerHTML` is used on non-trivial content — the markdown pipeline has its own
sanitization (allowlisted tags, URL protocol validation).

## Remaining innerHTML Usage

Only two intentional sites remain — both are `renderMarkdown()` output:

- `render.js:575`: markdown-rendered field values (sanitized by the markdown pipeline)
- `about.js:32`: about page content fetched from `/content/about.md`

The markdown pipeline (`markdown.js`) has its own sanitization: allowlisted HTML tags,
URL protocol validation, and `target`/`rel` enforcement on links.

All other modules use DOM nodes exclusively. `escapeHTML()` is retained
only in `i18n.js` for interpolation value escaping.
