-- ---------------------------------------------------------------------------
-- Integration safety: circuit-breaker state + event log.
--
-- KaliNova's open-data integrations (Wikidata, Wikimedia Commons, OSM tiles,
-- Nominatim, reviewed RSS feeds) are each fronted by a circuit breaker. Its
-- state lives here so it survives restarts, is shared by every app process,
-- and can be inspected or overridden by an administrator on /admin/integrations.
--
--   integration_status   one row per service/feed — breaker state, counters,
--                        budget usage, manual switch and reason
--   integration_events   append-only log of state changes (opened, closed,
--                        manual off, reset, licence hides), purged after 90
--                        days by the housekeeping sweep
--
-- Data policy:
--   * last_error stores a short internal description of the last failure
--     (a status code or error kind) — never a stack trace, never upstream
--     internals, and never a URL carrying reader-supplied query terms.
--   * is_enabled / auto_state are plain state, not secrets.
--
-- Safe by construction:
--   * additive only, brand new tables, no existing table is touched
--   * every statement is guarded, so re-running is a no-op
-- ---------------------------------------------------------------------------

-- --- integration_status ---------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'integration_status'
    ) THEN
        CREATE TABLE integration_status (
            -- 'wikidata', 'commons', 'nominatim', 'map_tiles', or
            -- 'rss:<source slug>' for each feed.
            service                 VARCHAR(60) PRIMARY KEY,

            -- Where the request goes: the fixed integrations and per-feed RSS.
            module                  VARCHAR(40) NOT NULL DEFAULT 'external',

            -- Mirror of the ENABLE_* environment switch. The environment switch
            -- is the source of truth; this column simply records what it was
            -- the last time the breaker persisted, for the admin page.
            is_enabled              BOOLEAN NOT NULL DEFAULT TRUE,

            -- MANUAL switches, changed only from /admin/integrations. A manual
            -- OFF overrides the automatic machine; a manual ON re-enables a
            -- locked (403-locked) breaker.
            manual_off              BOOLEAN NOT NULL DEFAULT FALSE,
            manual_reason           TEXT NOT NULL DEFAULT '',

            -- closed | open | half-open | locked-403
            auto_state              VARCHAR(20) NOT NULL DEFAULT 'closed',
            reason                  TEXT NOT NULL DEFAULT '',

            opened_at               TIMESTAMP WITH TIME ZONE,
            next_retry_at           TIMESTAMP WITH TIME ZONE,
            opened_count            INTEGER NOT NULL DEFAULT 0,

            failure_count           INTEGER NOT NULL DEFAULT 0,
            consecutive_failures    INTEGER NOT NULL DEFAULT 0,
            last_error              TEXT NOT NULL DEFAULT '',
            last_success_at         TIMESTAMP WITH TIME ZONE,
            last_failure_at         TIMESTAMP WITH TIME ZONE,

            -- 403 answers are treated as a policy signal; three in a day lock
            -- the breaker until an administrator intervenes.
            forbidden_24h           INTEGER NOT NULL DEFAULT 0,

            -- Trailing-window failure rate (the >50% rule).
            window_started_at       TIMESTAMP WITH TIME ZONE,
            window_requests         INTEGER NOT NULL DEFAULT 0,
            window_failures         INTEGER NOT NULL DEFAULT 0,

            -- Request budgets (hourly + daily envelopes).
            budget_hour_started_at  TIMESTAMP WITH TIME ZONE,
            budget_hour_used        INTEGER NOT NULL DEFAULT 0,
            budget_day_started_at   TIMESTAMP WITH TIME ZONE,
            budget_day_used         INTEGER NOT NULL DEFAULT 0,

            updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

-- --- integration_events ---------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'integration_events'
    ) THEN
        CREATE TABLE integration_events (
            id              BIGSERIAL PRIMARY KEY,
            service         VARCHAR(60) NOT NULL,
            event           VARCHAR(40) NOT NULL,
            reason          TEXT NOT NULL DEFAULT '',
            created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

-- Admin page reads recent events per service; the sweep deletes by age.
CREATE INDEX IF NOT EXISTS idx_integration_events_service_created
    ON integration_events (service, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_events_created
    ON integration_events (created_at);