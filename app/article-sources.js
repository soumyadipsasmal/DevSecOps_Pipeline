"use strict";

/**
 * KaliNova — editorial sources and research provenance
 *
 * Two related things, deliberately kept apart:
 *
 *   article_sources            citations the editor writes by hand. These are
 *                              published and rendered under the article, so
 *                              every field is validated strictly and nothing
 *                              reaches the page without passing through here.
 *
 *   article_research_metadata  short excerpts of external API material the
 *                              editor consulted while drafting. They are never
 *                              published; they exist so the copy-similarity
 *                              warning can compare a finished body against the
 *                              material it was written from, and so the article
 *                              carries a record of what was looked at.
 *
 * Everything is parameterised. Every function that takes an article id is only
 * ever called from a route the admin session middleware has already guarded,
 * except listPublicSources, which is the one read the public site performs and
 * which selects on published rows itself.
 *
 * Neither table ever stores an API key, token or connection string: the
 * reference rows hold the source's own name, URL and licence label, which are
 * public facts about a public source.
 */

const pool = require("./db");

const MAX_SOURCES = 12;
const MAX_RESEARCH = 20;
const NAME_MAX = 200;
const URL_MAX = 500;
const LICENSE_MAX = 120;
const ATTRIBUTION_MAX = 600;
const REFERENCE_TEXT_MAX = 4000;

/** The integrations the research panel may name. Matches the schema CHECK. */
const SOURCE_KEYS = ["wikidata", "commons", "news", "geo"];

const HTTP_URL = /^https?:\/\/[^\s"'<>\\]{1,490}$/i;

function asString(value) {
  return typeof value === "string" ? value : "";
}

function cleanLine(value, max) {
  return asString(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isBlank(value) {
  return cleanLine(value, ATTRIBUTION_MAX) === "";
}

/* ==================================================================== */
/* Validation                                                           */
/* ==================================================================== */

/**
 * Validate one hand-written citation.
 *
 * @returns {{ ok: true, source: object } | { ok: false, error: string }}
 */
function validateSource(raw, index) {
  const row = raw && typeof raw === "object" ? raw : {};
  const label = `Source ${index + 1}`;

  const name = cleanLine(row.name ?? row.source_name, NAME_MAX);
  const url = asString(row.url ?? row.source_url).trim().slice(0, URL_MAX + 1);
  const license = cleanLine(row.license, LICENSE_MAX);
  const attribution = cleanLine(row.attribution ?? row.attribution_text, ATTRIBUTION_MAX);

  if (name === "" && url === "" && license === "" && attribution === "") {
    return { ok: true, source: null }; // an empty row, simply skipped
  }

  if (name === "") return { ok: false, error: `${label}: a source name is required.` };
  if (name.length > NAME_MAX) return { ok: false, error: `${label}: the name is too long.` };

  if (url === "") return { ok: false, error: `${label}: a source URL is required.` };
  if (url.length > URL_MAX || !HTTP_URL.test(url)) {
    return { ok: false, error: `${label}: the URL must start with http:// or https://.` };
  }

  return {
    ok: true,
    source: {
      source_name: name,
      source_url: url,
      license: license || null,
      attribution_text: attribution || null
    }
  };
}

/**
 * Validate the whole citations repeater.
 *
 * @param {Array} rows
 * @returns {{ ok: boolean, sources?: object[], error?: string, errors?: object }}
 */
function validateSources(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > MAX_SOURCES) {
    return { ok: false, error: `An article can carry at most ${MAX_SOURCES} sources.` };
  }

  const sources = [];
  for (let i = 0; i < list.length; i += 1) {
    const result = validateSource(list[i], i);
    if (!result.ok) return { ok: false, error: result.error, errors: { sources: result.error } };
    if (result.source) sources.push(result.source);
  }

  return { ok: true, sources };
}

/**
 * Normalise research rows coming back from the research panel.
 *
 * These are advisory, so an over-long excerpt is truncated rather than
 * rejected — a save must never fail because of provenance metadata.
 *
 * @param {Array} rows
 * @returns {object[]} always safe to store
 */
function normalizeResearchRefs(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];

  for (const raw of list.slice(0, MAX_RESEARCH)) {
    const row = raw && typeof raw === "object" ? raw : null;
    if (!row) continue;

    const sourceKey = cleanLine(row.source_key ?? row.sourceKey, 40).toLowerCase();
    if (!SOURCE_KEYS.includes(sourceKey)) continue;

    const name = cleanLine(row.name ?? row.source_name, NAME_MAX);
    const url = asString(row.url ?? row.source_url).trim().slice(0, URL_MAX + 1);
    if (!name) continue;

    const text = asString(row.text ?? row.reference_text)
      .replace(/\u0000/g, "")
      .slice(0, REFERENCE_TEXT_MAX);

    out.push({
      source_key: sourceKey,
      source_name: name,
      source_url: HTTP_URL.test(url) ? url : null,
      license: cleanLine(row.license, LICENSE_MAX) || null,
      reference_text: text || null
    });
  }

  return out;
}

/* ==================================================================== */
/* Request body readers                                                 */
/* ==================================================================== */

/**
 * Read the citations repeater out of a form post.
 *
 * The fields are index-numbered (source_name_0, source_url_0, ...) rather than
 * bracketed arrays because the article form is parsed with `extended: false`,
 * and because numbered fields keep the form usable with JavaScript disabled.
 */
function parseSourcesFromBody(body) {
  if (!body || typeof body !== "object") return [];

  const count = Number.parseInt(String(body.source_count ?? ""), 10);
  if (!Number.isInteger(count) || count < 0 || count > MAX_SOURCES) return [];

  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      name: body[`source_name_${i}`],
      url: body[`source_url_${i}`],
      license: body[`source_license_${i}`],
      attribution: body[`source_attribution_${i}`]
    });
  }
  return rows;
}

/**
 * Read the attached research rows out of the hidden JSON field the panel
 * maintains. Anything unparsable becomes "no references", never a save error.
 */
function parseResearchFromBody(body) {
  if (!body || typeof body !== "object") return [];

  const raw = body.research_refs;
  if (typeof raw !== "string" || raw.trim() === "") return [];

  if (raw.length > 512 * 1024) return [];

  try {
    const parsed = JSON.parse(raw);
    return normalizeResearchRefs(parsed);
  } catch {
    return [];
  }
}

/* ==================================================================== */
/* Persistence                                                          */
/* ==================================================================== */

async function listSources(articleId) {
  const { rows } = await pool.query(
    `SELECT id, source_name, source_url, license, attribution_text, position
       FROM article_sources
      WHERE article_id = $1
      ORDER BY position ASC, id ASC`,
    [articleId]
  );
  return rows;
}

async function listResearch(articleId) {
  const { rows } = await pool.query(
    `SELECT id, source_key, source_name, source_url, license, reference_text
       FROM article_research_metadata
      WHERE article_id = $1
      ORDER BY id ASC`,
    [articleId]
  );
  return rows;
}

/**
 * The citations a reader may see. Selects on published rows itself so a draft
 * or an unpublished slug can never leak its reference list.
 */
async function listPublicSources(articleId) {
  const { rows } = await pool.query(
    `SELECT sources.source_name AS name,
            sources.source_url AS url,
            sources.license,
            sources.attribution_text AS attribution
       FROM article_sources sources
       JOIN articles ON articles.id = sources.article_id
      WHERE sources.article_id = $1
        AND articles.status = 'published'
      ORDER BY sources.position ASC, sources.id ASC`,
    [articleId]
  );
  return rows;
}

/** Replace an article's citations. Runs in one transaction. */
async function replaceSources(articleId, rows) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM article_sources WHERE article_id = $1", [articleId]);

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      await client.query(
        `INSERT INTO article_sources
           (article_id, source_name, source_url, license, attribution_text, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [articleId, row.source_name, row.source_url, row.license, row.attribution_text, i]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Replace an article's research provenance. Runs in one transaction. */
async function replaceResearch(articleId, rows) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM article_research_metadata WHERE article_id = $1", [articleId]);

    for (const row of rows) {
      await client.query(
        `INSERT INTO article_research_metadata
           (article_id, source_key, source_name, source_url, license, reference_text)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [articleId, row.source_key, row.source_name, row.source_url, row.license, row.reference_text]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Persist both sets for an article in one round of work. */
async function saveEditorialRefs(articleId, { sources = [], research = [] } = {}) {
  await Promise.all([
    replaceSources(articleId, sources),
    replaceResearch(articleId, research)
  ]);
}

module.exports = {
  ATTRIBUTION_MAX,
  LICENSE_MAX,
  MAX_RESEARCH,
  MAX_SOURCES,
  NAME_MAX,
  REFERENCE_TEXT_MAX,
  SOURCE_KEYS,
  HTTP_URL,
  URL_MAX,
  listPublicSources,
  listResearch,
  listSources,
  normalizeResearchRefs,
  parseResearchFromBody,
  parseSourcesFromBody,
  replaceResearch,
  replaceSources,
  saveEditorialRefs,
  validateSource,
  validateSources
};
