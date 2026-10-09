"use strict";

/**
 * KaliNova — tag service
 *
 * Tags are a lightweight taxonomy: an article can carry several, and each tag
 * gets a /tag/<slug> landing page. This module is the only place that reads or
 * writes the tags and article_tags tables, so the route layer stays thin.
 *
 * Batch reads are offered (getTagsForArticles) so a listing page can fetch the
 * tags for every article in one query instead of one query per row.
 */

const pool = require("./db");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Turn a display name into the slug shape the database CHECK enforces. */
function slugify(name) {
  const slug = String(name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug;
}

function clampLimit(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) return DEFAULT_LIMIT;
  return Math.min(number, MAX_LIMIT);
}

const TAG_COLUMNS =
  "id, name, slug, description, meta_title, meta_description, canonical_url, robots_index, robots_follow, created_at, updated_at";

async function listTags({ limit } = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.slug, t.description, t.meta_title, t.meta_description,
            t.canonical_url, t.robots_index, t.robots_follow, t.created_at, t.updated_at,
            COUNT(a.id)::int AS article_count
       FROM tags t
       LEFT JOIN article_tags at ON at.tag_id = t.id
       LEFT JOIN articles a ON a.id = at.article_id AND a.status = 'published'
      GROUP BY t.id
      ORDER BY t.name ASC
      LIMIT $1`,
    [clampLimit(limit)]
  );
  return rows;
}

async function getTagBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT ${TAG_COLUMNS} FROM tags WHERE slug = $1`,
    [String(slug || "").toLowerCase()]
  );
  return rows[0] || null;
}

async function getTagById(id) {
  const { rows } = await pool.query(`SELECT ${TAG_COLUMNS} FROM tags WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getTagsForArticle(articleId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.slug
       FROM tags t
       JOIN article_tags at ON at.tag_id = t.id
      WHERE at.article_id = $1
      ORDER BY at.position ASC, t.name ASC`,
    [articleId]
  );
  return rows;
}

/**
 * Tags for many articles in a single query. Returns a Map keyed by article id
 * so callers can attach tags without scanning the whole array per row.
 */
async function getTagsForArticles(articleIds) {
  const ids = (articleIds || []).map(Number).filter(Number.isInteger);
  const grouped = new Map(ids.map(id => [id, []]));
  if (!ids.length) return grouped;

  const { rows } = await pool.query(
    `SELECT at.article_id, t.id, t.name, t.slug
       FROM article_tags at
       JOIN tags t ON t.id = at.tag_id
      WHERE at.article_id = ANY($1)
      ORDER BY at.position ASC, t.name ASC`,
    [ids]
  );

  for (const row of rows) {
    const list = grouped.get(Number(row.article_id));
    if (list) list.push({ id: row.id, name: row.name, slug: row.slug });
  }
  return grouped;
}

/**
 * Replace an article's tags with the supplied list. Names that do not exist yet
 * are created. Returns the final tag list. Runs in a transaction so a failure
 * never leaves an article half-retagged.
 */
async function setArticleTags(articleId, tags) {
  const cleaned = [];
  const seen = new Set();
  for (const raw of tags || []) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const slug = slugify(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    cleaned.push({ name, slug });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM article_tags WHERE article_id = $1", [articleId]);

    let position = 0;
    for (const tag of cleaned) {
      const { rows } = await client.query(
        `INSERT INTO tags (name, slug)
         VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = tags.name
         RETURNING id`,
        [tag.name, tag.slug]
      );
      await client.query(
        `INSERT INTO article_tags (article_id, tag_id, position)
         VALUES ($1, $2, $3)
         ON CONFLICT (article_id, tag_id) DO NOTHING`,
        [articleId, rows[0].id, position]
      );
      position += 1;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getTagsForArticle(articleId);
}

/** Published articles carrying one tag, newest first. */
async function listArticlesByTag(slug, { limit, offset } = {}) {
  const tag = await getTagBySlug(slug);
  if (!tag) return { tag: null, articles: [], total: 0 };

  const safeLimit = clampLimit(limit);
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);

  const [articles, count] = await Promise.all([
    pool.query(
      `SELECT a.id, a.title, a.slug, a.meta_description, a.cover_image, a.banner_alt,
              a.published_at, a.updated_at, a.author_id,
              u.username AS author_username, u.slug AS author_slug,
              c.name AS category_name, c.slug AS category_slug
         FROM articles a
         JOIN article_tags at ON at.article_id = a.id
         LEFT JOIN users u ON u.id = a.author_id
         LEFT JOIN categories c ON c.id = a.category_id
        WHERE at.tag_id = $1
          AND a.status = 'published'
          AND a.published_at IS NOT NULL
        ORDER BY a.published_at DESC
        LIMIT $2 OFFSET $3`,
      [tag.id, safeLimit, safeOffset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
         FROM articles a
         JOIN article_tags at ON at.article_id = a.id
        WHERE at.tag_id = $1 AND a.status = 'published'`,
      [tag.id]
    )
  ]);

  return { tag, articles: articles.rows, total: count.rows[0].total };
}

async function upsertTag({ name, slug, description } = {}) {
  const cleanName = String(name || "").trim();
  const cleanSlug = slugify(slug || cleanName);
  if (!cleanName || !cleanSlug) {
    throw new Error("A tag needs a name that produces a non-empty slug.");
  }
  const { rows } = await pool.query(
    `INSERT INTO tags (name, slug, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name,
           description = COALESCE(EXCLUDED.description, tags.description)
     RETURNING ${TAG_COLUMNS}`,
    [cleanName, cleanSlug, description ? String(description).trim() : null]
  );
  return rows[0];
}

async function deleteTag(id) {
  const { rowCount } = await pool.query("DELETE FROM tags WHERE id = $1", [id]);
  return rowCount > 0;
}

module.exports = {
  slugify,
  listTags,
  getTagBySlug,
  getTagById,
  getTagsForArticle,
  getTagsForArticles,
  setArticleTags,
  listArticlesByTag,
  upsertTag,
  deleteTag,
  clampLimit
};
