"use strict";

/**
 * KaliNova — public open-data API (/api/…)
 *
 * Read-only endpoints that proxy a small set of free public services on behalf
 * of the frontend. Everything here is GET, cacheable and rate limited:
 *
 *   GET /api/wikidata/search?q=&limit=    Wikidata entity search   (CC0)
 *   GET /api/wikidata/entity/:id          curated facts for a Q-id (CC0)
 *   GET /api/media/search?q=&limit=       Commons file *metadata*  (per-file licences)
 *   GET /api/geo/config                   tile URL + attribution    (© OpenStreetMap contributors)
 *   GET /api/geo/destinations             configured travel map     (config, no upstream call)
 *   GET /api/geo/place?q=                 geocode via Nominatim     (cached in PostgreSQL)
 *   GET /api/news/latest?category=&limit= reviewed RSS headline strip
 *
 * Rules that apply to every handler in this file:
 *   - invalid input answers 400 with a fixed message; nothing the caller
 *     sends is echoed back, and upstream error details never reach a response
 *   - an unreachable, timed-out or broken upstream answers 503 with one
 *     generic message (the details go to the server log only)
 *   - the two endpoints that fan out per keystroke (search, geocode) are
 *     rate limited per IP; /news/latest is local-first and self-throttles
 *     through the single-flight refresh in rss-service
 *   - successful responses carry Cache-Control so a browser reuses the
 *     answer instead of re-hitting the origin
 *
 * There is no write path here: the public API of this site cannot mutate
 * anything, and the admin API lives behind its own session + CSP.
 */

const express = require("express");

const config = require("./config");
const security = require("./security");
const wikidata = require("./wikidata-service");
const media = require("./media-service");
const geo = require("./geo-service");
const { defaultService: rssFeedService } = require("./rss-service");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * Per-IP sliding window built on the project's existing limiter, so this
 * endpoint family behaves like the admin login limiter (same keying, same
 * Retry-After contract) instead of introducing a second implementation.
 */
function createRequestLimiter({ windowMs, maxAttempts, message }) {
  const limiter = security.createLoginLimiter({
    windowMs,
    maxAttempts,
    keyFor: req => String(req.ip || "unknown")
  });

  return (req, res, next) => {
    const key = limiter.keyFor(req);
    const retry = limiter.check(key);
    if (retry !== null) {
      res.set("Retry-After", String(retry));
      return res.status(429).json({ error: message });
    }
    limiter.record(key);
    return next();
  };
}

const searchLimiter = createRequestLimiter({
  windowMs: 60 * 1000,
  maxAttempts: 30,
  message: "Too many requests. Try again shortly."
});

const geocodeLimiter = createRequestLimiter({
  windowMs: 60 * 1000,
  maxAttempts: 20,
  message: "Too many requests. Try again shortly."
});

/* ------------------------------------------------------------------ */
/* Input helpers                                                       */
/* ------------------------------------------------------------------ */

/** Trimmed single-line string, or null when the input is unusable. */
function readQuery(raw, maxLength = 120) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null; // ?q=a&q=b and friends
  const value = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value || value.length > maxLength) return null;
  return value;
}

/** Integer in [min, max], the default when absent, or null when invalid. */
function readLimit(raw, { fallback, min, max }) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  if (value < min || value > max) return null;
  return value;
}

/** Category slug (categories.slug), "" for "all", or null when invalid. */
function readCategory(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return "";
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(value)) return null;
  return value;
}

/** Map any thrown error onto a safe JSON response. */
function sendFailure(res, error) {
  const status = error && Number.isInteger(error.status) ? error.status : 503;

  if (status === 400) return res.status(400).json({ error: "Invalid request" });
  if (status === 404) return res.status(404).json({ error: "Not found" });

  console.warn("[external] upstream failure:", error && error.message ? error.message : error);
  return res.status(503).json({ error: "Data service temporarily unavailable. Try again shortly." });
}

function setCache(res, seconds) {
  res.set("Cache-Control", `public, max-age=${seconds}`);
}

const WIKIDATA_SOURCE = {
  name: "Wikidata",
  license: "CC0 1.0",
  url: "https://www.wikidata.org/"
};

/* ------------------------------------------------------------------ */
/* Wikidata                                                            */
/* ------------------------------------------------------------------ */

router.get("/wikidata/search", searchLimiter, async (req, res) => {
  if (!config.enableWikidata) return res.status(404).json({ error: "Not found" });
  const query = readQuery(req.query.q);
  if (!query) return res.status(400).json({ error: "Query parameter q is required" });

  const limit = readLimit(req.query.limit, { fallback: 8, min: 1, max: 20 });
  if (limit === null) return res.status(400).json({ error: "limit must be between 1 and 20" });

  try {
    const data = await wikidata.search(query, limit);
    setCache(res, 300);
    return res.json({
      query: data.query,
      results: data.results.slice(0, limit),
      source: WIKIDATA_SOURCE
    });
  } catch (error) {
    return sendFailure(res, error);
  }
});

router.get("/wikidata/entity/:id", async (req, res) => {
  if (!config.enableWikidata) return res.status(404).json({ error: "Not found" });
  const id = String(req.params.id || "").trim().toUpperCase();
  if (!wikidata.ENTITY_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "Entity id must look like Q123" });
  }

  try {
    const entity = await wikidata.getEntity(id);
    setCache(res, 3600);
    return res.json(entity);
  } catch (error) {
    return sendFailure(res, error);
  }
});

/* ------------------------------------------------------------------ */
/* Wikimedia Commons (metadata only)                                   */
/* ------------------------------------------------------------------ */

router.get("/media/search", searchLimiter, async (req, res) => {
  if (!config.enableCommons) return res.status(404).json({ error: "Not found" });
  const query = readQuery(req.query.q);
  if (!query) return res.status(400).json({ error: "Query parameter q is required" });

  const limit = readLimit(req.query.limit, { fallback: 8, min: 1, max: 20 });
  if (limit === null) return res.status(400).json({ error: "limit must be between 1 and 20" });

  try {
    const data = await media.search(query, limit);
    setCache(res, 300);
    return res.json(data);
  } catch (error) {
    return sendFailure(res, error);
  }
});

/* ------------------------------------------------------------------ */
/* OpenStreetMap                                                       */
/* ------------------------------------------------------------------ */

router.get("/geo/config", (req, res) => {
  setCache(res, 86400);
  return res.json(geo.mapConfig());
});

router.get("/geo/destinations", (req, res) => {
  setCache(res, 300);
  return res.json({ map: geo.mapConfig(), destinations: geo.listDestinations() });
});

router.get("/geo/place", geocodeLimiter, async (req, res) => {
  if (!config.enableMaps) return res.status(404).json({ error: "Not found" });
  const query = readQuery(req.query.q);
  if (!query) return res.status(400).json({ error: "Query parameter q is required" });

  try {
    const data = await geo.geocode(query);
    setCache(res, 300);
    return res.json(data);
  } catch (error) {
    return sendFailure(res, error);
  }
});

/* ------------------------------------------------------------------ */
/* Reviewed RSS headline strip                                         */
/* ------------------------------------------------------------------ */

router.get("/news/latest", async (req, res) => {
  if (!config.enableRss) return res.status(404).json({ error: "Not found" });
  const category = readCategory(req.query.category);
  if (category === null) return res.status(400).json({ error: "Unknown category" });

  const limit = readLimit(req.query.limit, { fallback: 20, min: 1, max: 50 });
  if (limit === null) return res.status(400).json({ error: "limit must be between 1 and 50" });

  try {
    const data = await rssFeedService.getLatest({ category, limit });
    setCache(res, data.items.length ? 120 : 30);
    return res.json(data);
  } catch (error) {
    return sendFailure(res, error);
  }
});

module.exports = { externalApi: router };
