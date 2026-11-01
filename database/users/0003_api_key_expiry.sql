-- Migration: API key expiry
-- Nullable expires_at on api_keys (ISO 8601, NULL = never expires).
-- Existing keys keep NULL, so nothing stops working. Checked at point of
-- use by verifyApiKey on the existing hash lookup; no new index needed.
--
-- Apply BEFORE deploying the workers that read the column:
--   wrangler d1 execute pdbfe-users --file=database/users/0003_api_key_expiry.sql --remote

ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
