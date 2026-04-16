/**
 * @fileoverview About page renderer.
 * Fetches the about page content from a markdown file and renders it
 * using the existing renderMarkdown() pipeline. The content lives in
 * frontend/content/about.md for ease of maintenance.
 */

import { renderMarkdown } from '../markdown.js';
import { createLoading, createError } from '../render.js';

/**
 * Renders the about page into the app container.
 * Fetches /content/about.md and passes it through renderMarkdown().
 *
 * @param {Record<string, string>} _params - Route params (unused).
 */
export async function renderAbout(_params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    document.title = 'About — PDBFE';

    app.replaceChildren(createLoading('Loading'));

    try {
        const res = await fetch('/content/about.md');
        if (!res.ok) throw new Error(`Failed to load about page (${res.status})`);
        const md = await res.text();

        const article = document.createElement('article');
        article.className = 'about-page';
        // renderMarkdown() sanitises the content — safe for innerHTML
        // on authored markdown that we control.
        article.innerHTML = renderMarkdown(md);
        app.replaceChildren(article);
    } catch (err) {
        app.replaceChildren(createError(err.message));
    }
}
