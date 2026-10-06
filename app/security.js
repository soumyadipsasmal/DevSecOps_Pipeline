"use strict";

/**
 * KaliNova — admin authentication primitives
 *
 * Sessions are stateless, signed tokens delivered in an HttpOnly cookie. The
 * token only carries identity claims; every request re-reads the account from
 * PostgreSQL, so disabling an administrator or logging out invalidates existing
 * cookies immediately instead of waiting for a token to expire.
 *
 * Nothing in this module logs a credential, a token or a hash.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const config = require("./config");
const adminService = require("./admin-service");

const SESSION_ISSUER = "kalinova-admin";
const SESSION_AUDIENCE = "kalinova-admin";

/* ==================================================================== */
/* Cookies                                                              */
/* ==================================================================== */

/** Parse a Cookie header into a plain object. Malformed values are ignored. */
function parseCookies(header) {
  const jar = Object.create(null);
  if (typeof header !== "string" || header === "") return jar;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;

    const name = pair.slice(0, separator).trim();
    if (!name) continue;

    let value = pair.slice(separator + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      // A value that is not valid percent-encoding is kept verbatim; the value
      // is treated as untrusted either way.
      jar[name] = value;
    }
  }

  return jar;
}

/** Build a Set-Cookie header value. Attribute order matches RFC 6265 examples. */
function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAgeMs !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeMs / 1000))}`);
  }
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);

  return parts.join("; ");
}

function appendCookie(res, header) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", [header]);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", existing.concat(header));
  } else {
    res.setHeader("Set-Cookie", [existing, header]);
  }
}

/* ==================================================================== */
/* Session tokens                                                       */
/* ==================================================================== */

/**
 * Mint a session token for an authenticated administrator. A fresh jti is
 * issued per login, and the account's session_version is embedded so that
 * logout (which bumps that column) invalidates the token server-side.
 */
function issueSessionToken(admin) {
  return jwt.sign(
    {
      sub: String(admin.id),
      email: admin.email,
      role: admin.role,
      sv: Number(admin.sessionVersion) || 1
    },
    config.sessionSecret,
    {
      algorithm: "HS256",
      expiresIn: Math.floor(config.sessionMaxAgeMs / 1000),
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      jwtid: crypto.randomUUID()
    }
  );
}

/** Verify a session token. Returns the claims, or null for anything invalid. */
function verifySessionToken(token) {
  if (typeof token !== "string" || token === "") return null;

  try {
    const claims = jwt.verify(token, config.sessionSecret, {
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE
    });

    if (!claims || typeof claims !== "object") return null;
    if (!/^\d+$/.test(String(claims.sub || ""))) return null;

    return claims;
  } catch {
    // Expired, tampered, wrong algorithm, wrong issuer: all indistinguishable
    // to the caller, which is what we want.
    return null;
  }
}

function setSessionCookie(res, token) {
  appendCookie(
    res,
    serializeCookie(config.sessionCookieName, token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: config.sessionSameSite,
      maxAgeMs: config.sessionMaxAgeMs
    })
  );
}

function clearSessionCookie(res) {
  appendCookie(
    res,
    serializeCookie(config.sessionCookieName, "", {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: config.sessionSameSite,
      maxAgeMs: 0,
      expires: new Date(0)
    })
  );
}

/* ==================================================================== */
/* CSRF protection (signed double submit)                               */
/* ==================================================================== */

function signCsrfToken(nonce) {
  return crypto
    .createHmac("sha256", config.sessionSecret)
    .update(nonce)
    .digest("base64url");
}

function createCsrfToken() {
  const nonce = crypto.randomBytes(32).toString("base64url");
  return `${nonce}.${signCsrfToken(nonce)}`;
}

function isValidCsrfToken(token) {
  if (typeof token !== "string") return false;

  const separator = token.indexOf(".");
  if (separator <= 0) return false;

  const nonce = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = signCsrfToken(nonce);

  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length) return false;

  return crypto.timingSafeEqual(given, wanted);
}

/** Read the CSRF cookie from the request. */
function readCsrfCookie(req) {
  return parseCookies(req.headers.cookie || "")[config.csrfCookieName] || "";
}

/**
 * Ensure the request has a valid CSRF cookie and expose the matching value on
 * req.csrfToken so server-rendered forms can embed it.
 */
function attachCsrf(req, res, next) {
  const existing = readCsrfCookie(req);
  req.csrfToken = isValidCsrfToken(existing) ? existing : createCsrfToken();

  if (req.csrfToken !== existing) {
    appendCookie(
      res,
      serializeCookie(config.csrfCookieName, req.csrfToken, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: config.csrfSameSite,
        maxAgeMs: config.sessionMaxAgeMs
      })
    );
  }

  next();
}

/** Issue a CSRF token and return it (used by GET /api/admin/csrf). */
function issueCsrfToken(req, res) {
  attachCsrf(req, res, () => {});
  return req.csrfToken;
}

/** Constant-time comparison of the submitted token against the cookie. */
function submittedCsrfToken(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const fromBody = body._csrf;

  const header = req.get("x-csrf-token") || req.get("x-xsrf-token");

  const candidate = [fromBody, header].find(
    value => typeof value === "string" && value !== ""
  );
  return candidate || "";
}

function verifyCsrfToken(req) {
  const cookieToken = readCsrfCookie(req);
  const sent = submittedCsrfToken(req);

  if (!isValidCsrfToken(cookieToken)) return false;
  if (!isValidCsrfToken(sent)) return false;

  const given = Buffer.from(sent);
  const wanted = Buffer.from(cookieToken);
  if (given.length !== wanted.length) return false;

  return crypto.timingSafeEqual(given, wanted);
}

/** Reject state-changing admin requests that do not carry a valid token. */
function requireCsrf(req, res, next) {
  if (verifyCsrfToken(req)) return next();

  if (wantsJson(req)) {
    return res.status(403).json({ error: "Invalid or missing CSRF token." });
  }

  res.set("Content-Type", "text/plain; charset=utf-8");
  return res.status(403).send("Invalid or missing CSRF token.");
}

/* ==================================================================== */
/* Login rate limiting                                                  */
/* ==================================================================== */

/**
 * In-memory sliding-window limiter. The project has no shared cache, so this
 * is intentionally simple: it protects a single instance against credential
 * stuffing and, on a multi-instance deployment, each instance still enforces
 * its own window.
 */
function createLoginLimiter({ windowMs, maxAttempts, keyFor }) {
  const attempts = new Map();

  function prune(now) {
    for (const [key, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(key);
    }
  }

  const pruneTimer = setInterval(() => prune(Date.now()), Math.max(windowMs, 60000));
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();

  return {
    /** Returns null when the attempt is allowed, or retry-after seconds. */
    check(key) {
      const now = Date.now();
      const entry = attempts.get(key);

      if (!entry) return null;
      if (entry.resetAt <= now) {
        attempts.delete(key);
        return null;
      }
      if (entry.count < maxAttempts) return null;

      return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    },

    record(key) {
      const now = Date.now();
      const entry = attempts.get(key);

      if (!entry || entry.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      entry.count += 1;
    },

    reset(key) {
      attempts.delete(key);
    },

    keyFor,
    stop() {
      clearInterval(pruneTimer);
    }
  };
}

const loginLimiter = createLoginLimiter({
  windowMs: config.loginWindowMs,
  maxAttempts: config.loginMaxAttempts,
  keyFor: (req, email) => `${req.ip}|${String(email || "").toLowerCase()}`
});

/**
 * Per-IP ceiling. Two limiters, because keying only on email + IP would still
 * let one host cycle through a list of addresses.
 */
const ipLimiter = createLoginLimiter({
  windowMs: config.loginWindowMs,
  maxAttempts: config.loginMaxAttempts * 3,
  keyFor: req => String(req.ip || "unknown")
});

/* ==================================================================== */
/* Request helpers                                                      */
/* ==================================================================== */

function wantsJson(req) {
  if (req.path.startsWith("/api/")) return true;
  if ((req.headers["sec-fetch-mode"] || "") === "cors") return true;
  if (!req.headers.accept) return false;
  return req.headers.accept.includes("application/json") && !req.headers.accept.includes("text/html");
}

/** Only same-site absolute paths may be used as a post-login redirect. */
function safeNextPath(value) {
  const raw = String(value || "");
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  return raw;
}

/* ==================================================================== */
/* Middleware                                                           */
/* ==================================================================== */

/**
 * Resolve the caller from the session cookie. Attaches req.admin for any
 * active account and leaves req.admin null for anonymous or stale sessions.
 * The role check deliberately happens in requireAdmin so an authenticated
 * non-admin receives 403 rather than 401.
 */
async function attachAdmin(req, res, next) {
  req.admin = null;

  try {
    const token = parseCookies(req.headers.cookie || "")[config.sessionCookieName];
    if (!token) return next();

    const claims = verifySessionToken(token);
    if (!claims) return next();

    const admin = await adminService.getActiveAccount(Number(claims.sub));
    if (!admin) return next();

    // Logout (and password rotation) bumps session_version, so a stolen copy of
    // the cookie stops working as soon as the session is ended.
    if (Number(claims.sv) !== Number(admin.session_version)) return next();

    req.admin = admin;
    return next();
  } catch (error) {
    return next(error);
  }
}

/** API guard: JSON 401/403. */
function requireAdmin(req, res, next) {
  if (!req.admin) {
    clearSessionCookie(res);
    return res.status(401).json({ error: "Authentication required." });
  }
  if (req.admin.role !== "admin") {
    return res.status(403).json({ error: "Administrator access required." });
  }
  return next();
}

/** Page guard: redirect anonymous visitors to the login form. */
function requireAdminPage(req, res, next) {
  if (!req.admin) {
    clearSessionCookie(res);
    const target = safeNextPath(req.originalUrl);
    return res
      .status(302)
      .redirect(target ? `/admin/login?next=${encodeURIComponent(target)}` : "/admin/login");
  }
  if (req.admin.role !== "admin") {
    return res.status(403).json({ error: "Administrator access required." });
  }
  return next();
}

module.exports = {
  attachAdmin,
  attachCsrf,
  clearSessionCookie,
  createCsrfToken,
  createLoginLimiter,
  issueCsrfToken,
  issueSessionToken,
  loginLimiter,
  ipLimiter,
  parseCookies,
  readCsrfCookie,
  requireAdmin,
  requireAdminPage,
  // Pair for routes outside the admin routers, e.g. POST /api/articles.
  requireAdminSession: [attachAdmin, requireAdmin],
  requireCsrf,
  safeNextPath,
  serializeCookie,
  setSessionCookie,
  verifyCsrfToken,
  verifySessionToken,
  wantsJson
};