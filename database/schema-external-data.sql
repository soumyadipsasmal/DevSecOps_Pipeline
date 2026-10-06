-- ---------------------------------------------------------------------------
-- External open-data storage.
--
-- KaliNova reads a small set of free, attribution-friendly public services
-- (Wikidata, Wikimedia Commons, OpenStreetMap/Nominatim, a short list of
-- reviewed RSS feeds). This migration adds the two tables that keep those
-- integrations polite and cheap:
--
--   external_data_cache   the answer to an upstream lookup, kept server-side
--                         so a page view never waits on — or multiplies —
--                         someone else's public API
--   rss_items             headlines, dates, links and short excerpts only
--
-- Data policy encoded in the schema (mirrors docs/external-data-licenses.md):
--   * No third-party article bodies are stored. rss_items.description is a
--     bounded excerpt of the feed description; readers always follow
--     original_url to the publisher. The CHECK below keeps URLs pointing at
--     the open web rather than an internal mirror.
--   * No article images are downloaded. Commons/Wikidata results are kept in
--     external_data_cache payloads as metadata only (licence, attribution,
--     source URL); the browser hotlinks the original thumbnail from
--     upload.wikimedia.org under the file's own licence.
--   * Cache rows expire (expires_at). Old rows are pruned by the services
--     that write them; the expires_at index below keeps that cheap.
--
-- Safe by construction:
--   * additive only, brand new tables, no existing table is touched
--   * every statement is guarded, so re-running is a no-op
-- ---------------------------------------------------------------------------

-- --- external_data_cache ----------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'external_data_cache'
    ) THEN
        CREATE TABLE external_data_cache (
            -- Opaque, deterministic key built by the service (hash of the
            -- query plus the lookup kind), so a human-readable query never
            -- lands in a primary key.
            cache_key       TEXT PRIMARY KEY,

            -- Which upstream produced this row: 'nominatim', 'wikidata',
            -- 'commons'. Documentation and debugging only; the code that
            -- reads a key is the same code that wrote it.
            source          VARCHAR(40) NOT NULL,

            -- The normalised answer. JSONB so the services can evolve their
            -- payload shape without another migration.
            payload         JSONB NOT NULL,

            fetched_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

            -- After this instant the row is a miss, not an answer. NOT NULL
            -- on purpose: a cache row with no expiry is a permanent lie.
            expires_at      TIMESTAMP WITH TIME ZONE NOT NULL
        );
    END IF;
END $$;

-- Pruning and TTL checks ask for expired rows by time.
CREATE INDEX IF NOT EXISTS idx_external_data_cache_expires_at
    ON external_data_cache (expires_at);

-- Pruning groups by origin occasionally (e.g. drop a source's rows on a
-- policy change).
CREATE INDEX IF NOT EXISTS idx_external_data_cache_source
    ON external_data_cache (source);

-- --- rss_items --------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'rss_items'
    ) THEN
        CREATE TABLE rss_items (
            id              SERIAL PRIMARY KEY,

            -- Registry entry that produced the row (Wikimedia Foundation,
            -- Mongabay News, ...), NOT the per-item author: attribution for
            -- the headline sits with the publishing organisation and the
            -- link on the page.
            source          VARCHAR(120) NOT NULL,

            title           VARCHAR(300) NOT NULL,

            -- Excerpt of the feed description, ~240 characters. Deliberately
            -- not the article body.
            description     TEXT NOT NULL DEFAULT '',

            -- The publisher's own page. Readers go there; we only index it.
            original_url    TEXT NOT NULL,

            -- NULL is allowed: a feed without a date sorts last instead of
            -- inventing one.
            published_at    TIMESTAMP WITH TIME ZONE,

            -- Category slug, matching categories.slug used by the article
            -- pages (the frontend asks /api/news/latest with e.g. "wildlife").
            category        VARCHAR(60) NOT NULL DEFAULT 'latest-news',

            -- Feed guid, falling back to the URL when a feed omits it.
            -- UNIQUE is what makes re-ingestion idempotent: the INSERT below
            -- uses ON CONFLICT (guid) DO NOTHING.
            guid            VARCHAR(500) NOT NULL UNIQUE,

            created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

            -- Headlines and excerpts are pointers into the open web, never
            -- local copies of anything.
            CONSTRAINT rss_items_url_is_web CHECK (original_url ~* '^https?://'),
            CONSTRAINT rss_items_title_not_empty CHECK (length(btrim(title)) > 0)
        );
    END IF;
END $$;

-- The public endpoint reads "newest headlines", optionally per category.
CREATE INDEX IF NOT EXISTS idx_rss_items_published_at
    ON rss_items (published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_rss_items_category_published
    ON rss_items (category, published_at DESC NULLS LAST);

-- Retention: rows older than the prune window are deleted after refresh.
CREATE INDEX IF NOT EXISTS idx_rss_items_created_at
    ON rss_items (created_at);
