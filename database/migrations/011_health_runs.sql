-- Migration: weekly health check & repair reports (workers/sync/health.js).
--
-- The sync worker's weekly cron compares every table's ids against
-- upstream, repairs drift (deletes stale rows, fetches missing ones) and
-- writes one report row here; the mirror-health GitHub workflow reads the
-- latest row to publish a summary, open/update an issue and fail on repairs.
-- New table only; matches extracted/schema.sql.

CREATE TABLE IF NOT EXISTS "_health_runs" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "started_at" TEXT NOT NULL,
    "finished_at" TEXT NOT NULL,
    "repaired" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "alerts" INTEGER NOT NULL DEFAULT 0,
    "report" TEXT NOT NULL
);
