"use strict";

/**
 * KaliNova — map tile health check
 *
 * The map tiles are requested by the reader's browser (Leaflet), so a dead or
 * hostile tile host is invisible to the server's own requests. To keep that
 * section honest, the server performs ONE lightweight probe every
 * MAP_TILE_HEALTHCHECK_MS against the configured tile URL (the 0/0/0 tile).
 *
 * The probe runs through the normal circuit breaker for the tile host:
 *   - any bad answer (403/429/unreachable/timeout) counts for the breaker
 *   - if the breaker opens, mapConfig() reports mapsEnabled:false and the
 *     frontend renders the destination locations as a text index instead of
 *     the map — readers get the place names, never a blank canvas
 *
 * The probe is wrapped in a cross-process lock so several app instances do
 * not all hammer the tile host at once; the winner's result is shared through
 * the persisted breaker state.
 */

const config = require("./config");
const { runExclusive } = require("./background-jobs");
const circuit = require("./circuit-breaker");
const { fetchText } = require("./external-http");

let cachedMapsEnabled = config.enableMaps;

function probeUrl() {
  return config.osmTileUrl
    .replace("{z}", "0")
    .replace("{x}", "0")
    .replace("{y}", "0");
}

async function checkNow() {
  if (!config.enableMaps) {
    cachedMapsEnabled = false;
    const breaker = circuit.getBreaker("map_tiles");
    return breaker.summary();
  }

  const breaker = circuit.getBreaker("map_tiles");
  const gate = await breaker.gate();
  if (!gate.allow) {
    cachedMapsEnabled = false;
    return breaker.summary();
  }

  try {
    await fetchText(probeUrl(), { timeoutMs: Math.min(config.externalFetchTimeoutMs, 4000), maxBytes: 128 * 1024 });
    await breaker.recordResult({ ok: true });
    cachedMapsEnabled = true;
  } catch (error) {
    await breaker.recordResult({ ok: false, error });
    cachedMapsEnabled = false;
  }

  return breaker.summary();
}

async function refreshFromPersistence() {
  const breaker = circuit.getBreaker("map_tiles");
  const guide = await breaker.gate();
  cachedMapsEnabled = guide.allow;
}

function mapsEnabled() {
  return cachedMapsEnabled;
}

async function scheduled() {
  const { skipped } = await runExclusive("map-tile-health", () => checkNow());
  if (skipped) {
    // Another process owns the probe; its breaker state is shared through the
    // database, so re-derive the flag from what it persisted.
    const breaker = circuit.getBreaker("map_tiles");
    const guide = await breaker.gate();
    cachedMapsEnabled = guide.allow;
  }
}

let healthTimer = null;

function start() {
  if (healthTimer) return;
  refreshFromPersistence().catch(() => {});
  healthTimer = setInterval(() => scheduled().catch(() => {}), config.mapTileHealthcheckMs);
  if (typeof healthTimer.unref === "function") healthTimer.unref();
}

module.exports = {
  mapsEnabled,
  checkNow,
  refreshFromPersistence,
  scheduled,
  start
};