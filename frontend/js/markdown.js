/**
 * @fileoverview Lightweight markdown-to-HTML renderer for PeeringDB notes fields.
 * Handles the subset of markdown commonly used in PeeringDB: bold, italic,
 * links, line breaks, basic lists, and code spans.
 *
 * All input HTML is escaped first to prevent XSS. Link URLs are sanitised
 * to only allow http:, https:, and mailto: protocols.
 */

/**
 * Escapes HTML special characters to prevent XSS when injecting
 * into innerHTML. Applied before any markdown processing.
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
 * Converts a markdown-formatted string to sanitised HTML.
 * Processes: bold, italic, code spans, links, lists, line breaks.
 *
 * @param {string} text - Raw markdown text.
 * @returns {string} Sanitised HTML string.
 */
export function renderMarkdown(text) {
    if (!text || typeof text !== 'string') return '';

    // Step 1: Escape all HTML
    let html = escapeForMarkdown(text);

    // Step 2: Code spans (before other inline processing)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Step 3: Bold (**text** or __text__)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // Step 4: Italic (*text* or _text_)
    // Negative lookbehind for word chars prevents matching mid-word underscores
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<em>$1</em>');

    // Step 5: Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
        const safeUrl = sanitiseURL(url);
        if (!safeUrl) return label;
        return `<a href="${escapeForMarkdown(safeUrl)}" rel="noopener noreferrer" target="_blank">${label}</a>`;
    });

    // Step 6: Bare URLs (http/https only, not already in an <a> tag)
    html = html.replace(
        /(?<!href=&quot;)(https?:\/\/[^\s<&]+)/g,
        '<a href="$1" rel="noopener noreferrer" target="_blank">$1</a>'
    );

    // Step 7: Process line-by-line for lists and line breaks
    const lines = html.split('\n');
    const result = [];
    let inList = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Unordered list items
        if (/^[-*]\s+/.test(trimmed)) {
            if (!inList) {
                result.push('<ul>');
                inList = true;
            }
            result.push(`<li>${trimmed.replace(/^[-*]\s+/, '')}</li>`);
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
