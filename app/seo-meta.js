"use strict";

/**
 * KaliNova — server-side SEO metadata
 *
 * The client already rewrites title/description/canonical/robots/Open Graph,
 * Twitter and JSON-LD at render time (frontend/seo.js). That is fine for a
 * human, but a crawler that does not run JavaScript sees only what the static
 * index.html ships. This module builds the same metadata on the server so the
 * four server-rendered landing pages — /blog/<slug>, /category/<slug>,
 * /tag/<slug> and /author/<slug> — carry the correct tags in the first byte.
 *
 * It is deliberately pure: it takes a row and returns an object, then renders
 * HTML strings. No database access, no I/O, no request object. That keeps it
 * trivial to unit-test and impossible to leak an admin-only field into the
 * public page: only the fields named below are ever read.
 *
 * Every entity-level override is optional and falls back to the entity's own
 * content, so an editor who fills in nothing still gets sensible metadata.
 */

const config = require("./config");

const SITE_NAME = "KaliNova";
const LOCALE = "en_IN";
const DEFAULT_DESCRIPTION =
  "KaliNova is an independent publishing platform for readers and writers, covering stories on cinema, fashion, news, wildlife and travel.";
const DEFAULT_IMAGE = "/assets/og-image.png";
const DEFAULT_IMAGE_ALT = SITE_NAME;

/** The trailing fallback title every page uses when it has no better one. */
const DEFAULT_TITLE = `${SITE_NAME} — Read. Write. Share.`;

const TITLE_SUFFIX = ` | ${SITE_NAME}`;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 158;

/**
 * Escape a value for use in HTML text or a double-quoted attribute. Both
 * contexts are covered by the five-character set, which is all the metadata
 * renderer needs.
 */
function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Collapse whitespace and clip to `max` characters on a word boundary. */
function clamp(value, max) {
  const text = String(value === null || value === undefined ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max * 0.5 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** Resolve a path or absolute URL against the site origin. */
function absolute(origin, value) {
  if (!value) return "";
  const raw = String(value).trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return `${origin}${path}`;
}

function articlePath(slug) {
  return `/blog/${encodeURIComponent(String(slug))}`;
}

function categoryPath(slug) {
  return `/category/${encodeURIComponent(String(slug))}`;
}

function tagPath(slug) {
  return `/tag/${encodeURIComponent(String(slug))}`;
}

function authorPath(slug) {
  return `/author/${encodeURIComponent(String(slug))}`;
}

/**
 * The robots meta content. Only the two values the database constrains are
 * recognised; anything else falls back to the permissive default.
 */
function robotsContent(index, follow) {
  const indexPart = index === "noindex" ? "noindex" : "index";
  const followPart = follow === "nofollow" ? "nofollow" : "follow";
  return `${indexPart}, ${followPart}, max-image-preview:large, max-snippet:-1, max-video-preview:-1`;
}

function isoDate(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function authorName(author) {
  return String(
    (author && (author.display_name || author.username || author.name)) || SITE_NAME
  );
}

function siteRef(origin) {
  return `${origin}/#website`;
}

function organizationRef(origin) {
  return `${origin}/#organization`;
}

/**
 * The shared @graph the page JSON-LD is built from: Organization + WebSite,
 * matching the static block in index.html so the identifiers stay stable.
 */
function baseGraph(origin) {
  return [
    {
      "@type": "Organization",
      "@id": organizationRef(origin),
      name: SITE_NAME,
      url: `${origin}/`,
      logo: {
        "@type": "ImageObject",
        url: `${origin}/assets/kalinova-logo-96.png`,
        width: 96,
        height: 96
      }
    },
    {
      "@type": "WebSite",
      "@id": siteRef(origin),
      name: SITE_NAME,
      url: `${origin}/`,
      description: DEFAULT_DESCRIPTION,
      inLanguage: "en-IN",
      publisher: { "@id": organizationRef(origin) },
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${origin}/search?q={search_term_string}`
        },
        "query-input": "required name=search_term_string"
      }
    }
  ];
}

/**
 * Build the metadata object for a landing page. `page` is one of:
 *   { type: "article",  article, author, category, tags }
 *   { type: "category", category }
 *   { type: "tag",      tag }
 *   { type: "author",   author, articleCount }
 * Returns a plain object, fully defaulted.
 */
function buildPageMeta(page, options = {}) {
  const origin = (options.origin || config.siteOrigin).replace(/\/$/, "");

  if (page.type === "article") return buildArticleMeta(page, origin);
  if (page.type === "category") return buildCategoryMeta(page, origin);
  if (page.type === "tag") return buildTagMeta(page, origin);
  if (page.type === "author") return buildAuthorMeta(page, origin);

  return {
    type: "website",
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    canonical: `${origin}/`,
    robots: robotsContent("index", "follow"),
    author: SITE_NAME,
    image: absolute(origin, DEFAULT_IMAGE),
    imageAlt: DEFAULT_IMAGE_ALT,
    ogType: "website",
    url: `${origin}/`,
    locale: LOCALE,
    siteName: SITE_NAME,
    jsonLd: baseGraph(origin)
  };
}

function buildArticleMeta(page, origin) {
  const article = page.article || {};
  const path = articlePath(article.slug);
  const url = `${origin}${path}`;

  const rawTitle = article.meta_title || article.title || DEFAULT_TITLE;
  const title = article.meta_title
    ? clamp(rawTitle, TITLE_MAX)
    : clamp(`${rawTitle}${TITLE_SUFFIX}`, TITLE_MAX + TITLE_SUFFIX.length);
  const description = clamp(
    article.meta_description || article.excerpt || article.title || DEFAULT_DESCRIPTION,
    DESCRIPTION_MAX
  );
  const canonical = article.canonical_url
    ? absolute(origin, article.canonical_url)
    : url;
  const image = absolute(origin, article.og_image || article.cover_image || DEFAULT_IMAGE);
  const authorLabel = authorName(page.author);
  const published = isoDate(article.published_at || article.created_at);
  const modified = isoDate(article.updated_at || article.published_at || article.created_at);

  const jsonLd = baseGraph(origin);
  const articleNode = {
    "@type": article.schema_type || "BlogPosting",
    "@id": `${url}#article`,
    headline: clamp(article.title || rawTitle, 110),
    description,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    image: image ? [image] : undefined,
    inLanguage: "en-IN",
    isPartOf: { "@id": siteRef(origin) },
    publisher: { "@id": organizationRef(origin) },
    author: {
      "@type": "Person",
      name: authorLabel,
      url: page.author && page.author.slug ? `${origin}${authorPath(page.author.slug)}` : undefined
    }
  };
  if (published) articleNode.datePublished = published;
  if (modified) articleNode.dateModified = modified;
  if (page.category && page.category.name) {
    articleNode.articleSection = page.category.name;
  }
  if (Array.isArray(page.tags) && page.tags.length) {
    articleNode.keywords = page.tags.map(tag => tag.name).filter(Boolean).join(", ");
  }
  jsonLd.push(articleNode);

  const breadcrumb = [
    { name: SITE_NAME, path: "/" },
    page.category && page.category.name
      ? { name: page.category.name, path: categoryPath(page.category.slug) }
      : null,
    { name: article.title || rawTitle, path }
  ].filter(Boolean);
  jsonLd.push(buildBreadcrumb(origin, breadcrumb));

  const meta = {
    type: "article",
    title,
    description,
    canonical,
    robots: robotsContent(article.robots_index, article.robots_follow),
    author: authorLabel,
    image,
    imageAlt: article.banner_alt || article.title || DEFAULT_IMAGE_ALT,
    ogType: "article",
    url,
    locale: LOCALE,
    siteName: SITE_NAME,
    publishedTime: published,
    modifiedTime: modified,
    section: page.category && page.category.name ? page.category.name : undefined,
    tags: Array.isArray(page.tags) ? page.tags.map(tag => tag.name).filter(Boolean) : [],
    jsonLd
  };
  return applySocialOverrides(meta, article);
}

function buildCategoryMeta(page, origin) {
  const category = page.category || {};
  const path = categoryPath(category.slug);
  const url = `${origin}${path}`;
  const name = category.name || "Category";

  const title = clamp(
    category.meta_title || `${name}${TITLE_SUFFIX}`,
    TITLE_MAX + TITLE_SUFFIX.length
  );
  const description = clamp(
    category.meta_description || category.description || DEFAULT_DESCRIPTION,
    DESCRIPTION_MAX
  );
  const image = absolute(origin, category.image || DEFAULT_IMAGE);

  const jsonLd = baseGraph(origin);
  jsonLd.push({
    "@type": "CollectionPage",
    "@id": `${url}#collection`,
    name,
    description,
    url,
    isPartOf: { "@id": siteRef(origin) },
    inLanguage: "en-IN"
  });
  jsonLd.push(
    buildBreadcrumb(origin, [
      { name: SITE_NAME, path: "/" },
      { name, path }
    ])
  );

  return applySocialOverrides(
    {
      type: "category",
      title,
      description,
      canonical: category.canonical_url ? absolute(origin, category.canonical_url) : url,
      robots: robotsContent(category.robots_index, category.robots_follow),
      author: SITE_NAME,
      image,
      imageAlt: name,
      ogType: "website",
      url,
      locale: LOCALE,
      siteName: SITE_NAME,
      jsonLd
    },
    category
  );
}

function buildTagMeta(page, origin) {
  const tag = page.tag || {};
  const path = tagPath(tag.slug);
  const url = `${origin}${path}`;
  const name = tag.name || "Tag";

  const jsonLd = baseGraph(origin);
  jsonLd.push({
    "@type": "CollectionPage",
    "@id": `${url}#collection`,
    name,
    description: tag.description || undefined,
    url,
    isPartOf: { "@id": siteRef(origin) },
    inLanguage: "en-IN"
  });
  jsonLd.push(
    buildBreadcrumb(origin, [
      { name: SITE_NAME, path: "/" },
      { name, path }
    ])
  );

  return applySocialOverrides(
    {
      type: "tag",
      title: clamp(tag.meta_title || `${name}${TITLE_SUFFIX}`, TITLE_MAX + TITLE_SUFFIX.length),
      description: clamp(
        tag.meta_description || tag.description || `Stories tagged “${name}” on ${SITE_NAME}.`,
        DESCRIPTION_MAX
      ),
      canonical: tag.canonical_url ? absolute(origin, tag.canonical_url) : url,
      robots: robotsContent(tag.robots_index, tag.robots_follow),
      author: SITE_NAME,
      image: absolute(origin, DEFAULT_IMAGE),
      imageAlt: name,
      ogType: "website",
      url,
      locale: LOCALE,
      siteName: SITE_NAME,
      jsonLd
    },
    tag
  );
}

function buildAuthorMeta(page, origin) {
  const author = page.author || {};
  const slug = author.slug || author.username;
  const path = authorPath(slug);
  const url = `${origin}${path}`;
  const name = authorName(author);

  const jsonLd = baseGraph(origin);
  const person = {
    "@type": "Person",
    "@id": `${url}#person`,
    name,
    url,
    jobTitle: author.role === "admin" ? "Editor" : undefined,
    description: author.bio || undefined,
    image: author.avatar_url ? absolute(origin, author.avatar_url) : undefined,
    sameAs: author.social_links ? Object.values(author.social_links).filter(Boolean) : undefined
  };
  jsonLd.push(person);
  jsonLd.push({
    "@type": "ProfilePage",
    "@id": `${url}#profile`,
    name: `${name}${TITLE_SUFFIX}`,
    url,
    isPartOf: { "@id": siteRef(origin) },
    about: { "@id": `${url}#person` },
    inLanguage: "en-IN"
  });
  jsonLd.push(
    buildBreadcrumb(origin, [
      { name: SITE_NAME, path: "/" },
      { name, path }
    ])
  );

  return applySocialOverrides(
    {
      type: "author",
      title: clamp(author.meta_title || `${name}${TITLE_SUFFIX}`, TITLE_MAX + TITLE_SUFFIX.length),
      description: clamp(
        author.meta_description ||
          author.bio ||
          `Stories written by ${name} on ${SITE_NAME}.`,
        DESCRIPTION_MAX
      ),
      canonical: author.canonical_url ? absolute(origin, author.canonical_url) : url,
      robots: robotsContent(author.robots_index, author.robots_follow),
      author: name,
      image: absolute(origin, author.avatar_url || DEFAULT_IMAGE),
      imageAlt: name,
      ogType: "profile",
      url,
      locale: LOCALE,
      siteName: SITE_NAME,
      jsonLd
    },
    author
  );
}

/** Apply the og_* / twitter_* overrides shared by every entity type. */
function applySocialOverrides(meta, entity) {
  const origin = meta.url ? new URL(meta.url).origin : config.siteOrigin.replace(/\/$/, "");

  meta.ogTitle = entity.og_title || meta.title;
  meta.ogDescription = clamp(entity.og_description || meta.description, DESCRIPTION_MAX);

  if (entity.og_image) meta.image = absolute(origin, entity.og_image);
  meta.ogImage = meta.image;

  meta.twitterTitle = entity.twitter_title || meta.ogTitle;
  meta.twitterDescription = clamp(
    entity.twitter_description || meta.ogDescription,
    DESCRIPTION_MAX
  );
  if (entity.twitter_image) {
    meta.twitterImage = absolute(origin, entity.twitter_image);
  } else {
    meta.twitterImage = meta.image;
  }
  return meta;
}

function buildBreadcrumb(origin, trail) {
  return {
    "@type": "BreadcrumbList",
    "@id": `${trail[trail.length - 1].path}#breadcrumb`,
    itemListElement: trail.map((step, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: step.name,
      item: `${origin}${step.path}`
    }))
  };
}

/**
 * Render the metadata object as the head block that replaces the content
 * between the SEO-HEAD markers in index.html.
 */
function renderHeadTags(meta) {
  const lines = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="title" content="${escapeHtml(meta.title)}">`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<meta name="robots" content="${escapeHtml(meta.robots)}">`,
    `<meta name="author" content="${escapeHtml(meta.author)}">`,
    `<meta name="theme-color" content="#1F6B4F">`,
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}">`,
    "",
    `<meta property="og:site_name" content="${escapeHtml(meta.siteName)}">`,
    `<meta property="og:locale" content="${escapeHtml(meta.locale)}">`,
    `<meta property="og:type" content="${escapeHtml(meta.ogType)}">`,
    `<meta property="og:title" content="${escapeHtml(meta.ogTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.ogDescription)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.url)}">`,
    `<meta property="og:image" content="${escapeHtml(meta.image)}">`,
    `<meta property="og:image:alt" content="${escapeHtml(meta.imageAlt)}">`
  ];

  if (meta.publishedTime) {
    lines.push(`<meta property="article:published_time" content="${escapeHtml(meta.publishedTime)}">`);
  }
  if (meta.modifiedTime) {
    lines.push(`<meta property="article:modified_time" content="${escapeHtml(meta.modifiedTime)}">`);
  }
  if (meta.section) {
    lines.push(`<meta property="article:section" content="${escapeHtml(meta.section)}">`);
  }
  for (const tag of meta.tags || []) {
    lines.push(`<meta property="article:tag" content="${escapeHtml(tag)}">`);
  }

  lines.push(
    "",
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.twitterTitle || meta.ogTitle)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.twitterDescription || meta.ogDescription)}">`,
    `<meta name="twitter:image" content="${escapeHtml(meta.twitterImage || meta.image)}">`,
    `<meta name="twitter:image:alt" content="${escapeHtml(meta.imageAlt)}">`
  );

  return lines.join("\n");
}

/** Render the JSON-LD script block that replaces the SEO-JSONLD markers. */
function renderJsonLd(meta) {
  const graph = {
    "@context": "https://schema.org",
    "@graph": meta.jsonLd
  };
  // JSON.stringify escapes <, > and & is unnecessary inside a script of type
  // application/ld+json, but escaping "<" prevents a "</script>" in any string
  // from closing the element early.
  const json = JSON.stringify(graph, null, 2).replace(/</g, "\\u003c");
  return `<script type="application/ld+json" id="kalinova-jsonld">\n${json}\n</script>`;
}

module.exports = {
  SITE_NAME,
  DEFAULT_TITLE,
  DEFAULT_DESCRIPTION,
  buildPageMeta,
  renderHeadTags,
  renderJsonLd,
  robotsContent,
  escapeHtml,
  clamp,
  articlePath,
  categoryPath,
  tagPath,
  authorPath
};
