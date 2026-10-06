"use strict";

/**
 * KaliNova — article body sanitiser
 *
 * The admin editor posts HTML from the browser, so the body is never trusted.
 * This module rewrites it against a fixed allowlist: only the tags and
 * attributes listed below survive, every other attribute (including every
 * on* handler and every style attribute) is dropped, and text is re-escaped.
 *
 * A tag-based sanitiser is only as safe as its parser, so the input is scanned
 * rather than pattern-matched with a few replacements: unknown markup is
 * unwrapped or discarded whole, never passed through. Sanitised output is what
 * gets written to the database, which means the public renderer can insert it
 * without having to trust the column.
 *
 * Nothing here logs or echoes input, and no external HTML parser is required.
 */

/* Tags an article body may contain. `b`/`i` are accepted and normalised to
 * `strong`/`em` so content pasted from anywhere still renders semantically. */
const TAG_ALIASES = {
  b: "strong",
  i: "em",
  strike: "del",
  s: "del"
};

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
  "img",
  "figure",
  "figcaption",
  "hr",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  "div",
  "span",
  "sup",
  "sub"
]);

/* Void elements never get a closing tag. */
const VOID_TAGS = new Set(["br", "img", "hr"]);

/* Elements that are discarded together with everything inside them. Text inside
 * a <script> or a <style> is code, not prose, so unwrapping would leak it. */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "template",
  "noscript",
  "svg",
  "math",
  "canvas",
  "audio",
  "video",
  "source",
  "track",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "label",
  "link",
  "meta",
  "base",
  "head",
  "title",
  "map",
  "area",
  "dialog",
  "marquee"
]);

/* Block-level elements close an open <p>, exactly as a browser would. */
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "figure",
  "figcaption",
  "hr",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  "div"
]);

/* Allowed attributes per tag. `*` entries apply to every allowed tag. */
const ALLOWED_ATTRIBUTES = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "title", "width", "height", "loading"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  td: new Set(["colspan", "rowspan"]),
  "*": new Set(["lang", "dir"])
};

/* Schemes accepted in href/src. Anything else (javascript:, data:, vbscript:,
 * file:, blob:) is rejected outright. */
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

const MAX_INPUT_LENGTH = 400 * 1024;
const MAX_DEPTH = 40;

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

/** Decode the entity forms a browser decodes inside an attribute value. */
function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);?/gi, (match, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }

    switch (body.toLowerCase()) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
      case "#39":
        return "'";
      case "nbsp":
        return "\u00a0";
      case "tab":
        return "\t";
      case "newline":
        return "\n";
      default:
        return match;
    }
  });
}

/**
 * Return a safe URL, or null when the value must be dropped.
 *
 * Control characters and whitespace are removed first, because browsers ignore
 * them when resolving a scheme: "java\tscript:" is executable and has to be
 * rejected exactly like "javascript:".
 */
function safeUrl(value, { allowFragment = true } = {}) {
  const cleaned = decodeEntities(value)
    .replace(/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/g, "")
    .trim();

  if (cleaned === "") return null;
  // Protocol-relative URLs leave the site and are not needed in an article.
  if (cleaned.startsWith("//")) return null;
  // Site-relative paths and in-page references are the common case.
  if (cleaned.startsWith("/")) return cleaned;
  if (allowFragment && cleaned.startsWith("#")) return cleaned;
  if (cleaned.startsWith("?")) return cleaned;

  const scheme = cleaned.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) return SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? cleaned : null;

  // A bare relative reference ("guides/bollywood") is inert and allowed.
  return /^[a-z0-9._~!$&'()*+,;=:@%/-]+$/i.test(cleaned) ? cleaned : null;
}

function isNumeric(value, { min, max }) {
  if (!/^\d{1,6}$/.test(value)) return false;
  const number = Number.parseInt(value, 10);
  return number >= min && number <= max;
}

/** Filter one tag's attributes down to the allowlist and re-encode them. */
function filterAttributes(tagName, pairs) {
  const allowed = ALLOWED_ATTRIBUTES[tagName] || ALLOWED_ATTRIBUTES["*"];
  const output = {};

  for (const [rawName, rawValue] of pairs) {
    const name = rawName.toLowerCase();

    // Event handlers, style and anything else not explicitly allowed.
    if (!allowed.has(name)) continue;
    if (name.startsWith("on")) continue;
    if (name === "style") continue;

    const value = decodeEntities(rawValue).trim();

    if (name === "href") {
      const url = safeUrl(value);
      if (!url) continue;
      output.href = url;
      continue;
    }

    if (name === "src") {
      const url = safeUrl(value, { allowFragment: false });
      if (!url) continue;
      output.src = url;
      continue;
    }

    if (name === "target") {
      // Only _blank is useful; it forces rel="noopener" below.
      if (value !== "_blank") continue;
      output.target = "_blank";
      continue;
    }

    if (name === "rel") {
      output.rel = "noopener noreferrer";
      continue;
    }

    if (name === "loading") {
      if (value !== "lazy" && value !== "eager") continue;
      output.loading = value;
      continue;
    }

    if (name === "width" || name === "height") {
      if (!isNumeric(value, { min: 1, max: 4000 })) continue;
      output[name] = value;
      continue;
    }

    if (name === "colspan" || name === "rowspan") {
      if (!isNumeric(value, { min: 1, max: 100 })) continue;
      output[name] = value;
      continue;
    }

    if (name === "scope") {
      if (!["col", "row", "colgroup", "rowgroup"].includes(value.toLowerCase())) continue;
      output.scope = value.toLowerCase();
      continue;
    }

    if (name === "lang") {
      if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) continue;
      output.lang = value;
      continue;
    }

    if (name === "dir") {
      const dir = value.toLowerCase();
      if (dir !== "ltr" && dir !== "rtl" && dir !== "auto") continue;
      output.dir = dir;
      continue;
    }

    if (name === "alt" || name === "title") {
      output[name] = value.slice(0, 500);
      continue;
    }
  }

  return output;
}

function serialiseAttributes(attributes) {
  // An outbound link that opens a new tab must not hand the opener over.
  if (attributes.target === "_blank") attributes.rel = "noopener noreferrer";

  return Object.entries(attributes)
    .map(([name, value]) => (value === "" ? ` ${name}=""` : ` ${name}="${escapeHtml(value)}"`))
    .join("");
}

/**
 * Scan markup into text, comment and tag tokens.
 *
 * Anything that is not a well-formed tag becomes text, so a truncated or
 * malformed document degrades into escaped characters instead of live markup.
 */
function tokenize(html) {
  const tokens = [];
  const length = html.length;
  let position = 0;
  let text = "";

  const flushText = () => {
    if (text) {
      tokens.push({ type: "text", value: text });
      text = "";
    }
  };

  while (position < length) {
    const next = html.indexOf("<", position);

    if (next === -1) {
      text += html.slice(position);
      break;
    }

    text += html.slice(position, next);
    const rest = html.slice(next);

    if (rest.startsWith("<!--")) {
      const end = html.indexOf("-->", next + 4);
      position = end === -1 ? length : end + 3;
      continue; // Comments never reach the output.
    }

    if (/^<![a-z]/i.test(rest) || rest.startsWith("<?")) {
      const end = html.indexOf(">", next);
      position = end === -1 ? length : end + 1;
      continue; // Doctype / processing instruction.
    }

    const closeMatch = rest.match(/^<\/\s*([a-z][a-z0-9:-]*)/i);
    if (closeMatch) {
      const end = html.indexOf(">", next);
      if (end === -1) {
        text += rest;
        break;
      }
      flushText();
      tokens.push({ type: "close", name: closeMatch[1].toLowerCase() });
      position = end + 1;
      continue;
    }

    const openMatch = rest.match(/^<([a-z][a-z0-9:-]*)/i);
    if (openMatch) {
      const parsed = parseOpenTag(html, next);
      if (parsed) {
        flushText();
        tokens.push({ type: "open", name: openMatch[1].toLowerCase(), attributes: parsed.attributes, selfClosing: parsed.selfClosing });
        position = parsed.end;
        continue;
      }
    }

    // A bare "<" or "<not-a-tag" is literal text.
    text += "<";
    position = next + 1;
  }

  flushText();
  return tokens;
}

/** Parse "<name attr=value ...>" starting at `start`. Returns null when unterminated. */
function parseOpenTag(html, start) {
  const nameMatch = html.slice(start).match(/^<([a-z][a-z0-9:-]*)/i);
  if (!nameMatch) return null;

  let position = start + nameMatch[0].length;
  const length = html.length;
  const attributes = [];
  let selfClosing = false;

  while (position < length) {
    while (position < length && /\s/.test(html[position])) position += 1;

    if (position >= length) return null; // Unterminated tag: not a tag at all.

    if (html[position] === ">") {
      position += 1;
      break;
    }

    if (html[position] === "/" && html[position + 1] === ">") {
      selfClosing = true;
      position += 2;
      break;
    }

    if (html[position] === "/") {
      position += 1;
      continue;
    }

    // The name stops at "=", ">" or whitespace, so the optional value can be
    // read separately below. Matching the "=" inside the name pattern would
    // silently discard every attribute value.
    const attributeMatch = html.slice(position).match(/^([^\s=/>"']+)/);
    if (!attributeMatch) {
      position += 1;
      continue;
    }

    const name = attributeMatch[1];
    position += name.length;

    let value = "";
    const separator = html.slice(position).match(/^\s*=\s*/);
    if (separator) {
      position += separator[0].length;

      const raw = html.slice(position);
      const rawValue = raw.match(/^"([^"]*)"|^'([^']*)'|^([^\s>]*)/);
      if (rawValue) {
        value = rawValue[1] ?? rawValue[2] ?? rawValue[3] ?? "";
        position += rawValue[0].length;
      }
    }

    attributes.push([name, value]);
  }

  return { attributes, selfClosing, end: position };
}

/** True when the string contains no markup and can be wrapped in paragraphs. */
function looksLikePlainText(html) {
  return !/<[a-z!/][^>]*>/i.test(html);
}

/**
 * Convert plain text into paragraphs.
 *
 * Blank lines separate paragraphs; single newlines inside a block become <br>
 * so an author's own line breaks survive instead of being reflowed into one
 * paragraph. Everything is escaped — the text never becomes markup.
 */
function plainTextToHtml(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map(block =>
      block
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => escapeHtml(line))
        .join("<br />")
    )
    .filter(Boolean)
    .map(block => `<p>${block}</p>`)
    .join("");
}

/**
 * Sanitise an article body.
 *
 * @param {string} input raw HTML or plain text from the editor
 * @param {{ maxLength?: number }} [options]
 * @returns {{ html: string, text: string, truncated: boolean }}
 *   `html` is safe to insert into the document; `text` is the plain-text form
 *   used for excerpts and word counts.
 */
function sanitizeBody(input, { maxLength = MAX_INPUT_LENGTH } = {}) {
  const raw = typeof input === "string" ? input : "";

  if (raw.length > maxLength) {
    const error = new Error(`Article body is too large. The limit is ${Math.floor(maxLength / 1024)} KB.`);
    error.code = "BODY_TOO_LARGE";
    throw error;
  }

  // Strip a UTF-8 byte order mark and normalise line endings.
  const source = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  if (source.trim() === "") {
    return { html: "", text: "", truncated: false };
  }

  if (looksLikePlainText(source)) {
    const html = plainTextToHtml(source.trim());
    return { html, text: source.trim(), truncated: false };
  }

  const tokens = tokenize(source);
  const output = [];
  const stack = [];
  let skipUntilClose = null;
  let skipDepth = 0;

  const top = () => stack[stack.length - 1];

  const openTag = (name, attributes = "", selfClosing = false) =>
    `<${name}${attributes}${VOID_TAGS.has(name) || selfClosing ? " /" : ""}>`;

  const closeTag = name => `</${name}>`;

  /** Close elements down to (and including) `name`, if it is open. */
  const closeThrough = name => {
    const index = stack.lastIndexOf(name);
    if (index === -1) return false;
    while (stack.length > index) output.push(closeTag(stack.pop()));
    return true;
  };

  for (const token of tokens) {
    if (skipUntilClose) {
      // Inside a discarded element: track nesting so <div><script>x</script></div>
      // does not end the skip early.
      if (token.type === "open" && token.name === skipUntilClose) skipDepth += 1;
      if (token.type === "close" && token.name === skipUntilClose) {
        skipDepth -= 1;
        if (skipDepth <= 0) skipUntilClose = null;
      }
      continue;
    }

    if (token.type === "text") {
      // Decode first, then escape: "&amp;" in the source is the character "&",
      // and escaping the raw form would store "&amp;amp;" and show the author a
      // literal "&amp;" on the page.
      output.push(escapeHtml(decodeEntities(token.value)));
      continue;
    }

    const rawName = token.name;
    const name = TAG_ALIASES[rawName] || rawName;

    if (DROP_WITH_CONTENT.has(rawName) || DROP_WITH_CONTENT.has(name)) {
      if (token.type === "open" && !VOID_TAGS.has(rawName) && !token.selfClosing) {
        skipUntilClose = rawName;
        skipDepth = 1;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      continue; // Unknown tag: unwrap, keeping its text.
    }

    if (token.type === "close") {
      if (stack.length >= MAX_DEPTH) continue;
      closeThrough(name);
      continue;
    }

    if (stack.length >= MAX_DEPTH) continue;

    // <li> closes the previous item; a list item without a list is dropped.
    if (name === "li") {
      if (top() === "li") output.push(closeTag(stack.pop()));
      if (!["ul", "ol"].includes(top())) continue;
    }

    // A block element cannot live inside a paragraph: close it first.
    if (BLOCK_TAGS.has(name) && top() === "p") output.push(closeTag(stack.pop()));
    // Nested links are invalid; start a new one instead of nesting.
    if (name === "a" && top() === "a") output.push(closeTag(stack.pop()));

    const attributes = filterAttributes(name, token.attributes);
    output.push(openTag(name, serialiseAttributes(attributes), token.selfClosing));

    if (!VOID_TAGS.has(name) && !token.selfClosing) stack.push(name);
  }

  while (stack.length) output.push(closeTag(stack.pop()));

  const html = output.join("");
  return { html, text: stripTags(html), truncated: false };
}

/** Plain text of an HTML fragment, with block ends turned into line breaks. */
function stripTags(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|blockquote|figcaption|div|tr)>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Word count of an HTML fragment. */
function countWords(html) {
  const text = stripTags(html);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

module.exports = {
  ALLOWED_TAGS,
  DROP_WITH_CONTENT,
  MAX_INPUT_LENGTH,
  countWords,
  decodeEntities,
  escapeHtml,
  looksLikePlainText,
  safeUrl,
  sanitizeBody,
  stripTags
};