-- Schema for the pdbfe-users D1 database.
-- Stores user profiles, preferences, favorites, and API keys for the
-- pdbfe auth system. Separate from the PeeringDB mirror database (peeringdb)
-- so user data is never affected by mirror rebuilds.
--
-- Bootstrap: wrangler d1 execute pdbfe-users --file=database/users/schema.sql

-- Users table: one row per PeeringDB user who has logged into pdbfe.
-- Auto-provisioned on first OAuth login via the auth worker.
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,  -- PeeringDB user ID (not auto-increment)
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL DEFAULT '',
    preferences TEXT    NOT NULL DEFAULT '{}',  -- JSON: { language?, ... }
    created_at  TEXT    NOT NULL,      -- ISO 8601
    updated_at  TEXT    NOT NULL       -- ISO 8601
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

-- Favorites table: normalized rows for O(1) existence checks and
-- indexed lookups. Composite PK prevents duplicates at the DB level.
-- The cached `label` column avoids an extra API fetch when listing
-- favorites on the account page.
CREATE TABLE IF NOT EXISTS user_favorites (
    user_id     INTEGER NOT NULL REFERENCES users(id),
    entity_type TEXT    NOT NULL,  -- 'net', 'ix', 'fac', 'org', 'carrier', 'campus'
    entity_id   INTEGER NOT NULL,
    label       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,  -- ISO 8601
    PRIMARY KEY (user_id, entity_type, entity_id)
);

-- Index for listing a user's favorites sorted by creation date.
CREATE INDEX IF NOT EXISTS idx_user_favorites_list
    ON user_favorites(user_id, created_at DESC);

-- Preference options: lookup table for validating user preference values.
-- Adding a new preference or allowed value is an INSERT, not a code change.
CREATE TABLE IF NOT EXISTS preference_options (
    pref_key    TEXT NOT NULL,   -- e.g. 'language', 'theme'
    pref_value  TEXT NOT NULL,   -- e.g. 'en', 'dark'
    PRIMARY KEY (pref_key, pref_value)
);
