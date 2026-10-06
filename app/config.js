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

const config = Object.freeze({
  isProduction,
  nodeEnv: process.env.NODE_ENV || "development",
  port: process.env.PORT || 3007,

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