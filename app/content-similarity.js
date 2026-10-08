"use strict";

/**
 * KaliNova — copy-similarity warning
 *
 * Compares an article body against the external reference material the editor
 * attached to it and reports how much of the body is word-for-word the same.
 *
 * This is an editorial nudge, not a plagiarism detector: it uses word n-gram
 * containment over the two texts, has no index of anyone else's writing, and
 * reaches no legal conclusion. Nothing here ever blocks a save or a draft.
 *
 * Method: both texts are reduced to a token stream, split into 5-word shingles,
 * The score is the share of the article's shingles that also occur in a
 * reference.
 * 1.0 means every 5-word run of the article was found in that reference; 0.0
 * means none was. Word shingles rather than characters, so ordinary phrases
 * shared by any two texts about the same subject do not move the number.
 *
 * No dependencies, no I/O, no network: the inputs are strings the caller
 * already has, which keeps this unit-testable offline like the rest of the CMS
 * suite.
 */

const DEFAULT_SHINGLE_SIZE = 5;
const DEFAULT_WARN_PERCENT = 35;
// Below this many tokens a text is too short for 5-word runs to mean anything.
const MIN_ARTICLE_TOKENS = 20;
const MAX_TEXT_CHARS = 200000;

const { stripTags } = require("./article-html");

/** The percentage of an article that must match before we say anything. */
function warnThreshold(options = {}) {
  if (Number.isFinite(options.threshold) && options.threshold >= 0 && options.threshold <= 1) {
    return options.threshold;
  }

  const raw = Number.parseInt(String(process.env.SIMILARITY_WARN_PERCENT || ""), 10);
  const percent = Number.isInteger(raw) && raw >= 5 && raw <= 100 ? raw : DEFAULT_WARN_PERCENT;
  return percent / 100;
}

/** Lower-cased words with the punctuation removed, or [] for unusable input. */
function tokenize(input) {
  const text = stripTags(String(input || ""))
    .slice(0, MAX_TEXT_CHARS)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text ? text.split(" ") : [];
}

/** Every consecutive run of `size` words, de-duplicated. */
function shingles(tokens, size = DEFAULT_SHINGLE_SIZE) {
  const out = new Set();
  if (tokens.length < size) return out;

  for (let i = 0; i <= tokens.length - size; i += 1) {
    out.add(tokens.slice(i, i + size).join(" "));
  }
  return out;
}

/**
 * Score an article body against one or more reference texts.
 *
 * @param {string} articleText plain text or HTML of the body being saved
 * @param {Array<{name?: string, text?: string}>} references attached research
 * @param {{threshold?: number, shingleSize?: number}} [options]
 * @returns {{ratio: number, percent: number, flagged: boolean,
 *            threshold: number, checked: number, worst: object|null,
 *            matches: object[]}}
 */
function score(articleText, references = [], options = {}) {
  const threshold = warnThreshold(options);
  const size = Number.isInteger(options.shingleSize) && options.shingleSize >= 2
    ? options.shingleSize
    : DEFAULT_SHINGLE_SIZE;

  const empty = {
    ratio: 0,
    percent: 0,
    flagged: false,
    threshold,
    checked: 0,
    worst: null,
    matches: []
  };

  const articleTokens = tokenize(articleText);
  if (articleTokens.length < MIN_ARTICLE_TOKENS) return empty;

  const articleShingles = shingles(articleTokens, size);
  if (articleShingles.size === 0) return empty;

  const list = Array.isArray(references) ? references : [];
  const matches = [];

  for (const reference of list) {
    if (!reference || typeof reference !== "object") continue;

    const referenceTokens = tokenize(
      reference.text === undefined ? reference.reference_text : reference.text
    );
    if (referenceTokens.length < size) continue;

    const referenceShingles = shingles(referenceTokens, size);
    if (referenceShingles.size === 0) continue;

    let hit = 0;
    for (const gram of articleShingles) {
      if (referenceShingles.has(gram)) hit += 1;
    }

    const ratio = hit / articleShingles.size;
    matches.push({
      name: String(reference.name || reference.source_name || reference.sourceName || "reference").slice(0, 200),
      ratio,
      percent: Math.round(ratio * 100)
    });
  }

  if (matches.length === 0) return { ...empty, threshold };

  matches.sort((a, b) => b.ratio - a.ratio);
  const worst = matches[0];

  return {
    ratio: worst.ratio,
    percent: worst.percent,
    flagged: worst.ratio >= threshold,
    threshold,
    checked: matches.length,
    worst,
    matches
  };
}

module.exports = {
  DEFAULT_SHINGLE_SIZE,
  DEFAULT_WARN_PERCENT,
  MIN_ARTICLE_TOKENS,
  score,
  shingles,
  stripHtml: stripTags,
  tokenize,
  warnThreshold
};
