-- ---------------------------------------------------------------------------
-- SEO content taxonomy: tags.
--
-- The public site groups stories by category (one per article) and, from this
-- migration on, by tag (zero or more per article). Tags power the /tag/<slug>
-- landing pages, the article keyword metadata and the search facets.
--
-- Design notes (mirroring every earlier migration):
--   * additive only — two brand-new tables, no existing table is read or
--     rewritten
--   * every statement is guarded, so re-running the file is a no-op
--   * a tag slug is unique, so /tag/<slug> always resolves to one tag
--   * the join table is the source of truth for membership; deleting an
--     article or a tag removes its links (ON DELETE CASCADE)
--   * ordering is explicit (position) so an editor controls the keyword order
--
-- Nothing is seeded: a fresh volume has no tags until an editor adds them.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION kalinova_touch_tags_updated_at()
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
          AND table_name = 'tags'
    ) THEN
        CREATE TABLE tags (
            id               SERIAL PRIMARY KEY,

            -- Display name, e.g. "Bollywood".
            name             VARCHAR(80) NOT NULL,

            -- URL-safe identity for /tag/<slug>. Unique so a tag cannot be
            -- shadowed by a later one with the same public address.
            slug             VARCHAR(120) NOT NULL UNIQUE,

            description      TEXT,

            -- Same per-entity SEO block the other landing pages carry.
            meta_title       VARCHAR(200),
            meta_description TEXT,
            canonical_url    TEXT,
            robots_index     VARCHAR(10) NOT NULL DEFAULT 'index',
            robots_follow    VARCHAR(10) NOT NULL DEFAULT 'follow',

            created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT tags_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
            CONSTRAINT tags_robots_index_allowed CHECK (robots_index IN ('index', 'noindex')),
            CONSTRAINT tags_robots_follow_allowed CHECK (robots_follow IN ('follow', 'nofollow')),
            CONSTRAINT tags_canonical_url_shape CHECK (
                canonical_url IS NULL
                OR canonical_url ~ '^https?://[^\s<>]+$'
                OR canonical_url LIKE '/%'
            )
        );
    END IF;
END $$;

DROP TRIGGER IF EXISTS tags_touch_updated_at ON tags;
CREATE TRIGGER tags_touch_updated_at
    BEFORE UPDATE ON tags
    FOR EACH ROW
    EXECUTE FUNCTION kalinova_touch_tags_updated_at();

CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags (slug);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'article_tags'
    ) THEN
        CREATE TABLE article_tags (
            article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,

            -- Editor-controlled order; when unset the tag list falls back to
            -- alphabetical in the application layer.
            position   INTEGER NOT NULL DEFAULT 0,

            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

            PRIMARY KEY (article_id, tag_id)
        );
    END IF;
END $$;

-- Listing every article that carries one tag, and every tag on one article,
-- are both frequent; the primary key only covers (article_id, tag_id) lookups.
CREATE INDEX IF NOT EXISTS idx_article_tags_tag ON article_tags (tag_id, article_id);
