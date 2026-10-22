/**
 * @fileoverview Builds the deployable copy of the frontend with versioned
 * asset URLs, so the static assets can be served `immutable`.
 *
 * Copies frontend/ (minus node_modules) into an output directory, replaces
 * js/ with a minified, code-split bundle (see bundleJs): js/boot.js plus
 * content-hashed js/chunks/*, with source maps. Then it appends
 * `?v=<token>` to:
 *   - the /js, /css and listed /third_party URLs in src=/href= attributes of
 *     index.html and api/*.html (replacing any hand-written ?v=N)
 *   - the font URLs in third_party/inter/inter.css
 *   - quoted listed /third_party URLs in js/ (the Leaflet files pdb-map loads)
 *   - the locale URL in js/i18n.js (`/locales/${lang}.json`)
 *
 * It then sets `Cache-Control: public, max-age=31536000, immutable` on the
 * matching rules in the output's _headers (see setImmutableRules). That
 * lives only in the build: `wrangler pages dev` on frontend/ (local dev, e2e)
 * serves plain URLs, where it would pin stale files in the browser for a
 * year.
 *
 * Every release changes every URL, so a browser never mixes versions, and
 * between releases repeat loads need no network for these assets. deploy.sh
 * uploads the output directory.
 *
 * Leaflet's images (third_party/leaflet/images) stay unversioned: leaflet.js
 * finds its icon path by matching `marker-icon.png)` at the end of the CSS
 * url(), which a ?v= would break.
 *
 * The build's _headers also carries the page's full `Link:` header (see
 * setLinkHeader), which Cloudflare sends as 103 Early Hints. Pages would generate
 * one from the preload tags, but leaves out the font preload (as="font" with
 * crossorigin), and any Link set in _headers replaces its generated one
 * entirely (checked on a preview deployment), so the build lists every
 * preload and modulepreload tag itself.
 *
 * The token is `<version>-<hash>`: the release version plus a short hash of
 * every versioned directory, so a redeploy with changed files but an
 * unchanged VERSION still gets new URLs.
 *
 * Usage:
 *   node scripts/version_frontend.js <out-dir> <version>
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '../frontend');

/** Directories whose contents go into the version hash. */
const HASHED_DIRS = ['js', 'css', 'locales', 'third_party'];

/** Third-party files served under a versioned URL (Leaflet images excluded, see above). */
export const VERSIONED_THIRD_PARTY = Object.freeze([
    '/third_party/inter/inter.css',
    '/third_party/inter/inter-latin.woff2',
    '/third_party/inter/inter-latin-ext.woff2',
    '/third_party/leaflet/leaflet.css',
    '/third_party/leaflet/leaflet.js',
]);

/**
 * _headers rules made immutable in the build. Each matches only versioned
 * URLs; the frontend/_headers.example rules for them must not overlap
 * (Pages joins the values of every rule that matches a path).
 */
export const IMMUTABLE_RULES = Object.freeze([
    '/js/*',
    '/css/*',
    '/locales/*',
    '/third_party/inter/*',
    '/third_party/leaflet/leaflet.css',
    '/third_party/leaflet/leaflet.js',
]);

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** /js/*.js and /css/*.css in src= or href= attributes, with or without an existing ?v=. */
const HTML_ASSET = /((?:src|href)=")(\/(?:js\/[^"?]+\.js|css\/[^"?]+\.css))(?:\?v=[^"]*)?"/g;

/** /third_party/... in src= or href= attributes; only VERSIONED_THIRD_PARTY URLs are rewritten. */
const HTML_THIRD_PARTY = /((?:src|href)=")(\/third_party\/[^"?]+)"/g;

/** url('/third_party/...') in CSS; only VERSIONED_THIRD_PARTY URLs are rewritten. */
const CSS_THIRD_PARTY = /url\((['"]?)(\/third_party\/[^'"()?\s]+)\1\)/g;

/** A quoted /third_party URL in JS source; only VERSIONED_THIRD_PARTY URLs are rewritten. */
const JS_THIRD_PARTY = /(['"])(\/third_party\/[^'"?]+)\1/g;

/** The locale fetch URL in js/i18n.js, exactly as written there. */
export const LOCALE_URL = '`/locales/${lang}.json`';

/** Any <link ...> tag. */
const LINK_TAG = /<link\s[^>]*>/g;

/** One attribute in a tag: name, optionally ="value". */
const TAG_ATTR = /([a-z][a-z-]*)(?:="([^"]*)")?/g;

/** A whole line holding a `<link rel="modulepreload">` for a /js module. */
const MODULEPRELOAD_LINE = /^[ \t]*<link rel="modulepreload" href="\/js\/[^"]*">[ \t]*\n/gm;

/** @param {string} token */
const query = (token) => `?v=${encodeURIComponent(token)}`;

/**
 * Appends `?v=<token>` to the /js, /css and versioned /third_party URLs in
 * an HTML page's src= and href= attributes.
 *
 * @param {string} html - Page source.
 * @param {string} token - Version token.
 * @returns {string}
 */
export function versionHtml(html, token) {
    const q = query(token);
    return html
        .replace(HTML_ASSET, (_, attr, url) => `${attr}${url}${q}"`)
        .replace(HTML_THIRD_PARTY, (m, attr, url) => (VERSIONED_THIRD_PARTY.includes(url) ? `${attr}${url}${q}"` : m));
}

/**
 * Appends `?v=<token>` to versioned /third_party URLs inside CSS url().
 *
 * @param {string} css - Stylesheet source.
 * @param {string} token - Version token.
 * @returns {string}
 */
export function versionCssUrls(css, token) {
    const q = query(token);
    return css.replace(CSS_THIRD_PARTY, (m, quote, url) => (
        VERSIONED_THIRD_PARTY.includes(url) ? `url(${quote}${url}${q}${quote})` : m
    ));
}

/**
 * Appends `?v=<token>` to quoted VERSIONED_THIRD_PARTY URLs in JS source,
 * e.g. the Leaflet files pdb-map loads on demand.
 *
 * @param {string} src - JavaScript source.
 * @param {string} token - Version token.
 * @returns {string}
 */
export function versionJsThirdParty(src, token) {
    const q = query(token);
    return src.replace(JS_THIRD_PARTY, (m, quote, url) => (VERSIONED_THIRD_PARTY.includes(url) ? `${quote}${url}${q}${quote}` : m));
}

/**
 * Versions the locale fetch URL in js/i18n.js. Throws if the expected
 * template literal is missing, so a refactor of i18n.js fails the build
 * instead of shipping immutable, unversioned locales.
 *
 * @param {string} src - js/i18n.js source.
 * @param {string} token - Version token.
 * @returns {string}
 */
export function versionLocaleUrl(src, token) {
    if (!src.includes(LOCALE_URL)) {
        throw new Error(`js/i18n.js no longer contains ${LOCALE_URL}; update LOCALE_URL in scripts/version_frontend.js`);
    }
    return src.replaceAll(LOCALE_URL, `\`/locales/\${lang}.json${query(token)}\``);
}

/**
 * Sets the immutable Cache-Control on each IMMUTABLE_RULES path in a Pages
 * _headers file: replaces the Cache-Control of an existing rule for that
 * exact path (or adds one to it), and appends a rule for paths it lacks.
 * Throws if another rule with a Cache-Control would also match one of these
 * paths, because Pages would join the two values.
 *
 * @param {string} headers - _headers source.
 * @returns {string}
 */
export function setImmutableRules(headers) {
    const lines = headers.split('\n');
    /** @type {string|null} */
    let rule = null;
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const cacheRules = [];
    for (const line of lines) {
        const isRule = line.length > 0 && !/^[\s#]/.test(line);
        if (isRule) {
            rule = line.trim();
            out.push(line);
            if (IMMUTABLE_RULES.includes(rule)) {
                seen.add(rule);
                out.push(`  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`);
            }
            continue;
        }
        if (rule && /^\s+cache-control\s*:/i.test(line)) {
            if (IMMUTABLE_RULES.includes(rule)) continue; // replaced above
            cacheRules.push(rule);
        }
        out.push(line);
    }
    for (const other of cacheRules) {
        const prefix = other.endsWith('*') ? other.slice(0, -1) : null;
        const overlaps = IMMUTABLE_RULES.filter((r) => r === other || (prefix !== null && r.startsWith(prefix)));
        if (overlaps.length) {
            throw new Error(`_headers rule ${other} sets Cache-Control and overlaps ${overlaps.join(', ')}; Pages would join the values`);
        }
    }
    const missing = IMMUTABLE_RULES.filter((r) => !seen.has(r));
    if (missing.length) {
        out.push('', '# Added by scripts/version_frontend.js: these URLs carry the release version (?v=).');
        for (const r of missing) out.push(r, `  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`, '');
    }
    return out.join('\n');
}

/**
 * The Link header entries for a page's preload and modulepreload tags, in
 * page order, formatted as Pages formats its generated ones.
 *
 * modulepreload tags become `rel="preload"; as=script; crossorigin`:
 * Cloudflare forwards only rel=preload (and preconnect) in the 103 Early
 * Hints, so a modulepreload entry never reaches the browser early. With
 * crossorigin the preload matches the module's CORS-mode request and is
 * reused (checked in Chromium: each module fetched once, no warning).
 * Without it, it would not match, which is how Rocket Loader's injected
 * preload made boot.js download twice.
 *
 * @param {string} html - Versioned page.
 * @returns {string[]}
 */
export function linkEntries(html) {
    /** @type {string[]} */
    const entries = [];
    for (const [tag] of html.matchAll(LINK_TAG)) {
        /** @type {Record<string, string>} */
        const attrs = {};
        for (const [, name, value] of tag.slice(5).matchAll(TAG_ATTR)) attrs[name] = value ?? '';
        if (!attrs.href || (attrs.rel !== 'preload' && attrs.rel !== 'modulepreload')) continue;
        if (attrs.rel === 'modulepreload') {
            entries.push(`<${attrs.href}>; rel="preload"; as=script; crossorigin`);
            continue;
        }
        let entry = `<${attrs.href}>; rel="${attrs.rel}"`;
        if (attrs.as) entry += `; as=${attrs.as}`;
        if (attrs.type) entry += `; type="${attrs.type}"`;
        if ('crossorigin' in attrs) entry += '; crossorigin';
        entries.push(entry);
    }
    return entries;
}

/** Asset paths that must not carry the page's Link header (`! Link` detaches it). */
export const NO_LINK_PATHS = Object.freeze(['/js/*', '/css/*', '/locales/*', '/third_party/*', '/content/*', '/api/*']);

/**
 * Adds a header line to the rule for rulePath: inside the existing rule if
 * there is one, otherwise as a new rule at the end. Never a second block for
 * the same path: Pages keeps only one of them (on a preview deployment a
 * second `/*` block dropped X-Frame-Options, a second `/js/*` the immutable
 * Cache-Control).
 *
 * @param {string} headers - _headers source.
 * @param {string} rulePath - Rule path, e.g. '/*'.
 * @param {string} line - Header line without indentation, e.g. '! Link'.
 * @returns {string}
 */
export function addToRule(headers, rulePath, line) {
    const lines = headers.split('\n');
    const at = lines.findIndex((l) => l.length > 0 && !/^[\s#]/.test(l) && l.trim() === rulePath);
    if (at === -1) return [...lines, '', rulePath, `  ${line}`, ''].join('\n');
    lines.splice(at + 1, 0, `  ${line}`);
    return lines.join('\n');
}

/**
 * Throws if any rule path appears in more than one block (see addToRule).
 *
 * @param {string} headers - _headers source.
 */
export function assertUniqueRules(headers) {
    const seen = new Set();
    for (const l of headers.split('\n')) {
        if (l.length === 0 || /^[\s#]/.test(l)) continue;
        const rule = l.trim();
        if (seen.has(rule)) throw new Error(`_headers has two blocks for ${rule}; Pages would keep only one`);
        seen.add(rule);
    }
}

/**
 * Sets the page's full Link header on every path (the SPA serves index.html
 * under every route) and detaches it from the asset paths (NO_LINK_PATHS)
 * so only pages carry it. A page without preloads leaves the file as is,
 * and Pages' generated header in place.
 *
 * @param {string} headers - _headers source.
 * @param {string} html - Versioned index.html.
 * @returns {string}
 */
export function setLinkHeader(headers, html) {
    const entries = linkEntries(html);
    if (!entries.length) return headers;
    let out = addToRule(headers, '/*', `Link: ${entries.join(', ')}`);
    for (const p of NO_LINK_PATHS) out = addToRule(out, p, '! Link');
    return out;
}

/**
 * Replaces js/ in outDir with a minified, code-split ES module bundle of
 * js/boot.js: modules that boot.js loads with import() (the lazy routes)
 * and code shared between them become chunks under js/chunks/, named by
 * content hash, so they need no ?v. Names are kept (--keep-names) and each
 * file gets a linked source map. The entry's map reference gets the ?v
 * token, as the entry's own name carries no hash.
 *
 * esbuild comes from frontend/package.json (the deploy installs it there).
 *
 * @param {string} srcDir - The frontend directory (resolves esbuild).
 * @param {string} outDir - Build directory whose js/ is replaced.
 * @param {string} token - Version token.
 * @returns {string[]} The chunk URLs boot.js imports statically, for preloading.
 */
export function bundleJs(srcDir, outDir, token) {
    const esbuild = createRequire(path.join(srcDir, 'package.json'))('esbuild');
    const jsDir = path.join(outDir, 'js');
    const tmp = path.join(outDir, '.js-bundle');
    const result = esbuild.buildSync({
        entryPoints: [path.join(jsDir, 'boot.js')],
        outdir: tmp,
        bundle: true,
        splitting: true,
        format: 'esm',
        minify: true,
        keepNames: true,
        sourcemap: 'linked',
        charset: 'utf8',
        entryNames: '[name]',
        chunkNames: 'chunks/[name]-[hash]',
        metafile: true,
        logLevel: 'error',
    });
    fs.rmSync(jsDir, { recursive: true, force: true });
    fs.renameSync(tmp, jsDir);

    const entry = path.join(jsDir, 'boot.js');
    const src = fs.readFileSync(entry, 'utf8');
    const mapRef = '//# sourceMappingURL=boot.js.map';
    if (!src.includes(mapRef)) throw new Error('bundled boot.js has no source map reference');
    fs.writeFileSync(entry, src.replace(mapRef, `${mapRef}${query(token)}`));

    const out = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint);
    if (!out) throw new Error('esbuild produced no entry output');
    return out[1].imports
        .filter((i) => i.kind === 'import-statement')
        .map((i) => '/js/' + path.relative(tmp, path.resolve(i.path)).split(path.sep).join('/'));
}

/**
 * Replaces the page's /js modulepreload tags with tags for the given URLs,
 * where the first of them stood (or before </head>).
 *
 * @param {string} html - Page source.
 * @param {string[]} urls - Module URLs to preload, in order.
 * @returns {string}
 */
export function setModulePreloads(html, urls) {
    const first = html.search(MODULEPRELOAD_LINE);
    const stripped = html.replace(MODULEPRELOAD_LINE, '');
    const at = first === -1 ? stripped.indexOf('</head>') : first;
    const tags = urls.map((u) => `    <link rel="modulepreload" href="${u}">\n`).join('');
    return stripped.slice(0, at) + tags + stripped.slice(at);
}

/**
 * Lists the files under a directory, recursively, as paths relative to root.
 *
 * @param {string} root
 * @param {string} sub
 * @returns {string[]}
 */
function filesUnder(root, sub) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
        .sort();
}

/**
 * Short content hash of every file in HASHED_DIRS (paths and bytes).
 *
 * @param {string} srcDir - The frontend directory.
 * @returns {string} 10 hex characters.
 */
export function assetHash(srcDir) {
    const h = crypto.createHash('sha256');
    for (const sub of HASHED_DIRS) {
        for (const rel of filesUnder(srcDir, sub)) {
            h.update(rel + '\0');
            h.update(fs.readFileSync(path.join(srcDir, rel)));
        }
    }
    return h.digest('hex').slice(0, 10);
}

/**
 * Rewrites a file in place with fn, if it exists.
 *
 * @param {string} file
 * @param {(src: string) => string} fn
 */
function rewrite(file, fn) {
    if (!fs.existsSync(file)) return;
    const src = fs.readFileSync(file, 'utf8');
    const out = fn(src);
    if (out !== src) fs.writeFileSync(file, out);
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

    // Before bundling: minification changes these lines beyond recognition.
    rewrite(path.join(outDir, 'js', 'i18n.js'), (src) => versionLocaleUrl(src, token));
    for (const rel of filesUnder(outDir, 'js').filter((f) => f.endsWith('.js'))) {
        rewrite(path.join(outDir, rel), (src) => versionJsThirdParty(src, token));
    }
    const chunkPreloads = bundleJs(srcDir, outDir, token);

    const pages = ['index.html', ...filesUnder(outDir, 'api').filter((f) => f.endsWith('.html'))];
    for (const rel of pages) rewrite(path.join(outDir, rel), (src) => versionHtml(src, token));
    rewrite(path.join(outDir, 'index.html'), (src) => setModulePreloads(src, [`/js/boot.js${query(token)}`, ...chunkPreloads]));

    rewrite(path.join(outDir, 'third_party', 'inter', 'inter.css'), (src) => versionCssUrls(src, token));

    // _headers is generated (deploy.sh --generate-configs copies the
    // example); start from the example when it hasn't been, so the build
    // comes out the same either way.
    const headersFile = path.join(outDir, '_headers');
    const exampleFile = path.join(outDir, '_headers.example');
    let headers = '';
    if (fs.existsSync(headersFile)) headers = fs.readFileSync(headersFile, 'utf8');
    else if (fs.existsSync(exampleFile)) headers = fs.readFileSync(exampleFile, 'utf8');
    const index = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const built = setLinkHeader(setImmutableRules(headers), index);
    assertUniqueRules(built);
    fs.writeFileSync(headersFile, built);
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
