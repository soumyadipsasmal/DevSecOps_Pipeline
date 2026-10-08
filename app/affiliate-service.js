"use strict";

/**
 * KaliNova — affiliate links
 *
 * An affiliate link is a centrally managed destination an editor attaches to an
 * article (or a category), served to readers as /go/<slug>. The destination is
 * always an absolute http(s) URL validated here and double-checked by a
 * database CHECK. The click log lives in affiliate_clicks and stores only the
 * anonymised fields produced by monetization-service (see its methods for the
 * privacy rules).
 *
 * A paused link answers 410 Gone from the redirect handler instead of silently
 * dropping a reader onto an address the site no longer vouches for.
 */

const pool = require("./db");
const monetization = require("./monetization-service");

const { asString, normalizeBool, normalizeHttpUrl, parsePositiveInt, slugify } = monetization;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function toLink(row) {
  return {
    id: row.id,
    name: row.name,
    network: row.network,
    destination_url: row.destination_url,
    tracking_url: row.tracking_url,
    disclosure_text: row.disclosure_text,
    slug: row.slug,
    article_id: row.article_id,
    category_id: row.category_id,
    status: row.status,
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
    click_count: Number(row.click_count || 0)
  };
}

async function listLinks({ status = "" } = {}) {
  const params = [];
  let where = "";
  if (monetization.AFFILIATE_STATUSES.includes(status)) {
    params.push(status);
    where = ` WHERE al.status = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT al.id, al.name, al.network, al.destination_url, al.tracking_url,
            al.disclosure_text, al.slug, al.article_id, al.category_id,
            al.status, al.position, al.created_at, al.updated_at,
            COUNT(ac.id)::int AS click_count,
            a.title AS article_title, c.name AS category_name
       FROM affiliate_links al
       LEFT JOIN affiliate_clicks ac ON ac.affiliate_id = al.id
       LEFT JOIN articles a ON a.id = al.article_id
       LEFT JOIN categories c ON c.id = al.category_id
       ${where}
      GROUP BY al.id, a.title, c.name
      ORDER BY al.position ASC, al.name ASC`,
    params
  );

  return rows.map(toLink);
}

async function getLink(id) {
  const parsed = parsePositiveInt(id);
  if (!parsed) return null;

  const { rows } = await pool.query(
    `SELECT al.id, al.name, al.network, al.destination_url, al.tracking_url,
            al.disclosure_text, al.slug, al.article_id, al.category_id,
            al.status, al.position, al.created_at, al.updated_at,
            COUNT(ac.id)::int AS click_count,
            a.title AS article_title, c.name AS category_name
       FROM affiliate_links al
       LEFT JOIN affiliate_clicks ac ON ac.affiliate_id = al.id
       LEFT JOIN articles a ON a.id = al.article_id
       LEFT JOIN categories c ON c.id = al.category_id
      WHERE al.id = $1
      GROUP BY al.id, a.title, c.name
      LIMIT 1`,
    [parsed]
  );

  return rows[0] ? toLink(rows[0]) : null;
}

async function getLinkBySlug(slug) {
  const clean = asString(slug, 80);
  if (!SLUG_PATTERN.test(clean)) return null;

  const { rows } = await pool.query(
    `SELECT id, name, network, destination_url, tracking_url, disclosure_text,
            slug, article_id, category_id, status, position, created_at, updated_at
       FROM affiliate_links
      WHERE slug = $1
      LIMIT 1`,
    [clean]
  );

  return rows[0];
}

/** Pick the tracking URL when the caller configured one; the destination otherwise. */
function redirectTarget(link) {
  return link.tracking_url && link.tracking_url !== "" ? link.tracking_url : link.destination_url;
}

/**
 * Validate one affiliate link submission. Mirrors the schema CHECK constraints so
 * an invalid value is a form error, not a database exception.
 */
function validateLink(input = {}, { isNew = false } = {}) {
  const body = input && typeof input === "object" ? input : {};
  const errors = {};
  const values = {};

  const name = asString(body.name, monetization.MAX_NAME_LENGTH);
  if (name === "") errors.name = "Give the link a name.";
  values.name = name;

  values.network = asString(body.network, 80);

  const destination = normalizeHttpUrl(body.destination_url);
  if (destination === "") errors.destination_url = "Use an absolute http:// or https:// URL.";
  values.destination_url = destination;

  // Optional; only kept when well formed, so a stray relative link is dropped.
  values.tracking_url = normalizeHttpUrl(body.tracking_url);

  values.disclosure_text = asString(body.disclosure_text, 4000);

  const requestedSlug = asString(body.slug, 80);
  if (isNew && requestedSlug === "") {
    values.slug = slugify(name);
  } else if (requestedSlug === "") {
    // Editing still needs a slug; fall back to the (unchanging) name.
    values.slug = slugify(name);
  } else {
    values.slug = requestedSlug.toLowerCase();
  }
  if (!SLUG_PATTERN.test(values.slug || "") || (values.slug || "") === "") {
    errors.slug = "Slug must use lowercase letters, numbers and hyphens.";
    values.slug = values.slug || slugify(name);
  }

  const articleId = parsePositiveInt(body.article_id ?? body.articleId);
  const categoryId = parsePositiveInt(body.category_id ?? body.categoryId);
  // Either attachment is fine; both may be empty (site-wide link).
  values.article_id = articleId;
  values.category_id = categoryId;

  const status = asString(body.status, 20).toLowerCase() || "active";
  values.status = monetization.AFFILIATE_STATUSES.includes(status) ? status : "active";
  if (!monetization.AFFILIATE_STATUSES.includes(status)) {
    errors.status = `Status must be one of: ${monetization.AFFILIATE_STATUSES.join(", ")}.`;
  }

  values.position = Number.isInteger(body.position)
    ? body.position
    : Number.parseInt(String(body.position ?? "0"), 10) || 0;
  values.position = Math.max(0, Math.min(values.position, 32767));

  return Object.keys(errors).length ? { ok: false, errors, values } : { ok: true, values };
}

async function slugAvailable(slug, excludeId = null) {
  const params = [slug];
  let extra = "";
  if (excludeId) {
    params.push(excludeId);
    extra = ` AND id <> $${params.length}`;
  }
  const { rows } = await pool.query(`SELECT 1 FROM affiliate_links WHERE slug = $1${extra} LIMIT 1`, params);
  return rows.length === 0;
}

async function createLink(values) {
  const slug = await uniqueSlug(values.slug);

  const { rows } = await pool.query(
    `INSERT INTO affiliate_links
       (name, network, destination_url, tracking_url, disclosure_text, slug,
        article_id, category_id, status, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      values.name,
      values.network,
      values.destination_url,
      values.tracking_url,
      values.disclosure_text,
      slug,
      values.article_id,
      values.category_id,
      values.status,
      values.position
    ]
  );

  return getLink(rows[0].id);
}

async function updateLink(id, values) {
  const parsed = parsePositiveInt(id);
  if (!parsed) return null;

  const existing = await pool.query("SELECT 1 FROM affiliate_links WHERE id = $1 LIMIT 1", [parsed]);
  if (existing.rows.length === 0) return null;

  const slug = await uniqueSlug(values.slug, parsed);

  await pool.query(
    `UPDATE affiliate_links
        SET name = $2, network = $3, destination_url = $4, tracking_url = $5,
            disclosure_text = $6, slug = $7, article_id = $8, category_id = $9,
            status = $10, position = $11
      WHERE id = $1`,
    [
      parsed,
      values.name,
      values.network,
      values.destination_url,
      values.tracking_url,
      values.disclosure_text,
      slug,
      values.article_id,
      values.category_id,
      values.status,
      values.position
    ]
  );

  return getLink(parsed);
}

async function deleteLink(id) {
  const parsed = parsePositiveInt(id);
  if (!parsed) return null;

  const { rows } = await pool.query(
    "DELETE FROM affiliate_links WHERE id = $1 RETURNING id, name, slug",
    [parsed]
  );
  return rows.length === 1 ? rows[0] : null;
}

async function uniqueSlug(candidate, excludeId = null) {
  const base = candidate || "link";
  if (await slugAvailable(base, excludeId)) return base;

  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const candidateSlug = `${base.slice(0, 80 - String(suffix).length - 1)}-${suffix}`;
    if (await slugAvailable(candidateSlug, excludeId)) return candidateSlug;
  }
  // Practically unreachable: a suffix up to 50 on a busy table.
  const fallback = `link-${Math.random().toString(36).slice(2, 8)}`;
  return (await slugAvailable(fallback, excludeId)) ? fallback : base;
}

/**
 * Record one click in the same transaction as nothing else: the event table
 * insert. The overview counts come from affiliate_clicks, and getLink carries a
 * join count, so no denormalised counter is maintained here.
 */
async function recordClick({ linkId, articleId = null, meta }) {
  const parsed = parsePositiveInt(linkId);
  if (!parsed) return null;

  const { rows } = await pool.query(
    `INSERT INTO affiliate_clicks (affiliate_id, article_id, referrer, device, ip_hash, ua_snippet)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      parsed,
      parsePositiveInt(articleId),
      meta.referrer || "",
      meta.device || "",
      meta.ip_hash || "",
      meta.ua_snippet || ""
    ]
  );
  return rows[0] ? rows[0].id : null;
}

/** Public: usable affiliate links for an article, as the reader should see them. */
async function linksForArticle(articleId, categoryId) {
  const params = [];
  const clauses = [];
  if (parsePositiveInt(articleId)) clauses.push("al.article_id = $" + params.push(articleId));
  if (parsePositiveInt(categoryId)) clauses.push("al.category_id = $" + params.push(categoryId));
  // A link attached to neither an article nor a category is site-wide and is
  // eligible everywhere.
  clauses.push("(al.article_id IS NULL AND al.category_id IS NULL)");

  const where = `al.status = 'active' AND (${clauses.join(" OR ")})`;

  const { rows } = await pool.query(
    `SELECT id, name, network, disclosure_text, slug, destination_url
       FROM affiliate_links al
      WHERE ${where}
      ORDER BY al.position ASC, al.name ASC`,
    params
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    network: row.network,
    disclosure_text: row.disclosure_text,
    slug: row.slug,
    // The redirect target is chosen by the server at click time; the public
    // list never leaks a tracking URL or a raw destination.
    url: `/go/${row.slug}`
  }));
}

module.exports = {
  SLUG_PATTERN,
  createLink,
  deleteLink,
  getLink,
  getLinkBySlug,
  linksForArticle,
  listLinks,
  recordClick,
  redirectTarget,
  updateLink,
  validateLink
};