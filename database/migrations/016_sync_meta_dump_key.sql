-- Migration: _sync_meta.dump_key — R2 key of the table's current full-table dump
--
-- The async worker sets it after uploading dumps/<tag>/<last_modified_at>.json
-- to the pdbfe-dumps bucket; the API serves that object for a default
-- full-table list while the key matches the table's last_modified_at
-- (workers/api/dumps.js). Empty until the first dump.

ALTER TABLE "_sync_meta" ADD COLUMN "dump_key" TEXT NOT NULL DEFAULT '';
