-- Images embedded inside an article body, ordered by reading position.
-- Rows are produced by `npm run seed:images`, which scores the images in
-- scripts/topic-images.tsv against each article and assigns them by relevancy.
CREATE TABLE IF NOT EXISTS article_images (
    id SERIAL PRIMARY KEY,
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    position INTEGER NOT NULL,
    title TEXT,
    alt_text TEXT,
    creator TEXT,
    license TEXT,
    source TEXT,
    topic_slug VARCHAR(100),
    score NUMERIC(8, 4),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (article_id, position)
);

CREATE INDEX IF NOT EXISTS idx_article_images_article_id
    ON article_images(article_id, position ASC);