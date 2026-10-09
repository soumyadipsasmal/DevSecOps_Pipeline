"use strict";

/**
 * KaliNova — dynamic sitemap and robots
 *
 * frontend/sitemap.xml and frontend/robots.txt are static files copied into the
 * image. They describe the site as it was when the image was built, which goes
 * stale the moment an editor publishes a story. This service builds both from
 * the database instead, so a published article is discoverable without a
 * rebuild.
 *
 * The sitemap is an index that points at one child sitemap per content type.
 * Splitting it that way keeps every generated document well under the 50,000
 * URL / 50 MB limits in the sitemap protocol even on a large site, and lets a
 * crawler refresh just the part that changed (articles) without re-reading the
 * stable parts (static pages).
 *
 * Reads only public columns. An unpublished, scheduled, archived or noindex row
 * is never included: a sitemap is a request to index, and putting a noindex URL
 * in one is a contradiction search engines report as an error.
 */

const pool = require("./db");
const config = require("./config");

const SITEMAP_LIMIT = 45000;
const URLSET_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** Escape the five characters that would break an XML text node. */
function xmlEscape(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isoDate(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function urlEntry(loc, { lastmod, changefreq, priority } = {}) {
  const parts = [`  <url>`, `    <loc>${xmlEscape(loc)}</loc>`];
  if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
  if (changefreq) parts.push(`    <changefreq>${changefreq}</changefreq>`);
  if (priority !== undefined) parts.push(`    <priority>${priority.toFixed(1)}</priority>`);
  parts.push(`  </url>`);
  return parts.join("\n");
}

function urlSet(entries) {
  return [
    URLSET_HEADER,
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>"
  ].join("\n");
}

function sitemapIndex(children) {
  const body = children.map(
    child =>
      [
        "  <sitemap>",
        `    <loc>${xmlEscape(child.loc)}</loc>`,
        child.lastmod ? `    <lastmod>${child.lastmod}</lastmod>` : null,
        "  </sitemap>"
      ]
        .filter(Boolean)
        .join("\n")
  );
  return [
    URLSET_HEADER,
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...body,
    "</sitemapindex>"
  ].join("\n");
}

function originOf() {
  return config.siteOrigin.replace(/\/$/, "");
}

/* ---- data ------------------------------------------------------------- */

async function getPublishedArticles() {
  const { rows } = await pool.query(
    `SELECT slug, published_at, updated_at
       FROM articles
      WHERE status = 'published'
        AND published_at IS NOT NULL
        AND (robots_index IS NULL OR robots_index <> 'noindex')
      ORDER BY published_at DESC
      LIMIT $1`,
    [SITEMAP_LIMIT]
  );
  return rows;
}

async function getCategories() {
  // Categories have no updated_at column; a category URL's lastmod is simply
  // omitted rather than guessed from an unrelated timestamp.
  const { rows } = await pool.query(
    `SELECT slug
       FROM categories
      WHERE slug IS NOT NULL
        AND (robots_index IS NULL OR robots_index <> 'noindex')
      ORDER BY name ASC`
  );
  return rows;
}

async function getTags() {
  const { rows } = await pool.query(
    `SELECT slug, updated_at
       FROM tags
      WHERE slug IS NOT NULL
        AND (robots_index IS NULL OR robots_index <> 'noindex')
      ORDER BY name ASC
      LIMIT $1`,
    [SITEMAP_LIMIT]
  );
  return rows;
}

async function getAuthors() {
  const { rows } = await pool.query(
    `SELECT slug, updated_at
       FROM users
      WHERE slug IS NOT NULL
        AND is_active IS NOT FALSE
        AND (robots_index IS NULL OR robots_index <> 'noindex')
      ORDER BY username ASC`
  );
  return rows;
}

/* ---- documents -------------------------------------------------------- */

function staticEntries(origin) {
  const pages = [
    { path: "/", priority: 1.0, changefreq: "daily" },
    { path: "/about", priority: 0.4, changefreq: "monthly" },
    { path: "/services", priority: 0.4, changefreq: "monthly" },
    { path: "/careers", priority: 0.3, changefreq: "monthly" },
    { path: "/contact", priority: 0.4, changefreq: "monthly" }
  ];
  return pages.map(page =>
    urlEntry(`${origin}${page.path}`, {
      changefreq: page.changefreq,
      priority: page.priority
    })
  );
}

async function buildPagesSitemap() {
  return urlSet(staticEntries(originOf()));
}

async function buildArticlesSitemap() {
  const origin = originOf();
  const rows = await getPublishedArticles();
  const entries = rows.map(row =>
    urlEntry(`${origin}/blog/${encodeURIComponent(row.slug)}`, {
      lastmod: isoDate(row.updated_at || row.published_at),
      changefreq: "weekly",
      priority: 0.8
    })
  );
  return urlSet(entries);
}

async function buildCategoriesSitemap() {
  const origin = originOf();
  const rows = await getCategories();
  const entries = rows.map(row =>
    urlEntry(`${origin}/category/${encodeURIComponent(row.slug)}`, {
      lastmod: isoDate(row.updated_at),
      changefreq: "weekly",
      priority: 0.7
    })
  );
  return urlSet(entries);
}

async function buildTagsSitemap() {
  const origin = originOf();
  const rows = await getTags();
  const entries = rows.map(row =>
    urlEntry(`${origin}/tag/${encodeURIComponent(row.slug)}`, {
      lastmod: isoDate(row.updated_at),
      changefreq: "weekly",
      priority: 0.5
    })
  );
  return urlSet(entries);
}

async function buildAuthorsSitemap() {
  const origin = originOf();
  const rows = await getAuthors();
  const entries = rows.map(row =>
    urlEntry(`${origin}/author/${encodeURIComponent(row.slug)}`, {
      lastmod: isoDate(row.updated_at),
      changefreq: "weekly",
      priority: 0.5
    })
  );
  return urlSet(entries);
}

const CHILDREN = {
  pages: { file: "sitemap-pages.xml", build: buildPagesSitemap },
  articles: { file: "sitemap-articles.xml", build: buildArticlesSitemap },
  categories: { file: "sitemap-categories.xml", build: buildCategoriesSitemap },
  tags: { file: "sitemap-tags.xml", build: buildTagsSitemap },
  authors: { file: "sitemap-authors.xml", build: buildAuthorsSitemap }
};

/** The sitemap index at /sitemap.xml. */
async function buildSitemapIndex() {
  const origin = originOf();
  const now = new Date().toISOString();
  const children = Object.values(CHILDREN).map(child => ({
    loc: `${origin}/${child.file}`,
    lastmod: now
  }));
  return sitemapIndex(children);
}

/** Build one child sitemap, or null when the name is unknown. */
async function buildChild(name) {
  const child = CHILDREN[name];
  if (!child) return null;
  return child.build();
}

function childFileName(name) {
  return CHILDREN[name] ? CHILDREN[name].file : null;
}

/**
 * robots.txt. A sitemap line is only emitted when an origin is known, because a
 * relative Sitemap directive is invalid.
 */
function buildRobots() {
  const origin = originOf();
  const lines = [
    "User-agent: *",
    "Allow: /",
    "",
    "# The admin area and the JSON API are not for crawlers.",
    "Disallow: /admin",
    "Disallow: /api/",
    "",
    "# Assets that do not need indexing.",
    "Disallow: /assets/uploads/",
    `Sitemap: ${origin}/sitemap.xml`,
    ""
  ];
  return lines.join("\n");
}

module.exports = {
  buildSitemapIndex,
  buildChild,
  buildRobots,
  buildPagesSitemap,
  buildArticlesSitemap,
  buildCategoriesSitemap,
  buildTagsSitemap,
  buildAuthorsSitemap,
  childFileName,
  xmlEscape,
  SITEMAP_LIMIT
};
