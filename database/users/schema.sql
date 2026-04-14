-- Schema for the pdbfe-users D1 database.
-- Stores user profiles and API keys for the pdbfe auth system.
-- Separate from the PeeringDB mirror database (peeringdb) so user data
-- is never affected by mirror rebuilds.
--
-- Bootstrap: wrangler d1 execute pdbfe-users --file=database/users/schema.sql

-- Users table: one row per PeeringDB user who has logged into pdbfe.
-- Auto-provisioned on first OAuth login via the auth worker.
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,  -- PeeringDB user ID (not auto-increment)
    name       TEXT    NOT NULL,
    email      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL,      -- ISO 8601
    updated_at TEXT    NOT NULL       -- ISO 8601
);

-- API keys table: normalized rows replace the JSON array that was
-- previously embedded in the KV user record. Each key is a separate row
-- with ACID guarantees on INSERT/DELETE, eliminating the Ghost Key race
-- condition that existed with KV's eventual consistency.
--
-- The full API key is never stored. Only its SHA-256 hash is persisted
-- for verification. The 4-char prefix is kept for display in the UI.
CREATE TABLE IF NOT EXISTS api_keys (
    key_id     TEXT    NOT NULL,      -- first 8 hex chars of the full key
    user_id    INTEGER NOT NULL REFERENCES users(id),
    label      TEXT    NOT NULL DEFAULT 'Unnamed key',
    prefix     TEXT    NOT NULL,      -- first 4 hex chars, for UI display
    hash       TEXT    NOT NULL UNIQUE, -- SHA-256 hex of the full key
    created_at TEXT    NOT NULL,      -- ISO 8601
    PRIMARY KEY (user_id, key_id)
);

-- Index for API key verification on the hot path.
-- The API worker hashes the incoming key and looks up this index.
-- Replaces the KV `apikey:<sha256(key)>` reverse index.
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);
