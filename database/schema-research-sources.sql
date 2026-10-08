-- ---------------------------------------------------------------------------
-- Editorial sources + research provenance.
--
-- Two brand-new tables, both attached to an existing article. Nothing in the
-- articles table is altered and no existing row is rewritten.
--
--   article_sources            the citations an editor writes by hand and the
--                              reader sees under "Sources & references"
--   article_research_metadata  snapshots of external API material the editor
--                              consulted while drafting, kept for provenance
--                              and for the copy-similarity warning
--
-- Data policy:
--   * article_research_metadata holds short reference excerpts only (capped by
--     app/article-sources.js) — never whole third-party articles, never media
--     files, never article bodies. It is provenance, not a content store.
--   * Neither table is ever read by the public article query except
--     article_sources, which is served only for published rows.
--   * No API key, token or connection string is stored here.
--
-- Safe by construction:
--   * additive only, brand new tables, no existing table is touched
--   * every statement is guarded, so re-running is a no-op
--   * both foreign keys cascade, so deleting an article leaves no orphans
-- ---------------------------------------------------------------------------

-- --- article_sources -------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'article_sources'
    ) THEN
        CREATE TABLE article_sources (
            id                  SERIAL PRIMARY KEY,

            article_id          INTEGER NOT NULL
                                    REFERENCES articles(id) ON DELETE CASCADE,

            -- "Wikidata", "OpenStreetMap", "Interview, 4 March 2026", ...
            source_name         VARCHAR(200) NOT NULL,

            -- The locator the reader can follow. http(s) only; enforced again
            -- in app/article-sources.js before anything is written.
            source_url          VARCHAR(500) NOT NULL,

            -- Licence or terms label when the source states one
            -- ("CC0 1.0", "ODbL", "CC BY-SA 4.0", ...). Optional: a source
            -- with no declared licence simply leaves this NULL rather than
            -- having one invented for it.
            license             VARCHAR(120),

            -- Attribution line to print when the licence requires one. Stays
            -- NULL when it does not, so the UI never shows a fabricated credit.
            attribution_text    VARCHAR(600),

            -- Display order chosen in the editor.
            position            INTEGER NOT NULL DEFAULT 0,

            created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_article_sources_article
            ON article_sources(article_id, position ASC);
    END IF;
END
$$;

-- --- article_research_metadata ---------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'article_research_metadata'
    ) THEN
        CREATE TABLE article_research_metadata (
            id                  SERIAL PRIMARY KEY,

            article_id          INTEGER NOT NULL
                                    REFERENCES articles(id) ON DELETE CASCADE,

            -- Which integration produced this: wikidata | commons | news | geo
            source_key          VARCHAR(40) NOT NULL,

            source_name         VARCHAR(200) NOT NULL,
            source_url          VARCHAR(500),
            license             VARCHAR(120),

            -- The reference excerpt the editor looked at, kept so the
            -- copy-similarity warning can compare the finished body against
            -- the material it was written from. Truncated in the app.
            reference_text      TEXT,

            created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX idx_article_research_article
            ON article_research_metadata(article_id);

        -- The integration list is a fixed allowlist in the application; the
        -- CHECK keeps a hand-edited row inside it too.
        ALTER TABLE article_research_metadata
            ADD CONSTRAINT article_research_metadata_source_key_check
            CHECK (source_key IN ('wikidata', 'commons', 'news', 'geo'));
    END IF;
END
$$;
