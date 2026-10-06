"use strict";

/**
 * KaliNova — admin routes
 *
 * Two routers over the same services:
 *   adminPages  server-rendered HTML under /admin
 *   adminApi    JSON under /api/admin
 *
 * Authentication rules:
 *   - The login POST on each surface is the only route that works without a
 *     session.
 *   - Every other route runs attachAdmin first, then the guard for its surface
 *     (redirect for pages, 401/403 JSON for the API).
 *   - Every state-changing request also has to present the CSRF token issued
 *     with the page (or with GET /api/admin/csrf).
 */

const express = require("express");

const adminService = require("./admin-service");
const adsRoutes = require("./admin-ads-routes");
const config = require("./config");
const security = require("./security");
const views = require("./admin-views");
const articleRoutes = require("./admin-article-routes");

const adminPages = express.Router();
const adminApi = express.Router();

const LOGIN_PATH = "/admin/login";
const DASHBOARD_PATH = "/admin/dashboard";

/* ==================================================================== */
/* Shared pieces                                                        */
/* ==================================================================== */

// The article form carries the body text, so it gets a larger ceiling. This has
// to come first: a body already parsed under the tight limit below cannot be
// re-read, and the request would be rejected before reaching the editor routes.
adminPages.use(articleRoutes.articleFormParser);

// HTML form posts and JSON bodies both arrive here; the JSON parser is
// installed globally in server.js.
adminPages.use(express.urlencoded({ extended: false, limit: "16kb" }));
adminApi.use(express.urlencoded({ extended: false, limit: "16kb" }));

/** Admin responses must never be cached by a proxy or the browser. */
function noStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("X-Robots-Tag", "noindex, nofollow");
  next();
}

/** Content-Security-Policy for the admin surface only. */
function adminCsp(req, res, next) {
  res.set("Content-Security-Policy", config.adminCsp);
  next();
}

function sendLoginPage(res, { status, error, notice, email, csrfToken, next }) {
  res.status(status).type("html").send(
    views.renderLoginPage({ error, notice, email, csrfToken, next })
  );
}

/**
 * Rate limit gate for both login surfaces. The per-IP ceiling stops one host
 * from cycling through a list of addresses; the per-IP+email window stops one
 * address from being brute forced.
 */
function loginThrottle(req, res, next) {
  const email = typeof req.body?.email === "string" ? req.body.email : "";

  const ipRetryAfter = security.ipLimiter.check(security.ipLimiter.keyFor(req));
  if (ipRetryAfter) return tooManyAttempts(req, res, ipRetryAfter);

  const key = security.loginLimiter.keyFor(req, email);
  const retryAfter = security.loginLimiter.check(key);
  if (retryAfter) return tooManyAttempts(req, res, retryAfter);

  req.adminLoginKey = key;
  return next();
}

const THROTTLED_MESSAGE = "Too many sign-in attempts. Try again in a few minutes.";

function tooManyAttempts(req, res, retryAfter) {
  res.set("Retry-After", String(retryAfter));

  if (security.wantsJson(req)) {
    return res.status(429).json({ error: THROTTLED_MESSAGE });
  }

  return sendLoginPage(res, {
    status: 429,
    error: THROTTLED_MESSAGE,
    csrfToken: req.csrfToken
  });
}

/** Record a failed attempt against both windows. */
function recordFailure(req) {
  security.loginLimiter.record(req.adminLoginKey);
  security.ipLimiter.record(security.ipLimiter.keyFor(req));
}

/**
 * Shared credential check. Returns the authenticated admin or null; the caller
 * decides whether to answer with the generic message.
 */
async function runLogin(req) {
  const validation = adminService.validateCredentials(req.body);
  if (!validation.ok) return { fieldError: validation.message };

  const result = await adminService.authenticate(validation.email, validation.password);
  if (!result.ok) return { failed: true };

  await adminService.recordLogin(result.admin.id);
  return { admin: result.admin, sessionVersion: result.sessionVersion };
}

/* ==================================================================== */
/* HTML pages: /admin/*                                                */
/* ==================================================================== */

adminPages.use(noStore, adminCsp, security.attachCsrf, security.attachAdmin);

adminPages.get("/", (req, res) => {
  res.redirect(302, DASHBOARD_PATH);
});

adminPages.get("/login", (req, res) => {
  // An already signed-in administrator has no reason to see the form.
  if (req.admin && req.admin.role === "admin") return res.redirect(303, DASHBOARD_PATH);

  const next = security.safeNextPath(req.query.next) || "";
  const notice = req.query.logged_out === "1" ? "You have been signed out." : null;

  return sendLoginPage(res, {
    status: 200,
    csrfToken: req.csrfToken,
    next,
    notice
  });
});

adminPages.post("/login", loginThrottle, async (req, res, next) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const nextPath = security.safeNextPath(req.body?.next) || "";

  if (!security.verifyCsrfToken(req)) {
    return sendLoginPage(res, {
      status: 403,
      error: "This form has expired. Please try again.",
      email,
      csrfToken: req.csrfToken,
      next: nextPath
    });
  }

  try {
    const result = await runLogin(req);

    if (result.fieldError) {
      return sendLoginPage(res, {
        status: 400,
        error: result.fieldError,
        email,
        csrfToken: req.csrfToken,
        next: nextPath
      });
    }

    if (!result.admin) {
      recordFailure(req);

      // One message for every failure mode: unknown address, wrong password,
      // disabled account and non-admin role are indistinguishable.
      return sendLoginPage(res, {
        status: 401,
        error: views.GENERIC_LOGIN_ERROR,
        email,
        csrfToken: req.csrfToken,
        next: nextPath
      });
    }

    security.loginLimiter.reset(req.adminLoginKey);
    // A fresh token per sign-in, so a pre-existing cookie is never upgraded.
    security.setSessionCookie(
      res,
      security.issueSessionToken({ ...result.admin, sessionVersion: result.sessionVersion })
    );

    return res.redirect(303, nextPath || DASHBOARD_PATH);
  } catch (error) {
    return next(error);
  }
});

adminPages.post("/logout", security.requireCsrf, async (req, res, next) => {
  try {
    if (req.admin) {
      // Invalidate the token server-side as well as clearing the cookie, so a
      // copied cookie cannot be replayed after sign-out.
      await adminService.bumpSessionVersion(req.admin.id);
    }
    security.clearSessionCookie(res);
    return res.redirect(303, `${LOGIN_PATH}?logged_out=1`);
  } catch (error) {
    return next(error);
  }
});

adminPages.get("/dashboard", security.requireAdminPage, async (req, res, next) => {
  try {
    const summary = await adminService.getDashboardSummary();

    res.type("html").send(
      views.renderDashboardPage({
        admin: req.admin,
        summary,
        csrfToken: req.csrfToken
      })
    );
  } catch (error) {
    next(error);
  }
});

// Article CMS screens. Registered before the 404 handler below, and after the
// middleware chain above, so they already have no-store, the admin CSP, a CSRF
// token and an authenticated session.
articleRoutes.registerPages(adminPages);

// Ads & Monetization screens. Same chain, same guards.
adsRoutes.registerPages(adminPages);

// Anything else under /admin is a genuine 404, not the public 404 page.
adminPages.use((req, res) => {
  res.status(404).type("html").send(views.renderNotFoundPage({ csrfToken: req.csrfToken }));
});

/* ==================================================================== */
/* JSON API: /api/admin/*                                              */
/* ==================================================================== */

adminApi.use(noStore);

adminApi.get("/csrf", (req, res) => {
  res.json({ token: security.issueCsrfToken(req, res) });
});

adminApi.post("/login", loginThrottle, async (req, res, next) => {
  if (!security.verifyCsrfToken(req)) {
    return res.status(403).json({ error: "Invalid or missing CSRF token." });
  }

  try {
    const result = await runLogin(req);

    if (result.fieldError) {
      return res.status(400).json({ error: result.fieldError });
    }
    if (!result.admin) {
      recordFailure(req);
      return res.status(401).json({ error: views.GENERIC_LOGIN_ERROR });
    }

    security.loginLimiter.reset(req.adminLoginKey);
    security.setSessionCookie(
      res,
      security.issueSessionToken({ ...result.admin, sessionVersion: result.sessionVersion })
    );

    return res.json({ admin: result.admin });
  } catch (error) {
    return next(error);
  }
});

adminApi.post("/logout", security.attachAdmin, security.requireCsrf, async (req, res, next) => {
  try {
    if (req.admin) await adminService.bumpSessionVersion(req.admin.id);
    security.clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/** Never returns password_hash: adminService.sanitizeAdmin drops it. */
adminApi.get("/me", security.attachAdmin, security.requireAdmin, (req, res) => {
  res.json({
    id: req.admin.id,
    email: req.admin.email,
    role: req.admin.role
  });
});

adminApi.get("/dashboard", security.attachAdmin, security.requireAdmin, async (req, res, next) => {
  try {
    const summary = await adminService.getDashboardSummary();
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

// Article CMS JSON endpoints, before the 404 handler.
articleRoutes.registerApi(adminApi);

// Ads & Monetization JSON endpoints, before the 404 handler.
adsRoutes.registerApi(adminApi);

adminApi.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

module.exports = { adminApi, adminPages, DASHBOARD_PATH, LOGIN_PATH };