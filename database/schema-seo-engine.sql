-- ---------------------------------------------------------------------------
-- SEO Engine storage: URL redirects.
--
-- KaliNova publishes under /blog/<slug>, and a slug change on a published
-- article must never silently break an existing URL. This table records the
-- 301 sources the site should forward, written automatically when an editor
-- renames a published slug and manageable by hand on /admin/redirects.
--
-- The SEO analysis itself is computed dynamically (deterministic rules over
-- the article row) and stores nothing — see docs/seo-engine.md. No score table
-- exists because a cached score would go stale the moment the writer edits a
-- single paragraph; the analyzer is cheap enough to run on demand in the
-- editor and on publish.
--
-- Design notes (mirroring the earlier migrations):
--   * every statement is guarded, so re-running is a no-op
--   * additive: no existing table is dropped, rewritten or re-seeded
--   * a unique index on source_path is the real duplicate guard (the admin
--     checks also catch collisions before they reach the database)
--   * only site-relative paths or absolute http(s) destinations are accepted
--     by the application; the CHECKs below are the second line of defence
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION kalinova_touch_redirects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'redirects'
    ) THEN
        CREATE TABLE redirects (
            id                 SERIAL PRIMARY KEY,

            -- Normalised site path, e.g. /blog/my-old-title. No query string,
            -- no fragment, no trailing slash, no backslash.
            source_path        TEXT NOT NULL,

            -- Where the source should land: same-site path (/blog/new-title) or
            -- an absolute http(s) URL. A redirect into an admin or API path is
            -- refused by the application, not enforced by the database.
            destination_path   TEXT NOT NULL,

            -- 301 is the SEO default; a small set of 302s is allowed for
            -- temporary moves.
            status_code        INTEGER NOT NULL DEFAULT 301
                               CHECK (status_code IN (301, 302)),

            is_active          BOOLEAN NOT NULL DEFAULT true,

            created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT redirects_source_path_clean
                CHECK (source_path LIKE '/%'
                       AND length(source_path) <= 2000
                       AND source_path NOT LIKE '%?%'
                       AND source_path NOT LIKE '%#%'
                       AND source_path NOT LIKE '%\%'),

            CONSTRAINT redirects_destination_http
                CHECK (destination_path LIKE '/%'
                       OR destination_path LIKE 'https://%'
                       OR destination_path LIKE 'http://%')
        );

        CREATE UNIQUE INDEX idx_redirects_source_path ON redirects (source_path);
        CREATE INDEX idx_redirects_is_active ON redirects (is_active);

        COMMENT ON TABLE redirects IS 'Server-side URL redirects for renamed or retired public paths.';
    END IF;
END $$;

DROP TRIGGER IF EXISTS redirects_touch_updated_at ON redirects;

CREATE TRIGGER redirects_touch_updated_at
    BEFORE UPDATE ON redirects
    FOR EACH ROW
    EXECUTE FUNCTION kalinova_touch_redirects_updated_at();