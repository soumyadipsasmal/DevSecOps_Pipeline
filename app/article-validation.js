"use strict";

/**
 * KaliNova — article input validation
 *
 * Every rule here is enforced on the server. The admin form mirrors these rules
 * for immediate feedback, but the browser is never the authority: the same
 * checks run for both the HTML form posts and the JSON admin API.
 *
 * Field names follow the existing articles table (title, slug, content,
 * cover_image, category_id, status, published_at), with meta_description and
 * banner_alt added by database/schema-article-cms.sql.
 */

const { sanitizeBody, stripTags, MAX_INPUT_LENGTH } = require("./article-html");

const TITLE_MAX = 200;
const SLUG_MAX = 180;
const META_DESCRIPTION_MAX = 160;
const META_DESCRIPTION_MIN = 50;
const BANNER_ALT_MAX = 200;
const BODY_MIN_PUBLISHED = 40;

const STATUS_DRAFT = "draft";
const STATUS_PUBLISHED = "published";
const STATUSES = [STATUS_DRAFT, STATUS_PUBLISHED];

/*
 * Advertising opt-out for one article. The site-wide AdSense unit is public
 * layout unless an article opts out; the three choices are "follow the
 * category default", "show ads" and "no ads". NULL (the default) defers to the
 * category's default flag.
 */
const ADS_ENABLED_CHOICE_DEFAULT = "default";
const ADS_ENABLED_CHOICE_YES = "1";
const ADS_ENABLED_CHOICE_NO = "0";
const ADS_ENABLED_CHOICES = [
  ADS_ENABLED_CHOICE_DEFAULT,
  ADS_ENABLED_CHOICE_YES,
  ADS_ENABLED_CHOICE_NO
];

/** @returns {{ ok: boolean, choice?: string, enabled?: boolean|null, error?: string }} */
function validateAdsEnabled(value) {
  const raw = value === null || value === undefined ? ADS_ENABLED_CHOICE_DEFAULT : String(value).trim();
  if (!ADS_ENABLED_CHOICES.includes(raw)) {
    return { ok: false, error: "Ads choice must be default, 1 or 0." };
  }
  if (raw === ADS_ENABLED_CHOICE_YES) return { ok: true, choice: raw, enabled: true };
  if (raw === ADS_ENABLED_CHOICE_NO) return { ok: true, choice: raw, enabled: false };
  return { ok: true, choice: raw, enabled: null };
}

/* A row that arrived with some other status — nothing in the seed data does, but
 * the column allows it — is still displayed and editable. The CMS only ever
 * writes draft or published, which is what articles_status_check (added by
 * database/schema-article-cms.sql) enforces on new and updated rows. */

/** Cover images may be a local upload, one of the bundled topic photos, or an
 * absolute https URL (the seeded editorial rows use Unsplash). */
const UPLOAD_PATH_PATTERN = /^\/assets\/uploads\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|avif)$/i;
const TOPIC_PATH_PATTERN = /^\/assets\/topics\/[a-z0-9-]+\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|avif)$/i;
const REMOTE_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+\/[^\s"'<>]*$/i;

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Turn a title into a URL-safe slug.
 * "Top 10 Bollywood Movies to Watch in 2026" -> "top-10-bollywood-movies-to-watch-in-2026"
 */
function slugify(value) {
  return asString(value)
    .normalize("NFKD")
    // Drop combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['"‘’“”]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

/** Normalise an administrator-supplied slug; returns "" when nothing is usable. */
function normalizeSlug(value) {
  const slug = slugify(value);
  return slug;
}

/**
 * Validate the status field.
 * @returns {{ ok: boolean, status?: string, error?: string }}
 */
function validateStatus(value) {
  if (isBlank(value)) return { ok: true, status: STATUS_DRAFT };

  const status = asString(value).trim().toLowerCase();
  if (STATUSES.includes(status)) return { ok: true, status };

  return { ok: false, error: "Status must be draft or published." };
}

/** Accept only image references the site can actually serve. */
function validateCoverImage(value) {
  if (isBlank(value)) return { ok: true, coverImage: null };

  const raw = asString(value).trim();
  if (raw.length > 1000) return { ok: false, error: "Banner image reference is too long." };

  if (UPLOAD_PATH_PATTERN.test(raw)) return { ok: true, coverImage: raw };
  if (TOPIC_PATH_PATTERN.test(raw)) return { ok: true, coverImage: raw };
  if (REMOTE_URL_PATTERN.test(raw)) return { ok: true, coverImage: raw };

  return {
    ok: false,
    error: "Banner image must be a JPEG, PNG, WebP or AVIF image."
  };
}

/**
 * Validate one article submission.
 *
 * @param {object} input raw request body
 * @param {{ isDraft?: boolean }} [options] draft rules are relaxed: the body and
 *   meta description may be left empty, but nothing that is present may be invalid.
 *   When `isDraft` is not given it is derived from the submitted status, so a
 *   caller cannot accidentally validate as a draft without asking for one.
 * @returns {{ ok: boolean, values?: object, errors?: Record<string, string> }}
 */
function validateArticle(input, options = {}) {
  const body = input && typeof input === "object" ? input : {};
  const errors = {};

  const statusField = validateStatus(body.status);
  const resolvedStatus = statusField.ok ? statusField.status : STATUS_DRAFT;
  // Draft rules are derived from the status unless a caller states otherwise.
  // The route handlers pass isDraft explicitly from the resolved status, so
  // this is the single place the rule is decided.
  const isDraft =
    options.isDraft === undefined ? resolvedStatus !== STATUS_PUBLISHED : Boolean(options.isDraft);

  /* ---- title -------------------------------------------------------- */
  const title = asString(body.title).trim().replace(/\s+/g, " ");
  if (title === "") {
    errors.title = "Title is required";
  } else if (title.length > TITLE_MAX) {
    errors.title = `Title must be ${TITLE_MAX} characters or fewer`;
  }

  /* ---- slug --------------------------------------------------------- */
  // An empty slug is generated from the title; a supplied slug is normalised.
  const requestedSlug = asString(body.slug).trim();
  const slug = requestedSlug === "" ? slugify(title) : normalizeSlug(requestedSlug);
  if (title !== "" && slug === "") {
    errors.slug = "Slug must contain at least one letter or number";
  }

  /* ---- category ----------------------------------------------------- */
  const rawCategory = body.category_id ?? body.categoryId;
  const categoryId = rawCategory === "" || rawCategory === null || rawCategory === undefined
    ? null
    : Number.parseInt(String(rawCategory), 10);
  if (categoryId === null || !Number.isInteger(categoryId) || categoryId <= 0) {
    errors.category_id = "Select a category";
  }

  /* ---- meta description --------------------------------------------- */
  const metaDescription = asString(body.meta_description ?? body.metaDescription)
    .trim()
    .replace(/\s+/g, " ");
  if (metaDescription === "") {
    if (!isDraft) errors.meta_description = "Meta description is required";
  } else if (metaDescription.length > META_DESCRIPTION_MAX) {
    // Never truncated silently: the author decides what to cut.
    errors.meta_description = `Meta description must be ${META_DESCRIPTION_MAX} characters or fewer`;
  }

  /* ---- body ---------------------------------------------------------- */
  const rawBody = asString(body.content ?? body.body_html ?? body.bodyHtml ?? body.body);
  if (rawBody.length > MAX_INPUT_LENGTH) {
    errors.content = `Article body is too large. The limit is ${Math.floor(MAX_INPUT_LENGTH / 1024)} KB`;
  }

  let bodyHtml = "";
  if (rawBody.length <= MAX_INPUT_LENGTH) {
    const sanitised = sanitizeBody(rawBody);
    bodyHtml = sanitised.html;
    const textLength = stripTags(sanitised.html).length;
    if (textLength === 0) {
      if (!isDraft) errors.content = "Article body is required";
    } else if (!isDraft && textLength < BODY_MIN_PUBLISHED) {
      errors.content = `Article body must be at least ${BODY_MIN_PUBLISHED} characters to publish`;
    }
  }

  /* ---- banner -------------------------------------------------------- */
  const cover = validateCoverImage(body.cover_image ?? body.coverImage ?? body.banner_image);
  if (!cover.ok) errors.cover_image = cover.error;

  const rawAlt = asString(body.banner_alt ?? body.bannerAlt ?? body.coverAlt).trim();
  if (cover.ok && cover.coverImage) {
    // Alt text is required whenever an image will be shown. Rows seeded before
    // this column existed have no alt, so an edit that keeps an existing banner
    // must not be blocked until the author fills it in.
    if (rawAlt === "") {
      errors.banner_alt = "Banner alt text is required when a banner image is set";
    } else if (rawAlt.length > BANNER_ALT_MAX) {
      errors.banner_alt = `Banner alt text must be ${BANNER_ALT_MAX} characters or fewer`;
    }
  } else if (rawAlt.length > BANNER_ALT_MAX) {
    errors.banner_alt = `Banner alt text must be ${BANNER_ALT_MAX} characters or fewer`;
  }

  /* ---- status --------------------------------------------------------- */
  const status = statusField;
  if (!status.ok) errors.status = status.error;

  /* ---- advertising opt-out -------------------------------------------- */
  const ads = validateAdsEnabled(body.ads_enabled ?? body.adsEnabled);
  if (!ads.ok) errors.ads_enabled = ads.error;

  const failed = Object.keys(errors).length > 0;
  if (failed) return { ok: false, errors };

  return {
    ok: true,
    values: {
      title,
      slug,
      categoryId,
      metaDescription: metaDescription || null,
      bodyHtml,
      bodyFormat: /<[a-z][^>]*>/i.test(bodyHtml) ? "html" : "text",
      coverImage: cover.coverImage,
      bannerAlt: cover.coverImage ? rawAlt : null,
      status: status.status || STATUS_DRAFT,
      adsEnabled: ads.enabled,
      adsEnabledChoice: ads.choice
    }
  };
}

/**
 * Find a slug that no other article is using.
 *
 * The unique index on articles.slug is the real guarantee; this only produces a
 * friendly value before the insert so the author is not shown a database error.
 *
 * @param {string} candidate
 * @param {(slug: string) => Promise<boolean>} isTaken
 * @param {number} [excludeId] ignore this article (used when editing)
 */
async function ensureUniqueSlug(candidate, isTaken, excludeId = null) {
  const base = candidate || "article";
  const limit = base.slice(0, SLUG_MAX);

  if (!(await isTaken(limit, excludeId))) return limit;

  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const candidateSlug = `${limit.slice(0, SLUG_MAX - String(suffix).length - 1)}-${suffix}`;
    if (!(await isTaken(candidateSlug, excludeId))) return candidateSlug;
  }

  // Extremely unlikely; a short random suffix still keeps the URL unique.
  const fallback = `${limit.slice(0, SLUG_MAX - 9)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await isTaken(fallback, excludeId))) return fallback;

  const error = new Error("Could not generate a unique slug. Edit the slug manually.");
  error.code = "SLUG_EXHAUSTED";
  throw error;
}

module.exports = {
  ADS_ENABLED_CHOICES,
  BANNER_ALT_MAX,
  BODY_MIN_PUBLISHED,
  META_DESCRIPTION_MAX,
  META_DESCRIPTION_MIN,
  REMOTE_URL_PATTERN,
  SLUG_MAX,
  STATUSES,
  STATUS_DRAFT,
  STATUS_PUBLISHED,
  TITLE_MAX,
  TOPIC_PATH_PATTERN,
  UPLOAD_PATH_PATTERN,
  ensureUniqueSlug,
  normalizeSlug,
  slugify,
  validateAdsEnabled,
  validateArticle,
  validateCoverImage,
  validateStatus
};