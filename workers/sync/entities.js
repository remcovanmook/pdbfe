/**
 * @fileoverview Entity registry for the sync worker.
 *
 * Consumes extracted/entities.json directly instead of re-exporting
 * from the API worker. The sync worker only needs { table, fields }
 * per entity — it doesn't use the Entity class, relationships,
 * joinColumns, or query builder logic from api/entities.js.
 *
 * This keeps the sync worker fully decoupled from the API worker.
 */

import entitySchema from '../../extracted/entities.json' with { type: 'json' };

/**
 * Lightweight entity registry for the sync worker.
 * Maps entity tag → { table, fields } for use by syncEntity().
 *
 * @type {Record<string, { table: string, fields: Array<{ name: string, type: string, nullable?: boolean }> }>}
 */
export const ENTITIES = Object.fromEntries(
    Object.entries(entitySchema.entities).map(([tag, entity]) => [
        tag,
        {
            table: entity.table,
            fields: entity.fields,
        },
    ])
);
