-- Migration: add __vector_embedded flag to searchable entity tables.
-- Tracks whether the entity's name has been embedded into the Vectorize index
-- for semantic search. 0 = not yet embedded (or stale), 1 = current.
--
-- INSERT OR REPLACE in the sync worker resets this to 0 (the DEFAULT) for
-- any row it touches, so syncVectors picks it up for re-embedding.

ALTER TABLE "peeringdb_organization" ADD COLUMN "__vector_embedded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network"      ADD COLUMN "__vector_embedded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_ix"           ADD COLUMN "__vector_embedded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_facility"     ADD COLUMN "__vector_embedded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_carrier"      ADD COLUMN "__vector_embedded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_campus"       ADD COLUMN "__vector_embedded" INTEGER NOT NULL DEFAULT 0;
