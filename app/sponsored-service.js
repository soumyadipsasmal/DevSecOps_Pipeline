"use strict";

/**
 * KaliNova — sponsored campaigns
 *
 * One campaign per article (the schema enforces it with a unique key on
 * article_id). A campaign only appears to readers when it is in the 'active'
 * status; everything else is an editor's working state that the public article
 * endpoint simply does not return. The upsert below replaces the campaign on
 * assignment, so two editors never race into two rows for the same story.
 */

const pool = require("./db");
const monetization = require("./monetization-service");

const { asString, normalizeHttpUrl, parsePositiveInt } = monetization;

function toCampaign(row) {
  return {
    article_id: row.article_id,
    article_title: row.title || null,
    article_slug: row.slug || null,
    sponsor_name: row.sponsor_name,
    sponsor_url: row.sponsor_url,
    label: row.label,
    disclosure: row.disclosure,
    start_at: row.start_at,
    end_at: row.end_at,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function listCampaigns({ status = "" } = {}) {
  const params = [];
  let where = "";
  if (monetization.SPONSORED_STATUSES.includes(status)) {
    params.push(status);
    where = ` WHERE sc.status = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT sc.article_id, sc.sponsor_name, sc.sponsor_url, sc.label, sc.disclosure,
            sc.start_at, sc.end_at, sc.status, sc.created_at, sc.updated_at,
            a.title, a.slug
       FROM sponsored_campaigns sc
       LEFT JOIN articles a ON a.id = sc.article_id
       ${where}
      ORDER BY sc.updated_at DESC, sc.article_id DESC`,
    params
  );

  return rows.map(toCampaign);
}

async function getCampaignByArticle(articleId) {
  const parsed = parsePositiveInt(articleId);
  if (!parsed) return null;

  const { rows } = await pool.query(
    `SELECT sc.article_id, sc.sponsor_name, sc.sponsor_url, sc.label, sc.disclosure,
            sc.start_at, sc.end_at, sc.status, sc.created_at, sc.updated_at,
            a.title, a.slug
       FROM sponsored_campaigns sc
       LEFT JOIN articles a ON a.id = sc.article_id
      WHERE sc.article_id = $1
      LIMIT 1`,
    [parsed]
  );

  return rows[0] ? toCampaign(rows[0]) : null;
}

function parseOptionalDate(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const date = new Date(String(value).trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Validate a campaign submission. article_id must reference a real article — the
 * service checks that before writing so the caller gets a clean error message
 * rather than a foreign-key exception.
 */
function validateCampaign(input = {}) {
  const body = input && typeof input === "object" ? input : {};
  const errors = {};
  const values = {};

  const articleId = parsePositiveInt(body.article_id ?? body.articleId);
  values.article_id = articleId;
  if (!articleId) errors.article_id = "Select the article this campaign belongs to.";

  const sponsorName = asString(body.sponsor_name, 160);
  if (sponsorName === "") errors.sponsor_name = "Give the sponsor a name.";
  values.sponsor_name = sponsorName;

  values.sponsor_url = normalizeHttpUrl(body.sponsor_url);

  const label = asString(body.label, 20);
  values.label = monetization.SPONSORED_LABELS.includes(label) ? label : "Sponsored";
  if (!monetization.SPONSORED_LABELS.includes(label)) {
    errors.label = "Label must be Sponsored or Advertisement.";
  }

  values.disclosure = asString(body.disclosure, 4000);

  const status = asString(body.status, 20).toLowerCase() || "draft";
  values.status = monetization.SPONSORED_STATUSES.includes(status) ? status : "draft";
  if (!monetization.SPONSORED_STATUSES.includes(status)) {
    errors.status = `Status must be one of: ${monetization.SPONSORED_STATUSES.join(", ")}.`;
  }

  const startAt = parseOptionalDate(body.start_at ?? body.startAt);
  const endAt = parseOptionalDate(body.end_at ?? body.endAt);
  if (startAt && endAt && new Date(endAt) < new Date(startAt)) {
    errors.end_at = "End date cannot be earlier than the start date.";
  }
  values.start_at = startAt;
  values.end_at = endAt;

  return Object.keys(errors).length ? { ok: false, errors, values } : { ok: true, values };
}

/**
 * Create or replace the campaign for an article. Returns { ok:false } with a
 * clean error when the article does not exist.
 */
async function upsertCampaign(values) {
  const parsed = parsePositiveInt(values.article_id);
  if (!parsed) return { ok: false, error: "Select a real article." };

  const article = await pool.query("SELECT 1 FROM articles WHERE id = $1 LIMIT 1", [parsed]);
  if (article.rows.length === 0) return { ok: false, error: "That article does not exist." };

  const { rows } = await pool.query(
    `INSERT INTO sponsored_campaigns
       (article_id, sponsor_name, sponsor_url, label, disclosure, start_at, end_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (article_id) DO UPDATE
       SET sponsor_name = EXCLUDED.sponsor_name,
           sponsor_url = EXCLUDED.sponsor_url,
           label = EXCLUDED.label,
           disclosure = EXCLUDED.disclosure,
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at,
           status = EXCLUDED.status
     RETURNING article_id`,
    [
      parsed,
      values.sponsor_name,
      values.sponsor_url,
      values.label,
      values.disclosure,
      values.start_at,
      values.end_at,
      values.status
    ]
  );

  return { ok: true, campaign: await getCampaignByArticle(rows[0].article_id) };
}

async function deleteCampaign(articleId) {
  const parsed = parsePositiveInt(articleId);
  if (!parsed) return null;

  const { rows } = await pool.query(
    "DELETE FROM sponsored_campaigns WHERE article_id = $1 RETURNING article_id",
    [parsed]
  );
  return rows.length === 1 ? rows[0].article_id : null;
}

/**
 * The public projection: only an 'active' campaign is ever shown, and only the
 * fields a reader needs. Dates do not gate the badge here — the admin decides
 * when to activate a campaign and when to end it.
 */
async function getPublicCampaign(articleId) {
  const parsed = parsePositiveInt(articleId);
  if (!parsed) return null;

  const { rows } = await pool.query(
    `SELECT sponsor_name, sponsor_url, label, disclosure
       FROM sponsored_campaigns
      WHERE article_id = $1 AND status = 'active'
      LIMIT 1`,
    [parsed]
  );

  if (rows.length === 0) return null;
  return {
    label: rows[0].label,
    sponsor_name: rows[0].sponsor_name,
    sponsor_url: rows[0].sponsor_url || null,
    disclosure: rows[0].disclosure || ""
  };
}

module.exports = {
  deleteCampaign,
  getCampaignByArticle,
  getPublicCampaign,
  listCampaigns,
  upsertCampaign,
  validateCampaign
};