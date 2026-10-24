-- Migration: _row_changes records changed rows only
--
-- 014 recorded, per detail response, when it changed at each depth: the sync
-- worker propagated every change to all responses showing it (~20k rows a
-- day). Now the table holds only the rows the sync changed (row_at), plus
-- set_at on the direct parent when a child joined or left its set; the API's
-- depth expansion checks a response's own rows against it
-- (workers/sync/row_changes.js, workers/api/depth.js).
--
-- The data is disposable: drop and recreate. The id 0 row per entity marks
-- every object changed now — the table holds no history from before this
-- point — and ages out with the 25h retention like any other row.

DROP TABLE IF EXISTS "_row_changes";
CREATE TABLE "_row_changes" (
    "entity" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "row_at" INTEGER NOT NULL DEFAULT 0,
    "set_at" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("entity", "id")
) WITHOUT ROWID;

INSERT INTO "_row_changes" ("entity", "id", "row_at", "set_at")
SELECT "entity", 0, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
FROM "_sync_meta";
