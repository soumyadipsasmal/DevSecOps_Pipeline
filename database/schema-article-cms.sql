-- ---------------------------------------------------------------------------
-- Article CMS: the columns the admin editor needs.
--
-- Everything already exists in `articles`: title, slug, content, cover_image,
-- category_id, status and published_at are all reused, and slug is already
-- UNIQUE. This migration only adds what was missing.
--
-- Safe by construction:
--   * additive only — no DROP, no RENAME, no data rewrite beyond one honest
--     backfill of updated_at
--   * every statement is guarded, so re-running is a no-op
--   * the status CHECK is added NOT VALID: it enforces the draft/published model
--     for new and updated rows without scanning or rejecting existing rows
-- ---------------------------------------------------------------------------

-- --- meta description -------------------------------------------------------
-- Used for <meta name="description"> and og:description. Replaces the
-- description the frontend used to derive from the body text. NULL for rows
-- written before the CMS, which keeps their existing rendering untouched.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS meta_description TEXT;

-- --- banner alt text --------------------------------------------------------
-- Accessibility: the alt text of cover_image.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS banner_alt TEXT;

-- --- rich text / plain text marker -----------------------------------------
-- The seeded bodies are plain text that the frontend renders with formatContent()
-- ("## " headings, "**bold**"). Editor output is sanitised HTML and is marked
-- here so the public renderer can tell the two apart instead of guessing.
-- Existing rows keep 'text' because 'text' is the column default.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS body_format VARCHAR(10) NOT NULL DEFAULT 'text';

-- --- updated_at -------------------------------------------------------------
-- Added with a backfill rather than DEFAULT CURRENT_TIMESTAMP on ADD COLUMN,
-- so an old article does not claim to have been edited today. published_at (or
-- created_at) is the truthful last-modified date for everything already stored.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'articles'
          AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE articles ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE;
        UPDATE articles SET updated_at = COALESCE(published_at, created_at, NOW());
        ALTER TABLE articles ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE articles ALTER COLUMN updated_at SET NOT NULL;
    END IF;
END $$;

-- --- status model -----------------------------------------------------------
-- The CMS only ever writes 'draft' or 'published'. NOT VALID keeps any legacy
-- row with an unexpected status working instead of failing the whole migration.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'articles_status_check'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'articles'))
    ) THEN
        ALTER TABLE articles
            ADD CONSTRAINT articles_status_check
            CHECK (status IN ('draft', 'published')) NOT VALID;
    END IF;
END $$;

-- --- keep updated_at honest -------------------------------------------------
-- Any UPDATE (admin save, publish toggle, seed script) refreshes updated_at, so
-- the admin list can sort by "last edited" and the sitemap can report a real
-- lastmod without every writer remembering to set the column.
CREATE OR REPLACE FUNCTION kalinova_touch_articles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS articles_touch_updated_at ON articles;

CREATE TRIGGER articles_touch_updated_at
    BEFORE UPDATE ON articles
    FOR EACH ROW
    EXECUTE FUNCTION kalinova_touch_articles_updated_at();

-- --- indexes ----------------------------------------------------------------
-- slug is already UNIQUE (that index covers lookups by slug). The admin list
-- filters and orders by the columns below, so they get their own indexes.
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles (status);
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_updated_at ON articles (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_category_status ON articles (category_id, status);