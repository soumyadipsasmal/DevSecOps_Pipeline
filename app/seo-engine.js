"use strict";

/**
 * KaliNova — SEO Engine v1
 *
 * An internal content-quality analyzer for administrators. It evaluates an
 * article while it is being written and on publish, using deterministic rules
 * that run entirely on the server. Nothing here calls an external API, sends
 * article content anywhere, or claims to reproduce Google's ranking algorithm.
 *
 * KaliNova's SEO Score is an internal content-quality metric. It is not a
 * Google ranking score.
 *
 * Architecture:
 *
 *   Article data  ->  analyzeArticle()  ->  report
 *                          |
 *                          +-- categories: onPage / content / technical /
 *                              internalLinks / media / social
 *                          +-- checks (every point is explainable)
 *                          +-- errors / warnings / suggestions
 *                          +-- internalLinkSuggestions
 *                          +-- publish readiness (BLOCKED / NEEDS_REVIEW / READY)
 *
 * The weights (spec section 3):
 *
 *   On-page SEO       30
 *   Content quality   25
 *   Technical SEO     20
 *   Internal linking  10
 *   Media SEO         10
 *   Social metadata    5
 *                    100
 *
 * Determinism: the analyzer performs no I/O. Checks that need the database —
 * duplicate titles, duplicate slugs, broken internal links, related-article
 * suggestions — receive injectable lookup functions via `options.services` so
 * unit tests can run offline and the router wires the real queries.
 *
 * Versioning: the report carries `version: "seo-v1"`. Future engines bump the
 * version so a stored analysis can never be read as another engine's output.
 * (v1 does not persist analyses at all — see docs/seo-engine.md.)
 */

const { stripTags } = require("./article-html");

const VERSION = "seo-v1";

const SEVERITY = {
  ERROR: "ERROR",
  WARNING: "WARNING",
  PASS: "PASS",
  INFO: "INFO"
};

/* Transparent weighted categories (spec section 3). */
const CATEGORY_WEIGHTS = {
  onPage: 30,
  content: 25,
  technical: 20,
  internalLinks: 10,
  media: 10,
  social: 5
};

const CATEGORY_LABELS = {
  onPage: "On-page SEO",
  content: "Content quality",
  technical: "Technical SEO",
  internalLinks: "Internal links",
  media: "Media SEO",
  social: "Social metadata"
};

const DEFAULT_SITE_URL = "https://kalinova.in";

const ALLOWED_IMAGE_TYPES = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif"]);
const ALLOWED_SCHEMA_TYPES = new Set(["Article", "BlogPosting", "NewsArticle", "WebPage"]);
const GENERIC_ALT = new Set(["image", "photo", "banner", "cover", "thumbnail", "picture", "img", "images", "hero"]);

const TITLE_IDEAL_MIN = 30;
const TITLE_IDEAL_MAX = 60;
const META_IDEAL_MIN = 120;
const META_IDEAL_MAX = 160;
const SLUG_IDEAL_MAX = 64;
const BODY_THIN_WORDS = 150;
const PARAGRAPH_LONG_WORDS = 240;
const SENTENCE_LONG_WORDS = 45;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "for", "of", "to",
  "in", "on", "at", "by", "with", "as", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "shall", "should", "can", "could", "may", "might", "must", "it", "its", "this",
  "that", "these", "those", "there", "here", "when", "where", "which", "who",
  "whom", "why", "how", "from", "into", "over", "under", "again", "then", "now",
  "also", "more", "most", "some", "any", "all", "each", "every", "both", "few",
  "other", "such", "only", "own", "same", "very", "just", "about", "what", "not",
  "if", "than", "too", "up", "out", "off", "no", "yes", "via", "per", "e", "g",
  "www", "https", "http"
]);

/* ==================================================================== */
/* Text helpers                                                          */
/* ==================================================================== */

function pick(values, ...keys) {
  for (const key of keys) {
    if (values[key] !== undefined && values[key] !== null) return values[key];
  }
  return undefined;
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value);
}

function tokens(value) {
  const raw = asString(value).toLowerCase();
  return raw.match(/[a-z0-9]+(?:['\u2019-][a-z0-9]+)*/g) || [];
}

function meaningfulTokens(value) {
  return tokens(value).filter(word => {
    if (word.length < 2) return false;
    if (/^[0-9]+$/.test(word)) return false;
    return !STOPWORDS.has(word);
  });
}

function tokenSet(value) {
  return new Set(meaningfulTokens(value));
}

function sentences(text) {
  const parts = asString(text)
    .replace(/\s+/g, " ")
    .split(/[.!?\n]+/)
    .map(part => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [];
}

function paragraphs(text) {
  return asString(text)
    .split(/\n\s*\n+/)
    .map(paragraph => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function bigrams(words) {
  const out = [];
  for (let i = 0; i + 1 < words.length; i += 1) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

function trigrams(words) {
  const out = [];
  for (let i = 0; i + 2 < words.length; i += 1) out.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

function countFrequency(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return counts;
}

function topEntry(counts) {
  let best = null;
  for (const [value, count] of counts) {
    if (!best || count > best[1] || (count === best[1] && value < best[0])) {
      best = [value, count];
    }
  }
  return best || ["", 0];
}

function imageTypeFromUrl(value) {
  const match = asString(value).match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  return match ? match[1].toLowerCase() : "";
}

function filenameFromPath(value) {
  const clean = asString(value).split("?")[0].split("#")[0].replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts.length ? parts[parts.length - 1] : "";
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 10) / 10;
  return Math.max(0, Math.min(100, rounded));
}

/* ==================================================================== */
/* Content parsing                                                       */
/* ==================================================================== */

/**
 * Parse a body into the fragments the checks need. `html` is either raw HTML
 * (body_format "html") or plain text (body_format "text").
 *
 * The parser never executes anything: it reads the sanitised string with
 * regular expressions only, and the router sanitises before calling.
 */
function parseBody(body, format) {
  const input = asString(body);
  const textFormat = String(format || "").toLowerCase() !== "html";
  const text = stripTags(input);

  const headings = [];
  const links = [];
  const images = [];
  const paragraphList = [];

  if (textFormat) {
    for (const line of input.split("\n")) {
      const match = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (match) headings.push({ level: match[1].length, text: match[2].trim() });
    }
  } else {
    const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
    let headingMatch;
    while ((headingMatch = headingPattern.exec(input)) !== null) {
      headings.push({
        level: Number(headingMatch[1]),
        text: stripTags(headingMatch[2]).trim()
      });
    }

    const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi;
    let anchorMatch;
    while ((anchorMatch = anchorPattern.exec(input)) !== null) {
      const tag = anchorMatch[0];
      const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      if (href) links.push({ href: href[1] || href[2] || "" });
    }

    const imagePattern = /<img\b[^>]*>/gi;
    let imageMatch;
    while ((imageMatch = imagePattern.exec(input)) !== null) {
      const tag = imageMatch[0];
      const src = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const alt = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      images.push({ src: src ? src[1] || src[2] : "", alt: alt ? alt[1] || alt[2] : "" });
    }

    const paragraphPattern = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;
    let paragraphMatch;
    while ((paragraphMatch = paragraphPattern.exec(input)) !== null) {
      const paragraphText = stripTags(paragraphMatch[1]).trim();
      if (paragraphText) paragraphList.push(paragraphText);
    }
  }

  return { text, headings, links, images, paragraphList };
}

function isInternalUrl(href) {
  const value = asString(href).trim();
  if (!value || value.startsWith("#") || value.startsWith("?") || value.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    // An absolute external URL, unless it points at the configured site origin.
    return /^https?:\/\//i.test(value) && /kalinova/i.test(value);
  }
  return value.startsWith("/");
}

function pathSlugOf(href) {
  const value = asString(href).split("?")[0].split("#")[0].replace(/\/+$/, "");
  const match = value.match(/^\/(?:blog|stories)\/([^/]+)$/i);
  if (match) return decodeURIComponent(match[1]).toLowerCase();
  return "";
}

/* ==================================================================== */
/* Check helpers                                                         */
/* ==================================================================== */

function pointsFor(severity, max) {
  if (severity === SEVERITY.PASS || severity === SEVERITY.INFO) return max;
  if (severity === SEVERITY.WARNING) return max * 0.5;
  return 0;
}

function buildCheck(list, id, category, severity, message, max) {
  const points = pointsFor(severity, max);
  list.push({ id, category, severity, message, points, max });
  return list[list.length - 1];
}

/* ==================================================================== */
/* Topic / keyword analysis                                              */
/* ==================================================================== */

function deriveTopic(input, explicitKeyword) {
  let topic = "";
  const keywordTokens = explicitKeyword ? meaningfulTokens(explicitKeyword) : [];
  if (keywordTokens.length) {
    return { value: asString(explicitKeyword).trim(), inferred: false, tokens: keywordTokens };
  }

  const headingTopic = input.headings.find(heading => heading.level === 1)?.text
    || input.headings.find(heading => heading.level === 2)?.text
    || "";
  const source = input.title.trim() || headingTopic;
  const derived = meaningfulTokens(source);
  if (!derived.length) return { value: "", inferred: true, tokens: [] };

  // A short, readable label: up to four meaningful tokens joined with spaces.
  const label = derived
    .slice(0, 4)
    .join(" ")
    .replace(/\b(a|an|the)\b/g, "")
    .trim();
  return { value: label || derived[0] || "", inferred: true, tokens: derived };
}

function topicPresentLocations(topicTokens, input) {
  const checks = [];
  const titleTokens = tokenSet(input.title);
  const metaTokens = tokenSet(input.metaDescription);
  const slugTokens = tokenSet(input.slug);
  const firstParagraph = input.paragraphList[0] || input.text.slice(0, 240);
  const firstParagraphTokens = tokenSet(firstParagraph);
  const headingTokens = new Set();
  for (const heading of input.headings) {
    for (const word of meaningfulTokens(heading.text)) headingTokens.add(word);
  }

  if (topicTokens.some(word => titleTokens.has(word))) checks.push("title");
  if (topicTokens.some(word => metaTokens.has(word))) checks.push("meta description");
  if (topicTokens.some(word => slugTokens.has(word))) checks.push("slug");
  if (topicTokens.some(word => firstParagraphTokens.has(word))) checks.push("opening paragraph");
  if (topicTokens.some(word => headingTokens.has(word))) checks.push("headings");

  return {
    present: checks.join(", ") || "nowhere yet",
    title: checks.includes("title"),
    meta: checks.includes("meta description"),
    slug: checks.includes("slug"),
    opening: checks.includes("opening paragraph"),
    headings: checks.includes("headings")
  };
}

/* ==================================================================== */
/* Internal-link suggestion algorithm                                   */
/* ==================================================================== */

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of b) if (a.has(item)) overlap += 1;
  const union = new Set([...a, ...b]);
  return overlap / union.size;
}

function suggestInternalLinks(article, candidates, options) {
  const limit = options.internalLinkLimit || 5;
  const suggestions = [];
  const ownTitleTokens = tokenSet(article.title);
  const bodyText = article.text || article.body || "";
  const bodyTokens = meaningfulTokens(bodyText);
  const bodyFreq = countFrequency(bodyTokens);
  const bodyLeaders = [...bodyFreq.entries()]
    .filter(([, count]) => count >= 3)
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, 60)
    .map(([word]) => word);

  let scoreFor = null;
  if (typeof options.scoreFor === "function") scoreFor = options.scoreFor;
  else scoreFor = () => null;

  for (const candidate of candidates || []) {
    const sameArticle =
      (article.id && candidate.id !== undefined && String(article.id) === String(candidate.id)) ||
      (article.slug && String(candidate.slug) === String(article.slug));
    if (sameArticle) continue;

    const candidateTokens = tokenSet(candidate.title);
    let relevance = 0;
    const sharedTerms = [];

    if (article.categoryId && candidate.category_id !== undefined) {
      if (String(article.categoryId) === String(candidate.category_id)) {
        relevance += 35;
        sharedTerms.push("same category");
      }
    } else if (article.categorySlug && candidate.category_slug) {
      if (String(article.categorySlug) === String(candidate.category_slug)) {
        relevance += 35;
        sharedTerms.push("same category");
      }
    }

    const titleOverlap = jaccard(ownTitleTokens, candidateTokens);
    relevance += Math.round(titleOverlap * 35);

    const bodyOverlap = bodyLeaders.filter(word => candidateTokens.has(word));
    if (bodyOverlap.length) {
      relevance += Math.min(30, bodyOverlap.length * 8);
      sharedTerms.push(...bodyOverlap.slice(0, 3));
    }

    const owned = scoreFor(candidate);
    if (owned !== null) relevance += Math.round(owned);

    if (relevance < 5) continue;

    const uniqueShared = [...new Set(sharedTerms)];
    let reason = "Related story on KaliNova.";
    if (uniqueShared.includes("same category")) {
      reason = `Another ${candidate.category_name || "article"} in the same topic.`;
    } else if (uniqueShared.length) {
      reason = `Overlapping themes: ${uniqueShared.slice(0, 3).join(", ")}.`;
    }

    suggestions.push({
      title: candidate.title,
      url: `/blog/${candidate.slug}`,
      reason,
      relevance: clampPercent(relevance)
    });
  }

  suggestions.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });

  return suggestions.slice(0, limit);
}

/* ==================================================================== */
/* Publication state                                                     */
/* ==================================================================== */

function statusText(status) {
  return asString(status).trim().toLowerCase();
}

/* ==================================================================== */
/* Analyzer                                                              */
/* ==================================================================== */

/**
 * Run the full SEO analysis over an article.
 *
 * @param {object} input  article values (snake_case or camelCase accepted)
 * @param {object} [options]
 * @param {string} [options.siteUrl]       configured origin; never hardcoded
 * @param {string} [options.focusKeyword]  optional explicit topic supplied by the caller
 * @param {string} [options.schemaType]    optional schema type (default BlogPosting)
 * @param {number} [options.internalLinkLimit]
 * @param {object[]} [options.articleImages] rows from article_images
 * @param {object} [options.services]
 * @param {function} [options.services.similarTitles]   (title, excludeId) => Promise<[{title, similarity, same}]>
 * @param {function} [options.services.slugTaken]       (slug, excludeId) => Promise<boolean>
 * @param {function} [options.services.articleTargetExists} (kind, slug) => Promise<boolean>
 * @param {function} [options.services.suggestCandidates] () => Promise<[{id,title,slug,category_id,category_slug}]>
 * @returns {object} report
 */
async function analyzeArticle(input, options = {}) {
  const values = input && typeof input === "object" ? input : {};
  const article = {
    id: pick(values, "id", "article_id") ?? null,
    title: asString(pick(values, "title", "")).trim().replace(/\s+/g, " "),
    slug: asString(pick(values, "slug", "")).trim()
      .replace(/^\/+|\/+$/g, "")
      .split("?")[0],
    metaDescription: asString(pick(values, "meta_description", "metaDescription", "")).trim()
      .replace(/\s+/g, " "),
    body: asString(pick(values, "content", "body_html", "bodyHtml", "body", "")),
    bodyFormat: asString(pick(values, "body_format", "bodyFormat", "")).toLowerCase(),
    coverImage: asString(pick(values, "cover_image", "coverImage", "")).trim() || null,
    bannerAlt: asString(pick(values, "banner_alt", "bannerAlt", "")).trim(),
    categoryId: pick(values, "category_id", "categoryId") === null || pick(values, "category_id", "categoryId") === undefined
      ? null
      : Number.parseInt(String(pick(values, "category_id", "categoryId")), 10),
    categoryName: asString(pick(values, "category_name", "categoryName", "")).trim(),
    categorySlug: asString(pick(values, "category_slug", "categorySlug", "")).trim(),
    status: statusText(pick(values, "status", "")),
    publishedAt: pick(values, "published_at", "publishedAt", "") || null,
    createdAt: pick(values, "created_at", "createdAt", "") || null,
    canonical: asString(pick(values, "canonical", "canonical_url", "")).trim() || null
  };

  const services = options.services || {};
  const siteUrl = (options.siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, "");
  const schemaType = asString(options.schemaType || "").trim() || "BlogPosting";

  const parseResult = parseBody(article.body, article.bodyFormat);
  article.body = parseResult.text.trim();

  const words = tokens(article.body);
  const wordCount = words.length;
  const topic = deriveTopic({
    title: article.title,
    headings: parseResult.headings
  }, options.focusKeyword);
  const topicLocations = topicPresentLocations(topic.tokens, {
    title: article.title,
    metaDescription: article.metaDescription,
    slug: article.slug,
    text: article.body,
    headings: parseResult.headings,
    paragraphList: parseResult.paragraphList
  });

  const checksByCategory = {
    onPage: [],
    content: [],
    technical: [],
    internalLinks: [],
    media: [],
    social: []
  };
  const { onPage, content, technical, internalLinks, media, social } = checksByCategory;
  const internalLinkSuggestions = [];

  /* ---------------------------------------------------------------- */
  /* ON-PAGE SEO (30)                                                  */
  /* ---------------------------------------------------------------- */

  const titlePresent = article.title.length > 0;
  buildCheck(
    onPage,
    "title_present",
    "onPage",
    titlePresent ? SEVERITY.PASS : SEVERITY.ERROR,
    titlePresent
      ? "The article has a title."
      : "The article has no title. Search engines need a title to display.",
    3
  );

  const titleLength = article.title.length;
  if (!titlePresent) {
    buildCheck(onPage, "title_length", "onPage", SEVERITY.INFO, "Add a title to measure its length.", 4);
  } else if (titleLength < TITLE_IDEAL_MIN) {
    buildCheck(
      onPage,
      "title_length",
      "onPage",
      SEVERITY.WARNING,
      `Your title is ${titleLength} characters. A title between ${TITLE_IDEAL_MIN} and ${TITLE_IDEAL_MAX} characters is easier to display in full search results.`,
      4
    );
  } else if (titleLength > TITLE_IDEAL_MAX) {
    buildCheck(
      onPage,
      "title_length",
      "onPage",
      SEVERITY.WARNING,
      `Your title is ${titleLength} characters. Consider shortening it toward ${TITLE_IDEAL_MAX} characters so search results do not truncate it.`,
      4
    );
  } else {
    buildCheck(
      onPage,
      "title_length",
      "onPage",
      SEVERITY.PASS,
      `Title length (${titleLength} characters) is within the recommended ${TITLE_IDEAL_MIN}-${TITLE_IDEAL_MAX} range.`,
      4
    );
  }

  const titleWords = meaningfulTokens(article.title);
  const titleFreq = countFrequency(titleWords);
  const topTitleWord = topEntry(titleFreq);
  const titleRepeats = titleFreq.size < titleWords.length;
  const titleRepeatFlag =
    (topTitleWord[1] && topTitleWord[1] >= 3) ||
    (topEntry(countFrequency(bigrams(titleWords)))[1] || 0) >= 2;
  buildCheck(
    onPage,
    "title_repetitive",
    "onPage",
    titleRepeatFlag ? SEVERITY.WARNING : SEVERITY.PASS,
    titleRepeatFlag && titleRepeats
      ? `The title repeats "${topTitleWord[0]}" often. Consider a phrase that expresses the same idea once.`
      : "The title does not repeat a phrase excessively.",
    3
  );

  const topicTokensInTitle = topic.tokens.filter(word => tokenSet(article.title).has(word)).length;
  const titleStuffed = topicTokensInTitle >= 3;
  buildCheck(
    onPage,
    "title_keyword_stuffing",
    "onPage",
    titleStuffed ? SEVERITY.WARNING : SEVERITY.PASS,
    titleStuffed
      ? `The topic "${topic.value}" appears in the title more than twice. Keep the title natural for readers.`
      : "The title does not look keyword-stuffed.",
    2
  );

  let titleDupCheck;
  if (typeof services.similarTitles === "function") {
    const matches = await services.similarTitles(article.title, article.id);
    const exact = matches && matches.find(item => item.same);
    const near = matches && matches.find(item => !item.same && item.similarity >= 0.6);
    const culprit = exact || near;
    titleDupCheck = buildCheck(
      onPage,
      "title_duplicate",
      "onPage",
      culprit ? SEVERITY.WARNING : SEVERITY.PASS,
      culprit
        ? `Another published article is titled "${culprit.title}". Consider a distinct title.`
        : "No duplicate title found among published articles.",
      4
    );
  } else {
    titleDupCheck = buildCheck(onPage, "title_duplicate", "onPage", SEVERITY.INFO, "Duplicate-title check needs the site database.", 4);
  }
  void titleDupCheck;

  const slugPresent = article.slug.length > 0;
  buildCheck(
    onPage,
    "slug_present",
    "onPage",
    slugPresent ? SEVERITY.PASS : SEVERITY.ERROR,
    slugPresent ? "The article has a URL slug." : "The article has no URL slug; one is generated from the title when you save.",
    2
  );

  let slugIssues = [];
  if (slugPresent) {
    if (article.slug !== article.slug.toLowerCase()) slugIssues.push("contains uppercase letters");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) slugIssues.push("contains characters that are not URL-safe");
    if (article.slug.length > SLUG_IDEAL_MAX) slugIssues.push(`is ${article.slug.length} characters (long for a URL)`);
    if (article.slug.length < 3) slugIssues.push("is very short");
  }
  buildCheck(
    onPage,
    "slug_quality",
    "onPage",
    slugIssues.length ? SEVERITY.WARNING : SEVERITY.PASS,
    slugIssues.length
      ? `A readable, lowercase, hyphen-separated slug helps readers and search engines. The slug ${slugIssues.join(", ")}.`
      : "The slug is lowercase, URL-safe and readable.",
    5
  );

  const slugTopicOverlap = article.slug
    ? meaningfulTokens(article.slug.split("-").join(" ")).filter(word => topic.tokens.includes(word)).length
    : 0;
  buildCheck(
    onPage,
    "slug_topic_match",
    "onPage",
    !topic.tokens.length ? SEVERITY.INFO
      : slugTopicOverlap ? SEVERITY.PASS : SEVERITY.WARNING,
    !topic.tokens.length
      ? "Add a title so the slug can be checked against the topic."
      : slugTopicOverlap
        ? "The slug reflects the article's topic."
        : "The slug does not echo the article's topic. Consider a slug that matches the title's main idea.",
    3
  );

  let slugDupCheck;
  if (typeof services.slugTaken === "function") {
    const taken = await services.slugTaken(article.slug, article.id);
    slugDupCheck = buildCheck(
      onPage,
      "slug_duplicate",
      "onPage",
      taken ? SEVERITY.ERROR : SEVERITY.PASS,
      taken
        ? "This slug is already used by another article. Choose another slug."
        : "No other article uses this slug.",
      4
    );
  } else {
    slugDupCheck = buildCheck(onPage, "slug_duplicate", "onPage", SEVERITY.INFO, "Duplicate-slug check needs the site database.", 4);
  }
  void slugDupCheck;

  /* ---------------------------------------------------------------- */
  /* CONTENT QUALITY (25)                                              */
  /* ---------------------------------------------------------------- */

  let wordSeverity;
  let wordMessage;
  if (wordCount === 0) {
    wordSeverity = SEVERITY.ERROR;
    wordMessage = "The article body is empty. Add content before publishing.";
  } else if (wordCount < BODY_THIN_WORDS) {
    wordSeverity = SEVERITY.WARNING;
    wordMessage = `The article is ${wordCount} words — a fairly thin piece. Consider expanding it so it can cover the topic properly.`;
  } else if (wordCount > 2400) {
    wordSeverity = SEVERITY.PASS;
    wordMessage = `The article is ${wordCount} words. Length alone does not make a story better; keep every paragraph purposeful.`;
  } else {
    wordSeverity = SEVERITY.PASS;
    wordMessage = `The article is ${wordCount} words, a solid length for a story.`;
  }
  buildCheck(content, "word_count", "content", wordSeverity, wordMessage, 4);

  const paragraphList = parseResult.paragraphList.length
    ? parseResult.paragraphList
    : paragraphs(article.body).filter(text => !/^#{1,6}\s/.test(text));
  buildCheck(
    content,
    "paragraph_count",
    "content",
    paragraphList.length >= 3 ? SEVERITY.PASS
      : paragraphList.length >= 1 ? SEVERITY.INFO : SEVERITY.WARNING,
    paragraphList.length === 0
      ? "There are no paragraphs to read yet."
      : paragraphList.length === 1
        ? "The body is a single paragraph; breaking it into sections would help scanning readers."
        : paragraphList.length < 3
          ? "Only a couple of paragraphs so far."
          : `The body is broken into ${paragraphList.length} paragraphs.`,
    2
  );

  const longParagraphs = paragraphList.filter(paragraph => meaningfulTokens(paragraph).length > PARAGRAPH_LONG_WORDS);
  const emptyParagraphs = article.body.split(/\n\s*\n+/).filter(line => asString(line).trim() === "").length;
  const paragraphIssues = [];
  if (longParagraphs.length) paragraphIssues.push(`${longParagraphs.length} paragraph(s) exceed ${PARAGRAPH_LONG_WORDS} words`);
  if (emptyParagraphs > 2) paragraphIssues.push("empty paragraphs appear between sections");
  buildCheck(
    content,
    "paragraph_quality",
    "content",
    paragraphIssues.length ? SEVERITY.WARNING : SEVERITY.PASS,
    paragraphIssues.length
      ? `Consider splitting long passages: ${paragraphIssues.join("; ")}.`
      : "Paragraph lengths look readable.",
    3
  );

  const headingLevels = parseResult.headings.map(heading => heading.level);
  const headingChecks = [];
  const h1Count = headingLevels.filter(level => level === 1).length;
  const skipped = [];
  let previous = 0;
  for (const level of headingLevels) {
    if (level === 1) continue; // the page H1 is the article title
    if (previous && level - previous > 1) skipped.push(`${previous}->${level}`);
    previous = level;
  }
  for (const heading of parseResult.headings) {
    if (!heading.text) headingChecks.push("an empty heading");
  }
  if (h1Count > 1) headingChecks.push("more than one H1 in the body");
  if (skipped.length) headingChecks.push(`heading levels jump (${skipped.slice(0, 2).join(", ")})`);

  const headingSeverity =
    headingChecks.length
      ? headingChecks.some(check => check.includes("more than one H1"))
        ? SEVERITY.WARNING
        : SEVERITY.INFO
      : SEVERITY.PASS;

  let headingMessage;
  if (!parseResult.headings.length) {
    headingMessage = "The body has no headings. They are optional here because the article title is already the page's H1, but headings help readers scan.";
  } else if (headingChecks.length) {
    headingMessage = `Heading structure: ${headingChecks.join("; ")}.`;
  } else {
    headingMessage = "Heading structure is logical (H2/H3 sections in a sensible order).";
  }
  buildCheck(content, "heading_structure", "content", headingSeverity, headingMessage, 5);

  const phraseIssues = [];
  if (wordCount >= 12) {
    const bigramTop = topEntry(countFrequency(bigrams(words)));
    const trigramTop = topEntry(countFrequency(trigrams(words)));
    if (trigramTop[1] >= 5) phraseIssues.push(`the phrase "${trigramTop[0]}" appears ${trigramTop[1]} times`);
    if (bigramTop[1] >= 8) phraseIssues.push(`"${bigramTop[0]}" appears ${bigramTop[1]} times`);
  }
  buildCheck(
    content,
    "phrase_repetition",
    "content",
    phraseIssues.length ? SEVERITY.WARNING : SEVERITY.PASS,
    phraseIssues.length
      ? `Repetition to look at: ${phraseIssues.join("; ")}. Vary the wording so the text stays natural.`
      : "No suspiciously repetitive phrases detected.",
    3
  );

  const sentenceList = sentences(article.body);
  const avgSentenceLength = sentenceList.length
    ? Math.round((wordCount / sentenceList.length) * 10) / 10
    : 0;
  buildCheck(
    content,
    "readability_indicator",
    "content",
    avgSentenceLength > SENTENCE_LONG_WORDS ? SEVERITY.INFO : SEVERITY.PASS,
    avgSentenceLength > SENTENCE_LONG_WORDS
      ? `Sentences average ${avgSentenceLength} words. Long sentences can be harder to scan; consider breaking a few up.`
      : `Sentences average ${avgSentenceLength || 0} words, which reads naturally.`,
    2
  );

  const topicLocationsPresent = [topicLocations.title, topicLocations.meta, topicLocations.slug, topicLocations.opening, topicLocations.headings]
    .filter(Boolean).length;
  let topicMessage;
  if (!topic.tokens.length) {
    topicMessage = "Add a title first so the topic can be inferred.";
  } else {
    topicMessage = `Topic "${topic.value}"${topic.inferred ? " (inferred from the title)" : ""} appears in: ${topicLocations.present}.`;
  }
  buildCheck(
    content,
    "keyword_presence",
    "content",
    !topic.tokens.length ? SEVERITY.INFO
      : topicLocationsPresent >= 3 ? SEVERITY.PASS
        : topicLocationsPresent >= 1 ? SEVERITY.WARNING : SEVERITY.WARNING,
    topicMessage,
    4
  );

  const topicOveruse = topic.tokens.filter(word => (countFrequency(meaningfulTokens(article.body)).get(word) || 0) >= 20).length;
  buildCheck(
    content,
    "keyword_stuffing",
    "content",
    topicOveruse ? SEVERITY.INFO : SEVERITY.PASS,
    topicOveruse
      ? `The topic term "${topic.value}" recurs frequently. Search engines know when a page is padded for them — write for readers instead.`
      : "Keyword use looks natural.",
    2
  );

  /* ---------------------------------------------------------------- */
  /* TECHNICAL SEO (20)                                                */
  /* ---------------------------------------------------------------- */

  const expectedCanonical = slugPresent ? `${siteUrl}/blog/${article.slug}` : "";
  buildCheck(
    technical,
    "canonical",
    "technical",
    !slugPresent ? SEVERITY.ERROR
      : article.canonical && article.canonical !== expectedCanonical ? SEVERITY.WARNING : SEVERITY.PASS,
    !slugPresent
      ? "A canonical URL cannot be derived without a slug."
      : article.canonical && article.canonical !== expectedCanonical
        ? `The submitted canonical (${article.canonical}) differs from the site's deterministic canonical (${expectedCanonical}).`
        : `The canonical URL is deterministic: ${expectedCanonical}.`,
    4
  );

  const knownStatus = ["published", "draft"].includes(article.status);
  buildCheck(
    technical,
    "indexing_robots",
    "technical",
    knownStatus ? SEVERITY.PASS : SEVERITY.WARNING,
    knownStatus
      ? article.status === "published"
        ? "Published articles are indexable (index, follow) and appear in the sitemap."
        : "Drafts are noindex and excluded from the sitemap; they become indexable when published."
      : "The status is unrecognised; indexing behaviour cannot be derived.",
    4
  );

  const structuredDataFields = [];
  if (!titlePresent) structuredDataFields.push("headline");
  if (!article.coverImage) structuredDataFields.push("image");
  if (!(article.publishedAt || article.createdAt)) structuredDataFields.push("datePublished");
  buildCheck(
    technical,
    "structured_data_fields",
    "technical",
    structuredDataFields.length === 0 ? SEVERITY.PASS : structuredDataFields.length === 5 ? SEVERITY.WARNING : SEVERITY.WARNING,
    structuredDataFields.length === 0
      ? "Article structured data has its headline, image, date, author and publisher."
      : structuredDataFields.length >= 4
        ? "Article structured data is missing its core source fields."
        : `Structured data source fields to add: ${structuredDataFields.join(", ")}.`,
    4
  );

  buildCheck(
    technical,
    "schema_type_valid",
    "technical",
    ALLOWED_SCHEMA_TYPES.has(schemaType) ? SEVERITY.PASS : SEVERITY.WARNING,
    ALLOWED_SCHEMA_TYPES.has(schemaType)
      ? `Schema type "${schemaType}" is rendered as JSON-LD on the article page.`
      : `Schema type "${schemaType}" is not a recognised type; "BlogPosting" is the site default.`,
    2
  );

  const hasCategory = Boolean(article.categoryId > 0) || Boolean(article.categoryName || article.categorySlug);
  buildCheck(
    technical,
    "category_present",
    "technical",
    hasCategory ? SEVERITY.PASS : SEVERITY.ERROR,
    hasCategory ? "The article has a category." : "The article has no category; navigation and topic pages depend on it.",
    2
  );

  const crawlerNote =
    article.status === "published"
      ? "This article is eligible for the XML sitemap."
      : "This article is excluded from the sitemap until it is published.";
  buildCheck(
    technical,
    "sitemap_eligibility",
    "technical",
    SEVERITY.PASS,
    crawlerNote,
    2
  );

  buildCheck(
    technical,
    "crawl_control",
    "technical",
    slugPresent && article.slug === article.slug.toLowerCase() && !/\/$|[A-Z?#&]/.test(article.slug)
      ? SEVERITY.PASS
      : SEVERITY.WARNING,
    slugPresent && article.slug === article.slug.toLowerCase() && !/\/$|[A-Z?#&]/.test(article.slug)
      ? "The URL is lowercase with no trailing slash or query, so it cannot fragment into duplicate crawl targets."
      : "Normalise the slug to lowercase with no trailing slash so the URL cannot be reached two different ways.",
    2
  );

  /* ---------------------------------------------------------------- */
  /* INTERNAL LINKS (10)                                               */
  /* ---------------------------------------------------------------- */

  const bodyInternalLinks = parseResult.links.filter(link => isInternalUrl(link.href));
  const uniqueInternal = new Set(bodyInternalLinks.map(link => link.href));
  const ownSlug = article.slug.toLowerCase();
  const selfLink = bodyInternalLinks.some(link => pathSlugOf(link.href) === ownSlug && ownSlug.length > 0);

  buildCheck(
    internalLinks,
    "internal_link_count",
    "internalLinks",
    bodyInternalLinks.length === 0 ? SEVERITY.WARNING
      : bodyInternalLinks.length <= 2 ? SEVERITY.INFO : SEVERITY.PASS,
    bodyInternalLinks.length === 0
      ? "The body has no internal links. A couple of links to other KaliNova stories help readers keep exploring."
      : bodyInternalLinks.length <= 2
        ? `The body has ${bodyInternalLinks.length} internal link(s); a couple more would help.`
        : `The body has ${bodyInternalLinks.length} internal link(s) to other parts of the site.`,
    5
  );

  buildCheck(
    internalLinks,
    "self_link",
    "internalLinks",
    selfLink ? SEVERITY.WARNING : SEVERITY.PASS,
    selfLink
      ? "The body links to this article's own URL. Link to other stories instead — an article cannot meaningfully link to itself."
      : "No self-links found.",
    2
  );

  let brokenCheck;
  if (typeof services.articleTargetExists === "function" && bodyInternalLinks.length) {
    const seen = new Set();
    let broken = null;
    for (const link of bodyInternalLinks.slice(0, 15)) {
      const slug = pathSlugOf(link.href);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const exists = await services.articleTargetExists("article", slug);
      if (!exists) {
        broken = link.href;
        break;
      }
    }
    brokenCheck = buildCheck(
      internalLinks,
      "broken_internal_link",
      "internalLinks",
      broken ? SEVERITY.WARNING : SEVERITY.PASS,
      broken
        ? `Internal link "${broken}" does not point at a published article. Check the target.`
        : "Internal links point at existing published articles.",
      2
    );
  } else if (!bodyInternalLinks.length) {
    brokenCheck = buildCheck(internalLinks, "broken_internal_link", "internalLinks", SEVERITY.INFO, "No internal links to check yet.", 2);
  } else {
    brokenCheck = buildCheck(internalLinks, "broken_internal_link", "internalLinks", SEVERITY.INFO, "Broken-link check needs the site database.", 2);
  }
  void brokenCheck;

  const repeated = [...uniqueInternal].find(href => bodyInternalLinks.filter(link => link.href === href).length >= 3);
  buildCheck(
    internalLinks,
    "repeated_links",
    "internalLinks",
    repeated ? SEVERITY.WARNING : SEVERITY.PASS,
    repeated
      ? `The link "${repeated}" is used repeatedly. Link to the same destination once.`
      : "No individual link is overused.",
    1
  );

  if (typeof services.suggestCandidates === "function") {
    const candidates = await services.suggestCandidates();
    internalLinkSuggestions.push(...suggestInternalLinks(
      { ...article, text: article.body },
      candidates,
      { internalLinkLimit: options.internalLinkLimit, scoreFor: services.scoreCandidate || null }
    ));
    if (article.categorySlug && internalLinkSuggestions.length === 0 && !services.scoreCandidate) {
      internalLinkSuggestions.unshift({
        title: article.categoryName || article.categorySlug,
        url: `/category/${article.categorySlug}`,
        reason: "Link to the topic page so readers (and crawlers) can reach the rest of the category.",
        relevance: 60
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* MEDIA SEO (10)                                                    */
  /* ---------------------------------------------------------------- */

  buildCheck(
    media,
    "banner_present",
    "media",
    article.coverImage ? SEVERITY.PASS : SEVERITY.WARNING,
    article.coverImage ? "The article has a banner image." : "The article has no banner image. A banner makes the story recognisable in listings and on social media.",
    3
  );

  const bannerNeedsAlt = Boolean(article.coverImage);
  buildCheck(
    media,
    "banner_alt_present",
    "media",
    bannerNeedsAlt
      ? (article.bannerAlt ? SEVERITY.PASS : SEVERITY.ERROR)
      : SEVERITY.INFO,
    bannerNeedsAlt
      ? (article.bannerAlt ? "The banner has descriptive alt text." : "The banner has no alt text. Alt text is required for accessibility and included in the article's structured data.")
      : "No banner to describe yet.",
    3
  );

  const bannerFilename = filenameFromPath(article.coverImage || "").replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const genericAlt = GENERIC_ALT.has(article.bannerAlt.toLowerCase());
  const altIsFilename = article.bannerAlt.toLowerCase() === bannerFilename;
  const altQualityNote =
    !bannerNeedsAlt ? "No banner to describe yet."
      : !article.bannerAlt ? "Add alt text first."
        : genericAlt || altIsFilename
          ? `Alt text "${article.bannerAlt}" reads like a label, not a description. Describe what the image shows.`
          : `Alt text "${article.bannerAlt}" describes the image meaningfully.`;
  buildCheck(
    media,
    "banner_alt_quality",
    "media",
    !bannerNeedsAlt || !article.bannerAlt ? SEVERITY.INFO
      : genericAlt || altIsFilename ? SEVERITY.WARNING : SEVERITY.PASS,
    altQualityNote,
    2
  );

  const bannerType = imageTypeFromUrl(article.coverImage || "");
  let fileTypeSeverity;
  let fileTypeMessage;
  if (!bannerNeedsAlt && !article.coverImage) {
    fileTypeSeverity = SEVERITY.INFO;
    fileTypeMessage = "No banner to check yet.";
  } else if (ALLOWED_IMAGE_TYPES.has(bannerType)) {
    fileTypeSeverity = SEVERITY.PASS;
    fileTypeMessage = `The banner is a ${bannerType.toUpperCase()} image — a family modern crawlers index well.`;
  } else if (bannerType && !ALLOWED_IMAGE_TYPES.has(bannerType)) {
    fileTypeSeverity = SEVERITY.ERROR;
    fileTypeMessage = `The banner extension (${bannerType}) is not a supported image type. Use JPEG, PNG, WebP or AVIF.`;
  } else {
    fileTypeSeverity = SEVERITY.INFO;
    fileTypeMessage = "Confirm the banner is a modern image format (JPEG, PNG, WebP or AVIF); the file itself is not inspected here.";
  }
  buildCheck(media, "banner_file_type", "media", fileTypeSeverity, fileTypeMessage, 1);

  const bodyImageRows = (options.articleImages || []).filter(row => row && typeof row === "object");
  const bodyImages = parseResult.images.map(image => ({ ...image, alt: image.alt }));
  const allBodyImages = [...bodyImages];
  const blankAlts = allBodyImages.filter(image => !asString(image.alt).trim()).length;
  const extraBlankAlts = bodyImageRows.filter(row => !asString(row.alt_text).trim()).length;
  buildCheck(
    media,
    "body_images_alt",
    "media",
    allBodyImages.length + bodyImageRows.length === 0 ? SEVERITY.INFO
      : blankAlts + extraBlankAlts > 0 ? SEVERITY.WARNING : SEVERITY.PASS,
    allBodyImages.length + bodyImageRows.length === 0
      ? "No in-body images to check yet."
      : blankAlts + extraBlankAlts > 0
        ? `${blankAlts + extraBlankAlts} in-body image(s) are missing alt text.`
        : "In-body images carry alt text.",
    1
  );

  /* ---------------------------------------------------------------- */
  /* SOCIAL METADATA (5)                                               */
  /* ---------------------------------------------------------------- */

  buildCheck(
    social,
    "og_title_source",
    "social",
    titlePresent ? SEVERITY.PASS : SEVERITY.ERROR,
    titlePresent ? "The Open Graph title derives from the article title." : "No title to put in the Open Graph title.",
    1
  );

  buildCheck(
    social,
    "og_description_source",
    "social",
    article.metaDescription ? SEVERITY.PASS : SEVERITY.WARNING,
    article.metaDescription
      ? "The Open Graph description derives from the meta description."
      : "No meta description yet — social previews will fall back to an excerpt of the body.",
    1
  );

  buildCheck(
    social,
    "og_image_source",
    "social",
    article.coverImage ? SEVERITY.PASS : SEVERITY.WARNING,
    article.coverImage
      ? "The Open Graph image derives from the banner image."
      : "No banner image — social shares will not carry a preview image.",
    1
  );

  buildCheck(
    social,
    "canonical_source",
    "social",
    slugPresent ? SEVERITY.PASS : SEVERITY.WARNING,
    slugPresent ? "The canonical URL derives from the slug on the configured site origin." : "No slug to build a canonical URL from.",
    1
  );

  buildCheck(
    social,
    "twitter_metadata",
    "social",
    titlePresent ? SEVERITY.PASS : SEVERITY.INFO,
    titlePresent ? "Twitter/X cards derive from the same title, description and image sources." : "Add a title so Twitter/X cards have source data.",
    1
  );

  /* ---------------------------------------------------------------- */
  /* REPORT                                                            */
  /* ---------------------------------------------------------------- */

  const categories = {};
  let score = 0;
  for (const [key, max] of Object.entries(CATEGORY_WEIGHTS)) {
    const list = checksByCategory[key];
    const awarded = Math.round(list.reduce((sum, check) => sum + check.points, 0));
    const boundedMax = max;
    categories[key] = { score: awarded, max: boundedMax };
    score += awarded;
  }

  const errors = [];
  const warnings = [];
  const allChecks = [];
  for (const list of Object.values(checksByCategory)) {
    for (const check of list) {
      allChecks.push(check);
      if (check.severity === SEVERITY.ERROR) errors.push(check.message);
      else if (check.severity === SEVERITY.WARNING) warnings.push(check.message);
    }
  }

  if (allChecks.length === 0) {
    buildCheck(allChecks, "engine", "content", SEVERITY.INFO, "No analysis ran.", 1);
  }

  const readiness = publishReadiness(categories, errors, warnings);
  const status = readiness.status;

  // General suggestions are derived from the same deterministic findings so the
  // helper list always agrees with the checks above it.
  const generalSuggestions = [];
  const seenSuggestions = new Set();
  for (const message of [...errors, ...warnings]) {
    if (generalSuggestions.length >= 5) break;
    if (seenSuggestions.has(message)) continue;
    seenSuggestions.add(message);
    generalSuggestions.push(message);
  }

  const report = {
    version: VERSION,
    engineEnabled: options.engineEnabled === undefined ? true : Boolean(options.engineEnabled),
    score,
    status,
    topic: topic.inferred ? { value: topic.value, inferred: true } : { value: topic.value, inferred: false },
    categories,
    checks: allChecks,
    errors,
    warnings,
    suggestions: generalSuggestions,
    internalLinkSuggestions
  };

  return report;
}

/**
 * Publish readiness state.
 *
 *   BLOCKED       a critical technical/content problem exists (that does not
 *                 stop a draft being saved, only publishing)
 *   NEEDS_REVIEW  one or more warnings, or weak content quality
 *   READY         no blocking problems and nothing flagged
 *
 * A low SEO score alone never blocks publishing (spec section 21).
 */
function publishReadiness(categories, errors, warnings) {
  const reasons = [];
  if (errors.length) {
    reasons.push(...errors.map(message => `Please fix: ${message}`).slice(0, 3));
    return { status: "BLOCKED", reasons };
  }

  if (warnings.length) {
    const first = warnings[0];
    reasons.push(`${warnings.length} warning${warnings.length === 1 ? "" : "s"} to review — for example: ${first}`);
  }

  const contentQuality = categories && categories.content ? categories.content.score : 0;
  if (contentQuality < 15) {
    reasons.push("Content quality is weak; expand the article before publishing.");
  }

  if (reasons.length) return { status: "NEEDS_REVIEW", reasons };
  return { status: "READY", reasons };
}

module.exports = {
  CATEGORY_LABELS,
  CATEGORY_WEIGHTS,
  DEFAULT_SITE_URL,
  SEVERITY,
  VERSION,
  analyzeArticle,
  deriveTopic,
  parseBody,
  publishReadiness,
  suggestInternalLinks
};