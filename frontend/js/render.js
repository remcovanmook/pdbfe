/**
 * @fileoverview Shared rendering utilities for the PeeringDB frontend.
 *
 * Provides DOM builder functions (createField, createLink, etc.) that
 * return DOM Nodes via template cloning and textContent assignment.
 * XSS-safe by construction — no HTML parsing involved.
 *
 * Also provides formatting helpers (formatSpeed, formatDate, etc.).
 */

import { renderMarkdown } from './markdown.js';
import { t, getCurrentLang } from './i18n.js';
import { isFavorite, addFavorite, removeFavorite } from './auth.js';
import { getTimezone } from './timezone.js';

/**
 * Formats a speed value in Mbps to a human-readable string.
 * 100 → "100M", 1000 → "1G", 100000 → "100G"
 *
 * @param {number|null|undefined} mbps - Speed in megabits per second.
 * @returns {string} Formatted speed string.
 */
export function formatSpeed(mbps) {
    if (!mbps) return '—';
    /**
     * Rounds a number to 1 decimal place, dropping trailing '.0'.
     * @param {number} n
     * @returns {string}
     */
    const fmt = (n) => {
        const r = Math.round(n * 10) / 10;
        return r % 1 === 0 ? String(r) : r.toFixed(1);
    };
    if (mbps >= 1_000_000) return `${fmt(mbps / 1_000_000)}T`;
    if (mbps >= 1_000) return `${fmt(mbps / 1_000)}G`;
    return `${mbps}M`;
}

/**
 * Formats an ISO date string as a relative time string.
 * Always returns a relative format (minutes, hours, days, months, years).
 *
 * @param {string|null|undefined} iso - ISO 8601 date string.
 * @returns {string} Relative time string (e.g. "5 minutes ago", "3 days ago").
 */
export function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return t('just now');
    if (diffMin === 1) return t('1 minute ago');
    if (diffMin < 60) return t('{n} minutes ago', { n: diffMin });
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr === 1) return t('1 hour ago');
    if (diffHr < 24) return t('{n} hours ago', { n: diffHr });
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return t('1 day ago');
    if (diffDay < 30) return t('{n} days ago', { n: diffDay });
    const diffMonth = Math.floor(diffDay / 30);
    if (diffMonth === 1) return t('1 month ago');
    if (diffMonth < 12) return t('{n} months ago', { n: diffMonth });
    const diffYear = Math.floor(diffDay / 365);
    if (diffYear === 1) return t('1 year ago');
    return t('{n} years ago', { n: diffYear });
}

/**
 * Formats an ISO date string as a locale-formatted absolute date and
 * time (e.g. "7 Apr 2026, 14:30"). Respects the user's timezone
 * preference from the timezone module.
 *
 * @param {string} iso - ISO 8601 date string.
 * @returns {string} Locale-formatted date, or the raw string on parse failure.
 */
export function formatLocaleDate(iso) {
    try {
        return new Date(iso).toLocaleString(getCurrentLang() || 'en', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
            timeZone: getTimezone(),
        });
    } catch {
        return iso;
    }
}

/**
 * Updates the OpenGraph meta tags in the document head.
 * Creates tags if they don't exist. This only affects client-side
 * rendering — bots that don't execute JS won't see these.
 *
 * @param {string} title - Page title for og:title.
 * @param {string} description - Page description for og:description.
 */
export function setOGTags(title, description) {
    setMetaProperty('og:title', title);
    setMetaProperty('og:description', description);
    setMetaProperty('og:url', globalThis.location.href);
}

/**
 * Sets a single `<meta property="...">` tag's content attribute.
 * Creates the tag if it doesn't exist.
 *
 * @param {string} property - The meta property name (e.g. "og:title").
 * @param {string} content - The content value.
 */
function setMetaProperty(property, content) {
    let meta = /** @type {HTMLMetaElement|null} */ (
        document.querySelector(`meta[property="${property}"]`)
    );
    if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('property', property);
        document.head.appendChild(meta);
    }
    meta.setAttribute('content', content);
}

// ═══════════════════════════════════════════════════════════════════
// DOM-based builders — return Nodes, not strings.
// All user data is assigned via textContent (XSS-safe by construction).
// ═══════════════════════════════════════════════════════════════════

/**
 * Lazily caches a reference to a <template> element by ID.
 * Returns the template's content for cloning. Throws if the
 * template does not exist in the document.
 *
 * @param {string} id - Template element ID (e.g. "tpl-info-field").
 * @returns {DocumentFragment} The template's .content property.
 */
function getTemplate(id) {
    const tpl = /** @type {HTMLTemplateElement|null} */ (document.getElementById(id));
    if (!tpl) throw new Error(`Missing <template id="${id}">`);
    return tpl.content;
}

/**
 * Creates a colour-coded entity-type badge.
 * The CSS maps `data-type` to a per-entity accent colour.
 *
 * @param {string} type - Entity type key (net, ix, fac, org, carrier, campus).
 * @param {Object} [options] - Badge options.
 * @param {boolean} [options.header] - If true, uses the larger header variant.
 * @returns {HTMLSpanElement}
 */
export function createEntityBadge(type, options) {
    const badge = document.createElement('span');
    badge.className = 'entity-badge' + (options?.header ? ' entity-badge--header' : '');
    badge.dataset.type = type;
    badge.textContent = type;
    return badge;
}

/**
 * Creates an internal SPA link element as a DOM node.
 * Uses textContent for the label, so XSS is structurally impossible.
 *
 * @param {string} type - Entity type (net, ix, fac, org, carrier, campus).
 * @param {number|string} id - Entity ID.
 * @param {string} label - Display text.
 * @returns {HTMLAnchorElement} An anchor element with data-link attribute.
 */
export function createLink(type, id, label) {
    const a = document.createElement('a');
    a.href = `/${type}/${id}`;
    a.dataset.link = '';
    a.textContent = label;
    return a;
}

/**
 * Creates a key/value info field as a DOM node by cloning the
 * tpl-info-field template. Returns null for empty/null values,
 * matching the same skip-empty semantics as renderField().
 *
 * @param {string} label - Field label (passed through t() for i18n).
 * @param {string|number|null|undefined} value - Field value.
 * @param {Object} [opts] - Options.
 * @param {string} [opts.href] - Wrap value in an external link.
 * @param {boolean} [opts.external] - Open link in a new tab.
 * @param {string} [opts.linkType] - Entity type for internal SPA link.
 * @param {number|string} [opts.linkId] - Entity ID for internal SPA link.
 * @param {boolean} [opts.markdown] - Render value as markdown (uses innerHTML for the value span only).
 * @param {boolean} [opts.translate] - Pass value through t() for enum translations.
 * @param {boolean} [opts.date] - Format value as a locale-aware date with timezone.
 * @param {boolean} [opts.email] - Render value as a mailto: link.
 * @param {string} [opts.map] - Google Maps search query. Wraps value in a maps link.
 * @returns {HTMLDivElement|null} The info-field element, or null if value is empty.
 */
export function createField(label, value, opts = {}) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const clone = /** @type {HTMLDivElement} */ (
        /** @type {DocumentFragment} */ (getTemplate('tpl-info-field').cloneNode(true)).firstElementChild
    );
    const labelEl = /** @type {HTMLSpanElement} */ (clone.querySelector('.info-field__label'));
    const valueEl = /** @type {HTMLSpanElement} */ (clone.querySelector('.info-field__value'));

    labelEl.textContent = t(label);

    const displayValue = opts.translate ? t(String(value)) : String(value);

    if (opts.linkType && opts.linkId) {
        valueEl.appendChild(createLink(opts.linkType, opts.linkId, String(value)));
    } else if (opts.markdown) {
        // Markdown content goes through the sanitising renderMarkdown pipeline.
        // This is the only place innerHTML is used — on authored/sanitised content.
        valueEl.innerHTML = renderMarkdown(displayValue);
    } else if (opts.href) {
        const a = document.createElement('a');
        a.href = opts.href;
        if (opts.external) {
            a.target = '_blank';
            a.rel = 'noopener';
        }
        a.textContent = displayValue;
        valueEl.appendChild(a);
    } else if (opts.date) {
        valueEl.textContent = formatLocaleDate(displayValue);
    } else if (opts.email) {
        const a = document.createElement('a');
        a.href = `mailto:${displayValue}`;
        a.textContent = displayValue;
        valueEl.appendChild(a);
    } else if (opts.map) {
        const a = document.createElement('a');
        a.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(opts.map)}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = displayValue;
        valueEl.appendChild(a);
    } else {
        valueEl.textContent = displayValue;
    }

    return clone;
}

/**
 * Creates a group of info fields with a section title as a DOM node.
 * Clones the tpl-info-group template and appends non-null field nodes.
 * Returns null if all fields are null/empty.
 *
 * @param {string} title - Group title (passed through t() for i18n).
 * @param {Array<HTMLElement|null>} fields - Array of createField() results.
 * @returns {HTMLDivElement|null} The info-group element, or null if empty.
 */
export function createFieldGroup(title, fields) {
    const populated = fields.filter(Boolean);
    if (populated.length === 0) return null;

    const clone = /** @type {HTMLDivElement} */ (
        /** @type {DocumentFragment} */ (getTemplate('tpl-info-group').cloneNode(true)).firstElementChild
    );
    clone.querySelector('.info-group__title').textContent = t(title);

    for (const field of populated) {
        clone.appendChild(/** @type {Node} */ (field));
    }

    return clone;
}

/**
 * Creates a stats bar with label/value pairs as a DOM node.
 * Each item is cloned from the tpl-stats-item template.
 *
 * @param {Array<{label: string, value: string|number}>} items - Stats to display.
 * @returns {HTMLDivElement} The stats-bar element.
 */
export function createStatsBar(items) {
    const bar = document.createElement('div');
    bar.className = 'stats-bar';

    const itemTpl = getTemplate('tpl-stats-item');

    for (const item of items) {
        const clone = /** @type {HTMLDivElement} */ (/** @type {DocumentFragment} */ (itemTpl.cloneNode(true)).firstElementChild);
        clone.querySelector('.stats-bar__value').textContent = String(item.value);
        clone.querySelector('.stats-bar__label').textContent = t(item.label);
        bar.appendChild(clone);
    }

    return bar;
}

/**
 * Creates a boolean yes/no indicator as a DOM node.
 *
 * @param {any} val - Value to check for truthiness.
 * @returns {HTMLSpanElement} Span element with boolean CSS class and translated text.
 */
export function createBool(val) {
    const span = document.createElement('span');
    if (val === true || val === 1 || val === 'Yes') {
        span.className = 'bool-yes';
        span.textContent = t('Yes');
    } else {
        span.className = 'bool-no';
        span.textContent = t('No');
    }
    return span;
}

/**
 * Creates a loading spinner element as a DOM node.
 *
 * @param {string} [message="Loading"] - Text to display beside the spinner.
 * @returns {HTMLDivElement} The loading element.
 */
export function createLoading(message = 'Loading') {
    const div = document.createElement('div');
    div.className = 'loading';
    div.textContent = t(message);
    return div;
}

/**
 * Creates an error message element as a DOM node.
 *
 * @param {string} message - Error text.
 * @returns {HTMLDivElement} The error-message element.
 */
export function createError(message) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = message;
    return div;
}

/**
 * Creates an empty-state element as a DOM node.
 *
 * @param {string} message - Display text (passed through t() for i18n).
 * @returns {HTMLDivElement} The empty-state element.
 */
export function createEmptyState(message) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = t(message);
    return div;
}

/**
 * Creates a text node inside a DocumentFragment, suitable for use
 * as a table cell's content when no special formatting is needed.
 *
 * @param {string} text - Cell text content.
 * @returns {Text} A text node.
 */
export function createTextNode(text) {
    return document.createTextNode(text);
}

/**
 * Builds the standard detail-layout wrapper used by all entity pages.
 * Assembles header, optional logo, optional stats bar, sidebar, and
 * main content into the grid layout structure.
 *
 * @param {Object} opts - Layout options.
 * @param {string} opts.title - Page title (h1).
 * @param {string} [opts.subtitle] - Subtitle text below the title.
 * @param {string} [opts.logoUrl] - URL of the entity or org logo. Skipped when falsy.
 * @param {string} [opts.entityType] - Entity type for favorite button (net, ix, fac, etc.).
 * @param {number} [opts.entityId] - Entity ID for favorite button.
 * @param {HTMLElement} [opts.statsBar] - Optional stats bar element.
 * @param {HTMLElement|DocumentFragment} opts.sidebar - Sidebar content.
 * @param {HTMLElement|DocumentFragment} opts.main - Main content area.
 * @returns {HTMLDivElement} The assembled detail-layout element.
 */
export function createDetailLayout(opts) {
    const layout = document.createElement('div');
    layout.className = 'detail-layout';

    // Header: star + title + subtitle in a single flex row
    const header = document.createElement('div');
    header.className = 'detail-header';

    // Favorite toggle button — works for anonymous (localStorage) and authenticated (D1)
    if (opts.entityType && opts.entityId) {
        header.appendChild(createFavoriteButton(opts.entityType, opts.entityId, opts.title));
    }

    // Entity-type badge (colour-coded)
    if (opts.entityType) {
        header.appendChild(createEntityBadge(opts.entityType, { header: true }));
    }

    const h1 = document.createElement('h1');
    h1.className = 'detail-header__title';
    h1.textContent = opts.title;
    header.appendChild(h1);

    if (opts.subtitle) {
        const sub = document.createElement('span');
        sub.className = 'detail-header__subtitle';
        sub.textContent = opts.subtitle;
        header.appendChild(sub);
    }

    layout.appendChild(header);

    // Stats bar (full-width row)
    if (opts.statsBar) {
        const statsRow = document.createElement('div');
        statsRow.style.gridColumn = '1 / -1';
        statsRow.appendChild(opts.statsBar);
        layout.appendChild(statsRow);
    }

    // Sidebar
    const sidebarWrap = document.createElement('div');
    sidebarWrap.className = 'detail-sidebar';

    // Logo — at the top of the sidebar, constrained by sidebar width.
    // Hidden until loaded; removed on error.
    if (opts.logoUrl) {
        const logo = document.createElement('img');
        logo.className = 'detail-sidebar__logo';
        logo.alt = `${opts.title} logo`;
        logo.style.display = 'none';

        // Attach handlers BEFORE setting src — cached images fire
        // load synchronously and would be missed otherwise.
        logo.onload = () => { logo.style.display = ''; };
        logo.onerror = () => { logo.remove(); };
        logo.src = opts.logoUrl;

        // Catch already-cached images where load fired before insertion
        if (logo.complete && logo.naturalWidth > 0) {
            logo.style.display = '';
        }

        sidebarWrap.appendChild(logo);
    }

    sidebarWrap.appendChild(opts.sidebar);
    layout.appendChild(sidebarWrap);

    // Main
    const mainWrap = document.createElement('div');
    mainWrap.className = 'detail-main';
    mainWrap.appendChild(opts.main);
    layout.appendChild(mainWrap);

    return layout;
}

/**
 * Creates a favorite toggle button (star icon). Checks the in-memory
 * favorites cache for initial state and toggles on click via the
 * auth module's addFavorite/removeFavorite helpers.
 *
 * @param {string} entityType - Entity type tag (net, ix, fac, etc.).
 * @param {number} entityId - Entity ID.
 * @param {string} label - Display name for the entity (cached in D1).
 * @returns {HTMLButtonElement} The favorite toggle button.
 */
export function createFavoriteButton(entityType, entityId, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'favorite-btn';

    const active = isFavorite(entityType, entityId);
    btn.classList.toggle('favorite-btn--active', active);
    btn.textContent = active ? '★' : '☆';
    btn.title = active ? t('Remove from favorites') : t('Add to favorites');

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        const wasActive = btn.classList.contains('favorite-btn--active');

        if (wasActive) {
            const ok = await removeFavorite(entityType, entityId);
            if (ok) {
                btn.classList.remove('favorite-btn--active');
                btn.textContent = '☆';
                btn.title = t('Add to favorites');
            }
        } else {
            const ok = await addFavorite(entityType, entityId, label);
            if (ok) {
                btn.classList.add('favorite-btn--active');
                btn.textContent = '★';
                btn.title = t('Remove from favorites');
            }
        }

        btn.disabled = false;
    });

    return btn;
}
