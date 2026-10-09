"use strict";

/**
 * KaliNova — admin article routes
 *
 * Registered onto the two routers that admin-routes.js already creates, so the
 * article screens inherit the exact same chain as the dashboard:
 *
 *   /admin/articles*      adminPages — server-rendered HTML, no-store + CSP +
 *                         CSRF + session attached by the router, then the
 *                         page guard below
 *   /api/admin/articles*  adminApi   — JSON for the same operations
 *
 * Nothing here reads an author id, a role or a status from the request. The
 * author is the seeded site author, the role comes from the session that the
 * existing middleware already verified, and every field an administrator can
 * submit goes through article-validation and article-html first.
 */

const express = require("express");

const config = require("./config");
const security = require("./security");
const articleService = require("./article-service");
const uploads = require("./article-uploads");
const articleViews = require("./admin-article-views");
const articleSources = require("./article-sources");
const contentSimilarity = require("./content-similarity");
const tagService = require("./tag-service");
const { renderNotFoundPage } = require("./admin-views");

const {
  STATUSES,
  STATUS_ARCHIVED,
  STATUS_DRAFT,
  STATUS_PUBLISHED,
  STATUS_SCHEDULED,
  validateArticle
} = require("./article-validation");
const { sanitizeBody } = require("./article-html");

/* ==================================================================== */
/* Request helpers                                                      */
/* ==================================================================== */

/**
 * Body parser for the article form.
 *
 * The other admin forms keep their tight 16 KB limit; an article body is a
 * different size class, so only /admin/articles gets a larger ceiling. It is
 * registered ahead of the shared parser by admin-routes.js.
 */
const articleUrlencoded = express.urlencoded({
  extended: false,
  limit: config.adminBodyLimit
});

/** Apply that larger ceiling to the article routes only. */
function articleFormParser(req, res, next) {
  if (req.path === "/articles" || req.path.startsWith("/articles/")) {
    return articleUrlencoded(req, res, next);
  }
  return next();
}

/** Upload bodies are raw bytes; the magic bytes decide the format, not a header. */
const uploadBodyParser = express.raw({
  type: () => true,
  limit: config.uploadMaxBytes + (1024 * 1024)
});

/** Accept the form and API field spellings alike. */
function readField(body, ...names) {
  for (const name of names) {
    const value = body ? body[name] : undefined;
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function parseId(value) {
  const id = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseListQuery(query = {}) {
  const asString = value => (typeof value === "string" ? value.slice(0, 120) : "");

  return {
    search: asString(query.search).trim(),
    status: asString(query.status).trim().toLowerCase(),
    category: asString(query.category).trim(),
    sort: asString(query.sort).trim(),
    page: asString(query.page).trim(),
    perPage: asString(query.perPage).trim()
  };
}

/**
 * Resolve the status to save.
 *
 * The three submit buttons send `intent`, which wins over the radio group, so
 * "Publish" and "Save as draft" do the obvious thing. Without JavaScript the
 * button is still submitted, so this works with the form exactly as rendered.
 */
/**
 * The status a submission is asking for.
 *
 * A submit button's `intent` wins over the status field. An unrecognised
 * status is passed through rather than silently coerced to draft, so
 * validateArticle rejects it instead of quietly publishing or unpublishing
 * something the author did not ask for.
 */
function resolveStatus(body) {
  const intent = String(readField(body, "intent") ?? "").trim().toLowerCase();
  if (intent === STATUS_PUBLISHED) return STATUS_PUBLISHED;
  if (intent === STATUS_SCHEDULED) return STATUS_SCHEDULED;
  if (intent === STATUS_ARCHIVED) return STATUS_ARCHIVED;
  if (intent === STATUS_DRAFT) return STATUS_DRAFT;

  const status = String(readField(body, "status") ?? "").trim().toLowerCase();
  return status || STATUS_DRAFT;
}

function isPreviewIntent(body) {
  return String(readField(body, "intent") ?? "").trim().toLowerCase() === "preview";
}

/**
 * Read the tag names off a submission. Accepts a comma-separated string (the
 * form's single input) or an array (the JSON API). Returns undefined when the
 * field is absent, so a caller can tell "no tags sent" from "clear the tags".
 */
function parseTags(body) {
  const raw = readField(body, "tags", "tag_list", "tagList");
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const seen = new Set();
  const tags = [];
  for (const value of list) {
    const name = String(value ?? "").trim().slice(0, 80);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    tags.push(name);
  }
  return tags;
}

/** Run the shared validation for one submission, including the category check. */
async function validateSubmission(body) {
  const status = resolveStatus(body);
  const result = validateArticle(
    {
      title: readField(body, "title"),
      slug: readField(body, "slug"),
      category_id: readField(body, "category_id", "categoryId"),
      meta_description: readField(body, "meta_description", "metaDescription"),
      content: readField(body, "content", "body_html", "bodyHtml", "body"),
      cover_image: readField(body, "cover_image", "coverImage"),
      banner_alt: readField(body, "banner_alt", "bannerAlt"),
      excerpt: readField(body, "excerpt"),
      meta_title: readField(body, "meta_title", "metaTitle"),
      canonical_url: readField(body, "canonical_url", "canonicalUrl"),
      robots_index: readField(body, "robots_index", "robotsIndex"),
      robots_follow: readField(body, "robots_follow", "robotsFollow"),
      og_title: readField(body, "og_title", "ogTitle"),
      og_description: readField(body, "og_description", "ogDescription"),
      og_image: readField(body, "og_image", "ogImage"),
      twitter_title: readField(body, "twitter_title", "twitterTitle"),
      twitter_description: readField(body, "twitter_description", "twitterDescription"),
      twitter_image: readField(body, "twitter_image", "twitterImage"),
      schema_type: readField(body, "schema_type", "schemaType"),
      focus_keyword: readField(body, "focus_keyword", "focusKeyword"),
      scheduled_at: readField(body, "scheduled_at", "scheduledAt"),
      ads_enabled: readField(body, "ads_enabled", "adsEnabled"),
      status
    },
    { isDraft: status !== STATUS_PUBLISHED && status !== STATUS_SCHEDULED }
  );

  if (!result.ok) return result;

  // The category dropdown is populated from the database, but the request can
  // still name one that does not exist.
  if (!(await articleService.categoryExists(result.values.categoryId))) {
    return { ok: false, errors: { category_id: "Select a category" } };
  }

  return result;
}

/** Values echoed back into the form when validation fails. */
function submittedValues(body) {
  const one = (...names) => {
    const value = readField(body, ...names);
    return value === undefined ? "" : String(value);
  };

  return {
    title: one("title"),
    slug: one("slug"),
    category_id: one("category_id", "categoryId"),
    meta_description: one("meta_description", "metaDescription"),
    content: one("content", "body_html", "bodyHtml", "body"),
    cover_image: one("cover_image", "coverImage"),
    banner_alt: one("banner_alt", "bannerAlt"),
    excerpt: one("excerpt"),
    meta_title: one("meta_title", "metaTitle"),
    canonical_url: one("canonical_url", "canonicalUrl"),
    robots_index: one("robots_index", "robotsIndex"),
    robots_follow: one("robots_follow", "robotsFollow"),
    og_title: one("og_title", "ogTitle"),
    og_description: one("og_description", "ogDescription"),
    og_image: one("og_image", "ogImage"),
    twitter_title: one("twitter_title", "twitterTitle"),
    twitter_description: one("twitter_description", "twitterDescription"),
    twitter_image: one("twitter_image", "twitterImage"),
    schema_type: one("schema_type", "schemaType"),
    focus_keyword: one("focus_keyword", "focusKeyword"),
    tags: one("tags", "tag_list", "tagList"),
    scheduled_at: one("scheduled_at", "scheduledAt"),
    ads_enabled: one("ads_enabled", "adsEnabled"),
    // Echoed raw so a rejected status can be shown back; the radio buttons
    // fall back to draft when it is not one of the allowed values.
    status: String(readField(body, "status") ?? "").trim().toLowerCase()
  };
}

/**
 * Read the editorial extras off a submission.
 *
 * Sources are validated here rather than inside validateArticle so the article
 * rules stay independent of the citations, and a bad source URL is reported as
 * a form error instead of failing the whole article.
 *
 * @returns {{ ok: boolean, errors: object, sources: object[], research: object[] }}
 */
function readEditorial(body) {
  const rows = articleSources.parseSourcesFromBody(body);
  const validated = articleSources.validateSources(rows);

  return {
    ok: validated.ok,
    errors: validated.ok ? {} : { sources: validated.error },
    sources: validated.ok ? validated.sources : [],
    rawSources: rows,
    research: articleSources.parseResearchFromBody(body)
  };
}

/**
 * The copy-similarity gate.
 *
 * Never runs for a draft, and never runs when the editor has already
 * acknowledged the number: it exists to put one explicit acknowledgement in
 * front of a person who is about to publish, not to refuse the work.
 *
 * @returns {null | object} the similarity result when acknowledgment is missing
 */
function pendingSimilarityWarning(body, researchRefs) {
  const status = resolveStatus(body);
  if (status !== STATUS_PUBLISHED && status !== STATUS_SCHEDULED) return null;
  if (String(readField(body, "acknowledge_similarity") ?? "").trim() === "1") return null;

  const result = contentSimilarity.score(
    readField(body, "content", "body_html", "bodyHtml", "body"),
    researchRefs
  );

  return result.flagged ? result : null;
}

/** Everything the form needs to render a submission back to the editor. */
function formContext(body, { article = null, errors = {} } = {}) {
  const editorial = readEditorial(body);

  return {
    article,
    errors: { ...errors, ...editorial.errors },
    values: submittedValues(body),
    sources: editorial.rawSources,
    researchRefs: editorial.research
  };
}

/** JSON shape of an article for the admin API. */
function articleJson(article) {
  return {
    id: article.id,
    author_id: article.author_id,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt,
    meta_description: article.meta_description,
    meta_title: article.meta_title,
    canonical_url: article.canonical_url,
    robots_index: article.robots_index,
    robots_follow: article.robots_follow,
    og_title: article.og_title,
    og_description: article.og_description,
    og_image: article.og_image,
    twitter_title: article.twitter_title,
    twitter_description: article.twitter_description,
    twitter_image: article.twitter_image,
    schema_type: article.schema_type,
    focus_keyword: article.focus_keyword,
    tags: Array.isArray(article.tags) ? article.tags : undefined,
    content: article.content,
    body_format: article.body_format,
    cover_image: article.cover_image,
    banner_alt: article.banner_alt,
    category_id: article.category_id,
    category_name: article.category_name,
    category_slug: article.category_slug,
    is_featured: article.is_featured,
    is_trending: article.is_trending,
    status: article.status,
    ads_enabled: article.ads_enabled,
    scheduled_at: article.scheduled_at,
    published_at: article.published_at,
    created_at: article.created_at,
    updated_at: article.updated_at,
    public_url: article.status === STATUS_PUBLISHED ? `/blog/${article.slug}` : null
  };
}

function notFound(res) {
  return res.status(404).json({ error: "Article not found" });
}

/** The human sentence shown after a save, one per editorial status. */
function savedNotice(title, status) {
  if (status === STATUS_PUBLISHED) return `“${title}” is published.`;
  if (status === STATUS_SCHEDULED) return `“${title}” is scheduled.`;
  if (status === STATUS_ARCHIVED) return `“${title}” is archived.`;
  return `“${title}” was saved as a draft.`;
}

/**
 * The copy-similarity warning as a 422 the API client can act on.
 *
 * Nothing is written: the caller resubmits with acknowledge_similarity=1 once
 * a person has seen the number. Drafts never produce this response.
 */
function similarityRequired(res, similarity) {
  return res.status(422).json({
    error: "Copy-similarity acknowledgement required before publishing.",
    code: "SIMILARITY_ACK_REQUIRED",
    errors: {
      acknowledge_similarity:
        `About ${similarity.percent}% of this article matches reference material you attached. ` +
        "Review it, then resubmit with acknowledge_similarity=1."
    },
    similarity: {
      percent: similarity.percent,
      threshold: Math.round(similarity.threshold * 100),
      checked: similarity.checked,
      worst: similarity.worst
        ? { name: similarity.worst.name, percent: similarity.worst.percent }
        : null
    }
  });
}

/**
 * Render an upload or validation failure without losing the rest of the form.
 *
 * Sources and research references are re-read from the submitted body, so a
 * rejected article never silently drops the citations the editor wrote.
 */
async function renderFormWithError(req, res, {
  article = null,
  errors = {},
  uploadError = "",
  similarity = null,
  notice = ""
} = {}) {
  const body = req.body || {};
  const editorial = readEditorial(body);
  const categories = await articleService.listCategories();

  return res.status(uploadError ? 400 : 422).type("html").send(
    articleViews.renderArticleForm({
      admin: req.admin,
      csrfToken: req.csrfToken,
      article,
      categories,
      uploads: await uploads.listUploads(),
      values: submittedValues(body),
      sources: editorial.rawSources,
      researchRefs: editorial.research,
      errors: { ...editorial.errors, ...errors },
      similarity,
      notice,
      uploadError
    })
  );
}

/* ==================================================================== */
/* HTML pages                                                           */
/* ==================================================================== */

/**
 * Preview whatever is in the form right now.
 *
 * Shared by POST /admin/articles/preview and by the Preview button on the new
 * and edit forms, and used before anything is written to the database.
 */
async function handleUnsavedPreview(req, res, next) {
  try {
    const body = req.body || {};
    // On the edit form the stored article provides the banner and category, so
    // a preview of unsaved changes does not need to reload them from a lookup.
    const existing = req.article || null;
    const submitted = validateArticle(
      {
        title: readField(body, "title"),
        slug: readField(body, "slug"),
        category_id: readField(body, "category_id", "categoryId"),
        meta_description: readField(body, "meta_description", "metaDescription"),
        content: readField(body, "content", "body_html", "bodyHtml", "body"),
        cover_image: readField(body, "cover_image", "coverImage"),
        banner_alt: readField(body, "banner_alt", "bannerAlt"),
        status: resolveStatus(body)
      },
      // A preview never saves, so the relaxed draft rules apply: the point is
      // to see what is on screen, not to decide whether it may be published.
      { isDraft: true }
    );

    const values = submittedValues(body);
    if (submitted.ok) {
      values.title = submitted.values.title;
      values.slug = submitted.values.slug;
      values.category_id = String(submitted.values.categoryId);
      values.meta_description = submitted.values.metaDescription || "";
      values.content = submitted.values.bodyHtml;
      values.cover_image = submitted.values.coverImage || "";
      values.banner_alt = submitted.values.bannerAlt || "";
    }

    const category = values.category_id
      ? (await articleService.listCategories()).find(row => String(row.id) === String(values.category_id))
      : null;

    return res.type("html").send(
      articleViews.renderPreview({
        admin: req.admin,
        csrfToken: req.csrfToken,
        article: existing,
        isUnsaved: true,
        values: { ...values, category_name: category ? category.name : "" },
        bodyHtml: sanitizeBody(values.content).html
      })
    );
  } catch (error) {
    return next(error);
  }
}

function registerPages(pages) {
  /* ---- list --------------------------------------------------------- */

  pages.get("/articles", security.requireAdminPage, async (req, res, next) => {
    try {
      const filters = parseListQuery(req.query);
      const [result, categories] = await Promise.all([
        articleService.listArticles(filters),
        articleService.listCategories()
      ]);

      return res.type("html").send(
        articleViews.renderArticleList({
          admin: req.admin,
          csrfToken: req.csrfToken,
          result,
          filters,
          categories,
          notice: typeof req.query.notice === "string" ? req.query.notice.slice(0, 200) : ""
        })
      );
    } catch (error) {
      return next(error);
    }
  });

  /* ---- new ---------------------------------------------------------- */

  pages.get("/articles/new", security.requireAdminPage, async (req, res, next) => {
    try {
      const [categories, recentUploads] = await Promise.all([
        articleService.listCategories(),
        uploads.listUploads()
      ]);

      return res.type("html").send(
        articleViews.renderArticleForm({
          admin: req.admin,
          csrfToken: req.csrfToken,
          categories,
          uploads: recentUploads,
          values: { status: STATUS_DRAFT },
          sources: [],
          researchRefs: []
        })
      );
    } catch (error) {
      return next(error);
    }
  });

  /* ---- preview the submitted values without saving ------------------- */

  pages.post("/articles/preview", security.requireCsrf, security.requireAdminPage, handleUnsavedPreview);

  /* ---- create ------------------------------------------------------- */

  pages.post("/articles", security.requireCsrf, security.requireAdminPage, async (req, res, next) => {
    try {
      if (isPreviewIntent(req.body)) return handleUnsavedPreview(req, res, next);

      const result = await validateSubmission(req.body);
      if (!result.ok) return renderFormWithError(req, res, { errors: result.errors });

      const editorial = readEditorial(req.body);
      if (!editorial.ok) return renderFormWithError(req, res);

      // Publishing puts the copy-similarity number in front of the editor once.
      // A draft never reaches here, and a save is never refused without one.
      const warning = pendingSimilarityWarning(req.body, editorial.research);
      if (warning) {
        return renderFormWithError(req, res, {
          similarity: warning,
          notice: "Nothing was saved yet. Review the copy-similarity warning below, then publish again."
        });
      }

      const article = await articleService.createArticle(result.values);
      await articleSources.saveEditorialRefs(article.id, {
        sources: editorial.sources,
        research: editorial.research
      });
      const tags = parseTags(req.body);
      if (tags) await tagService.setArticleTags(article.id, tags);

      return res.redirect(
        303,
        `/admin/articles?notice=${encodeURIComponent(savedNotice(article.title, result.values.status))}`
      );
    } catch (error) {
      return next(error);
    }
  });

  /* ---- one article -------------------------------------------------- */

  pages.get("/articles/:id", security.requireAdminPage, (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return next();

    return res.redirect(302, `/admin/articles/${id}/edit`);
  });

  pages.get("/articles/:id/edit", security.requireAdminPage, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const article = await articleService.getArticleForAdmin(id);
      if (!article) return notFoundPage(req, res);

      const [categories, recentUploads, sources, research, tags] = await Promise.all([
        articleService.listCategories(),
        uploads.listUploads(),
        articleSources.listSources(id),
        articleSources.listResearch(id),
        tagService.getTagsForArticle(id)
      ]);

      // Show the number on load as well as on publish, so an editor can see the
      // relationship between what they wrote and what they consulted before
      // pressing anything.
      const similarity = contentSimilarity.score(
        article.content,
        research.map(row => ({ name: row.source_name, text: row.reference_text }))
      );

      return res.type("html").send(
        articleViews.renderArticleForm({
          admin: req.admin,
          csrfToken: req.csrfToken,
          article,
          categories,
          uploads: recentUploads,
          values: {
            status: article.status,
            tags: tags.map(tag => tag.name).join(", ")
          },
          sources: sources.map(row => ({
            name: row.source_name,
            url: row.source_url,
            license: row.license || "",
            attribution: row.attribution_text || ""
          })),
          researchRefs: research.map(row => ({
            source_key: row.source_key,
            source_name: row.source_name,
            source_url: row.source_url,
            license: row.license,
            reference_text: row.reference_text
          })),
          similarity,
          notice: ""
        })
      );
    } catch (error) {
      return next(error);
    }
  });

  pages.post("/articles/:id", security.requireCsrf, security.requireAdminPage, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const existing = await articleService.getArticleForAdmin(id);
      if (!existing) return notFoundPage(req, res);

      if (isPreviewIntent(req.body)) {
        req.article = existing;
        return handleUnsavedPreview(req, res, next);
      }

      const result = await validateSubmission(req.body);
      if (!result.ok) return renderFormWithError(req, res, { article: existing, errors: result.errors });

      const editorial = readEditorial(req.body);
      if (!editorial.ok) return renderFormWithError(req, res, { article: existing });

      const warning = pendingSimilarityWarning(req.body, editorial.research);
      if (warning) {
        return renderFormWithError(req, res, {
          article: existing,
          similarity: warning,
          notice: "Nothing was saved yet. Review the copy-similarity warning below, then publish again."
        });
      }

      const article = await articleService.updateArticle(id, result.values);
      await articleSources.saveEditorialRefs(id, {
        sources: editorial.sources,
        research: editorial.research
      });
      const tags = parseTags(req.body);
      if (tags) await tagService.setArticleTags(id, tags);

      const updatedNotice =
        result.values.status === STATUS_PUBLISHED
          ? `“${article.title}” was updated and is published.`
          : result.values.status === STATUS_SCHEDULED
            ? `“${article.title}” was updated and scheduled.`
            : result.values.status === STATUS_ARCHIVED
              ? `“${article.title}” was updated and archived.`
              : `“${article.title}” was updated and is now a draft.`;

      return res.redirect(303, `/admin/articles?notice=${encodeURIComponent(updatedNotice)}`);
    } catch (error) {
      return next(error);
    }
  });

  /* ---- preview a saved article --------------------------------------- */

  pages.get("/articles/:id/preview", security.requireAdminPage, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const article = await articleService.getArticleForAdmin(id);
      if (!article) return notFoundPage(req, res);

      return res.type("html").send(
        articleViews.renderPreview({
          admin: req.admin,
          csrfToken: req.csrfToken,
          article,
          values: {
            title: article.title,
            cover_image: article.cover_image,
            banner_alt: article.banner_alt,
            meta_description: article.meta_description,
            category_name: article.category_name
          }
        })
      );
    } catch (error) {
      return next(error);
    }
  });

  /* ---- publish / unpublish ------------------------------------------- */

  pages.post("/articles/:id/status", security.requireCsrf, security.requireAdminPage, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const status = String(readField(req.body, "status") ?? "").trim().toLowerCase();
      const article = await articleService.setStatus(id, status);

      if (!article) {
        return res
          .status(400)
          .type("html")
          .send(renderNotFoundPage({ csrfToken: req.csrfToken, message: "That status is not available." }));
      }

      return res.redirect(
        303,
        `/admin/articles?notice=${encodeURIComponent(
          article.status === STATUS_PUBLISHED
            ? `“${article.title}” is published.`
            : `“${article.title}” was unpublished. It is off the site and out of the sitemap.`
        )}`
      );
    } catch (error) {
      return next(error);
    }
  });

  /* ---- delete -------------------------------------------------------- */

  pages.get("/articles/:id/delete", security.requireAdminPage, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const article = await articleService.getArticleForAdmin(id);
      if (!article) return notFoundPage(req, res);

      return res.type("html").send(
        articleViews.renderDeleteConfirm({ admin: req.admin, csrfToken: req.csrfToken, article })
      );
    } catch (error) {
      return next(error);
    }
  });

  pages.post("/articles/:id/delete", security.requireCsrf, security.requireAdminPage, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const removed = await articleService.deleteArticle(id);
      if (!removed) return notFoundPage(req, res);

      // A banner uploaded through this CMS is only removed from disk once no
      // other article still points at it; a seeded /assets/topics cover is left
      // alone because other rows may share it.
      if (uploads.isManagedUpload(removed.cover_image)) {
        if ((await articleService.countReferences(removed.cover_image)) === 0) {
          await uploads.deleteManagedUpload(removed.cover_image);
        }
      }

      return res.redirect(303, "/admin/articles?notice=Article%20deleted.");
    } catch (error) {
      return next(error);
    }
  });

  return pages;
}

/* Registered after registerPages so it can be used by both page routers. */
function notFoundPage(req, res) {
  return res.status(404).type("html").send(renderNotFoundPage({ csrfToken: req.csrfToken }));
}

/* ==================================================================== */
/* JSON API                                                             */
/* ==================================================================== */

function registerApi(api) {
  const guard = [security.attachAdmin, security.requireAdmin];

  api.get("/categories", ...guard, async (req, res, next) => {
    try {
      res.json({ categories: await articleService.listCategories() });
    } catch (error) {
      next(error);
    }
  });

  api.get("/articles", ...guard, async (req, res, next) => {
    try {
      const filters = parseListQuery(req.query);
      const result = await articleService.listArticles(filters);

      res.json({
        articles: result.rows.map(articleJson),
        pagination: {
          page: result.page,
          per_page: result.perPage,
          total: result.total,
          pages: result.pages
        },
        counts: result.counts
      });
    } catch (error) {
      next(error);
    }
  });

  api.get("/articles/:id", ...guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFound(res);

      const article = await articleService.getArticleForAdmin(id);
      if (!article) return notFound(res);

      return res.json({ article: articleJson(article) });
    } catch (error) {
      return next(error);
    }
  });

  api.post("/articles", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const result = await validateSubmission(req.body);
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const editorial = readEditorial(req.body);
      if (!editorial.ok) return res.status(422).json({ error: "Validation failed", errors: editorial.errors });

      const warning = pendingSimilarityWarning(req.body, editorial.research);
      if (warning) return similarityRequired(res, warning);

      const article = await articleService.createArticle(result.values);
      await articleSources.saveEditorialRefs(article.id, {
        sources: editorial.sources,
        research: editorial.research
      });
      const tags = parseTags(req.body);
      if (tags) article.tags = await tagService.setArticleTags(article.id, tags);

      return res.status(201).json({ article: articleJson(article) });
    } catch (error) {
      return next(error);
    }
  });

  const update = async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFound(res);

      const result = await validateSubmission(req.body);
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const editorial = readEditorial(req.body);
      if (!editorial.ok) return res.status(422).json({ error: "Validation failed", errors: editorial.errors });

      const warning = pendingSimilarityWarning(req.body, editorial.research);
      if (warning) return similarityRequired(res, warning);

      const article = await articleService.updateArticle(id, result.values);
      if (!article) return notFound(res);

      await articleSources.saveEditorialRefs(id, {
        sources: editorial.sources,
        research: editorial.research
      });
      const tags = parseTags(req.body);
      if (tags) article.tags = await tagService.setArticleTags(id, tags);

      return res.json({ article: articleJson(article) });
    } catch (error) {
      return next(error);
    }
  };

  api.put("/articles/:id", ...guard, security.requireCsrf, update);
  api.patch("/articles/:id", ...guard, security.requireCsrf, update);

  api.post("/articles/:id/status", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFound(res);

      const status = String(readField(req.body, "status") ?? "").trim().toLowerCase();
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(", ")}.` });
      }

      const article = await articleService.setStatus(id, status);
      if (!article) return notFound(res);

      return res.json({ article: articleJson(article) });
    } catch (error) {
      return next(error);
    }
  });

  api.delete("/articles/:id", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFound(res);

      const removed = await articleService.deleteArticle(id);
      if (!removed) return notFound(res);

      if (uploads.isManagedUpload(removed.cover_image)) {
        if ((await articleService.countReferences(removed.cover_image)) === 0) {
          await uploads.deleteManagedUpload(removed.cover_image);
        }
      }

      return res.json({ deleted: true, id: removed.id, slug: removed.slug });
    } catch (error) {
      return next(error);
    }
  });

  /* ---- uploads ------------------------------------------------------- */

  api.get("/uploads", ...guard, async (req, res, next) => {
    try {
      res.json({ uploads: await uploads.listUploads() });
    } catch (error) {
      next(error);
    }
  });

  api.post("/uploads", ...guard, security.requireCsrf, uploadBodyParser, async (req, res, next) => {
    try {
      const declaredName = String(req.query.name || req.get("x-file-name") || "");

      let fileName = "";
      try {
        fileName = decodeURIComponent(declaredName);
      } catch {
        // A malformed header only costs us the name in an error message.
        fileName = "";
      }

      const stored = await uploads.storeBannerImage(req.body, {
        declaredType: req.get("content-type"),
        declaredName: fileName
      });

      return res.status(201).json({
        upload: {
          path: stored.path,
          file_name: stored.fileName,
          bytes: stored.bytes,
          type: stored.type
        }
      });
    } catch (error) {
      if (["EMPTY_FILE", "FILE_TOO_LARGE", "UNSUPPORTED_IMAGE_TYPE"].includes(error.code)) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      return next(error);
    }
  });

  return api;
}

module.exports = { articleFormParser, registerApi, registerPages, uploadBodyParser };