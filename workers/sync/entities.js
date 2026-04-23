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

import { ENTITIES, ENTITY_TAGS } from '../../extracted/entities-worker.js';
export { ENTITIES, ENTITY_TAGS };

/**
 * Entity tags for which the sync worker maintains Vectorize embeddings.
 *
 * Derived from the precompiled entity registry: any entity whose field list
 * includes __logo_migrated is a user-navigable entity with a name field and
 * a logo — exactly the six searchable types (org, net, ix, fac, carrier,
 * campus). Using this as the discriminator avoids hardcoding the tag list
 * and stays consistent with parse_django_models.py _LOCAL_FIELDS.
 *
 * @type {ReadonlySet<string>}
 */
export const VECTOR_ENTITY_TAGS = new Set(
    Object.entries(ENTITIES)
        .filter(([, e]) => e.fields.some((/** @type {any} */ f) => f.name === '__logo_migrated'))
        .map(([tag]) => tag)
);
