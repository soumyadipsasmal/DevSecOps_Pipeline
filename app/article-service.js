"use strict";

/**
 * KaliNova — admin article data access
 *
 * The articles table already carries everything the CMS needs; the migration in
 * database/schema-article-cms.sql only adds meta_description, banner_alt,
 * updated_at and body_format. Nothing here creates or replaces a table.
 *
 * Every statement is parameterised, and every function that takes an id is
 * called from a route that has already been authenticated by the existing admin
 * middleware. Nothing is trusted from the request body: the author id comes from
 * the site's seeded author row, not from the client.
 */

const pool = require("./db");

const {
  STATUSES,
  STATUS_DRAFT,
  STATUS_PUBLISHED,
  ensureUniqueSlug
} = require("./article-validation");

const SITE_AUTHOR = "kalinova";

const ADMIN_COLUMNS = `
    articles.id,
    articles.author_id,
    articles.title,
    articles.slug,
    articles.meta_description,
    articles.content,
    articles.body_format,
    articles.cover_image,
    articles.banner_alt,
    articles.category_id,
    articles.is_featured,
    articles.is_trending,
    articles.status,
    articles.published_at,
    articles.created_at,
    articles.updated_at,
    categories.name AS category_name,
    categories.slug AS category_slug,
    users.username AS author_username
`;

const ARTICLE_JOINS = `
    FROM articles
    LEFT JOIN categories ON categories.id = articles.category_id
    LEFT JOIN users ON users.id = articles.author_id
`;

/* Whitelisted sort orders. A sort expression can never come from the client. */
const SORT_OPTIONS = {
  updated: "articles.updated_at DESC NULLS LAST, articles.id DESC",
  newest: "articles.created_at DESC, articles.id DESC",
  oldest: "articles.created_at ASC, articles.id ASC",
  title: "articles.title ASC",
  status: "articles.status ASC, articles.updated_at DESC NULLS LAST"
};

const PER_PAGE_CHOICES = [10, 25, 50, 100];

let siteAuthorId = null;

/**
 * The site's single author row. Articles are attributed to it so the public
 * byline never depends on who happens to be signed in.
 */
async function getSiteAuthorId() {
  if (siteAuthorId) return siteAuthorId;

  const result = await pool.query("SELECT id FROM users WHERE username = $1", [SITE_AUTHOR]);
  if (result.rows.length === 0) {
    throw new Error(`Author "${SITE_AUTHOR}" is missing. Run the database seed scripts.`);
  }

  siteAuthorId = result.rows[0].id;
  return siteAuthorId;
}

/** Categories for the admin dropdown, with a live article count. */
async function listCategories() {
  const { rows } = await pool.query(`
    SELECT
      categories.id,
      categories.name,
      categories.slug,
      categories.description,
      categories.display_order,
      COUNT(articles.id)::int AS article_count
    FROM categories
    LEFT JOIN articles ON articles.category_id = categories.id
    GROUP BY categories.id, categories.name, categories.slug, categories.description, categories.display_order
    ORDER BY categories.display_order ASC, categories.name ASC
  `);

  return rows;
}

async function categoryExists(id) {
  if (!Number.isInteger(id) || id <= 0) return false;
  const { rows } = await pool.query("SELECT 1 FROM categories WHERE id = $1", [id]);
  return rows.length > 0;
}

/** Categories that already exist, for a select element. */
function categoryOptions(categories, { selectedId = null } = {}) {
  return categories.map(category => ({
    ...category,
    selected: Number(selectedId) === Number(category.id)
  }));
}

/**
 * Paginated article list for /admin/articles.
 *
 * @param {object} query
 * @param {string} [query.search]    matched against title and slug
 * @param {string} [query.status]    draft | published (or empty for all)
 * @param {number|string} [query.category] category id
 * @param {string} [query.sort]      key of SORT_OPTIONS
 * @param {number|string} [query.page] 1-based
 * @param {number|string} [query.perPage]
 * @returns {Promise<{ rows: object[], total: number, page: number, perPage: number, pages: number, counts: object }>}
 */
async function listArticles(query = {}) {
  const conditions = [];
  const params = [];

  const search = String(query.search || "").trim();
  if (search) {
    params.push(`%${search.slice(0, 120)}%`);
    const placeholder = `$${params.length}`;
    conditions.push(`(articles.title ILIKE ${placeholder} OR articles.slug ILIKE ${placeholder})`);
  }

  const status = String(query.status || "").trim().toLowerCase();
  if (STATUSES.includes(status)) {
    params.push(status);
    conditions.push(`articles.status = $${params.length}`);
  }

  const categoryId = Number.parseInt(String(query.category ?? ""), 10);
  if (Number.isInteger(categoryId) && categoryId > 0) {
    params.push(categoryId);
    conditions.push(`articles.category_id = $${params.length}`);
  }

  const sort = SORT_OPTIONS[String(query.sort || "")] || SORT_OPTIONS.updated;

  const requestedPerPage = Number.parseInt(String(query.perPage ?? ""), 10);
  const perPage = PER_PAGE_CHOICES.includes(requestedPerPage) ? requestedPerPage : 20;

  const requestedPage = Number.parseInt(String(query.page ?? ""), 10);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

  // Totals for the same filters, plus the global draft/published split so the
  // filter tabs can show their counts without a second round trip.
  const [result, totals, counts] = await Promise.all([
    pool.query(
      `SELECT ${ADMIN_COLUMNS} ${ARTICLE_JOINS}${where} ORDER BY ${sort} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, (page - 1) * perPage]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM articles${where}`,
      params
    ),
    pool.query(
      "SELECT status, COUNT(*)::int AS count FROM articles GROUP BY status ORDER BY status"
    )
  ]);

  const total = totals.rows[0] ? totals.rows[0].total : 0;
  const byStatus = { draft: 0, published: 0 };
  for (const row of counts.rows) {
    if (row.status === STATUS_DRAFT || row.status === STATUS_PUBLISHED) {
      byStatus[row.status] = row.count;
    }
  }

  return {
    rows: result.rows,
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    counts: {
      all: counts.rows.reduce((sum, row) => sum + row.count, 0),
      ...byStatus
    }
  };
}

/** A single article for the edit form, including unpublished rows. */
async function getArticleForAdmin(id) {
  const parsed = Number.parseInt(String(id), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;

  const { rows } = await pool.query(
    `SELECT ${ADMIN_COLUMNS} ${ARTICLE_JOINS} WHERE articles.id = $1`,
    [parsed]
  );

  return rows[0] || null;
}

/** Used by slugTaken() and by the create/update path. */
async function isSlugTaken(slug, excludeId = null) {
  const { rows } = await pool.query(
    "SELECT 1 FROM articles WHERE slug = $1 AND ($2::integer IS NULL OR id <> $2) LIMIT 1",
    [slug, excludeId]
  );
  return rows.length > 0;
}

async function resolveSlug(desiredSlug, excludeId) {
  return ensureUniqueSlug(desiredSlug, (slug, id) => isSlugTaken(slug, id), excludeId);
}

/**
 * Insert an article.
 *
 * @param {object} values validated values from article-validation
 * @returns {Promise<object>} the stored row, admin projection
 */
async function createArticle(values) {
  const authorId = await getSiteAuthorId();
  const slug = await resolveSlug(values.slug, null);

  const { rows } = await pool.query(
    `INSERT INTO articles
       (author_id, title, slug, meta_description, content, body_format, cover_image,
        banner_alt, category_id, status, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text, CASE WHEN $10::text = 'published' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [
      authorId,
      values.title,
      slug,
      values.metaDescription,
      values.bodyHtml,
      values.bodyFormat,
      values.coverImage,
      values.bannerAlt,
      values.categoryId,
      values.status
    ]
  );

  return getArticleForAdmin(rows[0].id);
}

/**
 * Update an existing article in place — never insert a second row.
 * published_at is stamped once, when the article first becomes published, and is
 * kept when an already published article is edited again.
 */
async function updateArticle(id, values) {
  const parsed = Number.parseInt(String(id), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;

  const slug = await resolveSlug(values.slug, parsed);

  const { rows } = await pool.query(
    `UPDATE articles
        SET title = $2,
            slug = $3,
            meta_description = $4,
            content = $5,
            body_format = $6,
            cover_image = $7,
            banner_alt = $8,
            category_id = $9,
            status = $10::text,
            published_at = CASE
              WHEN $10::text = 'published' THEN COALESCE(published_at, NOW())
              ELSE published_at
            END
      WHERE id = $1
      RETURNING id`,
    [
      parsed,
      values.title,
      slug,
      values.metaDescription,
      values.bodyHtml,
      values.bodyFormat,
      values.coverImage,
      values.bannerAlt,
      values.categoryId,
      values.status
    ]
  );

  if (rows.length === 0) return null;
  return getArticleForAdmin(parsed);
}

/**
 * Publish or unpublish without touching any other field.
 *
 * Unpublishing deliberately keeps the row, its slug and its original
 * published_at: the article stops being public (the public queries filter on
 * status) and republishing later does not lose the first-publication date.
 */
async function setStatus(id, status) {
  const parsed = Number.parseInt(String(id), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  if (!STATUSES.includes(status)) return null;

  const { rows } = await pool.query(
    `UPDATE articles
        SET status = $2::text,
            published_at = CASE
              WHEN $2::text = 'published' THEN COALESCE(published_at, NOW())
              ELSE published_at
            END
      WHERE id = $1
      RETURNING id`,
    [parsed, status]
  );

  if (rows.length === 0) return null;
  return getArticleForAdmin(parsed);
}

/**
 * Delete an article and everything attached to it.
 *
 * article_images rows are removed by the ON DELETE CASCADE on the foreign key,
 * so no orphan rows are left behind. A banner uploaded through the CMS is
 * deleted from disk too, unless another article still references it.
 *
 * @returns {Promise<null | { id: number, slug: string, cover_image: string|null }>}
 *   null when the id does not exist.
 */
async function deleteArticle(id) {
  const parsed = Number.parseInt(String(id), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;

  const { rows } = await pool.query(
    "DELETE FROM articles WHERE id = $1 RETURNING id, slug, cover_image",
    [parsed]
  );

  if (rows.length === 0) return null;
  return rows[0];
}

/** Images still pointing at an uploaded banner, so it is not deleted too early. */
async function countReferences(publicPath) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE cover_image = $1)::int AS covers,
       COUNT(*) FILTER (WHERE content LIKE '%' || $1 || '%')::int AS bodies
     FROM articles`,
    [publicPath]
  );

  const row = rows[0] || { covers: 0, bodies: 0 };
  return row.covers + row.bodies;
}

/** A few published articles for the dashboard preview table. */
async function listRecent(limit = 8) {
  const { rows } = await pool.query(
    `SELECT ${ADMIN_COLUMNS} ${ARTICLE_JOINS}
      ORDER BY articles.updated_at DESC NULLS LAST, articles.id DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 8, 1), 50)]
  );

  return rows;
}

module.exports = {
  PER_PAGE_CHOICES,
  SITE_AUTHOR,
  SORT_OPTIONS,
  categoryExists,
  categoryOptions,
  countReferences,
  createArticle,
  deleteArticle,
  getArticleForAdmin,
  getSiteAuthorId,
  isSlugTaken,
  listArticles,
  listCategories,
  listRecent,
  resolveSlug,
  setStatus,
  updateArticle
};