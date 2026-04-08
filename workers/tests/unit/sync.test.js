/**
 * @fileoverview Unit tests for the sync worker's auto-schema-evolution.
 * Validates that ensureColumns detects missing D1 columns and runs
 * ALTER TABLE to add them, and that it's a no-op when all columns exist.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureColumns } from '../../sync/index.js';

/**
 * Creates a mock D1 database that tracks PRAGMA and ALTER queries.
 * PRAGMA table_info returns the provided column list; ALTER TABLE
 * calls are recorded for assertion.
 *
 * @param {string[]} existingColumns - Column names already in the table.
 * @returns {{db: D1Database, alters: string[]}} Mock DB and ALTER log.
 */
function mockD1(existingColumns) {
    /** @type {string[]} */
    const alters = [];

    const db = {
        prepare: (/** @type {string} */ sql) => ({
            all: async () => ({
                results: existingColumns.map(name => ({ name }))
            }),
            run: async () => {
                alters.push(sql);
            },
            bind: () => ({ all: async () => ({ results: [] }), run: async () => {} })
        })
    };

    return { db: /** @type {any} */ (db), alters };
}

describe('ensureColumns', () => {
    it('should be a no-op when all columns exist', async () => {
        const { db, alters } = mockD1(['id', 'name', 'status']);
        await ensureColumns(db, 'test_table', ['id', 'name', 'status']);
        assert.equal(alters.length, 0, 'no ALTER TABLE should run');
    });

    it('should ALTER TABLE for each missing column', async () => {
        const { db, alters } = mockD1(['id', 'name']);
        await ensureColumns(db, 'test_table', ['id', 'name', 'new_field', 'another_field']);

        assert.equal(alters.length, 2, 'should add 2 columns');
        assert.ok(alters[0].includes('"new_field"'), 'first ALTER should add new_field');
        assert.ok(alters[1].includes('"another_field"'), 'second ALTER should add another_field');
    });

    it('should add columns as nullable TEXT', async () => {
        const { db, alters } = mockD1(['id']);
        await ensureColumns(db, 'peeringdb_ixlan', ['id', 'ixf_ixp_member_list_url']);

        assert.equal(alters.length, 1);
        assert.match(alters[0], /ALTER TABLE "peeringdb_ixlan" ADD COLUMN "ixf_ixp_member_list_url" TEXT/);
    });

    it('should not duplicate existing columns', async () => {
        const { db, alters } = mockD1(['id', 'name', 'ixf_ixp_member_list_url']);
        await ensureColumns(db, 'test_table', ['id', 'name', 'ixf_ixp_member_list_url']);
        assert.equal(alters.length, 0, 'all columns already exist');
    });
});
