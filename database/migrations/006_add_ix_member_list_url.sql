-- Migration: add ixf_ixp_member_list_url to peeringdb_ix
--
-- PeeringDB 2.79.0 added this field to the ix entity response
-- (it was previously only on ixlan). The sync worker needs the
-- column to exist for INSERT OR REPLACE to succeed.
--
-- The column is nullable and API-injected (not from the Django model),
-- so it defaults to NULL.

ALTER TABLE "peeringdb_ix" ADD COLUMN "ixf_ixp_member_list_url" TEXT;
