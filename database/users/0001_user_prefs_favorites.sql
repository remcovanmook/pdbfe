-- Migration: Add user preferences and favorites.
-- Run: wrangler d1 execute pdbfe-users --file=database/users/0001_user_prefs_favorites.sql

-- Extensible JSON preferences column on the users table.
-- Default '{}' means "no overrides, use platform defaults."
-- Language is the first preference; others (theme, page size) can be
-- added without further schema migrations.
ALTER TABLE users ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}';

-- Favorites table: normalized rows for O(1) existence checks and
-- indexed lookups. Composite PK prevents duplicates at the DB level.
-- The cached `label` column avoids an extra API fetch when listing
-- favorites on the account page (the authoritative name is always
-- re-fetched from the mirror when rendering the homepage section).
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
