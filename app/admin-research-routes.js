"use strict";

/**
 * KaliNova — admin research route (/api/admin/research)
 *
 * One GET endpoint that lets an editor look up material while drafting, from
 * the same four free public sources the site already uses:
 *
 *   source=wikidata&q=…        entity search            (CC0 1.0)
 *   source=wikidata&entity=Q…  curated facts for a Q-id (CC0 1.0)
 *   source=commons&q=…         Commons file metadata    (per-file licences)
 *   source=geo&q=…             Nominatim geocode        (ODbL, © OpenStreetMap)
 *   source=news[&category=…]   reviewed RSS headlines   (per-feed licences)
 *
 * What this endpoint deliberately does not do:
 *   - it has no write path. It cannot save, publish or edit an article, and it
 *     returns no form field the browser will submit back into the body.
 *   - it never returns credentials, environment values or upstream internals.
 *     Each result is an explicit allowlist of fields.
 *   - it does not fetch media. Commons results are file *metadata* — a title, a
 *     description and the licence — never the image bytes.
 *
 * The panel "attaches as reference": the editor stores the returned record as
 * provenance (article_research_metadata) so the copy-similarity warning can
 * later compare the finished body against what was consulted. Nothing here is
 * ever pasted into the article body automatically.
 *
 * Auth: registered onto adminApi by admin-routes.js, so it already sits behind
 * no-store; the guard below adds the session check. A rate limiter built from
 * the project's own limiter keeps one editor from fanning out across an
 * upstream API.
 */

const config = require("./config");
const security = require("./security");
const wikidata = require("./wikidata-service");
const media = require("./media-service");
const geo = require("./geo-service");
const { defaultService: rssFeedService } = require("./rss-service");

const DISCLAIMER =
  "Research material only. Re-check the source before you publish, quote it in your own words, and keep the licence and attribution.";

const SOURCES = {
  wikidata: { key: "wikidata", name: "Wikidata", license: "CC0 1.0", url: "https://www.wikidata.org/" },
  commons: { key: "commons", name: "Wikimedia Commons", license: "See each file", url: "https://commons.wikimedia.org/" },
  geo: { key: "geo", name: "OpenStreetMap / Nominatim", license: "ODbL 1.0", url: "https://www.openstreetmap.org/copyright" },
  news: { key: "news", name: "Reviewed RSS feeds", license: "Per-feed terms", url: "https://kalinova.in/" }
};

function createResearchLimiter({ windowMs, maxAttempts, message }) {
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

const limitResearch = createResearchLimiter({
  windowMs: 60 * 1000,
  maxAttempts: 60,
  message: "Too many research lookups. Try again in a minute."
});

/* ==================================================================== */
/* Input helpers                                                         */
/* ==================================================================== */

function readLine(raw, maxLength = 120) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!value || value.length > maxLength) return null;
  return value;
}

function readLimit(raw, { fallback, min, max }) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return value >= min && value <= max ? value : null;
}

function readCategory(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,59}$/.test(value) ? value : null;
}

/** Strip any control characters before a label reaches the response. */
function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/* ==================================================================== */
/* Mappers — the only place upstream shapes become response shapes       */
/* ==================================================================== */

function mapWikidataSearch(payload, source) {
  const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, 20).map(row => ({
    key: clean(row.id, 40),
    name: clean(row.label, 200) || clean(row.id, 40),
    url: typeof row.url === "string" && /^https:\/\//.test(row.url) ? row.url : source.url,
    license: source.license,
    text: clean(`${row.label || ""} — ${row.description || ""}`, 600),
    description: clean(row.description, 400)
  }));

  return { query: payload.query || "", results };
}

function mapWikidataEntity(entity, source) {
  const facts = (Array.isArray(entity.facts) ? entity.facts : []).slice(0, 24).map(fact => ({
    property: clean(fact.label, 80),
    values: (Array.isArray(fact.values) ? fact.values : [])
      .slice(0, 8)
      .map(value => clean(String(value), 200))
      .filter(Boolean)
  }));

  const text = facts
    .slice(0, 8)
    .map(fact => `${fact.property}: ${fact.values.join(", ")}`)
    .join(". ");

  const url = typeof entity.url === "string" && /^https:\/\//.test(entity.url) ? entity.url : source.url;

  return {
    query: clean(entity.id, 40),
    results: [
      {
        key: clean(entity.id, 40),
        name: clean(entity.label, 200) || clean(entity.id, 40),
        url,
        license: source.license,
        text: clean(text || entity.description || "", 4000),
        description: clean(entity.description, 400),
        facts
      }
    ]
  };
}

function mapCommons(payload, source) {
  const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, 20).map(row => {
    const licence = clean(row.licence || row.license, 120) || source.license;
    const author = clean(row.author, 200);
    const pageUrl = typeof row.page_url === "string" && /^https:\/\//.test(row.page_url) ? row.page_url : source.url;

    return {
      key: clean(row.title, 300),
      name: clean(row.title, 300),
      url: pageUrl,
      license: licence,
      // Credit only when the file actually declares an author: an absent
      // attribution stays absent rather than being invented for it.
      attribution: author ? clean(`© ${author}`, 400) : "",
      attribution_required: Boolean(row.attribution_required),
      description: clean(row.description, 400),
      mime: clean(row.mime, 80),
      width: Number.isFinite(Number(row.width)) ? Number(row.width) : null,
      height: Number.isFinite(Number(row.height)) ? Number(row.height) : null,
      thumb_url: typeof row.thumb_url === "string" && /^https:\/\//.test(row.thumb_url) ? row.thumb_url : "",
      image_url: typeof row.image_url === "string" && /^https:\/\//.test(row.image_url) ? row.image_url : "",
      text: clean(`${row.title || ""} — ${row.description || ""} — ${licence}`, 1000)
    };
  });

  return { query: payload.query || "", results };
}

function mapGeo(payload, source) {
  const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, 10).map(row => {
    const name = clean(row.name, 200) || clean(row.display_name, 200);
    const displayName = clean(row.display_name, 300);
    const lat = Number.parseFloat(row.lat);
    const lon = Number.parseFloat(row.lon);

    const url = Number.isFinite(lat) && Number.isFinite(lon)
      ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`
      : source.url;

    return {
      key: displayName || name,
      name: name || displayName,
      url,
      license: source.license,
      attribution: "© OpenStreetMap contributors",
      description: displayName,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      text: clean(`${name} — ${displayName}`, 600)
    };
  });

  return { query: payload.query || "", results };
}

function mapNews(payload) {
  const items = (Array.isArray(payload.items) ? payload.items : []).slice(0, 50).map(item => ({
    key: clean(item.url, 500),
    name: clean(item.title, 300),
    url: typeof item.url === "string" && /^https:\/\//.test(item.url) ? item.url : "",
    // Headline-strip material is quoted as a lead, never reproduced: the feed's
    // own terms govern reuse and are named on the doc, not guessed at here.
    license: clean(item.source, 200) || "See the source feed",
    description: clean(item.description, 600),
    category: clean(item.category, 60),
    published_at: item.published_at || null,
    text: clean(`${item.title || ""} — ${item.description || ""}`, 1000)
  }));

  return { query: "", results: items };
}

/* ==================================================================== */
/* Router                                                                */
/* ==================================================================== */

function sendFailure(res, error) {
  const status = error && Number.isInteger(error.status) ? error.status : 503;

  if (status === 400) return res.status(400).json({ error: "Invalid request" });
  if (status === 404) return res.status(404).json({ error: "Not found" });

  console.warn("[research] upstream failure:", error && error.message ? error.message : error);
  return res.status(503).json({ error: "Data service temporarily unavailable. Try again shortly." });
}

function registerApi(api) {
  const guard = [security.attachAdmin, security.requireAdmin];

  api.get("/research", ...guard, limitResearch, async (req, res) => {
    const source = readLine(req.query.source, 20);
    if (source === null || !SOURCES[source]) {
      return res.status(400).json({ error: "Unknown research source" });
    }

    const meta = SOURCES[source];
    const limit = readLimit(req.query.limit, { fallback: 12, min: 1, max: 20 });
    if (limit === null) return res.status(400).json({ error: "limit must be between 1 and 20" });

    const query = readLine(req.query.q, 120);
    const entity = readLine(req.query.entity, 20);
    const category = readCategory(req.query.category);
    if (query === null || entity === null || category === null) {
      return res.status(400).json({ error: "Invalid request" });
    }

    // Each integration keeps its own environment switch, so a source that has
    // been turned off for the site is not reachable through this panel either.
    const enabled = {
      wikidata: config.enableWikidata,
      commons: config.enableCommons,
      geo: config.enableMaps,
      news: config.enableRss
    };
    if (!enabled[source]) return res.status(404).json({ error: "Not found" });

    try {
      let payload;

      if (source === "wikidata") {
        if (entity) {
          payload = mapWikidataEntity(await wikidata.getEntity(entity.toUpperCase()), meta);
        } else {
          if (!query) return res.status(400).json({ error: "Query parameter q is required" });
          payload = mapWikidataSearch(await wikidata.search(query, limit), meta);
        }
      } else if (source === "commons") {
        if (!query) return res.status(400).json({ error: "Query parameter q is required" });
        payload = mapCommons(await media.search(query, limit), meta);
      } else if (source === "geo") {
        if (!query) return res.status(400).json({ error: "Query parameter q is required" });
        payload = mapGeo(await geo.geocode(query), meta);
      } else {
        payload = mapNews(await rssFeedService.getLatest({ category, limit: Math.min(limit, 30) }));
      }

      return res.json({
        source: meta.key,
        source_name: meta.name,
        license: meta.license,
        source_url: meta.url,
        usage: "research",
        disclaimer: DISCLAIMER,
        retrieved_at: new Date().toISOString(),
        ...payload
      });
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  return api;
}

module.exports = { DISCLAIMER, SOURCES, registerApi };
