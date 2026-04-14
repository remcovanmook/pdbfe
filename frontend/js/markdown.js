/**
 * @fileoverview Lightweight markdown-to-HTML renderer for PeeringDB notes fields.
 * Handles the subset of markdown commonly used in PeeringDB: headings,
 * bold, italic, links, line breaks, basic lists, code spans, and
 * fenced code blocks.
 *
 * PeeringDB notes often contain raw HTML (especially anchor tags). The
 * renderer sanitises HTML first — allowing `<a href>` through a strict
 * harness — then escapes the remainder before applying markdown transforms.
 *
 * Link URLs are validated to only allow http:, https:, and mailto: protocols.
 */

/**
 * Sentinel strings used to protect sanitised HTML tags from the
 * escape pass. These are chosen to be unlikely to appear in real input.
 * @type {string}
 */
const LINK_OPEN = '\uE000LINK_OPEN\uE000';
const LINK_CLOSE = '\uE000LINK_CLOSE\uE000';
const TAG_OPEN = '\uE001TAG_OPEN\uE001';
const TAG_CLOSE = '\uE001TAG_CLOSE\uE001';

/**
 * Set of HTML tag names that are allowed through the sanitiser unchanged
 * (aside from `<a>`, which gets special handling).
 * @type {Set<string>}
 */
const SAFE_TAGS = new Set(['br', 'p', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li']);

/**
 * Escapes HTML special characters to prevent XSS when injecting
 * into innerHTML. Applied after sanitisation so that only non-safe
 * content is escaped.
 *
 * @param {string} str - Raw input string.
 * @returns {string} HTML-escaped string.
 */
function escapeForMarkdown(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Validates a URL, allowing only safe protocols.
 * Returns the URL if valid, empty string otherwise.
 *
 * @param {string} url - URL to validate.
 * @returns {string} Sanitised URL or empty string.
 */
function sanitiseURL(url) {
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
        return trimmed;
    }
    return '';
}

/**
 * Validates a URL for use in image src attributes.
 * Allows the same protocols as sanitiseURL plus data:image URIs
 * (base64-encoded inline images commonly found in PeeringDB notes).
 *
 * @param {string} url - URL to validate.
 * @returns {string} Sanitised URL or empty string.
 */
function sanitiseImageURL(url) {
    const trimmed = url.trim();
    // Strip optional dimension suffix (e.g. " =410x300")
    const cleaned = trimmed.replace(/\s*=[0-9]+x[0-9]+$/, '');
    if (/^data:image\/[a-z+]+;base64,/i.test(cleaned)) {
        return cleaned;
    }
    return sanitiseURL(cleaned);
}

/**
 * Escapes characters that have special meaning inside an HTML attribute
 * value (double-quoted). Used for href values in sanitised anchor tags.
 *
 * @param {string} str - Raw attribute value.
 * @returns {string} Escaped string safe for use inside `href="..."`.
 */
function escapeAttr(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Sanitises HTML in PeeringDB notes fields. Processes the raw input and:
 *
 * - Converts `<a href="...">text</a>` to placeholder-wrapped safe links.
 *   Only `href` is kept; `target` and `rel` are forced to safe values.
 *   All other attributes are stripped.
 * - Preserves other safe tags (br, p, strong, em, b, i, ul, ol, li) as-is.
 * - Strips all other HTML tags, keeping their text content.
 *
 * Anchor tags are wrapped in sentinel placeholders so they survive the
 * subsequent `escapeForMarkdown()` pass. Call `restoreLinks()` after
 * escaping to convert placeholders back to real `<a>` tags.
 *
 * @param {string} input - Raw notes text potentially containing HTML.
 * @returns {string} Sanitised text with link placeholders.
 */
function sanitiseHTML(input) {
    // Process all HTML tags in the input
    return input.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
        (fullMatch, tagName, attrs) => {
            const tag = tagName.toLowerCase();
            const isClosing = fullMatch.startsWith('</');

            // Anchor tags get special handling with a strict harness
            if (tag === 'a') {
                if (isClosing) {
                    return LINK_CLOSE;
                }
                // Extract href from attributes, ignore everything else
                const hrefMatch = /href\s*=\s*"([^"]*)"/i.exec(attrs)
                    || /href\s*=\s*'([^']*)'/i.exec(attrs)
                    || /href\s*=\s*([^\s>]+)/i.exec(attrs);

                if (hrefMatch) {
                    const url = sanitiseURL(hrefMatch[1]);
                    if (url) {
                        return `${LINK_OPEN}<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">`;
                    }
                }
                // No valid href — strip the tag, keep content
                return '';
            }

            // Safe tags are wrapped in sentinels to survive the escape pass
            if (SAFE_TAGS.has(tag)) {
                return isClosing
                    ? `${TAG_OPEN}</${tag}>${TAG_CLOSE}`
                    : `${TAG_OPEN}<${tag}>${TAG_CLOSE}`;
            }

            // Everything else is stripped (content kept)
            return '';
        }
    );
}

/**
 * Restores tag placeholders back to real HTML after the escape pass.
 * Handles both sanitised `<a>` tags (with sentinel-wrapped attributes)
 * and safe tags (br, strong, em, etc.).
 *
 * @param {string} html - Escaped HTML containing sentinels.
 * @returns {string} HTML with restored tags.
 */
function restoreTags(html) {
    return html
        // Restore anchor tags: sentinel wraps the escaped <a> tag
        .replace(
            /\uE000LINK_OPEN\uE000&lt;a href=&quot;([^&]*)&quot; target=&quot;_blank&quot; rel=&quot;noopener noreferrer&quot;&gt;/g,
            '<a href="$1" target="_blank" rel="noopener noreferrer">'
        )
        .replace(/\uE000LINK_CLOSE\uE000/g, '</a>')
        // Restore safe tags: sentinel wraps the escaped tag
        .replace(/\uE001TAG_OPEN\uE001&lt;(\/?[a-z]+)&gt;\uE001TAG_CLOSE\uE001/g, '<$1>');
}

/**
 * Converts a markdown-formatted string to sanitised HTML.
 * Handles both markdown formatting and raw HTML from PeeringDB notes.
 *
 * Processing order:
 * 1. Sanitise HTML (allow safe `<a href>`, preserve safe tags, strip rest)
 * 2. Escape remaining HTML special characters
 * 3. Restore sanitised link placeholders
 * 4. Apply markdown transforms (bold, italic, code, links, lists)
 *
 * @param {string} text - Raw markdown/HTML text from PeeringDB notes.
 * @returns {string} Sanitised HTML string ready for innerHTML.
 */
export function renderMarkdown(text) {
    if (!text || typeof text !== 'string') return '';

    // Step 1: Sanitise HTML — allow safe <a href>, strip unsafe tags
    let html = sanitiseHTML(text);

    // Step 2: Escape remaining HTML special characters
    html = escapeForMarkdown(html);

    // Step 3: Restore sanitised tags from placeholders
    html = restoreTags(html);

    // Step 3b: Extract fenced code blocks before inline processing.
    // This prevents bold/italic/link transforms from touching code content.
    // Each block is replaced with a numbered sentinel; restored at the end.
    /** @type {string[]} */
    const codeBlocks = [];
    html = html.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_, content) => {
        const idx = codeBlocks.length;
        codeBlocks.push(content.replace(/\n$/, ''));
        return `\uE002CODEBLOCK_${idx}\uE002`;
    });

    // Handle unclosed code blocks (fence at EOF without closing ```)
    html = html.replace(/^```[^\n]*\n([\s\S]*)$/gm, (_, content) => {
        const idx = codeBlocks.length;
        codeBlocks.push(content.replace(/\n$/, ''));
        return `\uE002CODEBLOCK_${idx}\uE002`;
    });

    // Step 4: Code spans (before other inline processing)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Step 5: Bold (**text** or __text__)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // Step 6: Italic (*text* or _text_)
    // Negative lookbehind for word chars prevents matching mid-word underscores
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<em>$1</em>');

    // Step 7a: Linked images [![alt](img-src)](link-url)
    html = html.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, (_, alt, imgSrc, linkUrl) => {
        const safeSrc = sanitiseImageURL(imgSrc);
        const safeHref = sanitiseURL(linkUrl);
        if (!safeSrc) return alt || '';
        const loading = safeSrc.startsWith('data:') ? ' loading="lazy"' : '';
        const img = `<img src="${/* safe — escapeAttr */ escapeAttr(safeSrc)}" alt="${/* safe — escapeAttr */ escapeAttr(alt)}"${/* safe — static string */ loading} style="max-width:100%">`;
        if (safeHref) {
            return `<a href="${/* safe — escapeAttr */ escapeAttr(safeHref)}" rel="noopener noreferrer" target="_blank">${/* safe — built from escapeAttr calls */ img}</a>`;
        }
        return img;
    });

    // Step 7b: Standalone images ![alt](src)
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
        const safeSrc = sanitiseImageURL(src);
        if (!safeSrc) return alt || '';
        const loading = safeSrc.startsWith('data:') ? ' loading="lazy"' : '';
        return `<img src="${/* safe — escapeAttr */ escapeAttr(safeSrc)}" alt="${/* safe — escapeAttr */ escapeAttr(alt)}"${/* safe — static string */ loading} style="max-width:100%">`;
    });

    // Step 7c: Markdown links [text](url) — only if not already inside an <a> tag
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
        const safeUrl = sanitiseURL(url);
        if (!safeUrl) return label;
        return `<a href="${escapeAttr(safeUrl)}" rel="noopener noreferrer" target="_blank">${/* safe — already escaped by escapeForMarkdown */ label}</a>`;
    });

    // Step 8: Bare URLs (http/https only, not already in an href or <a> tag)
    html = html.replace(
        /(?<!href=")(https?:\/\/[^\s<&]+)/g,
        '<a href="$1" rel="noopener noreferrer" target="_blank">$1</a>'
    );

    // Step 9: Process line-by-line for headings, lists, and line breaks
    const lines = html.split('\n');
    const result = [];
    let inList = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Code block placeholder — emit as <pre><code>
        const codeMatch = /^\uE002CODEBLOCK_(\d+)\uE002$/.exec(trimmed);
        if (codeMatch) {
            if (inList) {
                result.push('</ul>');
                inList = false;
            }
            result.push(`<pre><code>${/* safe — escaped by escapeForMarkdown in step 2 */ codeBlocks[Number(codeMatch[1])]}</code></pre>`);
            continue;
        }

        // Headings: # through ######
        const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
        if (headingMatch) {
            if (inList) {
                result.push('</ul>');
                inList = false;
            }
            const level = headingMatch[1].length;
            result.push(`<h${level}>${/* safe — escaped by escapeForMarkdown in step 2 */ headingMatch[2]}</h${level}>`);
            continue;
        }

        // Unordered list items
        if (/^[-*]\s+/.test(trimmed)) {
            if (!inList) {
                result.push('<ul>');
                inList = true;
            }
            result.push(`<li>${/* safe — already escaped by escapeForMarkdown */ trimmed.replace(/^[-*]\s+/, '')}</li>`);
            continue;
        }

        // Close list if we were in one
        if (inList) {
            result.push('</ul>');
            inList = false;
        }

        // Empty lines become spacing
        if (trimmed === '') {
            result.push('<br>');
            continue;
        }

        // Regular text line
        result.push(trimmed);
        result.push('<br>');
    }

    // Close any open list
    if (inList) {
        result.push('</ul>');
    }

    // Remove trailing <br>
    let output = result.join('\n');
    output = output.replace(/(<br>\s*)+$/, '');

    return output;
}
