"use strict";

/**
 * KaliNova — admin integrations & safety routes
 *
 * Registered onto the same two routers as the other admin screens, so these
 * inherit the full chain (no-store, admin CSP, CSRF, authenticated session)
 * from admin-routes.js:
 *
 *   /admin/integrations                        list breaker + feature state
 *   /admin/integrations/:service/disable       manual stop (reason recorded)
 *   /admin/integrations/:service/enable        restore automatic protection
 *
 * The JSON mirror under /api/admin/integrations exists for scripted review
 * and for the same operations. Every state change is recorded in
 * integration_events through the circuit breaker store.
 */

const express = require("express");

const security = require("./security");
const config = require("./config");
const circuit = require("./circuit-breaker");
const mapHealth = require("./map-health");
const integrationsViews = require("./admin-integrations-views");

const SERVICE_PATTERN = /^[a-z0-9:_-]{1,60}$/i;

function readService(value) {
  const raw = String(value || "");
  if (!SERVICE_PATTERN.test(raw)) return null;
  return raw;
}

function readReason(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

async function loadState() {
  const summaries = await circuit.listSummaries();
  return {
    summaries,
    config: {
      enableWikidata: Boolean(config.enableWikidata),
      enableCommons: Boolean(config.enableCommons),
      enableMaps: Boolean(config.enableMaps),
      enableRss: Boolean(config.enableRss)
    },
    mapsEnabled: mapHealth.mapsEnabled()
  };
}

function noticeFrom(query) {
  return typeof query.notice === "string" ? query.notice.slice(0, 200) : "";
}

/* ==================================================================== */
/* HTML pages                                                           */
/* ==================================================================== */

function registerPages(pages) {
  pages.get("/integrations", security.requireAdminPage, async (req, res, next) => {
    try {
      const state = await loadState();
      return res.type("html").send(
        integrationsViews.renderIntegrationsPage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          ...state,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      return next(error);
    }
  });

  pages.post(
    "/integrations/:service/disable",
    security.requireCsrf,
    security.requireAdminPage,
    async (req, res, next) => {
      try {
        const service = readService(req.params.service);
        if (!service) {
          return res.redirect(303, "/admin/integrations?notice=Unknown%20service.");
        }
        await circuit.adminSetManual(service, { off: true, reason: readReason(req.body?.reason) });
        return res.redirect(303, `/admin/integrations?notice=${encodeURIComponent(`${service} was disabled manually.`)}`);
      } catch (error) {
        return next(error);
      }
    }
  );

  pages.post(
    "/integrations/:service/enable",
    security.requireCsrf,
    security.requireAdminPage,
    async (req, res, next) => {
      try {
        const service = readService(req.params.service);
        if (!service) {
          return res.redirect(303, "/admin/integrations?notice=Unknown%20service.");
        }
        await circuit.adminReset(service);
        return res.redirect(303, `/admin/integrations?notice=${encodeURIComponent(`${service} was re-enabled.`)}`);
      } catch (error) {
        return next(error);
      }
    }
  );

  return pages;
}

/* ==================================================================== */
/* JSON API                                                             */
/* ==================================================================== */

function registerApi(api) {
  const guard = [security.attachAdmin, security.requireAdmin];

  api.get("/integrations", ...guard, async (req, res, next) => {
    try {
      res.json(await loadState());
    } catch (error) {
      next(error);
    }
  });

  api.post(
    "/integrations/:service/disable",
    ...guard,
    security.requireCsrf,
    async (req, res, next) => {
      try {
        const service = readService(req.params.service);
        if (!service) return res.status(400).json({ error: "Unknown service" });

        const summary = await circuit.adminSetManual(service, {
          off: true,
          reason: readReason(req.body?.reason)
        });
        return res.json({ summary });
      } catch (error) {
        return next(error);
      }
    }
  );

  api.post(
    "/integrations/:service/enable",
    ...guard,
    security.requireCsrf,
    async (req, res, next) => {
      try {
        const service = readService(req.params.service);
        if (!service) return res.status(400).json({ error: "Unknown service" });

        await circuit.adminReset(service);
        return res.json({ summary: await circuit.getBreaker(service).summary() });
      } catch (error) {
        return next(error);
      }
    }
  );

  return api;
}

module.exports = { registerApi, registerPages };