"use strict";

/**
 * KaliNova — OpenStreetMap support (geocoding + map configuration)
 *
 * Two public Nominatim calls exist in the whole site: the geocoding lookups
 * behind GET /api/geo/place. Everything else here is local data.
 *
 * Policy compliance (https://operations.osmfoundation.org/policies/nominatim/):
 *   - a descriptive User-Agent with contact details on every request
 *   - hard 1 request/second spacing across the process (see nominatimSlot)
 *   - no bulk or auto-complete querying: each configured destination query is
 *     geocoded at most once and the answer is persisted in PostgreSQL
 *     (external_data_cache) with a 90-day TTL, so page loads never reach
 *     Nominatim at all after the first visit
 *   - failures degrade: a cache/DB/upstream problem answers with an error
 *     from the route and the frontend simply hides the map section
 *
 * Map tiles are NOT fetched here — Leaflet requests them in the browser from
 * the URL configured by OSM_TILE_URL, with the mandatory
 * "© OpenStreetMap contributors" attribution supplied by mapConfig().
 */

const crypto = require("crypto");

const config = require("./config");
const pool = require("./db");
const { fetchJson, logUpstreamFailure } = require("./external-http");
const { createCache } = require("./external-cache");
const circuit = require("./circuit-breaker");
const mapHealth = require("./map-health");
const destinations = require("./travel-destinations");

const memoryCache = createCache({ maxEntries: 200 });

const GEOCODE_FRESH_MS = 10 * 60 * 1000;          // in-process burst window
const GEOCODE_DB_TTL_MS = 90 * 24 * 60 * 60 * 1000; // persisted coordinates
const GEOCODE_DB_TTL_EMPTY_MS = 7 * 24 * 60 * 60 * 1000; // "no such place" refreshes sooner
const NOMINATIM_TIMEOUT_MS = Math.min(config.externalFetchTimeoutMs, 4000);

/* ------------------------------------------------------------------ */
/* Nominatim rate limiting                                             */
/* ------------------------------------------------------------------ */

/* Serialises outgoing geocode requests to at least 1.1s apart, process-wide,
   whatever the caller does. The returned promise resolves when the caller's
   slot arrives. */
let nextSlotAt = 0;

function nominatimSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + 1100;
  if (at === now) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, at - now);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/* ------------------------------------------------------------------ */
/* Persistence (external_data_cache)                                   */
/* ------------------------------------------------------------------ */

function geocodeCacheKey(query) {
  return `geocode:${crypto.createHash("sha256").update(query.toLowerCase()).digest("hex").slice(0, 40)}`;
}

async function dbGet(key) {
  try {
    const result = await pool.query(
      "SELECT payload, expires_at FROM external_data_cache WHERE cache_key = $1",
      [key]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return row.payload;
  } catch (error) {
    // A database hiccup must not break geocoding; the upstream path still works.
    console.warn("[geo] external_data_cache read skipped:", error.message);
    return null;
  }
}

async function dbPut(key, payload, ttlMs) {
  try {
    await pool.query(
      `INSERT INTO external_data_cache (cache_key, source, payload, fetched_at, expires_at)
       VALUES ($1, $2, $3::jsonb, NOW(), $4)
       ON CONFLICT (cache_key)
       DO UPDATE SET payload = EXCLUDED.payload,
                     source = EXCLUDED.source,
                     fetched_at = NOW(),
                     expires_at = EXCLUDED.expires_at`,
      [key, "nominatim", JSON.stringify(payload), new Date(Date.now() + ttlMs)]
    );
  } catch (error) {
    console.warn("[geo] external_data_cache write skipped:", error.message);
  }
}

/* ------------------------------------------------------------------ */
/* Geocoding                                                           */
/* ------------------------------------------------------------------ */

function normalizeNominatimRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(0, 5)
    .map(row => {
      const lat = Number.parseFloat(row && row.lat);
      const lon = Number.parseFloat(row && row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
      return {
        lat,
        lon,
        name: String((row && row.name) || "").slice(0, 120),
        display_name: String((row && row.display_name) || "").slice(0, 200)
      };
    })
    .filter(Boolean);
}

async function fetchFromNominatim(query) {
  await nominatimSlot();
  const url =
    `${config.geocoderUrl}/search?format=jsonv2` +
    `&limit=5&q=${encodeURIComponent(query)}`;
  const rows = await fetchJson(url, { timeoutMs: NOMINATIM_TIMEOUT_MS, maxBytes: 512 * 1024 });
  return normalizeNominatimRows(rows);
}

/**
 * Resolve a place name to coordinates.
 * Order: process cache → PostgreSQL cache → Nominatim (once) → persist.
 *
 * @param {string} rawQuery
 * @returns {Promise<{query: string, results: Array, cached: boolean}>}
 * @throws {ExternalServiceError} when nothing cached and upstream fails
 */
async function geocode(rawQuery) {
  const query = String(rawQuery || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

  if (!query) {
    const error = new Error("query is required");
    error.status = 400;
    throw error;
  }

  const key = geocodeCacheKey(query);

  const mem = memoryCache.get(key);
  if (mem) return { query, results: mem.value.results, cached: true };

  const persisted = await dbGet(key);
  if (persisted && Array.isArray(persisted.results)) {
    memoryCache.set(key, persisted, { ttlMs: GEOCODE_FRESH_MS });
    return { query, results: persisted.results, cached: true };
  }

  // Cache miss: one throttled Nominatim request, then persisted. The request
  // runs through the nominatim breaker: while it is open (or the hourly/daily
  // request envelope is spent) the answer is quiet — an empty result and the
  // frontend hides the map, exactly as it does when the page itself fails.
  const nominatimBreaker = circuit.getBreaker("nominatim");
  const gate = await nominatimBreaker.gate();
  if (!gate.allow) {
    return { query, results: [], cached: false, unavailable: gate.kind };
  }

  let results;
  try {
    results = await fetchFromNominatim(query);
    await nominatimBreaker.recordResult({ ok: true });
  } catch (error) {
    await nominatimBreaker.recordResult({ ok: false, error });
    throw error;
  }

  const payload = { query, results, fetched_at: new Date().toISOString() };

  memoryCache.set(key, payload, { ttlMs: GEOCODE_FRESH_MS });
  await dbPut(
    key,
    payload,
    results.length ? GEOCODE_DB_TTL_MS : GEOCODE_DB_TTL_EMPTY_MS
  );

  return { query, results, cached: false };
}

/* ------------------------------------------------------------------ */
/* Map configuration / destinations                                    */
/* ------------------------------------------------------------------ */

function mapConfig() {
  return {
    tileUrl: config.osmTileUrl,
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
    attributionUrl: "https://www.openstreetmap.org/copyright",
    geocoder: "Nominatim (OpenStreetMap)",
    // A live server-side probe watches the tile host through a circuit
    // breaker; while the host is unreachable the frontend renders a text
    // destination index instead of a blank map.
    mapsEnabled: config.enableMaps && mapHealth.mapsEnabled()
  };
}

/** The configured destination list, in a shape safe to hand to the frontend. */
function listDestinations() {
  return destinations
    .filter(entry => entry && entry.id && entry.name && entry.query)
    .map(entry => ({
      id: String(entry.id),
      name: String(entry.name),
      region: String(entry.region || "").slice(0, 120),
      query: String(entry.query).slice(0, 160),
      wikidataId: /^Q[1-9][0-9]{0,8}$/.test(String(entry.wikidataId || "")) ? entry.wikidataId : null,
      places: (Array.isArray(entry.places) ? entry.places : [])
        .filter(place => place && place.name && place.query)
        .slice(0, 12)
        .map(place => ({
          name: String(place.name).slice(0, 120),
          query: String(place.query).slice(0, 160)
        }))
    }));
}

module.exports = {
  geocode,
  geocodeCacheKey,
  listDestinations,
  mapConfig,
  normalizeNominatimRows,
  nominatimSlot
};
