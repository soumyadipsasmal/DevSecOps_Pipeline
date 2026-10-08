"use strict";

/**
 * KaliNova — admin redirect routes
 *
 * Registered onto the two routers admin-routes.js builds, so both surfaces
 * inherit the same chain as the dashboard:
 *
 *   /admin/redirects*        adminPages — HTML, no-store + admin CSP + CSRF +
 *                             authenticated session, then the page guard
 *   /api/admin/redirects*    adminApi   — JSON for the same operations
 *
 * Rules that hold for every handler:
 *   - nothing is written before the service validated the submitted path and
 *     status code; the unique index on source_path is the final duplicate guard
 *   - deletions require an explicit "confirm" field from the form, exactly like
 *     the monetization screens
 *   - all mutations sit behind requireCsrf, so nothing changes on a GET
 */

const express = require("express");

const redirects = require("./redirect-service");
const security = require("./security");
const views = require("./admin-redirect-views");

function parseId(value) {
  const id = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function noticeFrom(query) {
  return typeof query.notice === "string" ? query.notice.slice(0, 200) : "";
}

function notFoundPage(req, res) {
  return res.status(404).type("html").send(views.renderNotFound({ csrfToken: req.csrfToken }));
}

function notFoundJson(res) {
  return res.status(404).json({ error: "Redirect not found" });
}

/** The public shape of one redirect row for the JSON API. */
function redirectJson(row) {
  return {
    id: row.id,
    source_path: row.source_path,
    destination_path: row.destination_path,
    status_code: row.status_code,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/* ==================================================================== */
/* HTML pages                                                           */
/* ==================================================================== */

function registerPages(pages) {
  const guard = security.requireAdminPage;

  pages.get("/redirects", guard, async (req, res, next) => {
    try {
      const rows = await redirects.listRedirects();
      res.type("html").send(
        views.renderRedirectsPage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          redirects: rows,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/redirects", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const result = await redirects.validateRedirect(req.body || {});
      if (!result.ok) {
        const rows = await redirects.listRedirects();
        return res.status(422).type("html").send(
          views.renderRedirectsPage({
            admin: req.admin,
            csrfToken: req.csrfToken,
            redirects: rows,
            errors: result.errors,
            values: views.submittedValues(req.body)
          })
        );
      }

      const created = await redirects.createRedirect(result.values);
      return res.redirect(303, `/admin/redirects?notice=${encodeURIComponent(`Redirect “${created.source_path}” was added.`)}`);
    } catch (error) {
      next(error);
    }
  });

  pages.get("/redirects/:id/edit", guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const redirect = id ? await redirects.getRedirect(id) : null;
      if (!redirect) return notFoundPage(req, res);

      res.type("html").send(
        views.renderRedirectForm({ admin: req.admin, csrfToken: req.csrfToken, redirect })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/redirects/:id", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const redirect = id ? await redirects.getRedirect(id) : null;
      if (!redirect) return notFoundPage(req, res);

      const result = await redirects.validateRedirect(req.body || {}, { id });
      if (!result.ok) {
        return res.status(422).type("html").send(
          views.renderRedirectForm({
            admin: req.admin,
            csrfToken: req.csrfToken,
            redirect,
            errors: result.errors,
            values: views.submittedValues(req.body)
          })
        );
      }

      const updated = await redirects.updateRedirect(id, result.values);
      if (!updated) return notFoundPage(req, res);

      return res.redirect(303, `/admin/redirects?notice=${encodeURIComponent("The redirect was saved.")}`);
    } catch (error) {
      next(error);
    }
  });

  pages.post("/redirects/:id/delete", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id || String(req.body?.confirm) !== "1") return notFoundPage(req, res);

      const deleted = await redirects.deleteRedirect(id);
      if (!deleted) return notFoundPage(req, res);

      return res.redirect(303, `/admin/redirects?notice=${encodeURIComponent(`Redirect “${deleted.source_path}” was deleted.`)}`);
    } catch (error) {
      next(error);
    }
  });

  return pages;
}

/* ==================================================================== */
/* JSON API                                                             */
/* ==================================================================== */

function registerApi(api) {
  const guard = [security.attachAdmin, security.requireAdmin];

  api.get("/redirects", ...guard, async (req, res, next) => {
    try {
      const search = typeof req.query.search === "string" ? req.query.search : "";
      res.json({ redirects: (await redirects.listRedirects({ search })).map(redirectJson) });
    } catch (error) {
      next(error);
    }
  });

  api.post("/redirects", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const result = await redirects.validateRedirect(req.body || {});
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const redirect = await redirects.createRedirect(result.values);
      return res.status(201).json({ redirect: redirectJson(redirect) });
    } catch (error) {
      next(error);
    }
  });

  api.get("/redirects/:id", ...guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const redirect = id ? await redirects.getRedirect(id) : null;
      if (!redirect) return notFoundJson(res);
      return res.json({ redirect: redirectJson(redirect) });
    } catch (error) {
      next(error);
    }
  });

  const updateRedirect = async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const redirect = id ? await redirects.getRedirect(id) : null;
      if (!redirect) return notFoundJson(res);

      const result = await redirects.validateRedirect(req.body || {}, { id });
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const updated = await redirects.updateRedirect(id, result.values);
      if (!updated) return notFoundJson(res);

      return res.json({ redirect: redirectJson(updated) });
    } catch (error) {
      next(error);
    }
  };

  api.put("/redirects/:id", ...guard, security.requireCsrf, updateRedirect);
  api.patch("/redirects/:id", ...guard, security.requireCsrf, updateRedirect);

  api.delete("/redirects/:id", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const deleted = id ? await redirects.deleteRedirect(id) : null;
      if (!deleted) return notFoundJson(res);
      return res.json({ ok: true, id: deleted.id, source_path: deleted.source_path });
    } catch (error) {
      next(error);
    }
  });

  return api;
}

module.exports = { registerApi, registerPages };