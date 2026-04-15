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
    ('language', 'auto'),
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

-- Seed: timezone options (auto + major IANA timezones)
INSERT OR IGNORE INTO preference_options (pref_key, pref_value) VALUES
    ('timezone', 'auto'),
    ('timezone', 'Pacific/Auckland'),
    ('timezone', 'Australia/Sydney'),
    ('timezone', 'Australia/Perth'),
    ('timezone', 'Asia/Tokyo'),
    ('timezone', 'Asia/Shanghai'),
    ('timezone', 'Asia/Kolkata'),
    ('timezone', 'Asia/Dubai'),
    ('timezone', 'Europe/Moscow'),
    ('timezone', 'Europe/Istanbul'),
    ('timezone', 'Europe/Helsinki'),
    ('timezone', 'Europe/Berlin'),
    ('timezone', 'Europe/Amsterdam'),
    ('timezone', 'Europe/Paris'),
    ('timezone', 'Europe/London'),
    ('timezone', 'Atlantic/Reykjavik'),
    ('timezone', 'America/Sao_Paulo'),
    ('timezone', 'America/New_York'),
    ('timezone', 'America/Chicago'),
    ('timezone', 'America/Denver'),
    ('timezone', 'America/Los_Angeles'),
    ('timezone', 'America/Anchorage'),
    ('timezone', 'Pacific/Honolulu'),
    ('timezone', 'UTC');
