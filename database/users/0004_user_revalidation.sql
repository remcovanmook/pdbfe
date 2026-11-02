-- Migration: daily revalidation of users against PeeringDB
-- refresh_token: the user's PeeringDB OAuth refresh token, AES-GCM encrypted
--   with the auth worker's TOKEN_ENCRYPTION_KEY (NULL = none stored; the
--   user is not revalidated until they next log in).
-- validated_at: ISO 8601 time of the last successful revalidation.
--
-- Apply BEFORE deploying the auth worker that reads the columns:
--   wrangler d1 execute pdbfe-users --file=database/users/0004_user_revalidation.sql --remote

ALTER TABLE users ADD COLUMN refresh_token TEXT;
ALTER TABLE users ADD COLUMN validated_at TEXT;
