"use strict";

/**
 * KaliNova — runtime configuration
 *
 * Every secret used by the admin area is read from the environment. Nothing is
 * defaulted to a literal secret in source: in production a missing or weak
 * ADMIN_SESSION_SECRET stops the process instead of shipping a guessable key.
 *
 * Environment variables
 *   ADMIN_SESSION_SECRET   secret used to sign admin session cookies (required in production)
 *   JWT_SECRET             legacy fallback for ADMIN_SESSION_SECRET
 *   ADMIN_SESSION_MINUTES  session lifetime in minutes           (default 480)
 *   ADMIN_COOKIE_NAME      session cookie name                  (default kalinova_admin_session)
 *   ADMIN_CSRF_COOKIE_NAME CSRF cookie name                     (default kalinova_admin_csrf)
 *   ADMIN_BCRYPT_ROUNDS    bcrypt cost factor                  (default 12)
 *   ADMIN_LOGIN_ATTEMPTS   failed logins allowed per window    (default 8)
 *   ADMIN_LOGIN_WINDOW_MINUTES  rate limit window in minutes    (default 15)
 *   ADMIN_UPLOAD_MAX_KB  banner upload limit in KB             (default 6144)
 *   ADMIN_COOKIE_SECURE    force the Secure cookie flag        (default: true in production)
 *   TRUST_PROXY            trust X-Forwarded-* from a proxy    (default false)
 *
 * Monetization
 *   ANALYTICS_SALT      random 64-char hex used to hash client addresses in the
 *                       anonymised event logs (see monetization-service.js).
 *                       Optional: when unset, events are recorded with an empty
 *                       hash so no per-visitor data is retained at all.
 *   NEWSLETTER_FROM_EMAIL  display address used if a provider is configured
 *   NEWSLETTER_PROVIDER    delivery provider name; the site currently ships
 *                       without one, so subscriptions are stored but no email
 *                       is sent. Setting a value only enables the preflight
 *                       wiring, not sending.
 *   ENABLE_ANALYTICS    master switch for the optional GA4 loader (default true)
 *   GA_MEASUREMENT_ID   Google Analytics 4 id (e.g. G-XXXXXXXXXX). Unset means
 *                       the analytics loader stays dormant and no third-party
 *                       request is ever made, which is the shipped default.
 */

const crypto = require("crypto");

const MINUTE_MS = 60 * 1000;
const isProduction = process.env.NODE_ENV === "production";

function readBoolean(name, fallback) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function readInteger(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;

  const value = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max} (received a different value).`
    );
  }
  return value;
}

function readPercent(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a number between 0 and 100.`);
  }
  return value;
}

function readCookieName(name, fallback) {
  const value = String(process.env[name] || "").trim() || fallback;
  // Cookie names go into a Set-Cookie header verbatim, so only the token
  // characters RFC 6265 allows are accepted.
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(value)) {
    throw new Error(`${name} contains characters that are not valid in a cookie name.`);
  }
  return value;
}

/**
 * Values that are long enough to pass the length check but obviously not real
 * secrets. A development placeholder copied into production must not be allowed
 * to sign session cookies, so production rejects these outright.
 */
const PLACEHOLDER_PATTERN =
  /(change[-_ ]?this|change[-_ ]?me|replace[-_ ]?me|dev[-_ ]?only|placeholder|example|dummy|your[-_ ]?secret|admin[-_ ]?session[-_ ]?secret|secret|password|pasword)/i;

/**
 * Resolve the session signing secret.
 *
 * Production requires a strong, explicit secret. Development and test get an
 * ephemeral random secret when none is configured so a missing variable can
 * never turn into a hardcoded key in the repository; the warning is the
 * reminder that sessions will not survive a restart.
 */
function resolveSessionSecret() {
  const configured = String(
    process.env.ADMIN_SESSION_SECRET || process.env.JWT_SECRET || ""
  ).trim();

  if (isProduction && PLACEHOLDER_PATTERN.test(configured)) {
    throw new Error(
      "ADMIN_SESSION_SECRET still looks like a placeholder. Generate a random value " +
        "with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
    );
  }

  if (configured.length >= 32) return configured;

  if (isProduction) {
    throw new Error(
      "ADMIN_SESSION_SECRET must be set to at least 32 characters before starting in production."
    );
  }

  if (configured) {
    console.warn(
      "[config] ADMIN_SESSION_SECRET is shorter than 32 characters. Use a longer random value."
    );
    return configured;
  }

  console.warn(
    "[config] ADMIN_SESSION_SECRET is not set. Using an ephemeral development secret; " +
      "admin sessions will not survive a restart. Set ADMIN_SESSION_SECRET before deploying."
  );
  return crypto.randomBytes(48).toString("hex");
}

/**
 * Express "trust proxy" setting. Left off unless the deployment says the app
 * runs behind a proxy, because trusting the header blindly lets any client
 * spoof its own IP address and defeat the login rate limiter.
 */
function resolveTrustProxy() {
  const raw = String(process.env.TRUST_PROXY || "").trim();
  if (raw === "") return false;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return readBoolean("TRUST_PROXY", false);
}

const sessionMaxAgeMs =
  readInteger("ADMIN_SESSION_MINUTES", 480, { min: 5, max: 10080 }) * MINUTE_MS;

/**
 * Open-data integration settings (Wikidata, Wikimedia Commons, OpenStreetMap,
 * RSS). None of these are secrets: they are public endpoint URLs, a contact
 * string that Wikimedia's API policy asks clients to send, and a timeout.
 * Every value has a working default, so a deployment that sets none of them
 * still runs.
 */
function readUrl(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (raw === "") return fallback;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("unsupported URL");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    console.warn(`[config] ${name} is not a valid http(s) URL. Using the default instead.`);
    return fallback;
  }
}

/**
 * The User-Agent contact address. Wikimedia's API guidelines require a
 * descriptive User-Agent with contact details, so this ships with the same
 * public address the site already lists in its footer. An invalid override is
 * ignored rather than stopping the process: a typo in a monitoring variable
 * must not take the website down.
 */
function readContactEmail() {
  const fallback = "soumyadipsasmal88@gmail.com";
  const raw = String(process.env.CONTACT_EMAIL || "").trim();
  if (raw === "") return fallback;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return raw;
  console.warn("[config] CONTACT_EMAIL does not look like an email address. Using the default instead.");
  return fallback;
}

/**
 * The Leaflet tile template. `{z}`, `{x}` and `{y}` are required — anything
 * else would hand Leaflet a URL it can never complete — and the scheme must be
 * http(s). A bad value falls back to the public OpenStreetMap tile servers so
 * the map on /category/travel never renders blank because of one variable.
 */
function readTileUrl() {
  const fallback = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const raw = String(process.env.OSM_TILE_URL || "").trim();
  if (raw === "") return fallback;
  const looksValid =
    /^https?:\/\//.test(raw) &&
    raw.includes("{z}") &&
    raw.includes("{x}") &&
    raw.includes("{y}");
  if (!looksValid) {
    console.warn("[config] OSM_TILE_URL must be an http(s) URL containing {z}, {x} and {y}. Using the default instead.");
    return fallback;
  }
  return raw;
}

/**
 * The optional Google Analytics 4 measurement id. GA4 ids look like
 * "G-XXXXXXXXXX" (uppercase letters and digits, 4-20 of them). Anything else
 * is ignored with a warning: a typo must not half-enable a third-party request.
 * When this is empty (the shipped default) the analytics loader is dormant and
 * no request leaves the reader's browser.
 */
function readGaMeasurementId() {
  const raw = String(process.env.GA_MEASUREMENT_ID || "").trim();
  if (raw === "") return "";
  if (!/^G-[A-Z0-9]{4,20}$/.test(raw)) {
    console.warn("[config] GA_MEASUREMENT_ID is not a valid GA4 id (expected G-XXXXXXXXXX). Analytics stays off.");
    return "";
  }
  return raw;
}

const siteOrigin = readUrl("SITE_URL", "https://kalinova.in");
const contactEmail = readContactEmail();

const config = Object.freeze({
  isProduction,
  nodeEnv: process.env.NODE_ENV || "development",
  port: process.env.PORT || 3007,

  // --- Open-data integrations (Wikidata / Wikimedia Commons / OSM / RSS) ---
  // Public API bases. The *_API_URL overrides exist so the test suite can point
  // the services at a local fixture server; production leaves them unset.
  wikidataApiUrl: readUrl("WIKIDATA_API_URL", "https://www.wikidata.org/w/api.php"),
  commonsApiUrl: readUrl("COMMONS_API_URL", "https://commons.wikimedia.org/w/api.php"),
  geocoderUrl: readUrl("GEOCODER_URL", "https://nominatim.openstreetmap.org"),
  osmTileUrl: readTileUrl(),
  siteOrigin,
  contactEmail,
  // Wikimedia asks API clients for a UA that identifies the application and a
  // way to reach its operator: https://foundation.wikimedia.org/wiki/UA
  wikimediaUserAgent: `Kalinova/1.0 (${siteOrigin}; ${contactEmail})`,
  // Every outbound request is bounded: no external API may hold a response
  // open long enough to tie up a request handler.
  externalFetchTimeoutMs: readInteger("EXTERNAL_FETCH_TIMEOUT_MS", 5000, { min: 1000, max: 30000 }),

  // --- Open-data safety: feature switches, circuit breakers, budgets --------
  // A feature that is switched off here is never called and its section is
  // hidden from readers. These environment switches always win: they override
  // any per-service breaker state and any admin toggle.
  enableWikidata: readBoolean("ENABLE_WIKIDATA", true),
  enableCommons: readBoolean("ENABLE_COMMONS", true),
  enableMaps: readBoolean("ENABLE_MAPS", true),
  enableRss: readBoolean("ENABLE_RSS", true),

  // Circuit-breaker thresholds. One breaker per integration (Wikidata, Commons,
  // Nominatim, the map tile host, and every RSS feed separately) opens on:
  // repeated consecutive failures, a failure rate over the trailing window,
  // immediate 429/401/403 answers, and repeated timeouts. An open breaker
  // serves cached data or hides the section; it never errors the page.
  cbFailureThreshold: readInteger("CB_FAILURE_THRESHOLD", 5, { min: 2, max: 100 }),
  cbWindowMinutes: readInteger("CB_WINDOW_MINUTES", 10, { min: 1, max: 1440 }),
  cbMinRequests: readInteger("CB_MIN_REQUESTS", 10, { min: 2, max: 1000 }),
  cbFailureRate: readPercent("CB_FAILURE_RATE_PERCENT", 50) / 100,
  cbCooldownMs: readInteger("CB_COOLDOWN_MS", 5 * 60 * 1000, { min: 10_000, max: 86_400_000 }),
  cbMaxCooldownMs: readInteger("CB_MAX_COOLDOWN_MS", 6 * 60 * 60 * 1000, {
    min: 60_000,
    max: 7 * 24 * 60 * 60 * 1000
  }),
  // Three 403s from one upstream in a day is a policy signal, not noise: the
  // breaker then stays off until an administrator re-enables it explicitly.
  cbForbiddenDailyMax: readInteger("CB_FORBIDDEN_DAILY_MAX", 3, { min: 1, max: 100 }),
  cbEventRetentionDays: readInteger("CB_EVENT_RETENTION_DAYS", 90, { min: 7, max: 365 }),

  // Request budgets (per service). Leaving the envelope stops new outbound
  // calls and serves whatever is cached; the budget resets on its window.
  // Conservative by default and generous enough that a real page load never
  // hits one.
  nominatimHourlyLimit: readInteger("NOMINATIM_HOURLY_LIMIT", 60, { min: 1, max: 100_000 }),
  nominatimDailyLimit: readInteger("NOMINATIM_DAILY_LIMIT", 1000, { min: 1, max: 1_000_000 }),
  wikidataHourlyLimit: readInteger("WIKIDATA_HOURLY_LIMIT", 600, { min: 1, max: 100_000 }),
  wikidataDailyLimit: readInteger("WIKIDATA_DAILY_LIMIT", 5000, { min: 1, max: 1_000_000 }),
  commonsHourlyLimit: readInteger("COMMONS_HOURLY_LIMIT", 600, { min: 1, max: 100_000 }),
  commonsDailyLimit: readInteger("COMMONS_DAILY_LIMIT", 5000, { min: 1, max: 1_000_000 }),
  rssHourlyLimit: readInteger("RSS_HOURLY_LIMIT", 24, { min: 1, max: 100_000 }),
  rssDailyLimit: readInteger("RSS_DAILY_LIMIT", 192, { min: 1, max: 1_000_000 }),
  rssMinIntervalMs: readInteger("RSS_MIN_INTERVAL_MS", 15 * 60 * 1000, {
    min: 60_000,
    max: 24 * 60 * 60 * 1000
  }),
  mapTileHealthcheckMs: readInteger("MAP_TILE_HEALTHCHECK_MS", 30 * 60 * 1000, {
    min: 60_000,
    max: 24 * 60 * 60 * 1000
  }),
  mapTileHourlyLimit: readInteger("MAP_TILE_HOURLY_LIMIT", 4, { min: 1, max: 1000 }),
  mapTileDailyLimit: readInteger("MAP_TILE_DAILY_LIMIT", 96, { min: 1, max: 100_000 }),

  // --- Monetization ---------------------------------------------------------
  // ANALYTICS_SALT is a server secret used only to HMAC client addresses in the
  // pruneable event tables; it is never exposed to any client. When unset, the
  // event rows simply get an empty hash and no per-visitor data is retained.
  analyticsSalt: String(process.env.ANALYTICS_SALT || "").trim(),
  // The newsletter has no delivery provider bundled with the site. NEWSLETTER_
  // FROM_EMAIL is the display address a future provider would send from, and
  // NEWSLETTER_PROVIDER is accepted only so a deployment can record which
  // provider it wires in; neither one switches email sending on by itself.
  newsletterProvider: String(process.env.NEWSLETTER_PROVIDER || "").trim(),
  newsletterFromEmail: String(process.env.NEWSLETTER_FROM_EMAIL || "").trim(),

  // --- Optional analytics ---------------------------------------------------
  // Off unless an operator sets a real GA4 id. Even then the loader waits for
  // the reader's advertising consent and honours Do Not Track / Global Privacy
  // Control, so nothing leaves the browser without a deliberate choice.
  enableAnalytics: readBoolean("ENABLE_ANALYTICS", true),
  gaMeasurementId: readGaMeasurementId(),

  // --- SEO Engine -----------------------------------------------------------
  // A deterministic, internal content-quality analyzer (docs/seo-engine.md).
  // It is not a Google ranking metric, runs entirely on the server, and stores
  // nothing. ENABLE_SEO_ENGINE lets a deployment hide the panel without code
  // changes; SEO_INTERNAL_LINK_LIMIT caps the related-story suggestions the
  // editor requests in one analysis run.
  enableSeoEngine: readBoolean("ENABLE_SEO_ENGINE", true),
  seoEngineVersion: "seo-v1",
  seoInternalLinkLimit: readInteger("SEO_INTERNAL_LINK_LIMIT", 5, { min: 0, max: 20 }),

  sessionSecret: resolveSessionSecret(),
  sessionMaxAgeMs,
  sessionCookieName: readCookieName("ADMIN_COOKIE_NAME", "kalinova_admin_session"),
  csrfCookieName: readCookieName("ADMIN_CSRF_COOKIE_NAME", "kalinova_admin_csrf"),

  bcryptRounds: readInteger("ADMIN_BCRYPT_ROUNDS", 12, { min: 10, max: 15 }),
  loginMaxAttempts: readInteger("ADMIN_LOGIN_ATTEMPTS", 8, { min: 1, max: 100 }),
  loginWindowMs:
    readInteger("ADMIN_LOGIN_WINDOW_MINUTES", 15, { min: 1, max: 1440 }) * MINUTE_MS,

  // Banner uploads: the raw body limit for POST /api/admin/uploads. 6 MB covers
  // a full-width hero image without turning the endpoint into a file store.
  uploadMaxBytes: readInteger("ADMIN_UPLOAD_MAX_KB", 6144, { min: 64, max: 20480 }) * 1024,

  // Article form posts (and the matching JSON API calls) carry the body text,
  // so they get their own ceiling instead of the tight 16 KB used by the login
  // and logout forms. The sanitizer refuses anything larger anyway.
  adminBodyLimit: readInteger("ADMIN_ARTICLE_BODY_KB", 512, { min: 32, max: 4096 }) + "kb",

  // SameSite=Lax still blocks the cookie on cross-site POSTs (the only thing
  // that matters for CSRF) while keeping normal top-level navigation working.
  sessionSameSite: "Lax",
  csrfSameSite: "Strict",

  // Secure cookies are the default in production. Local development over plain
  // http://localhost keeps them off unless ADMIN_COOKIE_SECURE=true is set.
  secureCookies: readBoolean("ADMIN_COOKIE_SECURE", isProduction),

  trustProxy: resolveTrustProxy(),

  // Locked down for the admin shell. The public site keeps its own policy in
  // frontend/_headers. The admin pages load only local assets — no third-party
  // font CDN — so nothing here needs to allow an external origin.
  adminCsp: [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "img-src 'self' data:",
    "style-src 'self'",
    "font-src 'self'"
  ].join("; ")
});

module.exports = config;