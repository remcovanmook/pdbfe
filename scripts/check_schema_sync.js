/**
 * @fileoverview CI check: verify entities.js field definitions match
 * the D1 schema columns in database/schema.sql.
 *
 * For each entity, extracts the table name and field names from the
 * ENTITIES registry, then parses the corresponding CREATE TABLE in
 * schema.sql and compares column lists.
 *
 * Reports fields defined in entities.js but missing from schema.sql
 * and vice versa. Exits 1 on any mismatch.
 *
 * Usage:
 *   node scripts/check_schema_sync.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENTITIES } from '../workers/api/entities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(__dirname, '../database/schema.sql');

if (!fs.existsSync(SCHEMA_FILE)) {
    console.error(`Schema file not found: ${SCHEMA_FILE}`);
    process.exit(1);
}

const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf-8');

/**
 * Parses column names from a CREATE TABLE statement in the SQL schema.
 * Matches lines like:  "column_name" TYPE ...
 *
 * @param {string} tableName - D1 table name.
 * @returns {Set<string>} Column names found in the schema.
 */
function parseSchemaColumns(tableName) {
    // Match CREATE TABLE "tableName" ( ... );
    const tableRegex = new RegExp(
        `CREATE TABLE IF NOT EXISTS "${tableName}"\\s*\\(([^;]+)\\);`,
        's'
    );
    const match = schemaSql.match(tableRegex);
    if (!match) return new Set();

    const body = match[1];
    const columns = new Set();
    // Match "column_name" at the start of each column definition line
    for (const line of body.split('\n')) {
        const colMatch = line.match(/^\s*"(\w+)"/);
        if (colMatch) columns.add(colMatch[1]);
    }
    return columns;
}

let hasErrors = false;
let checkedCount = 0;

for (const [tag, entity] of Object.entries(ENTITIES)) {
    const table = entity.table;
    const schemaColumns = parseSchemaColumns(table);

    if (schemaColumns.size === 0) {
        console.error(`  ✖ ${tag}: table "${table}" not found in schema.sql`);
        hasErrors = true;
        continue;
    }

    // Entity field names (entities.js is the API source of truth)
    const entityFields = new Set(entity.fields.map(f => f.name));

    const missingFromSchema = [...entityFields].filter(f => !schemaColumns.has(f));
    const missingFromEntity = [...schemaColumns].filter(c => !entityFields.has(c));

    if (missingFromSchema.length > 0) {
        console.error(`\n  ${tag} (${table}):`);
        console.error(`    In entities.js but NOT in schema.sql:`);
        missingFromSchema.forEach(f => console.error(`      - ${f}`));
        hasErrors = true;
    }

    if (missingFromEntity.length > 0) {
        // This is a warning, not an error — the sync worker auto-adds
        // columns, so schema.sql may legitimately have columns not yet
        // exposed via the API. Log but don't fail.
        console.warn(`\n  ${tag} (${table}):`);
        console.warn(`    In schema.sql but NOT in entities.js (not API-exposed):`);
        missingFromEntity.forEach(c => console.warn(`      ~ ${c}`));
    }

    checkedCount++;
}

if (hasErrors) {
    console.error('\nSchema sync check failed. Fix entities.js or schema.sql.');
    process.exit(1);
} else {
    console.log(`Schema sync check passed. ${checkedCount} entities verified.`);
}
