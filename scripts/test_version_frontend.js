/**
 * @fileoverview Tests for scripts/version_frontend.js.
 *
 * Usage:
 *   node --test scripts/test_version_frontend.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    versionModuleSpecifiers, versionHtml, versionCssUrls, versionLocaleUrl, setImmutableRules,
    buildVersionedFrontend, assetHash, IMMUTABLE_RULES, IMMUTABLE_CACHE_CONTROL, LOCALE_URL,
    linkEntries, addToRule, assertUniqueRules, setLinkHeader, NO_LINK_PATHS,
} from './version_frontend.js';

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend');

describe('versionModuleSpecifiers', () => {
    it('versions relative import, re-export and side-effect specifiers', () => {
        const src = [
            "import { a } from './a.js';",
            'import {\n    b,\n    c,\n} from "../b.js";',
            "export { d } from './d.js';",
            "import './components/e.js';",
        ].join('\n');
        const out = versionModuleSpecifiers(src, '1.2.3');
        assert.match(out, /from '\.\/a\.js\?v=1\.2\.3'/);
        assert.match(out, /from "\.\.\/b\.js\?v=1\.2\.3"/);
        assert.match(out, /from '\.\/d\.js\?v=1\.2\.3'/);
        assert.match(out, /import '\.\/components\/e\.js\?v=1\.2\.3'/);
    });

    it('leaves JSDoc type imports and non-relative specifiers alone', () => {
        const src = "/** @param {import('./api.js').T} x */\nimport x from 'https://cdn.example/x.js';";
        assert.equal(versionModuleSpecifiers(src, '1'), src);
    });
});

describe('versionHtml', () => {
    it('versions /js and /css URLs and replaces an existing ?v=', () => {
        const html = '<link rel="modulepreload" href="/js/boot.js">\n<script type="module" src="/js/boot.js"></script>\n<link rel="stylesheet" href="/css/index.css?v=7">';
        const out = versionHtml(html, '9');
        assert.equal(out, '<link rel="modulepreload" href="/js/boot.js?v=9">\n<script type="module" src="/js/boot.js?v=9"></script>\n<link rel="stylesheet" href="/css/index.css?v=9">');
    });

    it('versions listed /third_party URLs, including preloads', () => {
        const html = '<link rel="preload" href="/third_party/inter/inter-latin.woff2" as="font"><script defer src="/third_party/leaflet/leaflet.js"></script>';
        assert.equal(versionHtml(html, '9'), '<link rel="preload" href="/third_party/inter/inter-latin.woff2?v=9" as="font"><script defer src="/third_party/leaflet/leaflet.js?v=9"></script>');
    });

    it('leaves unlisted /third_party URLs alone (Leaflet images)', () => {
        const html = '<img src="/third_party/leaflet/images/marker-icon.png">';
        assert.equal(versionHtml(html, '9'), html);
    });
});

describe('versionCssUrls', () => {
    it('versions listed font URLs, quoted or not', () => {
        const css = "src: url('/third_party/inter/inter-latin.woff2') format('woff2'); x: url(/third_party/inter/inter-latin-ext.woff2);";
        assert.equal(versionCssUrls(css, '9'), "src: url('/third_party/inter/inter-latin.woff2?v=9') format('woff2'); x: url(/third_party/inter/inter-latin-ext.woff2?v=9);");
    });

    it('leaves relative and unlisted url() alone (Leaflet icon-path detection)', () => {
        const css = '.leaflet-default-icon-path { background-image: url(images/marker-icon.png); }';
        assert.equal(versionCssUrls(css, '9'), css);
    });
});

describe('versionLocaleUrl', () => {
    it('versions the locale fetch URL', () => {
        const src = `const res = await fetch(${LOCALE_URL}, { cache: 'force-cache' });`;
        assert.equal(versionLocaleUrl(src, '9'), "const res = await fetch(`/locales/${lang}.json?v=9`, { cache: 'force-cache' });");
    });

    it('fails loudly when i18n.js no longer has the expected URL', () => {
        assert.throws(() => versionLocaleUrl("fetch('/l/' + lang)", '9'), /no longer contains/);
    });
});

describe('setImmutableRules', () => {
    it('replaces the Cache-Control of matching rules and keeps other headers', () => {
        const out = setImmutableRules('/js/*\n  Cache-Control: no-cache\n  X-Foo: bar\n');
        assert.match(out, new RegExp(`/js/\\*\\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}\\n  X-Foo: bar`));
        assert.doesNotMatch(out, /no-cache/);
    });

    it('appends a rule for every immutable path the file lacks', () => {
        const out = setImmutableRules('/*\n  X-Frame-Options: DENY\n');
        for (const r of IMMUTABLE_RULES) assert.ok(out.includes(`${r}\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`), r);
    });

    it('refuses an overlapping catch-all with its own Cache-Control', () => {
        assert.throws(() => setImmutableRules('/third_party/*\n  Cache-Control: public, max-age=604800\n'), /overlaps/);
    });

    it('leaves non-overlapping rules alone', () => {
        const out = setImmutableRules('/third_party/leaflet/images/*\n  Cache-Control: public, max-age=604800\n');
        assert.match(out, /images\/\*\n  Cache-Control: public, max-age=604800/);
    });
});

describe('linkEntries', () => {
    it('lists preload and modulepreload tags in page order, as Pages formats them', () => {
        const html = '<link rel="stylesheet" href="/a.css"><link rel="preload" href="/f.woff2" as="font" type="font/woff2" crossorigin><link rel="modulepreload" href="/js/b.js"><link rel="preload" href="/c.css" as="style">';
        assert.deepEqual(linkEntries(html), [
            '</f.woff2>; rel="preload"; as=font; type="font/woff2"; crossorigin',
            '</js/b.js>; rel="modulepreload"',
            '</c.css>; rel="preload"; as=style',
        ]);
    });
});

describe('addToRule / assertUniqueRules / setLinkHeader', () => {
    it('adds a line inside an existing rule instead of a second block', () => {
        const out = addToRule('/*\n  X-Frame-Options: DENY\n', '/*', 'Link: <x>');
        assert.equal(out, '/*\n  Link: <x>\n  X-Frame-Options: DENY\n');
        assert.doesNotThrow(() => assertUniqueRules(out));
    });

    it('appends a rule that does not exist yet', () => {
        assert.equal(addToRule('/*\n  X: y', '/js/*', '! Link'), '/*\n  X: y\n\n/js/*\n  ! Link\n');
    });

    it('refuses two blocks for the same path', () => {
        assert.throws(() => assertUniqueRules('/*\n  A: 1\n\n/*\n  B: 2\n'), /two blocks for \/\*/);
    });

    it('sets Link on /* and detaches it from every asset path, keeping existing headers', () => {
        const out = setLinkHeader('/*\n  X-Frame-Options: DENY\n\n/js/*\n  Cache-Control: c\n', '<link rel="modulepreload" href="/js/b.js">');
        assert.match(out, /\/\*\n  Link: <\/js\/b\.js>; rel="modulepreload"\n  X-Frame-Options: DENY/);
        assert.match(out, /\/js\/\*\n  ! Link\n  Cache-Control: c/);
        for (const p of NO_LINK_PATHS) assert.ok(out.includes(`${p}\n  ! Link`), p);
        assert.doesNotThrow(() => assertUniqueRules(out));
    });

    it('leaves the file alone for a page without preloads', () => {
        assert.equal(setLinkHeader('/*\n  X: y\n', '<p>no preloads</p>'), '/*\n  X: y\n');
    });
});

describe('buildVersionedFrontend (real frontend/)', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pdbfe-dist-'));
    const token = buildVersionedFrontend(FRONTEND_DIR, out, '0.0.0');

    it('uses <version>-<content hash> as the token', () => {
        assert.equal(token, `0.0.0-${assetHash(FRONTEND_DIR)}`);
    });

    it('leaves no relative import (from or side-effect) without the token', () => {
        const files = fs.readdirSync(path.join(out, 'js'), { withFileTypes: true, recursive: true })
            .filter((e) => e.isFile() && e.name.endsWith('.js'));
        for (const e of files) {
            const src = fs.readFileSync(path.join(e.parentPath, e.name), 'utf8');
            for (const m of src.matchAll(/(?:\bfrom[ \t]*|^[ \t]*import[ \t]*)['"](\.\.?\/[^'"]+)['"]/gm)) {
                assert.ok(m[1].endsWith(`?v=${token}`), `${e.name}: ${m[1]}`);
            }
        }
    });

    it('versions every /js, /css and listed /third_party URL in the HTML pages', () => {
        for (const page of ['index.html', 'api/graphql.html', 'api/rest.html']) {
            const html = fs.readFileSync(path.join(out, page), 'utf8');
            for (const m of html.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+|\/third_party\/(?:inter\/[^"]+|leaflet\/leaflet\.(?:css|js)[^"]*))"/g)) {
                assert.ok(m[1].endsWith(`?v=${token}`), `${page}: ${m[1]}`);
            }
        }
    });

    it('preloads the font under exactly the URL inter.css requests', () => {
        const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
        const css = fs.readFileSync(path.join(out, 'third_party/inter/inter.css'), 'utf8');
        const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+\.woff2[^"]*)"/g)].map((m) => m[1]);
        assert.ok(preloads.length > 0, 'a font preload exists');
        for (const url of preloads) assert.ok(css.includes(`url('${url}')`), url);
    });

    it('versions the locale URL in i18n.js', () => {
        assert.ok(fs.readFileSync(path.join(out, 'js/i18n.js'), 'utf8').includes(`/locales/\${lang}.json?v=${token}`));
    });

    it('puts the full Link header, font included, in the single /* rule with the security headers', () => {
        const built = fs.readFileSync(path.join(out, '_headers'), 'utf8');
        assert.doesNotThrow(() => assertUniqueRules(built));
        const rule = built.slice(built.indexOf('/*\n'));
        const link = rule.split('\n').find((l) => l.startsWith('  Link: ')) ?? '';
        const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
        assert.equal(link, `  Link: ${linkEntries(html).join(', ')}`);
        assert.match(link, /inter-latin\.woff2\?v=[^>]+>; rel="preload"; as=font/);
        assert.match(rule, /X-Frame-Options: DENY/);
    });

    it('makes the versioned paths immutable in the build only', () => {
        const built = fs.readFileSync(path.join(out, '_headers'), 'utf8');
        for (const r of IMMUTABLE_RULES) {
            const start = built.indexOf(`\n${r}\n`) + 1;
            const block = built.slice(start, built.indexOf('\n\n', start));
            assert.ok(block.includes(`  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`), r);
        }
        assert.ok(!fs.readFileSync(path.join(FRONTEND_DIR, '_headers.example'), 'utf8').includes(IMMUTABLE_CACHE_CONTROL));
    });

    it('does not copy node_modules', () => {
        assert.equal(fs.existsSync(path.join(out, 'node_modules')), false);
    });
});
