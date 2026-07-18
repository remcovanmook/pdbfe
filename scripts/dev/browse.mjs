#!/usr/bin/env node
/**
 * @fileoverview Headless-browser harness for verifying frontend changes
 * against REAL data, without the manual ritual.
 *
 * What it automates (previously ~6 manual steps per verification):
 *   1. Backs up frontend/js/config.js and points API_ORIGIN/AUTH_ORIGIN at
 *      the live production workers (public API; CORS is `*`).
 *   2. Starts `wrangler pages dev` on a free port and waits for readiness.
 *   3. Launches headless Chromium with clipboard permissions granted.
 *   4. Runs your check, collecting console errors along the way.
 *   5. ALWAYS restores config.js and kills the server — even on crash.
 *
 * Usage:
 *   node scripts/dev/browse.mjs --url /net/4224
 *       Open the page, wait for network idle, print console errors and
 *       basic page facts (title, h1). Add --shot out.png for a screenshot,
 *       --wait '.detail-header__actions' to wait for a selector first.
 *
 *   node scripts/dev/browse.mjs --script my-check.mjs [--url /net/4224]
 *       Run a custom check. The script must `export default async (ctx)`,
 *       where ctx = { page, browser, context, baseURL, errors }.
 *       `page` is already on --url (or about:blank). Whatever the function
 *       returns is JSON-printed. Console errors collect into ctx.errors.
 *
 * Notes:
 *   - AUTH endpoints only allow the production origin, so auth-worker CORS
 *     errors in the console are expected noise on localhost; they are
 *     filtered from ctx.errors (kept under `authNoise`).
 *   - config.js is gitignored and machine-local; this harness never leaves
 *     it modified (SIGINT/SIGTERM/exit are all trapped).
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FRONTEND = join(ROOT, 'frontend');
const CONFIG = join(FRONTEND, 'js', 'config.js');
const CONFIG_BAK = CONFIG + '.browse-bak';
const PORT = Number(process.env.BROWSE_PORT || 8799);
const BASE = `http://localhost:${PORT}`;
const PROD_DOMAIN = process.env.BROWSE_DOMAIN || 'pdbfe.dev';

// Resolve @playwright/test from frontend/node_modules (not installed at root).
const frontendRequire = createRequire(join(FRONTEND, 'package.json'));
const { chromium } = frontendRequire('@playwright/test');

// ── arg parsing ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
/** @type {Record<string, string>} */
const opt = {};
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
}
if (!opt.url && !opt.script) {
    console.error('Usage: browse.mjs --url /path [--wait <selector>] [--shot out.png] | --script check.mjs [--url /path]');
    process.exit(2);
}

// ── config swap with guaranteed restore ─────────────────────────────
let swapped = false;
function restoreConfig() {
    if (swapped && existsSync(CONFIG_BAK)) {
        copyFileSync(CONFIG_BAK, CONFIG);
        unlinkSync(CONFIG_BAK);
        swapped = false;
    }
}
/** @type {import('node:child_process').ChildProcess | null} */
let server = null;
function cleanup() {
    restoreConfig();
    if (server && !server.killed) {
        try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
    }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

copyFileSync(CONFIG, CONFIG_BAK);
swapped = true;
writeFileSync(CONFIG, readFileSync(CONFIG, 'utf8').replaceAll('<your-domain>', PROD_DOMAIN));

// ── start wrangler pages dev ────────────────────────────────────────
// Resolve npx from fixed, root-owned directories and pin the child's PATH to
// the same list — never search a writable PATH for the binary we execute.
const FIXED_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
function resolveBin(name) {
    for (const dir of FIXED_PATH.split(':')) {
        const p = join(dir, name);
        if (existsSync(p)) return p;
    }
    throw new Error(`${name} not found in fixed paths (${FIXED_PATH})`);
}
server = spawn(resolveBin('npx'), ['wrangler', 'pages', 'dev', '.', '--port', String(PORT), '--log-level', 'error'], {
    cwd: FRONTEND,
    env: { ...process.env, PATH: FIXED_PATH },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
});

async function waitForServer() {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(2000) });
            if (res.ok) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`server did not come up on :${PORT} within 60s`);
}
await waitForServer();

// ── drive the browser ───────────────────────────────────────────────
const browser = await chromium.launch();
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const authNoise = [];
page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Auth worker only allows the production origin — expected on localhost.
    if (text.includes(`auth.${PROD_DOMAIN}`) || text.includes('ERR_FAILED')) authNoise.push(text);
    else errors.push(text);
});

let out;
try {
    if (opt.url) {
        await page.goto(BASE + opt.url, { waitUntil: 'networkidle', timeout: 30000 });
    }
    if (opt.wait) {
        await page.waitForSelector(opt.wait, { timeout: 20000 });
    }
    if (opt.script) {
        const mod = await import(pathToFileURL(resolve(opt.script)).href);
        out = await mod.default({ page, browser, context, baseURL: BASE, errors });
    } else {
        out = {
            url: page.url(),
            title: await page.title(),
            h1: await page.locator('h1').first().innerText().catch(() => null),
        };
        if (opt.shot) {
            await page.screenshot({ path: opt.shot, fullPage: opt.full === 'true' });
            out.screenshot = opt.shot;
        }
    }
} finally {
    await browser.close().catch(() => {});
}

console.log(JSON.stringify({ result: out, consoleErrors: errors, authNoise: authNoise.length }, null, 2));
process.exit(errors.length > 0 && opt['fail-on-errors'] === 'true' ? 1 : 0);
