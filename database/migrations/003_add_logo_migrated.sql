-- Migration: add __logo_migrated flag to all entity tables with a logo field.
-- Tracks whether the entity's logo has been copied to the pdbfe R2 bucket.
-- 0 = not yet migrated (still on upstream S3), 1 = available in R2.

ALTER TABLE "peeringdb_organization" ADD COLUMN "__logo_migrated" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_network" ADD COLUMN "__logo_migrated" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_ix" ADD COLUMN "__logo_migrated" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_facility" ADD COLUMN "__logo_migrated" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_carrier" ADD COLUMN "__logo_migrated" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "peeringdb_campus" ADD COLUMN "__logo_migrated" INTEGER NOT NULL DEFAULT 0;
