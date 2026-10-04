-- The live database was seeded before seed.sql carried cinema categories, so
-- three film stories were filed under latest-news. Matched on slug so the
-- correction is safe to re-run and does not depend on row ids.
UPDATE articles a
SET category_id = c.id
FROM (VALUES
    ('the-cinematography-that-made-a-debut-feel-like-a-classic', 'bollywood'),
    ('why-this-ensemble-cast-outperformed-the-script',          'bollywood'),
    ('six-rings-of-change-regional-cinema',                     'tollywood')
) AS fix (slug, category_slug)
JOIN categories c ON c.slug = fix.category_slug
WHERE a.slug = fix.slug
  AND a.category_id IS DISTINCT FROM c.id;