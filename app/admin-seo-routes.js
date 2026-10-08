"use strict";

/**
 * KaliNova — admin SEO routes
 *
 * The router hands a saved article row (or the unsaved editor content) to the
 * deterministic SEO analyzer and returns its report. Two surfaces:
 *
 *   GET  /api/admin/articles/:id/seo       analyse a stored article
 *   POST /api/admin/articles/seo/analyze   analyse unsaved editor content
 *
 * Both run behind the existing admin guards, the analyze POST additionally
 * asks for the CSRF token and is throttle by IP, and neither endpoint persists
 * anything: the report is computed on demand and thrown away (docs/seo-engine.md).
 *
 * The engine is pure and offline; the database-backed checks (duplicate title,
 * duplicate slug, broken internal links, related-story candidates) are passed
 * in as `services` here. Everything that fails silently in the engine shows as
 * an INFO check rather than a crash.
 */

const express = require("express");

const articleService = require("./article-service");
const config = require("./config");
const pool = require("./db");
const { analyzeArticle } = require("./seo-engine");
const security = require("./security");
const { sanitizeBody } = require("./article-html");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Engine wiring                                                       */
/* ------------------------------------------------------------------ */

function parseId(value) {
  const id = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "for", "of", "to",
  "in", "on", "at", "by", "with", "as", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "shall", "should", "can", "could", "may", "might", "must", "it", "its", "this",
  "that", "these", "those", "there", "here", "when", "where", "which", "who",
  "whom", "why", "how", "from", "into", "over", "under", "again", "then", "now",
  "also", "more", "most", "some", "any", "all", "each", "every", "both", "few",
  "other", "such", "only", "own", "same", "very", "just", "about", "what", "not",
  "if", "than", "too", "up", "out", "off", "no", "yes", "via", "per"
]);

function meaningTokens(value) {
  const raw = String(value || "").toLowerCase();
  return raw.match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) || [];
}

function meaningSet(value) {
  return new Set(
    meaningTokens(value).filter(word => word.length > 1 && !/^[0-9]+$/.test(word) && !STOPWORDS.has(word))
  );
}

/** Title-to-title similarity for the duplicate-title check. */
async function similarTitles(title, excludeId) {
  const exclude = Number.parseInt(String(excludeId ?? ""), 10) || null;
  const { rows } = await pool.query(
    `SELECT id, title FROM articles
      WHERE status = 'published'
        AND ($2::integer IS NULL OR id <> $2)
      ORDER BY updated_at DESC, id DESC
      LIMIT 300`,
    [exclude]
  );

  const own = meaningTokens(title);
  const outcome = [];
  for (const row of rows) {
    const same = String(row.title).trim().toLowerCase() === String(title).trim().toLowerCase();
    if (same) {
      outcome.push({ title: row.title, similarity: 1, same: true });
      continue;
    }

    const a = meaningSet(title);
    const b = meaningSet(row.title);
    if (a.size === 0 || b.size === 0) continue;

    let overlap = 0;
    for (const word of b) if (a.has(word)) overlap += 1;
    const union = new Set([...a, ...b]);
    outcome.push({ title: row.title, similarity: overlap / union.size, same: false });
  }

  return outcome;
}

/** Does any published article use this slug? */
async function slugTaken(slug, excludeId) {
  const exclude = Number.parseInt(String(excludeId ?? ""), 10) || null;
  const { rows } = await pool.query(
    "SELECT 1 FROM articles WHERE slug = $1 AND ($2::integer IS NULL OR id <> $2) LIMIT 1",
    [String(slug || ""), exclude]
  );
  return rows.length > 0;
}

/** Does a published article exist at this /blog/<slug> target? */
async function articleTargetExists(kind, slug) {
  if (kind !== "article") return false;
  const { rows } = await pool.query(
    "SELECT 1 FROM articles WHERE slug = $1 AND status = 'published' LIMIT 1",
    [String(slug || "")]
  );
  return rows.length > 0;
}

/** Candidate stories for the internal-link suggestions. */
async function suggestCandidates() {
  const { rows } = await pool.query(
    `SELECT articles.id, articles.title, articles.slug,
            articles.category_id, categories.slug AS category_slug
       FROM articles
       LEFT JOIN categories ON categories.id = articles.category_id
      WHERE articles.status = 'published'
      ORDER BY articles.published_at DESC, articles.id DESC
      LIMIT 500`
  );
  return rows;
}

function engineServices(articleId) {
  return {
    similarTitles: (title, excludeId) => similarTitles(title, excludeId ?? articleId),
    slugTaken: (slug, excludeId) => slugTaken(slug, excludeId ?? articleId),
    articleTargetExists,
    suggestCandidates
  };
}

function engineOptions(services) {
  return {
    siteUrl: config.siteOrigin,
    engineEnabled: config.enableSeoEngine,
    internalLinkLimit: config.seoInternalLinkLimit,
    services
  };
}

/** Sanitise editor content exactly as validation would, returning null when it is unusable. */
function sanitizedContent(value) {
  const raw = typeof value === "string" ? value : "";

  let sanitized;
  try {
    sanitized = sanitizeBody(raw);
  } catch (error) {
    return { error };
  }

  const html = sanitized.html;
  const bodyFormat = /<[a-z][^>]*>/i.test(html) ? "html" : "text";
  return { error: null, bodyHtml: html, bodyFormat, truncated: sanitized.truncated };
}

/** Read one value under several spellings. */
function pick(body, ...names) {
  for (const name of names) {
    const value = body ? body[name] : undefined;
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** The engine-ready article shape from editor (or stored) values. */
function articleInput(body) {
  const contentResult = sanitizedContent(pick(body, "content", "body_html", "bodyHtml", "body"));
  return {
    id: pick(body, "id", "article_id"),
    title: pick(body, "title"),
    slug: pick(body, "slug"),
    meta_description: pick(body, "meta_description", "metaDescription"),
    content: contentResult.error ? String(pick(body, "content") ?? "") : contentResult.bodyHtml,
    body_format: contentResult.error ? "" : contentResult.bodyFormat,
    cover_image: pick(body, "cover_image", "coverImage"),
    banner_alt: pick(body, "banner_alt", "bannerAlt"),
    category_id: pick(body, "category_id", "categoryId"),
    category_name: pick(body, "category_name", "categoryName"),
    category_slug: pick(body, "category_slug", "categorySlug"),
    status: pick(body, "status"),
    published_at: pick(body, "published_at", "publishedAt"),
    created_at: pick(body, "created_at", "createdAt")
  };
}

/** A stored admin row is already snake_case; pass it straight to the engine. */
function articleRowToValues(article) {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    meta_description: article.meta_description,
    content: article.content,
    body_format: article.body_format,
    cover_image: article.cover_image,
    banner_alt: article.banner_alt,
    category_id: article.category_id,
    category_name: article.category_name,
    category_slug: article.category_slug,
    status: article.status,
    published_at: article.published_at,
    created_at: article.created_at
  };
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/** Per-IP ceiling on the analyze endpoint: the panel is not a compute loop. */
const analyzeLimiter = (() => {
  const limiter = security.createLoginLimiter({
    windowMs: 60 * 1000,
    maxAttempts: 30,
    keyFor: req => String(req.ip || "unknown")
  });

  return (req, res, next) => {
    const key = limiter.keyFor(req);
    const retryAfter = limiter.check(key);
    if (retryAfter !== null) {
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too many SEO analysis requests. Try again shortly." });
    }
    limiter.record(key);
    return next();
  };
})();

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/** Analyse one stored article (draft or published). */
router.get("/articles/:id/seo", security.attachAdmin, security.requireAdmin, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: "Article not found" });

    const article = await articleService.getArticleForAdmin(id);
    if (!article) return res.status(404).json({ error: "Article not found" });

    const report = await analyzeArticle(
      articleRowToValues(article),
      engineOptions(engineServices(article.id))
    );

    return res.json({ report });
  } catch (error) {
    return next(error);
  }
});

/** Analyse the content currently in the editor. */
router.post("/articles/seo/analyze", analyzeLimiter, security.attachAdmin, security.requireAdmin, security.requireCsrf, async (req, res, next) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const input = articleInput(body);
    const contentResult = sanitizedContent(pick(body, "content", "body_html", "bodyHtml", "body"));

    if (contentResult.error) {
      return res.status(422).json({ error: contentResult.error.message, code: contentResult.error.code || "BODY_TOO_LARGE" });
    }

    const articleId = parseId(input.id) || null;
    const report = await analyzeArticle(
      input,
      engineOptions(engineServices(articleId))
    );

    return res.json({ report });
  } catch (error) {
    return next(error);
  }
});

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/** Mount the SEO endpoints onto the admin JSON surface. */
function registerApi(api) {
  api.use(router);
  return api;
}

module.exports = { registerApi };