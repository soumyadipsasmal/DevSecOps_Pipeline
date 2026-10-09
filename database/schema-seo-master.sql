-- ---------------------------------------------------------------------------
-- SEO master: per-entity SEO metadata, scheduling and social cards.
--
-- This is the storage the Phase-1 SEO pipeline reads and writes. It follows the
-- house pattern of the earlier migrations exactly:
--   * additive only — no DROP TABLE, no RENAME, no destructive rewrite
--   * every statement is guarded, so re-running the whole file is a no-op
--   * the one backfill (author slugs, below) is honest and only fills NULLs
--   * existing rows keep working: every new column is nullable or has a default
--     that reproduces today's behaviour (index/follow, BlogPosting)
--
-- What it adds:
--   articles      excerpt, focus keyword, canonical override, robots directives,
--                 Open Graph + Twitter card overrides, JSON-LD schema type and
--                 scheduled_at. Also widens articles_status_check from
--                 ('draft','published') to include 'scheduled' and 'archived'.
--   categories    the same metadata a category landing page needs.
--   users         authored-by pages: a public slug, website, social links and
--                 the same metadata block. Authors are already rows in users
--                 (see schema-admin-auth.sql); no parallel author table exists.
--   indexes       articles.author_id, so a public author page never table-scans.
--
-- The application (article-validation.js / article-service.js) validates every
-- value; the CHECKs here are the second line of defence, not the first.
-- ---------------------------------------------------------------------------

-- --- helper: honest updated_at for any table that gains one later -------------
-- Mirrors the touch functions in schema-article-cms.sql / schema-seo-engine.sql.
-- The three tables touched here already have their own updated_at triggers where
-- relevant, so this file adds none; the function exists so a future column does
-- not need a new one-off definition.
CREATE OR REPLACE FUNCTION kalinova_touch_seo_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- articles
-- ===========================================================================

-- --- excerpt ---------------------------------------------------------------
-- The short standfirst shown under the headline and used as the fallback for
-- the social/meta descriptions. NULL for every existing row, which keeps their
-- derived description exactly as it renders today.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS excerpt TEXT;

-- --- search / canonical overrides ------------------------------------------
-- meta_title defaults to the article title at render time (NULL here means
-- "use the title"), and canonical_url lets an editor point at a syndicated
-- original while the XML sitemap still lists this URL.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS meta_title VARCHAR(200);
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS canonical_url TEXT;

-- --- robots directives ------------------------------------------------------
-- Two independent switches. The defaults (index/follow) reproduce the current
-- behaviour for every existing row.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS robots_index VARCHAR(10) NOT NULL DEFAULT 'index';
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS robots_follow VARCHAR(10) NOT NULL DEFAULT 'follow';

-- --- Open Graph overrides ---------------------------------------------------
-- Each one falls back to the article data when NULL: og_title -> meta_title ->
-- title, og_description -> excerpt -> meta_description, og_image -> cover_image.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS og_title VARCHAR(200);
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS og_description TEXT;
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS og_image TEXT;

-- --- Twitter / X card overrides --------------------------------------------
-- Same fallback chain as Open Graph, ending at the Open Graph value.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS twitter_title VARCHAR(200);
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS twitter_description TEXT;
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS twitter_image TEXT;

-- --- JSON-LD schema type ----------------------------------------------------
-- Defaults to BlogPosting, which is what the client-side builder already emits.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS schema_type VARCHAR(40) NOT NULL DEFAULT 'BlogPosting';

-- --- focus keyword ----------------------------------------------------------
-- The single phrase the SEO panel scores against. Optional; NULL means the
-- analyzer falls back to the most frequent meaningful term in the body.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS focus_keyword VARCHAR(120);

-- --- scheduling -------------------------------------------------------------
-- The moment a 'scheduled' article should go live. NULL for draft/published
-- rows. The publisher promotes a due row to 'published' and stamps published_at.
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITH TIME ZONE;

-- --- constraints on the new columns (guarded) -------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'articles_robots_index_allowed'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'articles'))
    ) THEN
        ALTER TABLE articles
            ADD CONSTRAINT articles_robots_index_allowed
            CHECK (robots_index IN ('index', 'noindex')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'articles_robots_follow_allowed'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'articles'))
    ) THEN
        ALTER TABLE articles
            ADD CONSTRAINT articles_robots_follow_allowed
            CHECK (robots_follow IN ('follow', 'nofollow')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'articles_schema_type_allowed'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'articles'))
    ) THEN
        ALTER TABLE articles
            ADD CONSTRAINT articles_schema_type_allowed
            CHECK (schema_type IN (
                'Article', 'BlogPosting', 'NewsArticle', 'TechArticle',
                'ScholarlyArticle', 'Report', 'Review', 'HowTo', 'Recipe',
                'VideoObject'
            )) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'articles_canonical_url_shape'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'articles'))
    ) THEN
        ALTER TABLE articles
            ADD CONSTRAINT articles_canonical_url_shape
            CHECK (
                canonical_url IS NULL
                OR canonical_url ~ '^https?://[^\s<>]+$'
                OR canonical_url LIKE '/%'
            ) NOT VALID;
    END IF;
END $$;

-- --- status model: add 'scheduled' and 'archived' ---------------------------
-- schema-article-cms.sql installed a NOT VALID draft/published CHECK. Replace
-- it with the wider editorial workflow. Dropping and re-adding is idempotent,
-- and NOT VALID keeps any legacy row with an unexpected status working while
-- still enforcing the allowed set on every new and updated row.
ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_status_check;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'articles_status_check'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'articles'))
    ) THEN
        ALTER TABLE articles
            ADD CONSTRAINT articles_status_check
            CHECK (status IN ('draft', 'published', 'scheduled', 'archived')) NOT VALID;
    END IF;
END $$;

-- --- index: author lookups --------------------------------------------------
-- The public /author/<slug> page lists one author's published articles. The
-- existing indexes only cover category/status, so without this the join to
-- users still forces a sequential scan of articles.
CREATE INDEX IF NOT EXISTS idx_articles_author_id ON articles (author_id);

-- ===========================================================================
-- categories
-- ===========================================================================

ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS meta_title VARCHAR(200);
ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS meta_description TEXT;
ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS canonical_url TEXT;
ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS robots_index VARCHAR(10) NOT NULL DEFAULT 'index';
ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS robots_follow VARCHAR(10) NOT NULL DEFAULT 'follow';
ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS image TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'categories_robots_index_allowed'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'categories'))
    ) THEN
        ALTER TABLE categories
            ADD CONSTRAINT categories_robots_index_allowed
            CHECK (robots_index IN ('index', 'noindex')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'categories_robots_follow_allowed'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'categories'))
    ) THEN
        ALTER TABLE categories
            ADD CONSTRAINT categories_robots_follow_allowed
            CHECK (robots_follow IN ('follow', 'nofollow')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'categories_canonical_url_shape'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'categories'))
    ) THEN
        ALTER TABLE categories
            ADD CONSTRAINT categories_canonical_url_shape
            CHECK (
                canonical_url IS NULL
                OR canonical_url ~ '^https?://[^\s<>]+$'
                OR canonical_url LIKE '/%'
            ) NOT VALID;
    END IF;
END $$;

-- ===========================================================================
-- users  (public author pages)
-- ===========================================================================

-- --- public slug ------------------------------------------------------------
-- username is internal (and is what sign-in uses); slug is the URL-safe public
-- identity for /author/<slug>. Unique when present; NULL is allowed so an
-- account that never publishes an author page is untouched.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS slug VARCHAR(120);
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '{}'::jsonb;

-- --- author-page SEO metadata ----------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS meta_title VARCHAR(200);
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS meta_description TEXT;
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS canonical_url TEXT;
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS robots_index VARCHAR(10) NOT NULL DEFAULT 'index';
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS robots_follow VARCHAR(10) NOT NULL DEFAULT 'follow';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_robots_index_allowed'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'users'))
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_robots_index_allowed
            CHECK (robots_index IN ('index', 'noindex')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_robots_follow_allowed'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'users'))
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_robots_follow_allowed
            CHECK (robots_follow IN ('follow', 'nofollow')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_canonical_url_shape'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'users'))
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_canonical_url_shape
            CHECK (
                canonical_url IS NULL
                OR canonical_url ~ '^https?://[^\s<>]+$'
                OR canonical_url LIKE '/%'
            ) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_social_links_object'
          AND conrelid = to_regclass(format('%I.%I', current_schema(), 'users'))
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_social_links_object
            CHECK (jsonb_typeof(social_links) = 'object') NOT VALID;
    END IF;
END $$;

-- --- honest backfill: a slug for accounts that predate it -------------------
-- The seeded site has a single author ('kalinova'); a deployment may have more.
-- Derive the slug from the username the same way article-validation slugify()
-- does, and only for rows that do not have one yet, so an edited slug is never
-- overwritten. The DO block keeps the UPDATE from running (and from failing on
-- a name that slugifies to nothing) when there is nothing to fill.
DO $$
BEGIN
    UPDATE users
       SET slug = NULLIF(
             trim(BOTH '-' FROM
               regexp_replace(
                 regexp_replace(lower(username), '[^a-z0-9]+', '-', 'g'),
                 '-{2,}', '-', 'g'
               )
             ),
             ''
           )
     WHERE slug IS NULL;
EXCEPTION
    WHEN unique_violation THEN
        -- Two usernames slugified to the same value. Leave them NULL; an
        -- administrator sets a distinct slug on /admin/authors rather than the
        -- migration guessing. The unique index below still applies to new rows.
        NULL;
END $$;

-- Unique when present. A partial unique index is the right shape because
-- multiple NULLs are allowed and must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug_unique ON users (slug) WHERE slug IS NOT NULL;
