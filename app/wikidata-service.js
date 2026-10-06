"use strict";

/**
 * KaliNova — Wikidata (structured facts only)
 *
 * Wikidata's data is released under CC0 (public domain dedication), so facts
 * read from it may be used freely, including commercially, with no attribution
 * obligation (we still link the source — see docs/external-data-licenses.md).
 *
 * Wikipedia article *text* is CC BY-SA and is deliberately never fetched or
 * copied here. This module only reads Wikidata's structured API:
 *
 *   search(query)  wbsearchentities → id / label / description / source URL
 *   getEntity(id)  wbgetentities    → label, description and a curated set of
 *                                     facts (dates, places, roles, coordinates…)
 *
 * Design notes
 *   - Q-ids are the only thing accepted by getEntity: no caller-controlled
 *     free-form IDs reach the API.
 *   - Missing labels, claims or sub-entities are normal and are represented
 *     as absent fields, never as errors.
 *   - Referenced entity ids (a director, a cast member) are resolved in ONE
 *     batched follow-up request so a fact renders as "Satyajit Ray", not "Q57340".
 *   - Results run through the shared cache; upstream failures surface as
 *     ExternalServiceError and are turned into a generic 5xx by the routes.
 */

const config = require("./config");
const { fetchJson, logUpstreamFailure } = require("./external-http");
const { createCache } = require("./external-cache");
const { run } = require("./circuit-breaker");

const cache = createCache({ maxEntries: 300 });

const SEARCH_TTL_MS = 60 * 60 * 1000;        // 1 hour fresh
const SEARCH_STALE_MS = 24 * 60 * 60 * 1000; // …and a day of stale fallback
const ENTITY_TTL_MS = 24 * 60 * 60 * 1000;   // entities: a day fresh
const ENTITY_STALE_MS = 7 * 24 * 60 * 60 * 1000; // …a week of stale fallback

/**
 * The properties this site renders, with their human labels. A fixed list
 * keeps responses small and keeps arbitrary Wikidata properties (including
 * vandalised or obscure ones) out of the page. Everything here is a plain
 * label — no code ever executes property content.
 */
const PROPERTY_LABELS = {
  P31: "instance of",
  P17: "country",
  P19: "place of birth",
  P27: "country of citizenship",
  P57: "director",
  P105: "taxon rank",
  P106: "occupation",
  P131: "located in administrative entity",
  P136: "genre",
  P141: "conservation status",
  P161: "cast member",
  P170: "creator",
  P225: "taxon name",
  P276: "location",
  P279: "subclass of",
  P364: "original language of work",
  P495: "country of origin",
  P569: "date of birth",
  P575: "discovery or creation date",
  P577: "publication date",
  P625: "coordinate location",
  P921: "main subject",
  P1082: "population",
  P2044: "elevation"
};

/** Accepted entity ids: Q1 … Q999999999. */
const ENTITY_ID_PATTERN = /^Q[1-9][0-9]{0,8}$/;

/**
 * Unit entity ids that appear in the facts above, as display labels.
 * Verified against Wikidata (Q11573 = metre); anything absent from this map
 * falls back to "(Q…)" in the rendered fact, never to a unit-less number.
 */
const UNIT_LABELS = {
  Q11573: "m"
};

function normalizeQuery(raw, maxLength = 120) {
  const query = String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!query || query.length > maxLength) return null;
  return query;
}

function wikidataEntityUrl(id) {
  return `https://www.wikidata.org/wiki/${id}`;
}

/** wbsearchentities, formatversion=2. */
function extractSearchResults(payload) {
  const rows = Array.isArray(payload && payload.search) ? payload.search : [];
  return rows
    .filter(row => ENTITY_ID_PATTERN.test(String(row && row.id || "")))
    .slice(0, 20)
    .map(row => ({
      id: row.id,
      label: String(row.label || row.id),
      description: String(row.description || ""),
      url: wikidataEntityUrl(row.id)
    }));
}

/**
 * Render one snak datavalue as display text.
 * Returns null for anything that should simply be skipped.
 */
function formatDataValue(datavalue) {
  if (!datavalue || typeof datavalue !== "object") return null;
  const type = datavalue.type;
  const value = datavalue.value;
  if (value === undefined || value === null) return null;

  if (type === "time" && typeof value.time === "string") {
    // Wikidata times look like "+1969-08-05T00:00:00Z" or "-0044-03-15T00:00:00Z".
    const match = value.time.match(/^([+-])(\d+)-(\d{2})-(\d{2})/);
    if (!match) return null;
    const year = Number.parseInt(match[2], 10);
    if (!Number.isInteger(year)) return null;
    const month = match[3];
    const day = match[4];
    if (year === 0) return null;
    const sign = match[1] === "-" ? " BCE" : "";
    const yearText = sign ? String(year - 1 || 1) + sign : String(year);
    if (sign) return yearText;
    // Precision below "day" is common (year-only dates give 00 month/day).
    if (month === "00") return yearText;
    if (day === "00") return `${yearText}-${month}`;
    return `${yearText}-${month}-${day}`;
  }

  if (type === "entityid" || (value && typeof value === "object" && ENTITY_ID_PATTERN.test(String(value.id || "")))) {
    const id = String(value.id || "");
    return ENTITY_ID_PATTERN.test(id) ? id : null; // resolved to a label later
  }

  if (type === "wikibase-entityid" && value && typeof value === "object") {
    const id = String(value.id || "");
    return ENTITY_ID_PATTERN.test(id) ? id : null;
  }

  if (type === "string") return String(value).slice(0, 200);

  if (type === "monolingualtext" && value && typeof value === "object") {
    return String(value.text || "").slice(0, 200) || null;
  }

  if (type === "geo-coordinate" && value && typeof value === "object") {
    const lat = Number(value.latitude);
    const lon = Number(value.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  }

  if (type === "quantity" && value && typeof value === "object") {
    const amount = Number(value.amount);
    if (!Number.isFinite(amount)) return null;
    // Unit URIs are entity ids ("/entity/Q11573"); common units get their
    // human label, and an unknown unit is shown as its id rather than dropped
    // (or worse, rendered as a bare number with no unit at all).
    const unitMatch = typeof value.unit === "string" ? value.unit.match(/\/entity\/(Q\d+)$/) : null;
    const unit = unitMatch && unitMatch[1] !== "Q1" ? unitMatch[1] : null;
    if (!unit) return String(amount);
    const label = UNIT_LABELS[unit];
    return label ? `${amount} ${label}` : `${amount} (${unit})`;
  }

  if (type === "commons-media" && value && typeof value === "object") {
    return String(value.value || "").slice(0, 200) || null;
  }

  if (type === "url") return String(value).slice(0, 300);

  return null;
}

function claimStatements(entity, propertyId) {
  const claims = entity && entity.claims;
  if (!claims || typeof claims !== "object") return [];
  const list = Array.isArray(claims[propertyId]) ? claims[propertyId] : [];
  return list
    .filter(statement => statement && statement.mainsnak && statement.mainsnak.snaktype === "value")
    .map(statement => formatDataValue(statement.mainsnak.datavalue))
    .filter(value => value !== null && value !== "");
}

/**
 * Pull the curated facts out of a raw wbgetentities entity.
 * Only properties in PROPERTY_LABELS are read; everything else is ignored.
 */
function extractFacts(entity) {
  const facts = [];
  for (const [propertyId, label] of Object.entries(PROPERTY_LABELS)) {
    const values = claimStatements(entity, propertyId);
    if (values.length) facts.push({ property: propertyId, label, values: values.slice(0, 8) });
  }
  return facts;
}

/** Entity ids referenced by the facts, capped so a hostile entity cannot fan out. */
function referencedEntityIds(facts, limit = 15) {
  const ids = [];
  for (const fact of facts) {
    for (const value of fact.values) {
      if (typeof value === "string" && ENTITY_ID_PATTERN.test(value)) {
        if (!ids.includes(value)) ids.push(value);
        if (ids.length >= limit) return ids;
      }
    }
  }
  return ids;
}

/**
 * Batch-resolve referenced ids to English labels.
 * One request, best effort: on failure the raw ids remain, which is ugly but
 * never wrong.
 */
async function resolveEntityLabels(ids) {
  if (!ids.length) return {};
  const url =
    `${config.wikidataApiUrl}?action=wbgetentities` +
    `&ids=${encodeURIComponent(ids.join("|"))}` +
    `&props=labels&languages=en&format=json&formatversion=2`;

  try {
    const payload = await run("wikidata", () => fetchJson(url, { timeoutMs: 3000 }));
    const entities = payload && payload.entities;
    const labels = {};
    if (entities && typeof entities === "object") {
      const rows = Array.isArray(entities) ? entities : Object.values(entities);
      for (const row of rows) {
        if (row && row.id && row.labels && row.labels.en && row.labels.en.value) {
          labels[row.id] = String(row.labels.en.value);
        }
      }
    }
    return labels;
  } catch (error) {
    logUpstreamFailure("wikidata-labels", error);
    return {};
  }
}

/** Replace Q-id values with labels where a label was found. */
function applyLabels(facts, labels) {
  return facts.map(fact => ({
    ...fact,
    values: fact.values.map(value =>
      typeof value === "string" && ENTITY_ID_PATTERN.test(value)
        ? labels[value] || value
        : value
    ),
    linked: fact.values.some(value => typeof value === "string" && ENTITY_ID_PATTERN.test(value))
  }));
}

function extractEntity(id, payload) {
  const rawEntities = payload && payload.entities;
  let entity = null;
  if (rawEntities && typeof rawEntities === "object") {
    entity = Array.isArray(rawEntities) ? rawEntities[0] : rawEntities[id];
  }
  if (!entity || entity.missing !== undefined) return null;

  const label =
    (entity.labels && entity.labels.en && entity.labels.en.value) ||
    (entity.labels ? Object.values(entity.labels)[0]?.value : "") || id;
  const description =
    (entity.descriptions && entity.descriptions.en && entity.descriptions.en.value) || "";

  const facts = extractFacts(entity);

  return {
    id,
    label: String(label),
    description: String(description),
    url: wikidataEntityUrl(id),
    facts,
    // Deferred: getEntity resolves referenced ids to labels before answering.
    _referencedIds: referencedEntityIds(facts)
  };
}

/** Public shape (no internal bookkeeping fields). */
function toPublicEntity(id, entity, labels) {
  return {
    id: entity.id || id,
    label: entity.label,
    description: entity.description,
    url: entity.url,
    facts: applyLabels(entity.facts, labels),
    source: { name: "Wikidata", license: "CC0 1.0", url: entity.url }
  };
}

async function search(rawQuery, limit = 8) {
  const query = normalizeQuery(rawQuery);
  if (!query) {
    const error = new Error("query is required");
    error.status = 400;
    throw error;
  }
  const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 20);

  const key = `search:${query.toLowerCase()}|${bounded}`;
  const { value } = await cache.getOrLoad(
    key,
    async () => {
      const url =
        `${config.wikidataApiUrl}?action=wbsearchentities` +
        `&search=${encodeURIComponent(query)}` +
        `&language=en&uselang=en&type=item&limit=${bounded}` +
        `&format=json&formatversion=2`;
      const payload = await run("wikidata", () => fetchJson(url));
      return extractSearchResults(payload);
    },
    { ttlMs: SEARCH_TTL_MS, staleMs: SEARCH_STALE_MS }
  );

  return { query, results: value };
}

async function getEntity(rawId) {
  const id = String(rawId || "").trim().toUpperCase();
  if (!ENTITY_ID_PATTERN.test(id)) {
    const error = new Error("entity id must look like Q123");
    error.status = 400;
    throw error;
  }

  const { value } = await cache.getOrLoad(
    `entity:${id}`,
    async () => {
      const url =
        `${config.wikidataApiUrl}?action=wbgetentities` +
        `&ids=${id}&props=labels|descriptions|claims` +
        `&languages=en&format=json&formatversion=2`;
      const payload = await run("wikidata", () => fetchJson(url));
      const entity = extractEntity(id, payload);
      if (!entity) {
        const notFound = new Error("entity not found");
        notFound.status = 404;
        throw notFound;
      }
      const labels = await resolveEntityLabels(entity._referencedIds);
      return toPublicEntity(id, entity, labels);
    },
    { ttlMs: ENTITY_TTL_MS, staleMs: ENTITY_STALE_MS }
  );

  return value;
}

module.exports = {
  ENTITY_ID_PATTERN,
  PROPERTY_LABELS,
  applyLabels,
  claimStatements,
  extractEntity,
  extractFacts,
  extractSearchResults,
  formatDataValue,
  getEntity,
  normalizeQuery,
  referencedEntityIds,
  resolveEntityLabels,
  search,
  wikidataEntityUrl
};
