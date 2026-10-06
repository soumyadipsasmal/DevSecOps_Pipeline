"use strict";

/**
 * KaliNova — admin monetization routes
 *
 * Registered onto the two routers admin-routes.js already builds, so these
 * screens inherit the same chain as the dashboard and the article pages:
 *
 *   /admin/ads*          adminPages — HTML, no-store + admin CSP + CSRF +
 *                        authenticated session, then the page guard below
 *   /api/admin/ads*      adminApi   — JSON for the same operations
 *
 * Custom code submitted here is stored, not run: admin-ads-views.js shows it as
 * text and ads-service.getPublicManifest never returns it.
 */

const express = require("express");

const security = require("./security");
const adsService = require("./ads-service");
const adsViews = require("./admin-ads-views");
const { renderNotFoundPage } = require("./admin-views");

function parseId(value) {
  const id = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Settings + placements in one read, since the page shows both. */
async function loadState() {
  const [settings, placements] = await Promise.all([
    adsService.getSettings(),
    adsService.listPlacements()
  ]);

  return { settings, placements };
}

function noticeFrom(query) {
  return typeof query.notice === "string" ? query.notice.slice(0, 200) : "";
}

function notFoundPage(req, res) {
  return res.status(404).type("html").send(renderNotFoundPage({ csrfToken: req.csrfToken }));
}

/* ==================================================================== */
/* HTML pages                                                           */
/* ==================================================================== */

function registerPages(pages) {
  /* ---- settings + list ------------------------------------------------ */

  pages.get("/ads", security.requireAdminPage, async (req, res, next) => {
    try {
      const { settings, placements } = await loadState();

      return res.type("html").send(
        adsViews.renderAdsPage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          settings,
          placements,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      return next(error);
    }
  });

  /* ---- save settings -------------------------------------------------- */

  pages.post("/ads/settings", security.requireCsrf, security.requireAdminPage, async (req, res, next) => {
    try {
      // An unticked checkbox is absent from the body, so it has to be sent as an
      // explicit "0" to be read as "switch this off" rather than "leave it".
      const result = await adsService.updateSettings({
        ads_enabled: req.body?.ads_enabled ? "1" : "0",
        adsense_enabled: req.body?.adsense_enabled ? "1" : "0",
        adsense_script_enabled: req.body?.adsense_script_enabled ? "1" : "0",
        consent_required: req.body?.consent_required ? "1" : "0",
        adsense_client: req.body?.adsense_client,
        consent_script_url: req.body?.consent_script_url
      });

      if (!result.ok) {
        const { settings, placements } = await loadState();

        return res
          .status(422)
          .type("html")
          .send(
            adsViews.renderAdsPage({
              admin: req.admin,
              csrfToken: req.csrfToken,
              // The rejected input is echoed back so a typo can be corrected.
              settings: {
                ...settings,
                ads_enabled: Boolean(req.body?.ads_enabled),
                adsense_enabled: Boolean(req.body?.adsense_enabled),
                adsense_script_enabled: Boolean(req.body?.adsense_script_enabled),
                consent_required: Boolean(req.body?.consent_required),
                adsense_client: String(req.body?.adsense_client ?? ""),
                consent_script_url: String(req.body?.consent_script_url ?? "")
              },
              placements,
              errors: result.errors
            })
          );
      }

      return res.redirect(303, "/admin/ads?notice=Settings%20saved.");
    } catch (error) {
      return next(error);
    }
  });

  /* ---- one placement -------------------------------------------------- */

  pages.get("/ads/:id", security.requireAdminPage, (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return next();
    return res.redirect(302, `/admin/ads/${id}/edit`);
  });

  pages.get("/ads/:id/edit", security.requireAdminPage, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const placement = await adsService.getPlacement(id);
      if (!placement) return notFoundPage(req, res);

      return res.type("html").send(
        adsViews.renderPlacementForm({
          admin: req.admin,
          csrfToken: req.csrfToken,
          placement,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      return next(error);
    }
  });

  pages.post("/ads/:id", security.requireCsrf, security.requireAdminPage, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const placement = await adsService.getPlacement(id);
      if (!placement) return notFoundPage(req, res);

      const result = adsService.validatePlacement(req.body, { isNew: false });

      if (!result.ok) {
        return res.status(422).type("html").send(
          adsViews.renderPlacementForm({
            admin: req.admin,
            csrfToken: req.csrfToken,
            placement,
            values: adsViews.submittedValues(req.body),
            errors: result.errors
          })
        );
      }

      await adsService.updatePlacement(id, result.values);

      return res.redirect(303, `/admin/ads?notice=${encodeURIComponent(`${placement.placement_name} was saved.`)}`);
    } catch (error) {
      return next(error);
    }
  });

  return pages;
}

/* ==================================================================== */
/* JSON API                                                             */
/* ==================================================================== */

function registerApi(api) {
  const guard = [security.attachAdmin, security.requireAdmin];

  api.get("/ads/settings", ...guard, async (req, res, next) => {
    try {
      res.json({ settings: await adsService.getSettings() });
    } catch (error) {
      next(error);
    }
  });

  api.put("/ads/settings", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const result = await adsService.updateSettings(req.body || {});
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      return res.json({ settings: result.settings });
    } catch (error) {
      return next(error);
    }
  });

  api.get("/ads/placements", ...guard, async (req, res, next) => {
    try {
      res.json({ placements: await adsService.listPlacements() });
    } catch (error) {
      next(error);
    }
  });

  api.get("/ads/placements/:id", ...guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(404).json({ error: "Placement not found" });

      const placement = await adsService.getPlacement(id);
      if (!placement) return res.status(404).json({ error: "Placement not found" });

      return res.json({ placement });
    } catch (error) {
      return next(error);
    }
  });

  const updatePlacement = async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(404).json({ error: "Placement not found" });

      const result = adsService.validatePlacement(req.body || {}, { isNew: false });
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const saved = await adsService.updatePlacement(id, result.values);
      if (!saved) return res.status(404).json({ error: "Placement not found" });

      return res.json({ placement: await adsService.getPlacement(id) });
    } catch (error) {
      return next(error);
    }
  };

  api.put("/ads/placements/:id", ...guard, security.requireCsrf, updatePlacement);
  api.patch("/ads/placements/:id", ...guard, security.requireCsrf, updatePlacement);

  return api;
}

module.exports = { registerApi, registerPages };