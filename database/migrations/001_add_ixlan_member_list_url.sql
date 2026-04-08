-- Migration: add ixf_ixp_member_list_url to peeringdb_ixlan
--
-- The upstream PeeringDB API conditionally includes this field on ixlan
-- responses. Without it in our schema, INSERT OR REPLACE fails and the
-- sync worker silently stops updating this entity.
--
-- Run against the live D1 database:
--   npx wrangler d1 execute peeringdb --command "ALTER TABLE \"peeringdb_ixlan\" ADD COLUMN \"ixf_ixp_member_list_url\" TEXT;"

ALTER TABLE "peeringdb_ixlan" ADD COLUMN "ixf_ixp_member_list_url" TEXT;
