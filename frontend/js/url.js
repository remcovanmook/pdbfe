/**
 * @fileoverview URL scheme sanitisers shared across the frontend.
 *
 * PeeringDB entity fields (website, looking_glass, route_server, policy_url,
 * notes, …) are operator-editable, so any URL taken from an API response and
 * placed into a link or image is untrusted. These helpers enforce a strict
 * scheme allowlist so an attacker cannot smuggle a `javascript:` (or other
 * active) scheme into an `href`/`src`.
 *
 * Two distinct sanitisers, deliberately NOT merged:
 *   - sanitiseURL      — for navigable/link contexts (`<a href>`): http/https/mailto only.
 *   - sanitiseImageURL — for `<img src>` only: the above PLUS `data:image/*;base64`.
 *
 * `data:` URIs are allowed for images because inline base64 images (including
 * `image/svg+xml`) appear in real PeeringDB notes and are inert in an `<img>`
 * context (SVG loaded via `<img>` runs in restricted, non-scripted mode). That
 * value must therefore NEVER be routed through sanitiseURL / used as an `href`,
 * which is exactly why the two functions stay separate.
 */

/**
 * Validates a URL for a navigable/link context, allowing only safe schemes.
 * Returns the trimmed URL if it uses http:, https:, or mailto:, otherwise ''.
 *
 * @param {string} url - URL to validate.
 * @returns {string} Sanitised URL, or '' if the scheme is not allowed.
 */
export function sanitiseURL(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
        return trimmed;
    }
    return '';
}

/**
 * Validates a URL for use in an `<img src>` attribute. Allows the same schemes
 * as sanitiseURL plus `data:image/*;base64` inline images (common in PeeringDB
 * notes). NOT for use in any navigable context — see the file header.
 *
 * @param {string} url - URL to validate.
 * @returns {string} Sanitised URL, or '' if not allowed.
 */
export function sanitiseImageURL(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    // Strip optional dimension suffix (e.g. " =410x300"). Anchored to the end
    // with no leading `\s*` scan — a `\s*` here backtracks at every start
    // position, which is super-linear on a long whitespace run. trimEnd() drops
    // the space the suffix left behind.
    const cleaned = trimmed.replace(/=\d+x\d+$/, '').trimEnd();
    if (/^data:image\/[a-z+]+;base64,/i.test(cleaned)) {
        return cleaned;
    }
    return sanitiseURL(cleaned);
}
