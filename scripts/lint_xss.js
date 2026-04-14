/**
 * @fileoverview Zero-dependency XSS scanner for Vanilla JS template literals.
 *
 * Scans all .js files under frontend/js/ for template literal interpolations
 * (${...}) that appear inside HTML contexts (near HTML tags) without being
 * wrapped in a known safe function. Designed to run as a pre-commit hook.
 *
 * Safe functions are those that either escape HTML entities (escapeHTML),
 * return pre-escaped HTML (render*, linkEntity), perform i18n lookups (t),
 * or coerce to safe primitives (Number, String).
 *
 * Use the /* safe *\/ comment inside an interpolation to suppress a warning
 * for cases the scanner cannot statically verify.
 *
 * Usage:
 *   node scripts/lint_xss.js
 *
 * Exit codes:
 *   0 — No unescaped interpolations found.
 *   1 — One or more unescaped interpolations detected.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '../frontend/js');

/**
 * Functions whose return values are safe to interpolate into HTML.
 * Includes escaping functions, rendering functions that escape internally,
 * i18n lookups, formatting helpers, and type coercion.
 *
 * @type {string[]}
 */
const SAFE_FUNCTIONS = [
    // Direct escaping
    'escapeHTML',
    // i18n — returns translated label strings
    't',
    // Rendering functions that use escapeHTML internally
    'render',
    'renderLoading',
    'renderError',
    'renderTable',
    'renderField',
    'renderStatsBar',
    // Entity link builder — returns pre-escaped <a> tags
    'linkEntity',
    // Date formatting — returns locale-formatted strings
    'formatDate',
    'formatLocaleDate',
    // Type coercion — safe primitives
    'Number',
    'String',
];

let hasErrors = false;

/**
 * Recursively scans a directory for .js files and checks each one
 * for unescaped template literal interpolations in HTML contexts.
 *
 * @param {string} dir - Absolute path to the directory to scan.
 */
function scanDirectory(dir) {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            scanDirectory(fullPath);
        } else if (fullPath.endsWith('.js')) {
            scanFile(fullPath);
        }
    }
}

/**
 * Scans a single JS file for template literal interpolations that
 * appear in HTML contexts without safe function wrappers.
 *
 * Detection heuristic: a line contains both an HTML tag (<word) and
 * a template interpolation ${...}. This filters out non-HTML template
 * literals (SQL strings, log messages, etc.) that are not XSS vectors.
 *
 * @param {string} filePath - Absolute path to the .js file to scan.
 */
function scanFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Match template interpolations ${...} on lines that contain HTML tags.
    // Uses a non-greedy match for the interpolation content.
    const htmlInterpolationRegex = /<[a-zA-Z][^>]*>.*?\$\{([^}]+)\}/g;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match;
        // Reset regex state for each line
        htmlInterpolationRegex.lastIndex = 0;

        while ((match = htmlInterpolationRegex.exec(line)) !== null) {
            const innerContent = match[1].trim();

            // Check if the interpolation starts with a known safe function call
            const isSafe = SAFE_FUNCTIONS.some(fn => innerContent.startsWith(`${fn}(`));

            // Allow manual override: ${/* safe */ myVar} or ${/* safe — reason */ myVar}
            const hasSafeComment = /\/\*\s*safe\b/.test(innerContent);

            // Numeric expressions are not XSS vectors. This covers:
            //   - Property access ending in numeric names (.id, .asn, .length, .count)
            //   - Math.* calls (Math.ceil, Math.floor, etc.)
            const isNumeric = /^[\w.?[\]]+$/.test(innerContent)
                && /\.(id|asn|length|count|size|hits|cnt)\s*$/.test(innerContent)
                || innerContent.startsWith('Math.');

            // Variables whose names indicate they contain pre-assembled HTML
            // from safe rendering functions. The scanner cannot trace data flow,
            // so we whitelist common fragment variable names. These are container
            // variables that hold concatenated output from escapeHTML/render*.
            const bareVar = innerContent.replace(/\?$/, '');
            const isHtmlFragment = /^[a-zA-Z_$]+$/.test(bareVar) && (
                /HTML$/i.test(bareVar)                     // headerHTML, bodyHTML, valueHTML, filterHTML, pagingHTML
                || /^(sidebar|tables|rows|cells|inner|items|columns|statsBar|safe|rendered|count)$/.test(bareVar)
            );

            if (!isSafe && !hasSafeComment && !isNumeric && !isHtmlFragment) {
                const relativePath = path.relative(FRONTEND_DIR, filePath);
                console.error(`\n  XSS: ${relativePath}:${i + 1}`);
                console.error(`  Line: ${line.trim()}`);
                console.error(`  Fix: Wrap '\${${innerContent}}' in escapeHTML() or mark with /* safe */`);
                hasErrors = true;
            }
        }
    }
}

console.log('Scanning frontend for XSS vulnerabilities...');

if (!fs.existsSync(FRONTEND_DIR)) {
    console.error(`Directory not found: ${FRONTEND_DIR}`);
    process.exit(1);
}

scanDirectory(FRONTEND_DIR);

if (hasErrors) {
    console.error('\nXSS linting failed. Commit rejected.');
    process.exit(1);
} else {
    console.log('XSS linting passed. No unescaped HTML interpolations found.');
    process.exit(0);
}
