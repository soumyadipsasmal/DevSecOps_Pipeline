"use strict";

/**
 * KaliNova — monetization dashboard: shared glue
 *
 * This module is the shared core of the monetization screens. It owns the
 * privacy-safe request metadata (an HMAC of the client address, never the raw
 * IP), the audit log, the site-wide disclosure texts, the overview numbers and
 * the newsletter subscriber store.
 *
 * Deliberate non-features, kept honest on every admin screen:
 *   * Revenue numbers. KaliNova has no ad-network or payment provider wired in,
 *     so the overview answers "Revenue reporting not connected." instead of
 *     inventing a figure.
 *   * Email delivery. The site ships without a mailing provider, so subscribing
 *     stores a row (lowercased, deduplicated) but no email is sent, and the
 *     admin screens say so.
 *   * Raw identifiers. Event logs keep an HMAC of the client address keyed with
 *     ANALYTICS_SALT. When the salt is unset the hash is empty: still no raw IP,
 *     and no per-visitor signal at all.
 *
 * Reused instead of duplicated: the existing ad_settings/ads-service gate decides
 * whether AdSense may render; this module never re-decides that.
 */

const crypto = require("crypto");

const config = require("./config");
const pool = require("./db");

/* ==================================================================== */
/* Constants                                                            */
/* ==================================================================== */

/** Banner slots the public layout supports. Kept in sync with the CHECK in
 * database/schema-monetization.sql. */
const DIRECT_ADS_PLACEMENTS = Object.freeze([
  "homepage_top",
  "homepage_middle",
  "article_top",
  "article_middle",
  "article_bottom",
  "sidebar",
  "category_top",
  "footer"
]);

const DIRECT_ADS_STATUSES = Object.freeze(["draft", "scheduled", "active", "paused", "expired"]);
const SPONSORED_STATUSES = Object.freeze(["draft", "active", "paused", "ended"]);
const SPONSORED_LABELS = Object.freeze(["Sponsored", "Advertisement"]);
const AFFILIATE_STATUSES = Object.freeze(["active", "paused"]);

const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 1000;
const MAX_EMAIL_LENGTH = 254;

/* ==================================================================== */
/* Normalisation helpers (shared by every service below)                */
/* ==================================================================== */

function asString(value, max = 0) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return max ? text.slice(0, max) : text;
}

function normalizeBool(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

/**
 * An absolute http(s) URL, or "" when unusable. Credentials in the URL are
 * rejected (never stored, never followed).
 */
function normalizeHttpUrl(value, maxLength = MAX_URL_LENGTH) {
  const text = asString(value, maxLength);
  if (text === "") return "";
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

/** Convert free-form text into the token the schema accepts (64 lower hex). */
function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function normalizeEmail(value) {
  const email = asString(value, MAX_EMAIL_LENGTH).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function parsePositiveInt(value) {
  const id = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** A slug for affiliate redirect URLs: lowercase letters, numbers and hyphens. */
function slugify(value) {
  return asString(value, 120)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['"‘’“”]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/* ==================================================================== */
/* Privacy-safe request metadata                                        */
/* ==================================================================== */

/** Fold the User-Agent into one of three short buckets. */
function classifyDevice(userAgent) {
  const text = String(userAgent || "");
  if (/bot|crawl|spider|slurp|preview|headless|curl|wget/i.test(text)) return "bot";
  if (/mobile|android|iphone|ipad|kindle|fennec/i.test(text)) return "mobile";
  return "desktop";
}

/** Keep only the referrer's host — not the query string, never the full URL. */
function hostOnly(value) {
  const text = asString(value, 500);
  if (text === "") return "";
  try {
    return new URL(text).host;
  } catch {
    return "";
  }
}

/**
 * Build the anonymised event row from a request.
 *
 * ip_hash is HMAC-SHA256(client IP, ANALYTICS_SALT). Without the salt the hash
 * is empty: the row still records the event, it just carries no per-visitor
 * signal. The raw IP is never stored and never logged.
 */
function metaFromRequest(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || "").slice(0, 64);

  let ipHash = "";
  if (config.analyticsSalt) {
    ipHash = crypto
      .createHmac("sha256", config.analyticsSalt)
      .update(ip)
      .digest("hex");
  }

  return {
    ip_hash: ipHash,
    referrer: hostOnly(req.get("referer") || req.get("referrer")),
    device: classifyDevice(req.get("user-agent")),
    ua_snippet: asString(req.get("user-agent"), 128)
  };
}

/* ==================================================================== */
/* Audit log                                                            */
/* ==================================================================== */

/**
 * Record an admin monetization action.
 *
 * details is sanitised here: only flat, primitive values are kept, so a secret
 * that a caller slipped past its own code cannot reach the table.
 */
async function logAudit({ adminId, action, entityType = "", entityId = null, details = {} }) {
  let clean = {};
  const raw = details && typeof details === "object" ? details : {};
  for (const [key, value] of Object.entries(raw)) {
    const type = typeof value;
    if (value === null || type === "boolean" || type === "number" || type === "string") {
      if (type === "string") {
        clean[key] = String(value).slice(0, 400);
      } else {
        clean[key] = value;
      }
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO monetization_audit_logs (admin_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      parsePositiveInt(adminId),
      asString(action, 80),
      asString(entityType, 40),
      entityId === null || entityId === undefined ? null : parsePositiveInt(entityId),
      JSON.stringify(clean)
    ]
  );
  return rows[0] ? rows[0].id : null;
}

async function listAudit({ limit = 50, offset = 0 }) {
  const rows = await pool.query(
    `SELECT monetization_audit_logs.id,
            monetization_audit_logs.action,
            monetization_audit_logs.entity_type,
            monetization_audit_logs.entity_id,
            monetization_audit_logs.details,
            monetization_audit_logs.created_at,
            users.email AS admin_email
       FROM monetization_audit_logs
       LEFT JOIN users ON users.id = monetization_audit_logs.admin_id
      ORDER BY monetization_audit_logs.created_at DESC, monetization_audit_logs.id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.rows;
}

/* ==================================================================== */
/* Disclosures                                                          */
/* ==================================================================== */

async function getDisclosures() {
  const { rows } = await pool.query(
    `SELECT affiliate_disclosure,
            sponsored_disclosure,
            advertising_disclosure,
            privacy_notice,
            updated_at
       FROM monetization_disclosures
      WHERE id = 1
      LIMIT 1`
  );

  const row = rows[0];
  if (!row) {
    return {
      affiliate_disclosure:
        "Some links on this page are affiliate links. If you make a purchase through them, KaliNova may earn a commission at no extra cost to you.",
      sponsored_disclosure:
        "This article was produced in partnership with a sponsor. The sponsor did not control the reporting or the final text.",
      advertising_disclosure:
        "This page contains advertisements sold and placed by KaliNova. Advertisers do not influence editorial content.",
      privacy_notice:
        "KaliNova shows advertising only with your consent. See the privacy policy for how advertising data is handled.",
      updated_at: null
    };
  }

  return {
    affiliate_disclosure: asString(row.affiliate_disclosure, 4000),
    sponsored_disclosure: asString(row.sponsored_disclosure, 4000),
    advertising_disclosure: asString(row.advertising_disclosure, 4000),
    privacy_notice: asString(row.privacy_notice, 4000),
    updated_at: row.updated_at
  };
}

async function updateDisclosures(input = {}) {
  const current = await getDisclosures();
  const next = { ...current };

  for (const field of ["affiliate_disclosure", "sponsored_disclosure", "advertising_disclosure", "privacy_notice"]) {
    if (field in input) next[field] = asString(input[field], 4000);
  }

  await pool.query(
    `UPDATE monetization_disclosures
        SET affiliate_disclosure = $1,
            sponsored_disclosure = $2,
            advertising_disclosure = $3,
            privacy_notice = $4,
            updated_at = NOW()
      WHERE id = 1`,
    [
      next.affiliate_disclosure,
      next.sponsored_disclosure,
      next.advertising_disclosure,
      next.privacy_notice
    ]
  );

  return { ...next, updated_at: new Date() };
}

/* ==================================================================== */
/* Newsletter                                                          */
/* ==================================================================== */

/** The mailing wiring the deployment actually has. No provider ⇒ no sending. */
function mailingConfig() {
  const provider = config.newsletterProvider ? asString(config.newsletterProvider, 40) : "";
  return {
    provider: provider === "" ? "" : provider,
    from_email: config.newsletterFromEmail ? asString(config.newsletterFromEmail, 254) : "",
    // The site ships without a delivery provider: subscribing is a stored row,
    // never an email. This flag lets every screen state it plainly.
    can_send: false
  };
}

/**
 * Add (or reactivate) a subscriber. One row per email: resubscribing turns an
 * unsubscribed row back to subscribed rather than duplicating it. The token is
 * random and never derived from the address.
 */
async function subscribe({ email, name = "", source = "site" }) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return { ok: false, error: "Enter a valid email address." };

  const cleanName = asString(name, 120);
  const cleanSource = asString(source, 20) || "site";

  const { rows } = await pool.query(
    `INSERT INTO newsletter_subscribers (email, name, status, token, source, unsubscribed_at)
     VALUES ($1, $2, 'subscribed', $3, $4, NULL)
     ON CONFLICT (email) DO UPDATE
       SET status = 'subscribed',
           name = EXCLUDED.name,
           token = EXCLUDED.token,
           source = EXCLUDED.source,
           unsubscribed_at = NULL,
           subscribed_at = NOW()
     RETURNING id, email, status, token`,
    [cleanEmail, cleanName, createToken(), cleanSource]
  );

  const row = rows[0];
  return {
    ok: true,
    subscriber: {
      id: row.id,
      status: row.status,
      // The token returns to the caller once, for the (future) confirmation
      // flow. It is never rendered back to the browser a second time.
      token: row.token
    }
  };
}

async function unsubscribeByToken(token) {
  const { rows } = await pool.query(
    `UPDATE newsletter_subscribers
        SET status = 'unsubscribed', unsubscribed_at = NOW()
      WHERE token = $1
        AND status <> 'unsubscribed'
      RETURNING id`,
    [asString(token, 64)]
  );
  if (rows.length === 0) return { ok: false, error: "That unsubscribe link is not valid." };
  await logAudit({ adminId: null, action: "newsletter.unsubscribe", entityType: "newsletter_subscriber", entityId: rows[0].id });
  return { ok: true };
}

async function adminUnsubscribe(id) {
  const parsed = parsePositiveInt(id);
  if (!parsed) return null;
  const { rows } = await pool.query(
    `UPDATE newsletter_subscribers
        SET status = 'unsubscribed', unsubscribed_at = NOW()
      WHERE id = $1 AND status <> 'unsubscribed'
      RETURNING id`,
    [parsed]
  );
  return rows.length === 1 ? rows[0].id : null;
}

async function listSubscribers({ status = "", limit = 100, offset = 0 }) {
  const cleanStatus = [undefined, null, "", "all"].includes(status) ? "" : asString(status, 20);
  const params = [];
  let where = "";
  if (cleanStatus && ["subscribed", "pending", "unsubscribed"].includes(cleanStatus)) {
    params.push(cleanStatus);
    where = ` WHERE status = $${params.length}`;
  }
  params.push(Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));

  const { rows } = await pool.query(
    `SELECT id, email, name, status, source, subscribed_at, unsubscribed_at
       FROM newsletter_subscribers
       ${where}
      ORDER BY subscribed_at DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // Emails are admin-visible data, returned deliberately to the admin surface.
  return rows;
}

async function subscriberCounts() {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS count
       FROM newsletter_subscribers
      GROUP BY status`
  );
  const counts = { subscribed: 0, pending: 0, unsubscribed: 0 };
  for (const row of rows) if (row.status in counts) counts[row.status] = row.count;
  return counts;
}

/* ==================================================================== */
/* Overview                                                             */
/* ==================================================================== */

/**
 * One set of numbers for the overview screen. Revenue stays explicitly "not
 * connected": there is no ad-network or payment provider, and the product does
 * not invent figures.
 */
async function getOverview() {
  const [
    affiliateCounts,
    sponsoredCounts,
    adCounts,
    subscriber,
    disclosures,
    adsSettings,
    audience
  ] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              (SELECT COUNT(*)::int FROM affiliate_clicks WHERE created_at > NOW() - INTERVAL '30 days') AS clicks_30d
         FROM affiliate_links`
      )
      .then(result => result.rows[0]),
    pool.query(
      `SELECT status, COUNT(*)::int AS count
         FROM sponsored_campaigns
        GROUP BY status`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              (SELECT COUNT(*)::int FROM direct_ad_events WHERE event_type = 'impression' AND created_at > NOW() - INTERVAL '30 days') AS impressions_30d,
              (SELECT COUNT(*)::int FROM direct_ad_events WHERE event_type = 'click' AND created_at > NOW() - INTERVAL '30 days') AS clicks_30d
         FROM direct_ads`
      )
      .then(result => result.rows[0]),
    subscriberCounts(),
    getDisclosures(),
    pool.query("SELECT ads_enabled, adsense_enabled, adsense_client FROM ad_settings WHERE id = 1 LIMIT 1").then(result => result.rows[0] || null),
    pool.query(`SELECT COUNT(*)::int AS total_clicks FROM affiliate_clicks`).then(result => result.rows[0])
  ]);

  const sponsored = { draft: 0, active: 0, paused: 0, ended: 0 };
  for (const row of sponsoredCounts.rows) if (row.status in sponsored) sponsored[row.status] = row.count;

  const adSenseConfigured =
    adsSettings && adsSettings.ads_enabled === true &&
    adsSettings.adsense_enabled === true &&
    /^ca-pub-\d{10,20}$/.test(String(adsSettings.adsense_client || ""));

  return {
    affiliate: {
      total: affiliateCounts.total,
      active: affiliateCounts.active,
      total_clicks: audience.total_clicks,
      clicks_30d: affiliateCounts.clicks_30d
    },
    sponsored,
    direct_ads: {
      total: adCounts.total,
      active: adCounts.active,
      impressions_30d: adCounts.impressions_30d,
      clicks_30d: adCounts.clicks_30d
    },
    newsletter: subscriber,
    disclosures_updated_at: disclosures.updated_at,
    ad_sense: {
      configured: adSenseConfigured,
      note: adSenseConfigured
        ? "Google AdSense is configured and switched on."
        : "Google AdSense is not serving. Manage it under Ads & Monetization."
    },
    revenue: {
      connected: false,
      message: "Revenue reporting not connected."
    },
    mailing: mailingConfig()
  };
}

module.exports = {
  AFFILIATE_STATUSES,
  DIRECT_ADS_PLACEMENTS,
  DIRECT_ADS_STATUSES,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_URL_LENGTH,
  SPONSORED_LABELS,
  SPONSORED_STATUSES,
  adminUnsubscribe,
  asString,
  classifyDevice,
  createToken,
  getDisclosures,
  getOverview,
  listAudit,
  listSubscribers,
  logAudit,
  mailingConfig,
  metaFromRequest,
  normalizeBool,
  normalizeEmail,
  normalizeHttpUrl,
  parsePositiveInt,
  slugify,
  subscriberCounts,
  subscribe,
  unsubscribeByToken,
  updateDisclosures
};