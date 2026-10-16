/**
 * @fileoverview Keeps the frontend's built-in PREFERENCE_OPTIONS in step
 * with the auth worker's preference_options table, which validates saved
 * preferences. A value the frontend offers but the table lacks would be
 * rejected on save; one the table has but the frontend lacks is never
 * offered.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PREFERENCE_OPTIONS } from '../../js/preference-options.js';

const USERS_DB = new URL('../../../database/users/', import.meta.url);

/**
 * Collects every (pref_key, pref_value) pair seeded into preference_options
 * by the users-database migrations.
 *
 * @returns {Record<string, Set<string>>}
 */
function seededOptions() {
    /** @type {Record<string, Set<string>>} */
    const seeded = {};
    for (const file of readdirSync(USERS_DB).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
        const sql = readFileSync(new URL(file, USERS_DB), 'utf8');
        for (const stmt of sql.matchAll(/INSERT OR IGNORE INTO preference_options[^;]*;/g)) {
            for (const [, key, value] of stmt[0].matchAll(/\('([^']+)',\s*'([^']+)'\)/g)) {
                (seeded[key] ??= new Set()).add(value);
            }
        }
    }
    return seeded;
}

describe('PREFERENCE_OPTIONS', () => {
    const seeded = seededOptions();

    it('covers the same keys as the preference_options seed', () => {
        assert.deepEqual(Object.keys(PREFERENCE_OPTIONS).sort(), Object.keys(seeded).sort());
    });

    for (const [key, values] of Object.entries(PREFERENCE_OPTIONS)) {
        it(`${key} matches the preference_options seed`, () => {
            assert.deepEqual([...values].sort(), [...seeded[key]].sort());
        });

        it(`${key} lists 'auto' first, without duplicates`, () => {
            assert.equal(values[0], 'auto');
            assert.equal(new Set(values).size, values.length);
        });
    }
});
