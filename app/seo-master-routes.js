"use strict";

/**
 * KaliNova — public SEO surface
 *
 * Two routers live here:
 *
 *   seoRouter      /sitemap.xml, its child sitemaps, /robots.txt and the
 *                  read-only /api/search, /api/tags and /api/authors endpoints.
 *                  Mounted before express.static so the dynamic sitemap and
 *                  robots win over the static files of the same name.
 *
 *   seoPageRouter  the server-rendered landing pages (/blog/<slug>,
 *                  /category/<slug>, /tag/<slug>, /author/<slug>). Each one
 *                  verifies the entity exists and is public, then returns the
 *                  SPA shell with the correct head and JSON-LD already in it,
 *                  so a crawler that does not run JavaScript still sees the
 *                  right metadata. The client hydrates over the same shell.
 *
 * Nothing here reads an admin-only column: the projections are explicit lists,
 * not SELECT *.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const pool = require("./db");
const seoMeta = require("./seo-meta");
const sitemaps = require("./sitemap-service");
const tagService = require("./tag-service");

const INDEX_PATH = path.join(__dirname, "../frontend/index.html");
const NOT_FOUND_PATH = path.join(__dirname, "../frontend/404.html");

let indexTemplate = null;
function getIndexTemplate() {
  if (indexTemplate === null) indexTemplate = fs.readFileSync(INDEX_PATH, "utf8");
  return indexTemplate;
}

const HEAD_MARKERS = /<!-- SEO-HEAD:START -->[\s\S]*?<!-- SEO-HEAD:END -->/;
const JSONLD_MARKERS = /<!-- SEO-JSONLD:START -->[\s\S]*?<!-- SEO-JSONLD:END -->/;

/** Return the SPA shell with server-rendered metadata spliced into it. */
function renderIndexWithMeta(meta) {
  const template = getIndexTemplate();
  return template
    .replace(
      HEAD_MARKERS,
      `<!-- SEO-HEAD:START -->\n${seoMeta.renderHeadTags(meta)}\n<!-- SEO-HEAD:END -->`
    )
    .replace(
      JSONLD_MARKERS,
      `<!-- SEO-JSONLD:START -->\n${seoMeta.renderJsonLd(meta)}\n<!-- SEO-JSONLD:END -->`
    );
}

function sendMetaPage(res, meta) {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  return res.send(renderIndexWithMeta(meta));
}

function sendNotFound(res) {
  res.set("X-Robots-Tag", "noindex, follow");
  return res.status(404).sendFile(NOT_FOUND_PATH);
}

/* ====================================================================== */
/* Data loaders                                                            */
/* ====================================================================== */

const ARTICLE_META_COLUMNS = `
  a.id, a.title, a.slug, a.excerpt, a.meta_title, a.meta_description,
  a.canonical_url, a.robots_index, a.robots_follow, a.cover_image, a.banner_alt,
  a.og_title, a.og_description, a.og_image,
  a.twitter_title, a.twitter_description, a.twitter_image,
  a.schema_type, a.published_at, a.created_at, a.updated_at, a.author_id,
  c.name AS category_name, c.slug AS category_slug,
  u.username AS author_username, u.slug AS author_slug, u.avatar_url AS author_avatar
`;

async function loadArticleRow(slug) {
  const { rows } = await pool.query(
    `SELECT ${ARTICLE_META_COLUMNS}
       FROM articles a
       JOIN users u ON u.id = a.author_id
       LEFT JOIN categories c ON c.id = a.category_id
      WHERE a.slug = $1 AND a.status = 'published'
      LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

async function loadCategoryRow(slug) {
  const { rows } = await pool.query(
    `SELECT id, name, slug, description, image, meta_title, meta_description,
            canonical_url, robots_index, robots_follow
       FROM categories
      WHERE slug = $1
      LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

async function loadAuthorRow(slug) {
  const { rows } = await pool.query(
    `SELECT id, username, slug, avatar_url, bio, role, website, social_links,
            meta_title, meta_description, canonical_url, robots_index, robots_follow
       FROM users
      WHERE slug = $1 AND is_active IS NOT FALSE
      LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

function categoryFromRow(row) {
  if (!row) return null;
  return { name: row.category_name, slug: row.category_slug };
}

function authorFromRow(row) {
  if (!row) return null;
  return { username: row.author_username, slug: row.author_slug, avatar_url: row.author_avatar };
}

/* ====================================================================== */
/* Public JSON API                                                         */
/* ====================================================================== */

const searchRouter = express.Router();

searchRouter.get("/search", async (req, res) => {
  try {
    const term = String(req.query.q || "").trim().slice(0, 120);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 50);

    if (term.length < 2) {
      return res.json({ query: term, results: [], tags: [] });
    }

    const like = `%${term}%`;
    const [articles, tags] = await Promise.all([
      pool.query(
        `SELECT a.id, a.title, a.slug, a.excerpt, a.meta_description, a.cover_image,
                a.banner_alt, a.published_at,
                u.username AS author_username, u.slug AS author_slug,
                c.name AS category_name, c.slug AS category_slug
           FROM articles a
           JOIN users u ON u.id = a.author_id
           LEFT JOIN categories c ON c.id = a.category_id
          WHERE a.status = 'published'
            AND a.published_at IS NOT NULL
            AND (a.title ILIKE $1 OR a.meta_description ILIKE $1 OR a.excerpt ILIKE $1 OR a.content ILIKE $1)
          ORDER BY a.published_at DESC
          LIMIT $2`,
        [like, limit]
      ),
      pool.query(
        `SELECT id, name, slug
           FROM tags
          WHERE name ILIKE $1 OR slug ILIKE $1
          ORDER BY name ASC
          LIMIT 10`,
        [like]
      )
    ]);

    // Attach author names in a stable shape for the client.
    const results = articles.rows.map(row => ({
      ...row,
      author: { username: row.author_username, slug: row.author_slug },
      category: row.category_name ? { name: row.category_name, slug: row.category_slug } : null
    }));

    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json({ query: term, results, tags: tags.rows });
  } catch (error) {
    console.error("SEO search error:", error.message);
    res.status(500).json({ error: "Search unavailable" });
  }
});

searchRouter.get("/tags", async (req, res) => {
  try {
    const tags = await tagService.listTags({ limit: req.query.limit });
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.json({ tags });
  } catch (error) {
    console.error("SEO tags error:", error.message);
    res.status(500).json({ error: "Tags unavailable" });
  }
});

searchRouter.get("/tags/:slug", async (req, res) => {
  try {
    const { tag, articles, total } = await tagService.listArticlesByTag(req.params.slug, {
      limit: req.query.limit,
      offset: req.query.offset
    });
    if (!tag) return res.status(404).json({ error: "Tag not found" });

    res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
    res.json({ tag, articles, total });
  } catch (error) {
    console.error("SEO tag error:", error.message);
    res.status(500).json({ error: "Tag unavailable" });
  }
});

searchRouter.get("/authors/:slug", async (req, res) => {
  try {
    const author = await loadAuthorRow(req.params.slug);
    if (!author) return res.status(404).json({ error: "Author not found" });

    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.slug, a.excerpt, a.meta_description, a.cover_image,
              a.banner_alt, a.published_at,
              c.name AS category_name, c.slug AS category_slug
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id
        WHERE a.author_id = $1 AND a.status = 'published' AND a.published_at IS NOT NULL
        ORDER BY a.published_at DESC
        LIMIT 50`,
      [author.id]
    );

    // Never return the internal sign-in identity or settings columns.
    res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
    res.json({
      author: {
        username: author.username,
        slug: author.slug,
        bio: author.bio,
        avatar_url: author.avatar_url,
        website: author.website,
        social_links: author.social_links || {}
      },
      articles: rows
    });
  } catch (error) {
    console.error("SEO author error:", error.message);
    res.status(500).json({ error: "Author unavailable" });
  }
});

/* ====================================================================== */
/* Sitemap + robots                                                        */
/* ====================================================================== */

const sitemapRouter = express.Router();

sitemapRouter.get("/sitemap.xml", async (req, res) => {
  try {
    const xml = await sitemaps.buildSitemapIndex();
    res.type("application/xml").set("Cache-Control", "public, max-age=3600");
    res.send(xml);
  } catch (error) {
    console.error("Sitemap index error:", error.message);
    res.status(500).type("text/plain").send("Sitemap unavailable");
  }
});

sitemapRouter.get("/sitemap-:child.xml", async (req, res) => {
  try {
    const xml = await sitemaps.buildChild(req.params.child);
    if (!xml) return res.status(404).type("text/plain").send("Not found");
    res.type("application/xml").set("Cache-Control", "public, max-age=3600");
    res.send(xml);
  } catch (error) {
    console.error("Sitemap child error:", error.message);
    res.status(500).type("text/plain").send("Sitemap unavailable");
  }
});

sitemapRouter.get("/robots.txt", (req, res) => {
  res.type("text/plain").set("Cache-Control", "public, max-age=3600");
  res.send(sitemaps.buildRobots());
});

const seoRouter = express.Router();
seoRouter.use(sitemapRouter);
seoRouter.use("/api", searchRouter);

/* ====================================================================== */
/* Server-rendered landing pages                                           */
/* ====================================================================== */

const seoPageRouter = express.Router();

seoPageRouter.get(/^\/(?:blog|stories)\/([^/]+)\/?$/, async (req, res, next) => {
  const slug = String(req.params[0] || "").slice(0, 255);
  if (!slug) return next();

  try {
    const article = await loadArticleRow(slug);
    if (!article) return sendNotFound(res);

    const tags = await tagService.getTagsForArticle(article.id);
    const meta = seoMeta.buildPageMeta({
      type: "article",
      article,
      author: authorFromRow(article),
      category: categoryFromRow(article),
      tags
    });
    return sendMetaPage(res, meta);
  } catch (error) {
    // Database trouble must not take the public site down.
    return next();
  }
});

seoPageRouter.get(/^\/category\/([^/]+)\/?$/, async (req, res, next) => {
  const slug = String(req.params[0] || "").slice(0, 255);
  if (!slug) return next();

  try {
    const category = await loadCategoryRow(slug);
    if (!category) return next();
    return sendMetaPage(res, seoMeta.buildPageMeta({ type: "category", category }));
  } catch (error) {
    return next();
  }
});

seoPageRouter.get(/^\/tag\/([^/]+)\/?$/, async (req, res, next) => {
  const slug = String(req.params[0] || "").slice(0, 255);
  if (!slug) return next();

  try {
    const tag = await tagService.getTagBySlug(slug);
    if (!tag) return sendNotFound(res);
    return sendMetaPage(res, seoMeta.buildPageMeta({ type: "tag", tag }));
  } catch (error) {
    return next();
  }
});

seoPageRouter.get(/^\/author\/([^/]+)\/?$/, async (req, res, next) => {
  const slug = String(req.params[0] || "").slice(0, 255);
  if (!slug) return next();

  try {
    const author = await loadAuthorRow(slug);
    if (!author) return sendNotFound(res);
    return sendMetaPage(res, seoMeta.buildPageMeta({ type: "author", author }));
  } catch (error) {
    return next();
  }
});

module.exports = {
  seoRouter,
  seoPageRouter,
  renderIndexWithMeta
};
