/**
 * @fileoverview Builds the deployable copy of the frontend with versioned
 * asset URLs, so /js and /css can be served `immutable`.
 *
 * Copies frontend/ (minus node_modules) into an output directory and appends
 * `?v=<version>` to:
 *   - every relative static import/export specifier in js/**\/*.js
 *     (`from './x.js'`, `import './x.js'`)
 *   - the /js/*.js module and modulepreload URLs in index.html
 *   - the /css/*.css stylesheet URLs in index.html (replacing any ?v=N)
 *
 * and appends an `immutable` Cache-Control rule for /js/* and /css/* to the
 * output's _headers. That rule lives only in the build: `wrangler pages dev`
 * on frontend/ (local dev, e2e) serves plain URLs, where it would pin stale
 * modules in the browser for a year.
 *
 * Every release changes every URL, so a browser never mixes module versions,
 * and between releases repeat loads need no network for JS or CSS. The
 * working tree keeps plain URLs: local dev and e2e run against frontend/
 * directly. deploy.sh uploads the output directory instead.
 *
 * The token is `<version>-<hash>`: the release version plus a short hash of
 * the js/ and css/ contents, so a redeploy with changed files but an
 * unchanged VERSION still gets new URLs.
 *
 * Usage:
 *   node scripts/version_frontend.js <out-dir> <version>
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '../frontend');

/** `from './x.js'` / `from "../y.js"` in import and re-export statements. */
const FROM_SPECIFIER = /(\bfrom\s*)(['"])(\.\.?\/[^'"?]+\.js)\2/g;

/**
 * Side-effect imports at the start of a line: `import './x.js';`. Only
 * spaces and tabs around `import`: `\s` would also match newlines, so a run
 * of blank lines could be matched from every line start inside it.
 */
const BARE_IMPORT = /^([ \t]*import[ \t]*)(['"])(\.\.?\/[^'"?]+\.js)\2/gm;

/** /js/*.js in src= or href= attributes. */
const HTML_JS = /((?:src|href)=")(\/js\/[^"?]+\.js)"/g;

/** /css/*.css in href= attributes, with or without an existing ?v=. */
const HTML_CSS = /(href=")(\/css\/[^"?]+\.css)(?:\?v=[^"]*)?"/g;

/** Pages _headers rules for the versioned asset paths. */
export const IMMUTABLE_HEADERS = `
# Added by scripts/version_frontend.js: every /js and /css URL carries the
# release version (?v=), so a cached copy can never be out of date.
/js/*
  Cache-Control: public, max-age=31536000, immutable

/css/*
  Cache-Control: public, max-age=31536000, immutable
`;

/**
 * Appends `?v=<version>` to every relative import/export specifier.
 *
 * @param {string} src - JavaScript module source.
 * @param {string} version - Release version.
 * @returns {string}
 */
export function versionModuleSpecifiers(src, version) {
    const q = `?v=${encodeURIComponent(version)}`;
    return src
        .replace(FROM_SPECIFIER, (_, pre, quote, spec) => `${pre}${quote}${spec}${q}${quote}`)
        .replace(BARE_IMPORT, (_, pre, quote, spec) => `${pre}${quote}${spec}${q}${quote}`);
}

/**
 * Appends `?v=<version>` to the /js and /css URLs in index.html.
 *
 * @param {string} html - index.html source.
 * @param {string} version - Release version.
 * @returns {string}
 */
export function versionIndexHtml(html, version) {
    const q = `?v=${encodeURIComponent(version)}`;
    return html
        .replace(HTML_JS, (_, attr, url) => `${attr}${url}${q}"`)
        .replace(HTML_CSS, (_, attr, url) => `${attr}${url}${q}"`);
}

/**
 * Lists every .js file under a directory, recursively.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile() && e.name.endsWith('.js'))
        .map((e) => path.join(e.parentPath, e.name));
}

/**
 * Short content hash of every file under js/ and css/ (paths and bytes).
 *
 * @param {string} srcDir - The frontend directory.
 * @returns {string} 10 hex characters.
 */
export function assetHash(srcDir) {
    const h = crypto.createHash('sha256');
    for (const sub of ['js', 'css']) {
        const dir = path.join(srcDir, sub);
        const files = fs.readdirSync(dir, { withFileTypes: true, recursive: true })
            .filter((e) => e.isFile())
            .map((e) => path.relative(srcDir, path.join(e.parentPath, e.name)))
            .sort();
        for (const rel of files) {
            h.update(rel + '\0');
            h.update(fs.readFileSync(path.join(srcDir, rel)));
        }
    }
    return h.digest('hex').slice(0, 10);
}

/**
 * Copies srcDir to outDir (replacing it) and versions the asset URLs.
 *
 * @param {string} srcDir - The frontend directory.
 * @param {string} outDir - Output directory; removed first if present.
 * @param {string} version - Release version.
 * @returns {string} The token used in `?v=`.
 */
export function buildVersionedFrontend(srcDir, outDir, version) {
    if (!version) throw new Error('version is required');
    const token = `${version}-${assetHash(srcDir)}`;
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.cpSync(srcDir, outDir, {
        recursive: true,
        filter: (p) => path.basename(p) !== 'node_modules',
    });

    for (const file of jsFiles(path.join(outDir, 'js'))) {
        const src = fs.readFileSync(file, 'utf8');
        const out = versionModuleSpecifiers(src, token);
        if (out !== src) fs.writeFileSync(file, out);
    }

    const index = path.join(outDir, 'index.html');
    fs.writeFileSync(index, versionIndexHtml(fs.readFileSync(index, 'utf8'), token));

    fs.appendFileSync(path.join(outDir, '_headers'), IMMUTABLE_HEADERS);
    return token;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [outDir, version] = process.argv.slice(2);
    if (!outDir || !version) {
        console.error('Usage: node scripts/version_frontend.js <out-dir> <version>');
        process.exit(2);
    }
    const token = buildVersionedFrontend(FRONTEND_DIR, path.resolve(outDir), version);
    console.log(`Versioned frontend (v=${token}) written to ${outDir}`);
}
