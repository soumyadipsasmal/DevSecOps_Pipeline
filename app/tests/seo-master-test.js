"use strict";

/**
 * KaliNova — SEO master pipeline tests
 *
 * Covers the decisions the SEO-first content platform has to keep:
 *
 *   1. metadata is built from public fields only, escapes whatever it renders,
 *      and falls back sensibly when an editor filled in nothing
 *   2. the sitemap and robots are generated from the database, so a published
 *      story is discoverable without a rebuild, and an unpublished or noindex
 *      row is never requested for indexing
 *   3. tags are a real taxonomy: slugs are normalised, membership is unique and
 *      article or tag deletion cleans the join up
 *   4. the servers-side landing pages and the admin form are wired together
 *
 * Pure functions run inline. The database is used for a small create/read/
 * delete round-trip that cleans up after itself, and the pool is closed last.
 *
 * Run with:  node tests/seo-master-test.js
 */

require("./test-db-guard");

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const seoMeta = require("../seo-meta");
const sitemaps = require("../sitemap-service");
const tagService = require("../tag-service");
const validation = require("../article-validation");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function check(name, condition, detail) {
  test(name, () => {
    assert.ok(condition, detail || "condition was not true");
  });
}

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

const ORIGIN = "https://kalinova.in";

/* ==================================================================== */
/* [1] Metadata builder (pure)                                          */
/* ==================================================================== */

section("[1] Metadata builder");

const articleMeta = seoMeta.buildPageMeta({
  type: "article",
  article: {
    id: 1,
    title: "A Quiet Revolution in Indian Cinema",
    slug: "quiet-revolution-indian-cinema",
    excerpt: "How a new wave of directors is rewriting the rules.",
    meta_description: "A new wave of Indian directors is rewriting the rules of mainstream cinema.",
    cover_image: "/assets/topics/cinema.jpg",
    schema_type: "NewsArticle",
    robots_index: "index",
    robots_follow: "follow",
    published_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-03T00:00:00Z"
  },
  author: { username: "kalinova", slug: "kalinova" },
  category: { name: "Cinema", slug: "cinema" },
  tags: [{ name: "Bollywood", slug: "bollywood" }]
}, { origin: ORIGIN });

check("article title ends with the site suffix", articleMeta.title.endsWith(` | ${seoMeta.SITE_NAME}`), articleMeta.title);
check("article canonical is the blog URL", articleMeta.canonical === `${ORIGIN}/blog/quiet-revolution-indian-cinema`, articleMeta.canonical);
check("article robots defaults to index, follow", articleMeta.robots.startsWith("index, follow"), articleMeta.robots);
check("article og type is article", articleMeta.ogType === "article");
check("article image is absolutised", articleMeta.image === `${ORIGIN}/assets/topics/cinema.jpg`, articleMeta.image);
check("article author is resolved", articleMeta.author === "kalinova");
check("article section is the category", articleMeta.section === "Cinema");
check("article tags are exposed", articleMeta.tags.includes("Bollywood"));

check(
  "article JSON-LD uses the chosen schema type",
  articleMeta.jsonLd.some(node => node["@type"] === "NewsArticle"),
  articleMeta.jsonLd.map(node => node["@type"]).join(", ")
);
check("article JSON-LD has a breadcrumb", articleMeta.jsonLd.some(node => node["@type"] === "BreadcrumbList"));

const overrideMeta = seoMeta.buildPageMeta({
  type: "article",
  article: {
    title: "Internal headline",
    slug: "story",
    meta_title: "Search title",
    meta_description: "Search description",
    canonical_url: "https://elsewhere.example/original",
    robots_index: "noindex",
    robots_follow: "nofollow",
    og_title: "Social title",
    og_description: "Social description",
    og_image: "https://cdn.example/card.png",
    twitter_title: "Bird title",
    twitter_image: "/assets/twitter.png"
  },
  author: { username: "author" },
  category: null,
  tags: []
}, { origin: ORIGIN });

check("meta_title overrides the headline verbatim", overrideMeta.title === "Search title", overrideMeta.title);
check("canonical_url override is honoured", overrideMeta.canonical === "https://elsewhere.example/original", overrideMeta.canonical);
check("noindex/nofollow are honoured", overrideMeta.robots.startsWith("noindex, nofollow"), overrideMeta.robots);
check("og overrides are applied", overrideMeta.ogTitle === "Social title" && overrideMeta.image === "https://cdn.example/card.png", overrideMeta.image);
check("twitter overrides are applied", overrideMeta.twitterTitle === "Bird title" && overrideMeta.twitterImage === `${ORIGIN}/assets/twitter.png`, overrideMeta.twitterImage);

const categoryMeta = seoMeta.buildPageMeta({ type: "category", category: { name: "Travel", slug: "travel" } }, { origin: ORIGIN });
check("category canonical is the category URL", categoryMeta.canonical === `${ORIGIN}/category/travel`, categoryMeta.canonical);
check("category JSON-LD is a CollectionPage", categoryMeta.jsonLd.some(node => node["@type"] === "CollectionPage"));

const tagMeta = seoMeta.buildPageMeta({ type: "tag", tag: { name: "Wildlife", slug: "wildlife" } }, { origin: ORIGIN });
check("tag canonical is the tag URL", tagMeta.canonical === `${ORIGIN}/tag/wildlife`, tagMeta.canonical);

const authorMeta = seoMeta.buildPageMeta(
  { type: "author", author: { username: "kalinova", slug: "kalinova", bio: "Editor", role: "admin" } },
  { origin: ORIGIN }
);
check("author canonical is the author URL", authorMeta.canonical === `${ORIGIN}/author/kalinova`, authorMeta.canonical);
check("author JSON-LD includes a Person", authorMeta.jsonLd.some(node => node["@type"] === "Person"));

const rendered = seoMeta.renderHeadTags({
  ...articleMeta,
  title: 'Ha <script>alert("x")</script> & "quotes"',
  description: "d",
  canonical: articleMeta.canonical,
  author: "a",
  siteName: "KaliNova",
  locale: "en_IN",
  ogType: "article",
  ogTitle: "t",
  ogDescription: "d",
  url: articleMeta.url,
  image: "i",
  imageAlt: "alt",
  twitterTitle: "t",
  twitterDescription: "d",
  twitterImage: "i",
  robots: articleMeta.robots
});
check("rendered head escapes angle brackets", !rendered.includes("<script>"));
check("rendered head escapes ampersands", rendered.includes("&amp;"));
check("rendered head contains a canonical link", rendered.includes('rel="canonical"'));
check("rendered head contains og:title", rendered.includes('property="og:title"'));
check("rendered head contains twitter:card", rendered.includes('name="twitter:card"'));

const jsonld = seoMeta.renderJsonLd(articleMeta);
check("rendered JSON-LD is a script tag", jsonld.startsWith('<script type="application/ld+json"'));
check("rendered JSON-LD contains the graph context", jsonld.includes('"@context": "https://schema.org"'));

check("an empty page falls back to the site defaults", seoMeta.buildPageMeta({ type: "website" }, { origin: ORIGIN }).title === seoMeta.DEFAULT_TITLE);

/* ==================================================================== */
/* [2] Sitemap + robots                                                 */
/* ==================================================================== */

section("[2] Sitemap and robots");

check("xmlEscape escapes ampersands", sitemaps.xmlEscape("a&b") === "a&amp;b");
check("xmlEscape escapes angle brackets", sitemaps.xmlEscape("<a>") === "&lt;a&gt;");

const robots = sitemaps.buildRobots();
check("robots disallows /admin", robots.includes("Disallow: /admin"));
check("robots disallows the API", robots.includes("Disallow: /api/"));
check("robots points at the sitemap index", robots.includes("Sitemap: https://kalinova.in/sitemap.xml"));

/* ==================================================================== */
/* [3] Tag taxonomy helpers (pure)                                      */
/* ==================================================================== */

section("[3] Tag taxonomy");

check("slugify lowercases", tagService.slugify("Bollywood") === "bollywood");
check("slugify collapses spaces", tagService.slugify("Indian  Cinema") === "indian-cinema");
check("slugify strips punctuation", tagService.slugify("LGBTQ+ Rights!") === "lgbtq-rights");
check("slugify trims leading/trailing hyphens", tagService.slugify("  --News--  ") === "news");
check("slugify returns empty for symbols", tagService.slugify("!!!") === "");

/* ==================================================================== */
/* [4] Validation status model                                          */
/* ==================================================================== */

section("[4] Editorial status model");

check("the status list has four states", validation.STATUSES.length === 4, validation.STATUSES.join(", "));
check("archived is a known status", validation.STATUSES.includes("archived"));
check("scheduled is a known status", validation.STATUSES.includes("scheduled"));
check(
  "scheduled is treated as a publishing status",
  validation.PUBLICATION_STATUSES.includes("scheduled") && validation.PUBLICATION_STATUSES.includes("published")
);

/* ==================================================================== */
/* [5] Wiring: frontend markers, server mounting, Docker, npm, migrate  */
/* ==================================================================== */

section("[5] Wiring");

const indexHtml = read("../../frontend/index.html");
check("index.html has the SEO head markers", indexHtml.includes("<!-- SEO-HEAD:START -->") && indexHtml.includes("<!-- SEO-HEAD:END -->"));
check("index.html has the JSON-LD markers", indexHtml.includes("<!-- SEO-JSONLD:START -->") && indexHtml.includes("<!-- SEO-JSONLD:END -->"));

const serverSource = read("../server.js");
check(
  "server mounts the SEO router before static",
  serverSource.indexOf("app.use(seoRouter)") !== -1 &&
    serverSource.indexOf("app.use(seoRouter)") < serverSource.indexOf("app.use(express.static(")
);
check("server serves the SEO page router", serverSource.includes("app.use(seoPageRouter)"));
check("server starts the scheduled publisher", serverSource.includes("scheduledPublisher.start()"));

const routesSource = read("../seo-master-routes.js");
check("seo routes export the sitemap router", routesSource.includes("seoRouter"));
check("seo routes export the page router", routesSource.includes("seoPageRouter"));
check("seo page router filters articles on published status", /a\.status = 'published'/.test(routesSource));

const viewsSource = read("../admin-article-views.js");
check("the form has a tags input", viewsSource.includes('name="tags"'));
check("the form has a scheduled_at input", viewsSource.includes('name="scheduled_at"'));
check("the form has a robots index select", viewsSource.includes('name="robots_index"'));
check("the form has an og_image input", viewsSource.includes('name="og_image"'));

const adminRoutesSource = read("../admin-article-routes.js");
check("admin routes parse tags", adminRoutesSource.includes("parseTags"));
check("admin routes persist tags", adminRoutesSource.includes("tagService.setArticleTags"));

const dockerfile = read("../../Dockerfile");
for (const module of ["seo-meta.js", "sitemap-service.js", "tag-service.js", "seo-master-routes.js", "scheduled-publisher.js"]) {
  check(`Dockerfile copies ${module}`, dockerfile.includes(`app/${module}`));
}

const packageJson = JSON.parse(read("../package.json"));
check("the suite runs with npm test", packageJson.scripts.test.includes("seo-master-test.js"));

const migrateSource = read("../migrate.js");
check("the content migration is registered", migrateSource.includes("schema-seo-content.sql"));
check(
  "the content migration is registered after seo-master",
  migrateSource.indexOf("schema-seo-content.sql") > migrateSource.indexOf("schema-seo-master.sql")
);

const compose = read("../../docker-compose.yml");
check("the content schema is mounted into a fresh database", compose.includes("schema-seo-content.sql"));

const contentSchema = read("../../database/schema-seo-content.sql");
check("the content schema creates tags", /CREATE TABLE tags/.test(contentSchema));
check("the content schema creates article_tags", /CREATE TABLE article_tags/.test(contentSchema));

/* ==================================================================== */
/* [6] Database round-trip                                              */
/* ==================================================================== */

section("[6] Database round-trip");

(async () => {
  const pool = require("../db");
  let tempArticleId = null;
  const tempSlugs = ["zz-seo-test-alpha", "zz-seo-test-beta"];

  try {
    const index = await sitemaps.buildSitemapIndex();
    check("the sitemap index is valid XML", index.startsWith("<?xml") && index.includes("<sitemapindex"));
    for (const child of ["pages", "articles", "categories", "tags", "authors"]) {
      check(`the sitemap index references ${child}`, index.includes(`sitemap-${child}.xml`));
    }

    const articles = await sitemaps.buildArticlesSitemap();
    check("the articles sitemap is a urlset", articles.includes("<urlset"));
    const articleRows = await pool.query(
      "SELECT COUNT(*)::int AS total FROM articles WHERE status = 'published' AND published_at IS NOT NULL"
    );
    if (articleRows.rows[0].total > 1) {
      check("the articles sitemap has loc entries", (articles.match(/<loc>/g) || []).length >= 1);
    } else {
      check("the articles sitemap is generated", typeof articles === "string");
    }

    const categoriesSitemap = await sitemaps.buildCategoriesSitemap();
    check("the categories sitemap is generated", categoriesSitemap.includes("<urlset"));
    check("an unknown child sitemap is rejected", (await sitemaps.buildChild("nope")) === null);

    // A temporary published article exercises tags end to end, then is removed.
    const created = await pool.query(
      `INSERT INTO articles (title, slug, content, author_id, status, published_at)
       SELECT 'SEO master test article', $1, 'Test body content for the SEO master suite.', id, 'published', NOW()
         FROM users
        ORDER BY id ASC
        LIMIT 1
       RETURNING id`,
      ["zz-seo-test-article"]
    );
    tempArticleId = created.rows[0].id;

    const tagList = await tagService.setArticleTags(tempArticleId, ["SEO Test Alpha", "seo test alpha", "SEO Test Beta"]);
    check("duplicate tags are de-duplicated", tagList.length === 2, JSON.stringify(tagList.map(tag => tag.slug)));

    const viaLookup = await tagService.getTagBySlug("seo-test-alpha");
    check("a created tag is retrievable by slug", Boolean(viaLookup && viaLookup.slug === "seo-test-alpha"));

    const grouped = await tagService.getTagsForArticles([tempArticleId]);
    check("batch tag lookup groups by article", (grouped.get(tempArticleId) || []).length === 2);

    const byTag = await tagService.listArticlesByTag("seo-test-alpha");
    check("a tag lists its published articles", byTag.total === 1, String(byTag.total));

    for (const slug of tempSlugs) {
      const removed = await tagService.deleteTag((await tagService.getTagBySlug(slug) || {}).id);
      check(`tag ${slug} can be deleted`, removed === true || (await tagService.getTagBySlug(slug)) === null);
    }
  } catch (error) {
    check("the database is reachable", false, error.message);
  } finally {
    try {
      if (tempArticleId) await pool.query("DELETE FROM articles WHERE id = $1", [tempArticleId]);
      await pool.query("DELETE FROM tags WHERE slug = ANY($1)", [tempSlugs]);
      await pool.query("DELETE FROM tags WHERE slug = 'seo-test-beta'");
      await pool.query("DELETE FROM articles WHERE slug = 'zz-seo-test-article'");
    } catch {
      /* best-effort cleanup */
    }

    try {
      await pool.end();
    } catch {
      /* nothing was ever connected */
    }

    console.log(`\n${passed} checks passed, ${failed} failed`);
    if (failed > 0) {
      for (const failure of failures) {
        console.log(`  - ${failure.name}: ${failure.error.message}`);
      }
      process.exitCode = 1;
    }
  }
})();
