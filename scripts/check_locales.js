/**
 * @fileoverview CI check: verify all locale files cover the same keys
 * as the source catalog (strings.json).
 *
 * strings.json has a `strings` array containing the canonical key list.
 * Each locale file (de.json, fr.json, etc.) maps those keys to translations.
 * This script verifies every locale has the full set and no stale extras.
 *
 * Exits with code 1 if any locale is missing keys. Extra keys (stale
 * translations not yet cleaned up) are logged as warnings but don't fail.
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

if (!fs.existsSync(SOURCE_FILE)) {
    console.error(`Source catalog not found: ${SOURCE_FILE}`);
    process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf-8'));
const sourceKeys = new Set(catalog.strings);
let hasErrors = false;
let localeCount = 0;

for (const file of fs.readdirSync(LOCALES_DIR).sort()) {
    if (!file.endsWith('.json') || file === 'strings.json') continue;

    const filePath = path.join(LOCALES_DIR, file);
    const localeKeys = new Set(Object.keys(JSON.parse(fs.readFileSync(filePath, 'utf-8'))));

    const missing = [...sourceKeys].filter(k => !localeKeys.has(k));
    const extra = [...localeKeys].filter(k => !sourceKeys.has(k));

    if (missing.length > 0) {
        console.error(`\n  ✖ ${file}: ${missing.length} missing key(s)`);
        missing.slice(0, 5).forEach(k => console.error(`    - ${k}`));
        if (missing.length > 5) console.error(`    ... and ${missing.length - 5} more`);
        hasErrors = true;
    }

    if (extra.length > 0) {
        // Stale translations — warn but don't fail
        console.warn(`  ⚠ ${file}: ${extra.length} extra key(s) not in strings.json`);
    }

    localeCount++;
}

if (hasErrors) {
    console.error('\nLocale completeness check failed.');
    process.exit(1);
} else {
    console.log(`Locale check passed. ${sourceKeys.size} keys × ${localeCount} locales.`);
}
