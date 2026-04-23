/**
 * @fileoverview Entity registry for the PeeringDB sync worker.
 *
 * Re-exports entity metadata from the precompiled registry. The sync
 * worker only needs the entity tags, table names, and field definitions
 * for data import — it does not use relationships, field caching, or
 * query validation logic.
 *
 * Regenerate with: .venv/bin/python scripts/parse_django_models.py --force
 */

export { ENTITIES, ENTITY_TAGS } from '../../extracted/entities-worker.js';

/**
 * Entity tags for which the sync worker maintains Vectorize embeddings.
 * These are the six user-navigable entity types with a `name` field.
 * Matches the searchable set in workers/search/handlers/query.js.
 *
 * @type {ReadonlySet<string>}
 */
export const VECTOR_ENTITY_TAGS = new Set(['net', 'ix', 'fac', 'org', 'carrier', 'campus']);
