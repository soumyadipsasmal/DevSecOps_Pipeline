"use strict";

/**
 * KaliNova — direct ad campaigns
 *
 * Banner campaigns sold directly to advertisers. Unlike ad_placements (which
 * carry AdSense slot identifiers and are switched on one by one by an
 * administrator), a direct_ad is a campaign: artwork, destination, date window,
 * and a priority. The public renderer derives "servable" from the stored status
 * *and* the date window, so an 'active' campaign whose dates have not started
 * (or have lapsed) is not served.
 *
 * Impressions and clicks are recorded through recordEvent, which also maintains
 * the denormalised counters on the row inside the same transaction. Only
 * anonymised request metadata reaches the event table.
 */

const pool = require("./db");
const monetization = require("./monetization-service");

const { asString, normalizeHttpUrl, parsePositiveInt } = monetization;

const PLACEMENTS = monetization.DIRECT_ADS_PLACEMENTS;

function toAd(row) {
  return {
    id: row.id,
    name: row.name,
    advertiser_name: row.advertiser_name,
    image_url: row.image_url,
    image_alt: row.image_alt,
    destination_url: row.destination_url,
    placement: row.placement,
    start_date: row.start_date,
    end_date: row.end_date,
    status: row.status,
    priority: row.priority,
    campaign_notes: row.campaign_notes,
    impression_count: Number(row.impression_count || 0),
    click_count: Number(row.click_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function listAds({ status = "" } = {}) {
  const params = [];
  let where = "";
  if (monetization.DIRECT_ADS_STATUSES.includes(status)) {
    params.push(status);
    where = ` WHERE status = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT id, name, advertiser_name, image_url, image_alt, destination_url,
            placement, start_date, end_date, status, priority, campaign_notes,
            impression_count, click_count, created_at, updated_at
       FROM direct_ads
       ${where}
      ORDER BY
        CASE placement
          WHEN 'homepage_top' THEN 1 WHEN 'homepage_middle' THEN 2
          WHEN 'article_top' THEN 3 WHEN 'article_middle' THEN 4
          WHEN 'article_bottom' THEN 5 WHEN 'sidebar' THEN 6
          WHEN 'category_top' THEN 7 ELSE 8
        END, priority ASC, id DESC`,
    params
  );

  return rows.map(toAd);
}

async function getAd(id) {
  const parsed = parsePositiveInt(id);
  if (!parsed) return null;

  const { rows } = await pool.query(
    `SELECT id, name, advertiser_name, image_url, image_alt, destination_url,
            placement, start_date, end_date, status, priority, campaign_notes,
            impression_count, click_count, created_at, updated_at
       FROM direct_ads
      WHERE id = $1
      LIMIT 1`,
    [parsed]
  );

  return rows[0] ? toAd(rows[0]) : null;
}

/** Dates are stored as YYYY-MM-DD; blank is allowed (no window). */
function parseOptionalDate(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function validateAd(input = {}, { isNew = false } = {}) {
  const body = input && typeof input === "object" ? input : {};
  const errors = {};
  const values = {};

  const name = asString(body.name, monetization.MAX_NAME_LENGTH);
  if (name === "") errors.name = "Give the campaign a name.";
  values.name = name;

  values.advertiser_name = asString(body.advertiser_name, 120);

  const imageUrl = normalizeHttpUrl(body.image_url);
  if (imageUrl === "") errors.image_url = "Use an absolute http:// or https:// image URL.";
  values.image_url = imageUrl;

  values.image_alt = asString(body.image_alt, 300);

  const destination = normalizeHttpUrl(body.destination_url);
  if (destination === "") errors.destination_url = "Use an absolute http:// or https:// destination URL.";
  values.destination_url = destination;

  const placement = asString(body.placement, 40).toLowerCase();
  values.placement = PLACEMENTS.includes(placement) ? placement : "";
  if (!PLACEMENTS.includes(placement)) {
    errors.placement = `Placement must be one of: ${PLACEMENTS.join(", ")}.`;
  }

  const startDate = parseOptionalDate(body.start_date ?? body.startDate);
  const endDate = parseOptionalDate(body.end_date ?? body.endDate);
  if (startDate && endDate && endDate < startDate) {
    errors.end_date = "End date cannot be earlier than the start date.";
  }
  values.start_date = startDate;
  values.end_date = endDate;

  const status = asString(body.status, 20).toLowerCase() || "draft";
  values.status = monetization.DIRECT_ADS_STATUSES.includes(status) ? status : "draft";
  if (!monetization.DIRECT_ADS_STATUSES.includes(status)) {
    errors.status = `Status must be one of: ${monetization.DIRECT_ADS_STATUSES.join(", ")}.`;
  }

  let priority = Number.parseInt(String(body.priority ?? "100"), 10);
  if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
    errors.priority = "Priority must be a whole number between 1 and 1000.";
    priority = 100;
  }
  values.priority = priority;

  values.campaign_notes = asString(body.campaign_notes, 2000);

  return Object.keys(errors).length ? { ok: false, errors, values } : { ok: true, values };
}

async function createAd(values) {
  const { rows } = await pool.query(
    `INSERT INTO direct_ads
       (name, advertiser_name, image_url, image_alt, destination_url, placement,
        start_date, end_date, status, priority, campaign_notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      values.name,
      values.advertiser_name,
      values.image_url,
      values.image_alt,
      values.destination_url,
      values.placement,
      values.start_date,
      values.end_date,
      values.status,
      values.priority,
      values.campaign_notes
    ]
  );

  return getAd(rows[0].id);
}

async function updateAd(id, values) {
  const parsed = parsePositiveInt(id);
  if (!parsed) return null;

  const existing = await pool.query("SELECT 1 FROM direct_ads WHERE id = $1 LIMIT 1", [parsed]);
  if (existing.rows.length === 0) return null;

  await pool.query(
    `UPDATE direct_ads
        SET name = $2, advertiser_name = $3, image_url = $4, image_alt = $5,
            destination_url = $6, placement = $7, start_date = $8, end_date = $9,
            status = $10, priority = $11, campaign_notes = $12
      WHERE id = $1`,
    [
      parsed,
      values.name,
      values.advertiser_name,
      values.image_url,
      values.image_alt,
      values.destination_url,
      values.placement,
      values.start_date,
      values.end_date,
      values.status,
      values.priority,
      values.campaign_notes
    ]
  );

  return getAd(parsed);
}

async function deleteAd(id) {
  const parsed = parsePositiveInt(id);
  if (!parsed) return null;

  const { rows } = await pool.query(
    "DELETE FROM direct_ads WHERE id = $1 RETURNING id, name",
    [parsed]
  );
  return rows.length === 1 ? rows[0] : null;
}

/** The servable-window predicate, reused by the public list and event logging. */
function servableWhere(alias) {
  const t = alias || "";
  return `(
    ${t}status = 'active'
    AND (${t}start_date IS NULL OR ${t}start_date <= CURRENT_DATE)
    AND (${t}end_date IS NULL OR ${t}end_date >= CURRENT_DATE)
  )`;
}

/**
 * Public: the ads that may actually be rendered for a placement, best first.
 * Returns public-only fields; the artwork URL is served, the destination is
 * wrapped by /go only through the tracking endpoints, never echoed here.
 */
async function activeAdsForPlacement(placement) {
  const clean = asString(placement, 40).toLowerCase();
  if (!PLACEMENTS.includes(clean)) return [];

  const { rows } = await pool.query(
    `SELECT id, name, advertiser_name, image_url, image_alt, destination_url, priority
       FROM direct_ads
      WHERE placement = $1 AND ${servableWhere("")}
      ORDER BY priority ASC, id DESC`,
    [clean]
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    advertiser_name: row.advertiser_name,
    image_url: row.image_url,
    image_alt: row.image_alt,
    destination_url: row.destination_url,
    priority: row.priority
  }));
}

/**
 * Record an impression or a click. The event and the counter update happen in
 * one transaction; events for ads that are not currently servable are silently
 * refused (a stale cached page must not inflate the totals).
 */
async function recordEvent({ adId, type, meta }) {
  const parsed = parsePositiveInt(adId);
  if (!parsed || !["impression", "click"].includes(type)) return { recorded: false };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id FROM direct_ads
        WHERE id = $1 AND ${servableWhere("")}
        LIMIT 1`,
      [parsed]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      client.release();
      return { recorded: false };
    }

    await client.query(
      `INSERT INTO direct_ad_events (ad_id, event_type, referrer, device, ip_hash, ua_snippet)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [parsed, type, meta.referrer || "", meta.device || "", meta.ip_hash || "", meta.ua_snippet || ""]
    );

    const column = type === "impression" ? "impression_count" : "click_count";
    await client.query(`UPDATE direct_ads SET ${column} = ${column} + 1 WHERE id = $1`, [parsed]);

    await client.query("COMMIT");
    client.release();
    return { recorded: true };
  } catch (error) {
    await client.query("ROLLBACK");
    client.release();
    throw error;
  }
}

module.exports = {
  PLACEMENTS,
  activeAdsForPlacement,
  createAd,
  deleteAd,
  getAd,
  listAds,
  recordEvent,
  updateAd,
  validateAd
};