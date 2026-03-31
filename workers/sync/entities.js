/**
 * @fileoverview Entity registry re-export for the sync worker.
 * The canonical entity definitions live in api/entities.js. This module
 * re-exports them so the sync worker can resolve the right table names
 * and columns without duplicating the registry.
 */

export { ENTITIES, ENTITY_TAGS } from '../api/entities.js';
