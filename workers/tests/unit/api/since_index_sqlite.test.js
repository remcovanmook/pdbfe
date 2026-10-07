/**
 * @fileoverview The ?since= filter must be served by the "<table>_updated_idx"
 * indexes (schema.sql / migration 010), not a full table scan. Runs the
 * builder's real SQL through EXPLAIN QUERY PLAN on the generated schema.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1 } from '../../lib/sqlite_d1.js';
import { ENTITIES } from '../../../api/entities.js';
import { buildJsonQuery, buildRowQuery } from '../../../api/query.js';

const { sqlite } = createSqliteD1();
const opts = { depth: 0, limit: -1, skip: 0, since: 1791370000, sort: '', fields: [], pdbfe: false };

describe('?since= uses the updated index', () => {
    for (const tag of Object.keys(ENTITIES)) {
        it(`${tag}`, () => {
            for (const build of [buildJsonQuery, buildRowQuery]) {
                const { sql, params } = build(ENTITIES[tag], [], opts);
                const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => String(r.detail)).join(' | ');
                assert.match(plan, new RegExp(`USING INDEX ${ENTITIES[tag].table}_updated_idx`), `${build.name}: ${plan}`);
            }
        });
    }
});
