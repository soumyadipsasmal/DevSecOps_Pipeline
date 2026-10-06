"use strict";

/**
 * KaliNova — minimal RSS 2.0 / Atom reader
 *
 * A deliberately small, dependency-free extractor for the one thing this site
 * is allowed to take from a feed: headline, link, publication date, guid and a
 * short description. It reads the fields it needs and nothing else — no
 * <content:encoded> bodies, no media, no tracking pixels — because KaliNova
 * stores excerpts and links, never full third-party articles.
 *
 * Robustness rules:
 *   - CDATA, HTML entities and nested markup are normal in feeds
 *   - a malformed item is skipped; it never fails the whole feed
 *   - every regex is anchored to a single item block, so one broken tag in
 *     item 3 cannot corrupt item 4
 *
 * Covered formats: RSS 2.0 (<item>) and Atom (<entry>).
 */

const MAX_XML_BYTES = 1024 * 1024; // 1 MB is far beyond any headline feed.

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™"
};

function decodeEntities(text) {
  return String(text || "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, body) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return full;
      try {
        return String.fromCodePoint(code);
      } catch {
        return full;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : full;
  });
}

/** Unwrap CDATA if present, then reduce the content to plain text. */
function cleanText(raw) {
  if (!raw) return "";
  let text = String(raw);
  const cdata = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) text = cdata[1];

  // Decode first, then strip: feed descriptions routinely carry escaped HTML
  // (&lt;p&gt;…) as well as raw markup inside CDATA, and the excerpt we store
  // must contain the words, not the tags, either way.
  text = decodeEntities(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

/** First <tag>…</tag> inner content of a block (attributes allowed). */
function innerOf(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1] : "";
}

/**
 * Pull the permalink out of an item.
 * RSS puts the URL in <link>; Atom uses <link href="…">, sometimes several —
 * the alternate (or first) wins.
 */
function extractLink(block) {
  const direct = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (direct) {
    const value = cleanText(direct[1]);
    if (/^https?:\/\//i.test(value)) return value;
  }

  const links = block.match(/<link\b[^>]*>/gi) || [];
  let fallback = "";
  for (const tag of links) {
    const href = tag.match(/\bhref\s*=\s*"([^"]+)"/i);
    if (!href) continue;
    const value = decodeEntities(href[1]).trim();
    if (!/^https?:\/\//i.test(value)) continue;
    const rel = tag.match(/\brel\s*=\s*"([^"]+)"/i);
    if (!rel || rel[1] === "alternate") return value;
    if (!fallback) fallback = value;
  }
  return fallback;
}

function extractGuid(block, link) {
  const guid = cleanText(innerOf(block, "guid") || innerOf(block, "id"));
  if (guid && /^https?:\/\//i.test(guid)) return guid.slice(0, 500);
  if (guid) return guid.slice(0, 500);
  return link ? link.slice(0, 500) : "";
}

function extractDate(block) {
  const candidates = [
    innerOf(block, "pubDate"),
    innerOf(block, "published"),
    innerOf(block, "updated"),
    innerOf(block, "dc:date")
  ];
  for (const candidate of candidates) {
    const text = cleanText(candidate);
    if (!text) continue;
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function extractItems(xml) {
  const blocks = [];
  const itemPattern = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  const entryPattern = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;

  let match;
  while ((match = itemPattern.exec(xml)) !== null) blocks.push(match[1]);
  while ((match = entryPattern.exec(xml)) !== null) blocks.push(match[1]);

  return blocks;
}

/**
 * Parse a feed document into normalised items.
 * Returns { title, items: [...] }. Never throws for per-item problems.
 *
 * @param {string} xml
 * @param {{source?: string}} [options]
 */
function parseFeed(xml, options = {}) {
  const source = String(options.source || "").slice(0, 120);
  if (typeof xml !== "string" || xml.length === 0) return { title: source, items: [] };
  if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) return { title: source, items: [] };

  // A feed must at least declare itself; a JSON error page answers with none.
  if (!/<(?:rss|feed|rdf)\b/i.test(xml)) return { title: source, items: [] };

  const channelTitle = cleanText(innerOf(xml, "title")).slice(0, 160);
  const items = [];

  for (const block of extractItems(xml)) {
    try {
      const title = cleanText(innerOf(block, "title")).slice(0, 400);
      const link = extractLink(block);
      if (!title || !link) continue; // a headline without a destination is useless
      if (!/^https?:\/\//i.test(link)) continue;

      const description = cleanText(innerOf(block, "description") || innerOf(block, "summary")).slice(0, 700);
      const guid = extractGuid(block, link);
      const publishedAt = extractDate(block);

      items.push({ title, link, description, guid, publishedAt, source });
    } catch {
      // One malformed item must not sink the feed.
    }
  }

  return { title: channelTitle || source, items };
}

/**
 * Deduplicate and order a batch of parsed items.
 * Keyed by guid first, then by URL, so the same story arriving from two
 * places (or twice from one place) counts once. Newest first; items without
 * a date go last rather than pretending to be fresh.
 */
function dedupeAndSort(items, limit = 60) {
  const seenGuids = new Set();
  const seenUrls = new Set();
  const merged = [];

  for (const item of items) {
    const guidKey = item.guid || item.link;
    const urlKey = item.link;
    if (seenGuids.has(guidKey) || seenUrls.has(urlKey)) continue;
    seenGuids.add(guidKey);
    seenUrls.add(urlKey);
    merged.push(item);
  }

  merged.sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : null;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : null;
    if (at === null && bt === null) return 0;
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at;
  });

  return merged.slice(0, limit);
}

/** Cut text at a word boundary. Used for the excerpt we store. */
function excerpt(text, max = 240) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1).replace(/\s+\S*$/, "");
  return `${cut}…`;
}

module.exports = {
  MAX_XML_BYTES,
  cleanText,
  decodeEntities,
  dedupeAndSort,
  excerpt,
  extractItems,
  parseFeed
};
