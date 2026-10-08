"use strict";

/**
 * KaliNova — SEO engine & redirects tests
 *
 * Covers what the SEO Engine v1 feature has to keep true:
 *
 *   1. the engine is deterministic and pure — the same article always scores
 *      the same, no third-party service is called, and analysis persists
 *      nothing
 *   2. the report is transparent — fixed categories with fixed weights that sum
 *      to 100, one stable version identifier, and every finding surfaced as a
 *      check with a severity
 *   3. an article is never blocked on a low score; only critical technical or
 *      content problems produce BLOCKED, and publication readiness is content
 *      work, not ranking prediction
 *   4. the redirect table is the only thing the engine feature stores — a
 *      301 source is a clean public site path, destinations avoid the admin,
 *      API, asset and affiliate surfaces, and duplicates are impossible
 *   5. the admin surfaces (SEO panel + redirects) are wired behind the
 *      existing admin chain with CSRF on every mutation
 *
 * Everything that can run without a live HTTP server does. The database is
 * used for schema checks and one create/list/delete round trip, and the pool
 * is closed at the end.
 *
 * Run with:  node tests/seo-engine-test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const { analyzeArticle, CATEGORY_LABELS, CATEGORY_WEIGHTS, SEVERITY, VERSION, parseBody, deriveTopic } = require("../seo-engine");
const redirects = require("../redirect-service");

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

const read = relative => fs.readFileSync(path.join(__dirname, "..", "..", relative), "utf8");

/* The fixture the fixed expectation below was derived from: a normal,
 * published Mumbai piece. It has an HTML body with h2s (the public page
 * renders the title as the only h1) and a banner. It is deliberately NOT a
 * perfect article — the whole point is that a good-but-flawed article lands
 * in NEEDS_REVIEW with a handful of warnings, not BLOCKED. */
function fixture() {
  return {
    title: "How Mumbai Built Its Coastal Road",
    slug: "how-mumbai-built-its-coastal-road",
    meta_description:
      "Packages in Mumbai now flow along a six-lane coastal artery. Here is the story of the road, the bay and the city that waited for it.",
    content:
      "<h2>The promise</h2>" +
      "<p>For decades Mumbai promised its drivers a coastal road. The bay swallowed money and plans again and again.</p>" +
      "<h2>The build</h2>" +
      "<p>Engineers dredged the seabed and tipped rock into the water. Six lanes rose from the tide. Now containers and commuters share the artery.</p>" +
      "<h2>The cost</h2>" +
      "<p>The road costs money, and critics say the bay pays for it.</p>",
    body_format: "html",
    cover_image: "/uploads/coastal-road.webp",
    banner_alt: "The six-lane coastal road curving along Mumbai harbour at dusk",
    category_name: "Mumbai",
    status: "published"
  };
}

function fixtureOptions() {
  return {
    services: {
      similarTitles: async () => [],
      slugTaken: async () => false,
      articleTargetExists: async () => false,
      suggestCandidates: async () => []
    }
  };
}

/* ==================================================================== */
/* [1] Report contract                                                   */
/* ==================================================================== */

section("[1] Report contract");

test("the engine identifies itself with a stable version", () => {
  assert.strictEqual(VERSION, "seo-v1");
});

test("severity vocabulary is the documented one", () => {
  assert.deepStrictEqual(
    [SEVERITY.PASS, SEVERITY.WARNING, SEVERITY.ERROR, SEVERITY.INFO].slice().sort(),
    ["ERROR", "INFO", "PASS", "WARNING"]
  );
});

test("the six category weights are fixed and sum to 100", () => {
  assert.deepStrictEqual(CATEGORY_WEIGHTS, {
    onPage: 30,
    content: 25,
    technical: 20,
    internalLinks: 10,
    media: 10,
    social: 5
  });
  assert.strictEqual(Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test("every weight has a human label", () => {
  for (const key of Object.keys(CATEGORY_WEIGHTS)) {
    assert.ok(CATEGORY_LABELS[key], `missing label for ${key}`);
  }
});

test("the fixture article stays within the report contract", async () => {
  const report = await analyzeArticle(fixture(), fixtureOptions());
  assert.strictEqual(typeof report.score, "number");
  assert.ok(report.score >= 0 && report.score <= 100);
  assert.ok(report.checks.every(c => Object.keys(CATEGORY_WEIGHTS).includes(c.category)));
  assert.ok(report.checks.every(c => [SEVERITY.PASS, SEVERITY.WARNING, SEVERITY.ERROR, SEVERITY.INFO].includes(c.severity)));
  assert.ok(report.checks.length > 0);
});

/* ==================================================================== */
/* [2] Determinism & purity                                              */
/* ==================================================================== */

section("[2] Determinism & purity");

test("the same article always produces the same report", async () => {
  const first = await analyzeArticle(fixture(), fixtureOptions());
  const second = await analyzeArticle(fixture(), fixtureOptions());
  assert.deepStrictEqual(second, first);
});

test("the analyzer persists nothing and needs no upstream calls (no fetch, no require of http clients)", () => {
  const source = fs.readFileSync(require.resolve("../seo-engine"), "utf8");
  assert.ok(!source.includes("require(\"https\")") && !source.includes("require(\"http\")"));
  assert.ok(!source.includes("fetch("));
  assert.ok(!/createWriteStream|INSERT INTO|UPDATE /.test(source));
});

test("the engine reads the article body, not a legacy text field", () => {
  const source = fs.readFileSync(require.resolve("../seo-engine"), "utf8");
  assert.ok(source.includes("article.text || article.body") || source.includes("article.body"));
  assert.ok(!/article\.text\b(?![^\n]*\|\|)/.test(source));
});

/* ==================================================================== */
/* [3] Fixed fixture expectations                                        */
/* ==================================================================== */

section("[3] Fixed fixture expectations");

test("the fixture scores 93 out of 100", async () => {
  const report = await analyzeArticle(fixture(), fixtureOptions());
  assert.strictEqual(report.score, 93);
});

test("a flawed-but-publishable article is NEEDS_REVIEW, never BLOCKED", async () => {
  const report = await analyzeArticle(fixture(), fixtureOptions());
  assert.strictEqual(report.status, "NEEDS_REVIEW");
  assert.strictEqual(report.errors.length, 0);
  assert.strictEqual(report.warnings.length, 4);
});

test("the fixture runs the full 38-check battery", async () => {
  const report = await analyzeArticle(fixture(), fixtureOptions());
  assert.strictEqual(report.checks.length, 38);
});

test("the per-category scores match the fixed expectation", async () => {
  const report = await analyzeArticle(fixture(), fixtureOptions());
  assert.deepStrictEqual(report.categories, {
    onPage: { score: 29, max: 30 },
    content: { score: 23, max: 25 },
    technical: { score: 18, max: 20 },
    internalLinks: { score: 8, max: 10 },
    media: { score: 10, max: 10 },
    social: { score: 5, max: 5 }
  });
});

test("every category reports its own ceiling", async () => {
  const report = await analyzeArticle(fixture(), fixtureOptions());
  for (const [key, { max }] of Object.entries(report.categories)) {
    assert.strictEqual(max, CATEGORY_WEIGHTS[key]);
  }
});

test("the topic is inferred from the body when none is declared", async () => {
  const report = await analyzeArticle(fixture(), fixtureOptions());
  assert.deepStrictEqual(report.topic, { value: "mumbai built coastal road", inferred: true });
});

test("the fixture produces the known key checks", async () => {
  const report = await analyzeArticle(fixture(), fixtureOptions());
  const ids = new Set(report.checks.map(c => c.id));
  for (const id of [
    "title_present",
    "title_length",
    "title_duplicate",
    "slug_present",
    "slug_duplicate",
    "word_count",
    "heading_structure",
    "canonical",
    "category_present",
    "internal_link_count",
    "broken_internal_link",
    "banner_present",
    "banner_alt_present",
    "og_title_source",
    "twitter_metadata"
  ]) {
    assert.ok(ids.has(id), `missing check ${id}`);
  }
});

test("a body heading behind the page h1 is not a failure", async () => {
  // The public page renders the article title as the only h1, so the engine
  // must not demand a second h1 in the body. The fixture uses only h2s.
  const report = await analyzeArticle(fixture(), fixtureOptions());
  const heading = report.checks.find(c => c.id === "heading_structure");
  assert.ok(heading);
  assert.notStrictEqual(heading.severity, SEVERITY.ERROR);
});

test("general suggestions are derived from the findings, capped at five", async () => {
  const report = await analyzeArticle(fixture(), fixtureOptions());
  assert.deepStrictEqual(report.suggestions, report.warnings);
  assert.ok(report.suggestions.length <= 5);
});

/* ==================================================================== */
/* [4] Severity behaviour                                                */
/* ==================================================================== */

section("[4] Severity behaviour");

test("a missing title blocks publication at the technical level", async () => {
  const report = await analyzeArticle({ ...fixture(), title: "" }, fixtureOptions());
  assert.strictEqual(report.status, "BLOCKED");
  assert.ok(report.errors.some(message => /title/i.test(message)));
});

test("a missing meta description is a warning, not a block", async () => {
  const report = await analyzeArticle({ ...fixture(), meta_description: "" }, fixtureOptions());
  assert.notStrictEqual(report.status, "BLOCKED");
  const meta = report.checks.find(c => c.id === "meta_description_present" || /meta/.test(c.id));
  assert.ok(!meta || meta.severity !== SEVERITY.ERROR);
});

test("slug duplication surfaces through the injected slug check", async () => {
  const report = await analyzeArticle(fixture(), {
    services: {
      ...fixtureOptions().services,
      slugTaken: async () => true
    }
  });
  const slug = report.checks.find(c => c.id === "slug_duplicate");
  assert.ok(slug);
  assert.strictEqual(slug.severity, SEVERITY.ERROR);
  assert.strictEqual(report.status, "BLOCKED");
});

/* ==================================================================== */
/* [5] Body parsing                                                      */
/* ==================================================================== */

section("[5] Body parsing");

test("HTML paragraphs are parsed into the body's paragraph list", () => {
  const parsed = parseBody("<p>One line.</p><p>Another line.</p>", "html");
  assert.strictEqual(parsed.paragraphList.length, 2);
});

test("plain-text bodies are parsed for markdown headings", () => {
  const parsed = parseBody("# The promise\n\nBody paragraph.", "text");
  assert.strictEqual(parsed.headings.length, 1);
  assert.strictEqual(parsed.headings[0].level, 1);
  assert.strictEqual(parsed.headings[0].text, "The promise");
});

test("deriveTopic returns a lowercase phrase", () => {
  const value = deriveTopic({ title: "Mumbai coastal road", headings: [] });
  assert.ok(value.value && value.value === value.value.toLowerCase());
});

/* ==================================================================== */
/* [6] Redirect path validation                                          */
/* ==================================================================== */

section("[6] Redirect path validation");

test("a clean source path is accepted and normalised", () => {
  assert.strictEqual(redirects.normalizeSourcePath("/blog/old-title"), "/blog/old-title");
  assert.strictEqual(redirects.normalizeSourcePath("/blog/old-title/"), "/blog/old-title");
});

test("a query string or fragment on a source is stripped", () => {
  assert.strictEqual(redirects.normalizeSourcePath("/blog/old-title?utm=1#share"), "/blog/old-title");
});

test("a source must be a site path", () => {
  assert.strictEqual(redirects.normalizeSourcePath("blog/old-title"), null);
  assert.strictEqual(redirects.normalizeSourcePath("/"), null);
  assert.strictEqual(redirects.normalizeSourcePath("https://kalinova.in/blog/x"), null);
});

test("reserved surfaces can never be a source", () => {
  assert.strictEqual(redirects.normalizeSourcePath("/admin/articles"), null);
  assert.strictEqual(redirects.normalizeSourcePath("/api/articles"), null);
  assert.strictEqual(redirects.normalizeSourcePath("/assets/img.png"), null);
  assert.strictEqual(redirects.normalizeSourcePath("/go/coupon"), null);
  assert.strictEqual(redirects.normalizeSourcePath("/health"), null);
});

test("a same-site destination follows the source rules", () => {
  assert.strictEqual(redirects.normalizeDestinationPath("/blog/new-title"), "/blog/new-title");
  assert.strictEqual(redirects.normalizeDestinationPath("/admin/articles"), null);
  assert.strictEqual(redirects.normalizeDestinationPath("https://kalinova.in/admin/articles"), null);
});

test("an absolute http(s) destination is kept", () => {
  assert.strictEqual(redirects.normalizeDestinationPath("https://example.com/offer"), "https://example.com/offer");
  assert.strictEqual(redirects.normalizeDestinationPath("https://example.com/offer/"), "https://example.com/offer");
});

test("dangerous destinations are rejected", () => {
  assert.strictEqual(redirects.normalizeDestinationPath("javascript:alert(1)"), null);
  assert.strictEqual(redirects.normalizeDestinationPath("ftp://example.com/"), null);
  assert.strictEqual(redirects.normalizeDestinationPath("https://user:secret@example.com/"), null);
});

test("status code is 301 by default and accepts only 301/302", () => {
  assert.strictEqual(redirects.normalizeStatusCode(undefined), 301);
  assert.strictEqual(redirects.normalizeStatusCode("302"), 302);
  assert.strictEqual(redirects.normalizeStatusCode(301), 301);
  assert.strictEqual(redirects.normalizeStatusCode(307), null);
  assert.strictEqual(redirects.normalizeStatusCode("exploded"), null);
});

test("slugs normalise for the redirect writer", () => {
  assert.strictEqual(redirects.slugValue("/blog/a-b-c"), "a-b-c");
  assert.strictEqual(redirects.slugValue("blog/a-b-c"), "a-b-c");
  assert.strictEqual(redirects.slugValue("a-b-c"), "a-b-c");
});

/* ==================================================================== */
/* [7] Wiring: routes, middleware, nav, build                            */
/* ==================================================================== */

section("[7] Wiring");

const routesSource = fs.readFileSync(require.resolve("../admin-routes"), "utf8");
check("the SEO routes are registered on the JSON surface", routesSource.includes("seoRoutes.registerApi(adminApi)"));
check("the redirect pages are registered on the HTML surface", routesSource.includes("redirectRoutes.registerPages(adminPages)"));
check("the redirect API is registered on the JSON surface", routesSource.includes("redirectRoutes.registerApi(adminApi)"));

const serverSource = fs.readFileSync(require.resolve("../server"), "utf8");
check("the server owns the redirect middleware", serverSource.includes("redirects.findBySource(path)"));
check("the middleware only answers GET and HEAD redirects", /req\.method !== "GET" && req\.method !== "HEAD"/.test(serverSource));
check("the middleware skips the reserved surfaces", serverSource.includes('path.startsWith("/admin")') && serverSource.includes('path.startsWith("/go/")'));
check("redirect responses are not cached", serverSource.includes('res.set("Cache-Control", "no-store")'));

const viewsSource = fs.readFileSync(require.resolve("../admin-views"), "utf8");
check(
  "the redirects link sits after Monetization in the nav",
  viewsSource.indexOf('item("Monetization"') < viewsSource.indexOf('item("Redirects"')
);

const articleServiceSource = fs.readFileSync(require.resolve("../article-service"), "utf8");
check("a published slug change records a 301", articleServiceSource.includes("redirects.recordSlugChange"));
check("the 301 only fires for published articles across a slug change", /before\.status === "published"/.test(articleServiceSource));

const seoRoutesFile = fs.readFileSync(require.resolve("../admin-seo-routes"), "utf8");
check("the analyze POST requires the CSRF token", seoRoutesFile.includes("security.requireCsrf"));
check("the analyze POST is IP-throttled", seoRoutesFile.includes("createLoginLimiter"));
check("unsaved editor content is sanitised before analysis", seoRoutesFile.includes("sanitizeBody"));
check("the engine options carry the site origin from config", seoRoutesFile.includes("siteUrl: config.siteOrigin"));

const articleFormViews = fs.readFileSync(require.resolve("../admin-article-views"), "utf8");
check("the article form carries the SEO panel", articleFormViews.includes("data-seo-panel"));
check("the article form loads the SEO panel script", articleFormViews.includes("admin-seo.js"));

const seoPanelJs = read("frontend/assets/admin/admin-seo.js");
check("the panel script only calls the server endpoints", !/https?:\/\/[^"']/.test(seoPanelJs));
check("the panel script posts the CSRF token header", seoPanelJs.includes("X-CSRF-Token"));
check("the panel script builds the report without assigning innerHTML", !/\.innerHTML\s*=/.test(seoPanelJs));

const cmsCss = read("frontend/assets/admin/admin-cms.css");
check("the CMS stylesheet styles the SEO panel", cmsCss.includes("admin-seo-score") && cmsCss.includes("admin-seo-bar"));

/* ==================================================================== */
/* [8] Migration, build and documentation wiring                         */
/* ==================================================================== */

section("[8] Migration, build and documentation wiring");

const migrateSource = fs.readFileSync(require.resolve("../migrate"), "utf8");
const migrationsBlock = migrateSource.slice(migrateSource.indexOf("const MIGRATIONS"));
check("the redirects migration is registered", migrateSource.includes("schema-seo-engine.sql"));
check(
  "the redirects migration is registered last",
  migrationsBlock.indexOf("schema-seo-engine.sql") > migrationsBlock.indexOf("schema-monetization.sql")
);

const composeSource = read("docker-compose.yml");
check("the SEO schema is mounted into a fresh database", composeSource.includes("schema-seo-engine.sql"));
check("the mount keeps the monetization statements before it", composeSource.indexOf("schema-monetization.sql") < composeSource.indexOf("schema-seo-engine.sql"));

const dockerfileSource = read("Dockerfile");
for (const module of [
  "seo-engine.js",
  "redirect-service.js",
  "admin-seo-routes.js",
  "admin-redirect-routes.js",
  "admin-redirect-views.js"
]) {
  check(`the Dockerfile copies ${module}`, dockerfileSource.includes(`COPY app/${module} .`));
}

const packageSource = read("app/package.json");
check("the SEO engine suite runs with npm test", packageSource.includes("seo-engine-test.js"));
check("the suite has its own script", packageSource.includes('"test:seo-engine"'));

const envExample = read(".env.example");
check("the environment example documents the engine switch", envExample.includes("ENABLE_SEO_ENGINE"));
check("the environment example documents the link limit", envExample.includes("SEO_INTERNAL_LINK_LIMIT"));

const configSource = fs.readFileSync(require.resolve("../config"), "utf8");
check("config reads the engine switch", configSource.includes("readBoolean(\"ENABLE_SEO_ENGINE\""));
check("config reads the link limit", configSource.includes("readInteger(\"SEO_INTERNAL_LINK_LIMIT\""));
check("config keeps a stable engine version", configSource.includes("seoEngineVersion"));

const docsSource = read("docs/seo-engine.md");
for (const heading of ["deterministic", "categories", "internal link", "BLOCKED", "NEEDS_REVIEW", "301", "redirect"]) {
  check(`the documentation covers ${heading}`, docsSource.toLowerCase().includes(heading.toLowerCase()));
}
check("the documentation explains the no-ranking-claim", /not a Google ranking metric|not a ranking/i.test(docsSource));
check("the documentation explains that analysis persists nothing", /persist|stores nothing|stored nothing|no database write/i.test(docsSource));

/* ==================================================================== */
/* [9] Schema in the database                                            */
/* ==================================================================== */

section("[9] Schema in the database");

(async () => {
  const pool = require("../db");

  try {
    const tables = await pool.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = 'redirects'
    `);
    check("the redirects table exists", tables.rows.length === 1);

    const columns = await pool.query(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'redirects'
    `);
    const names = columns.rows.map(r => r.column_name);
    for (const column of ["source_path", "destination_path", "status_code", "is_active", "created_at", "updated_at"]) {
      check(`the redirects table carries ${column}`, names.includes(column));
    }

    const indexes = await pool.query(`
      SELECT indexname, indexdef
        FROM pg_catalog.pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'redirects'
    `);
    check(
      "a unique index guards source_path",
      indexes.rows.some(r => /unique/i.test(r.indexdef || "") && /source_path/.test(r.indexdef || ""))
    );

    /* One live round trip on the real table: create a redirect with a unique
     * source, prove the duplicate guard, resolve it from the middleware's code
     * path, pause it, then delete it so the suite never leaves test data
     * behind. */
    const unique = `/seo-engine-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const created = await redirects.createRedirect({
      sourcePath: unique,
      destinationPath: "/blog/target-path",
      statusCode: 301,
      isActive: true
    });
    check("createRedirect stores the row", created && created.source_path === unique);

    let duplicateRejected = false;
    try {
      await redirects.createRedirect({
        sourcePath: unique,
        destinationPath: "/blog/elsewhere",
        statusCode: 301,
        isActive: true
      });
    } catch (error) {
      duplicateRejected = /unique|duplicate|23505/i.test(String(error.message));
    }
    check("the unique index rejects a duplicate source", duplicateRejected);

    const resolved = await redirects.findBySource(unique);
    check("findBySource resolves an active redirect", resolved && resolved.destination_path === "/blog/target-path" && resolved.status_code === 301);

    const paused = await redirects.updateRedirect(created.id, {
      sourcePath: unique,
      destinationPath: "/about",
      statusCode: 302,
      isActive: false
    });
    check("updateRedirect changes the destination and pauses", paused.status_code === 302 && paused.is_active === false);
    const pausedResolve = await redirects.findBySource(unique);
    check("a paused redirect stops forwarding", pausedResolve === null);

    const reEnabled = await redirects.updateRedirect(created.id, {
      sourcePath: unique,
      destinationPath: "/blog/target-path",
      statusCode: 301,
      isActive: true
    });
    check("re-enabling restores forwarding", reEnabled.is_active === true);

    const deleted = await redirects.deleteRedirect(created.id);
    check("deleteRedirect removes the row", deleted && deleted.source_path === unique);
    const gone = await redirects.getRedirect(created.id);
    check("the deleted redirect is gone", gone === null);
  } catch (error) {
    check("the database is reachable and navigable", false, error.message);
  }

  try {
    await pool.end();
  } catch {
    /* nothing was ever connected */
  }

  console.log(`\n${passed} checks passed, ${failed} failed`);

  if (failures.length) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error.message}`);
    process.exitCode = 1;
  }
})();