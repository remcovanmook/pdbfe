/**
 * @fileoverview CI check: verify locale translation coverage.
 *
 * strings.json has a `strings` array containing the canonical key list.
 * Each locale file maps those keys to translations. This script measures
 * coverage (percentage of source keys present in each locale) and
 * enforces two thresholds:
 *
 *   - Below 40%: hard failure (locale is too incomplete to ship)
 *   - Below 60%: warning printed to CI output (PR should mention this)
 *   - 60%+: pass
 *
 * Extra keys (stale translations removed from strings.json) are logged
 * as info but never fail.
 *
 * Usage:
 *   node scripts/check_locales.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, '../frontend/locales');
const SOURCE_FILE = path.join(LOCALES_DIR, 'strings.json');

/** Coverage below this percentage is a hard failure. */
const FAIL_THRESHOLD = 40;

/** Coverage below this percentage triggers a warning. */
const WARN_THRESHOLD = 60;

if (!fs.existsSync(SOURCE_FILE)) {
    console.error(`Source catalog not found: ${SOURCE_FILE}`);
    process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf-8'));
const sourceKeys = new Set(catalog.strings);
const totalKeys = sourceKeys.size;

let hasErrors = false;
let hasWarnings = false;
let localeCount = 0;

for (const file of fs.readdirSync(LOCALES_DIR).sort()) {
    if (!file.endsWith('.json') || file === 'strings.json') continue;

    const filePath = path.join(LOCALES_DIR, file);
    const localeKeys = new Set(Object.keys(JSON.parse(fs.readFileSync(filePath, 'utf-8'))));

    const present = [...sourceKeys].filter(k => localeKeys.has(k)).length;
    const coverage = Math.round((present / totalKeys) * 100);
    const extra = [...localeKeys].filter(k => !sourceKeys.has(k)).length;

    if (coverage < FAIL_THRESHOLD) {
        console.error(`  ✖ ${file}: ${coverage}% coverage (${present}/${totalKeys}) — below ${FAIL_THRESHOLD}% minimum`);
        hasErrors = true;
    } else if (coverage < WARN_THRESHOLD) {
        console.warn(`  ⚠ ${file}: ${coverage}% coverage (${present}/${totalKeys}) — below ${WARN_THRESHOLD}%, mention in PR`);
        hasWarnings = true;
    } else {
        console.log(`  ✔ ${file}: ${coverage}% (${present}/${totalKeys})`);
    }

    if (extra > 0) {
        console.log(`    ${extra} stale key(s) not in strings.json`);
    }

    localeCount++;
}

console.log(`\n${totalKeys} source keys × ${localeCount} locales`);

if (hasErrors) {
    console.error(`\nLocale check failed. One or more locales below ${FAIL_THRESHOLD}% coverage.`);
    process.exit(1);
}

if (hasWarnings) {
    console.warn(`\nLocale check passed with warnings. Some locales below ${WARN_THRESHOLD}% — PR description should note incomplete translations.`);
}
