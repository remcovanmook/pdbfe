/**
 * @fileoverview Entity registry for the pdbfe-async worker.
 *
 * Re-exports entity metadata and derived tag sets from the precompiled
 * registry. The async worker uses these for D1 table lookups and to
 * determine which entity types support vector embedding and logo migration.
 *
 * Regenerate with: .venv/bin/python scripts/parse_django_models.py --force
 */

import { ENTITIES, ENTITY_TAGS } from '../../extracted/entities-worker.js';
export { ENTITIES, ENTITY_TAGS };

/**
 * Entity tags for which graph embedding vectors are maintained in Vectorize.
 * Derived from the precompiled entity registry: any entity whose field list
 * includes __logo_migrated is a user-navigable entity — exactly the six
 * searchable types (org, net, ix, fac, carrier, campus).
 *
 * @type {ReadonlySet<string>}
 */
export const VECTOR_ENTITY_TAGS = new Set(
    Object.entries(ENTITIES)
        .filter(([, e]) => e.fields.some((/** @type {any} */ f) => f.name === '__logo_migrated'))
        .map(([tag]) => tag)
);
