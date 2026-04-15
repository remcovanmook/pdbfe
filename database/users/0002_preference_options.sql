-- Migration: preference_options table
-- Replaces hardcoded enum validation in the auth worker.
-- Adding a new preference or value is now an INSERT, not a code change.

CREATE TABLE IF NOT EXISTS preference_options (
    pref_key    TEXT NOT NULL,   -- e.g. 'language', 'theme'
    pref_value  TEXT NOT NULL,   -- e.g. 'en', 'dark'
    PRIMARY KEY (pref_key, pref_value)
);

-- Seed: language options (matches frontend LANGUAGES map + English)
INSERT OR IGNORE INTO preference_options (pref_key, pref_value) VALUES
    ('language', 'en'),
    ('language', 'cs'),
    ('language', 'de'),
    ('language', 'el'),
    ('language', 'es'),
    ('language', 'fr'),
    ('language', 'it'),
    ('language', 'ja'),
    ('language', 'lt'),
    ('language', 'pt'),
    ('language', 'ro'),
    ('language', 'ru'),
    ('language', 'zh-cn'),
    ('language', 'zh-tw');

-- Seed: theme options
INSERT OR IGNORE INTO preference_options (pref_key, pref_value) VALUES
    ('theme', 'auto'),
    ('theme', 'dark'),
    ('theme', 'light');
