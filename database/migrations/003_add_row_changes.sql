-- Migration: add _row_changes (per-object change times for If-Modified-Since)
--
-- Written by the sync worker (workers/sync/row_changes.js), pruned after 25h.
-- The id 0 row per entity marks every object of that entity changed now:
-- the table holds no history from before this point, so a reader must not
-- answer 304 for an If-Modified-Since older than it. It ages out with the
-- retention window like any other row.

CREATE TABLE IF NOT EXISTS "_row_changes" (
    "entity" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "d0_at" INTEGER NOT NULL DEFAULT 0,
    "d1_at" INTEGER NOT NULL DEFAULT 0,
    "d2_at" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("entity", "id")
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS "_row_changes_d2_at_idx" ON "_row_changes" ("d2_at");

INSERT OR REPLACE INTO "_row_changes" ("entity", "id", "d0_at", "d1_at", "d2_at")
SELECT "entity", 0, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
FROM "_sync_meta";
