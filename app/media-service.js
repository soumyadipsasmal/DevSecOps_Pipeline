"use strict";

/**
 * KaliNova — Wikimedia Commons media search (metadata only)
 *
 * This endpoint answers with *information about* files — nothing is ever
 * downloaded, mirrored or attached to an article by it. That distinction is
 * the licence-compliance story for Commons: every file there carries its own
 * licence, and it is the reuser's job to read that licence before publishing
 * the file. So this module:
 *
 *   - returns the image URL, the media page URL, the licence name/URL and the
 *     author/credit when the API provides them
 *   - flags attribution requirements instead of assuming them away
 *   - drops files the API marks non-free or that carry no licence metadata at
 *     all, rather than returning them as if they were safe
 *   - never fetches image bytes; only the search JSON is requested
 *
 * The frontend deliberately has no auto-publish path into articles: an editor
 * reviews licence and attribution before any image enters an article gallery
 * (existing article_images rows already store creator/licence/source).
 *
 * API: action=query&generator=search (namespace 6 = File:), formatversion=2.
 */

const config = require("./config");
const { fetchJson, logUpstreamFailure } = require("./external-http");
const { createCache } = require("./external-cache");
const { run } = require("./circuit-breaker");

const cache = createCache({ maxEntries: 200 });

const SEARCH_TTL_MS = 60 * 60 * 1000;       // 1 hour fresh
const SEARCH_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours of stale fallback

const COMMONS_FILE_BASE = "https://commons.wikimedia.org/wiki/";

/** Raster formats a browser can render directly. SVG/PDF/timelines are skipped. */
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Licence families that need no attribution (used only as a convenience flag). */
const PUBLIC_DOMAIN_PATTERN = /\b(cc0|public domain|pd-?old|no restrictions)\b/i;

/**
 * The licence allowlist for files this site may serve.
 *
 * Only public-domain / CC0 and the attribution licences CC BY and CC BY-SA
 * are accepted. Non-commercial (-nc) and no-derivatives (-nd) variants are
 * rejected outright: KaliNova is an advertising-supported site and resizes
 * thumbnails, neither of which those licences permit. Missing, "fair use",
 * "permission granted" and other human strings are also dropped rather than
 * guessed at — a file that does not clearly carry an allowlisted licence is
 * not served.
 */
function licenseAllowed(rawName) {
  const name = String(rawName || "").trim().toLowerCase();
  if (!name) return false;
  // Reject the families that cannot be used here, whatever their wording.
  if (
    /non-?commercial|by-nc|non-?derivative|by-nd|fair ?use|fair ?dealing|all rights reserved|unknown|unclear|permission|no licence|no license|not verified/i.test(name)
  ) {
    return false;
  }
  return (
    /^(public domain|pd-|pdm|cc0|no restrictions|no known copyright)/i.test(name) ||
    /^(creative commons attribution|cc by)\b/i.test(name) ||
    /\bby-sa\b/i.test(name)
  );
}

function normalizeQuery(raw, maxLength = 120) {
  const query = String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!query || query.length > maxLength) return null;
  return query;
}

/** Strip the HTML the MediaWiki API returns for credit fields. */
function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(p|span|i|b|em|strong)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function metaValue(extmetadata, key) {
  const entry = extmetadata && extmetadata[key];
  return entry && typeof entry.value === "string" ? entry.value : "";
}

function commonsFileUrl(title) {
  // "File:Sunset.jpg" → "https://commons.wikimedia.org/wiki/File:Sunset.jpg"
  return COMMONS_FILE_BASE + String(title || "").replace(/ /g, "_");
}

/**
 * Decide how careful a caller must be about this file.
 * Returns { requiresAttribution, reviewRequired } — never a blanket "free to
 * use": only the file page itself can establish that.
 */
function assessLicence(licenceName, attributionRequiredFlag) {
  const name = String(licenceName || "").trim();
  if (!name) {
    return { requiresAttribution: true, reviewRequired: true, present: false };
  }
  if (PUBLIC_DOMAIN_PATTERN.test(name)) {
    return { requiresAttribution: false, reviewRequired: false, present: true };
  }
  if (attributionRequiredFlag !== "") {
    return {
      requiresAttribution: !/^0$/i.test(attributionRequiredFlag),
      reviewRequired: false,
      present: true
    };
  }
  // Unknown family: assume attribution is needed. "CC BY" and friends match
  // here as well; the safe default and the common case are the same.
  return { requiresAttribution: true, reviewRequired: false, present: true };
}

function extractResults(payload) {
  const query = payload && payload.query;
  let pages = query && query.pages;
  if (!pages) return [];
  // formatversion=2 gives an array; an object map is tolerated anyway.
  const rows = Array.isArray(pages) ? pages : Object.values(pages);

  const results = [];
  for (const page of rows) {
    if (!page || typeof page !== "object") continue;
    const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
    if (!info) continue;

    const mime = String(info.mime || "").toLowerCase();
    if (!ALLOWED_MIME.has(mime)) continue;

    const extmetadata = info.extmetadata || {};
    const licenceName = stripHtml(metaValue(extmetadata, "LicenseShortName") || metaValue(extmetadata, "License"));
    const licenceUrl = stripHtml(metaValue(extmetadata, "LicenseUrl") || metaValue(extmetadata, "License"));
    const isNonFree = /^(true|1|yes)$/i.test(metaValue(extmetadata, "NonFree"));
    if (isNonFree) continue;

    const assessment = assessLicence(licenceName, metaValue(extmetadata, "AttributionRequired"));
    if (!assessment.present) continue; // no licence metadata → not returned at all
    if (!licenseAllowed(licenceName)) continue; // outside the PD / CC0 / CC BY / CC BY-SA allowlist

    const title = String(page.title || "");
    const author = stripHtml(metaValue(extmetadata, "Artist")) || stripHtml(metaValue(extmetadata, "Credit"));
    const pageUrl = commonsFileUrl(title);
    const licenceShort = licenceName.slice(0, 80);

    const attributionParts = [title.replace(/^File:/, "")];
    if (author) attributionParts.push(author);
    if (licenceShort) attributionParts.push(licenceShort);

    results.push({
      title,
      image_url: String(info.url || ""),
      thumb_url: String(info.thumburl || info.url || ""),
      page_url: pageUrl,
      mime,
      width: Number(info.width) || null,
      height: Number(info.height) || null,
      author,
      licence: licenceShort,
      licence_url: /^https?:\/\//.test(licenceUrl) ? licenceUrl : "",
      attribution: attributionParts.join(" — "),
      requires_attribution: assessment.requiresAttribution,
      review_required: assessment.reviewRequired,
      source: "Wikimedia Commons"
    });
  }
  return results;
}

async function search(rawQuery, limit = 8) {
  const query = normalizeQuery(rawQuery);
  if (!query) {
    const error = new Error("query is required");
    error.status = 400;
    throw error;
  }
  const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 20);

  const key = `commons:${query.toLowerCase()}|${bounded}`;
  const { value } = await cache.getOrLoad(
    key,
    async () => {
      const url =
        `${config.commonsApiUrl}?action=query` +
        `&generator=search&gsrnamespace=6&gsrlimit=${bounded}` +
        `&gsrsearch=${encodeURIComponent(query)}` +
        `&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=600` +
        `&format=json&formatversion=2`;
      const payload = await run("commons", () => fetchJson(url));
      return extractResults(payload);
    },
    { ttlMs: SEARCH_TTL_MS, staleMs: SEARCH_STALE_MS }
  );

  return {
    query,
    results: value,
    note: "Metadata only. Check each file's licence page before reuse; attribution requirements vary per file."
  };
}

module.exports = {
  ALLOWED_MIME,
  assessLicence,
  commonsFileUrl,
  extractResults,
  licenseAllowed,
  normalizeQuery,
  search,
  stripHtml
};
