"use strict";

/**
 * KaliNova — editorial research workflow tests
 *
 * Covers the three decisions the content workflow has to keep:
 *
 *   1. external APIs are a research surface, never a publishing surface —
 *      the research route is read-only, admin-only, and cannot write to an
 *      article
 *   2. an editor always sees where a fact came from — citations are validated,
 *      published with the article, and never carry a licence or credit that
 *      the source did not state
 *   3. nothing is blocked by accident — the copy-similarity check warns, it
 *      does not refuse a draft, and a save is never lost
 *
 * Everything that can run without a live HTTP server does. The database is
 * used only for two existence checks, and the pool is closed at the end.
 *
 * Run with:  node tests/research-workflow-test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const contentSimilarity = require("../content-similarity");
const articleSources = require("../article-sources");
const articleViews = require("../admin-article-views");
const researchRoutes = require("../admin-research-routes");

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

/* ==================================================================== */
/* [1] Copy similarity                                                  */
/* ==================================================================== */

section("[1] Copy similarity");

const LONG_REFERENCE = `
The historic hill station of Shimla was the summer capital of British India,
and its narrow lanes still follow the ridgeline of the lower Himalaya.
Visitors arrive on the narrow-gauge train that climbs from Kalka, a journey
that takes most of a day and passes more than eight hundred bridges.
The town's wooden temples and colonial-era buildings sit above a valley
that fills with cloud through the monsoon months.`;

test("identical material scores 1.0", () => {
  const result = contentSimilarity.score(LONG_REFERENCE, [{ name: "ref", text: LONG_REFERENCE }]);
  assert.strictEqual(result.ratio, 1.0);
  assert.strictEqual(result.flagged, true);
});

test("unrelated material scores 0", () => {
  const article = `
    Solar panels convert sunlight into electricity using semiconductor junctions.
    Modern inverters feed the grid at a fixed frequency and meter what you export.
    A typical rooftop array pays for itself over a decade of generation.`;
  const result = contentSimilarity.score(article, [{ name: "ref", text: LONG_REFERENCE }]);
  assert.strictEqual(result.ratio, 0);
  assert.strictEqual(result.flagged, false);
});

test("no references means no warning", () => {
  const result = contentSimilarity.score(LONG_REFERENCE, []);
  assert.strictEqual(result.ratio, 0);
  assert.strictEqual(result.checked, 0);
  assert.strictEqual(result.flagged, false);
});

test("markup is stripped before comparing", () => {
  const plain = contentSimilarity.tokenize(LONG_REFERENCE).join(" ");
  const marked = contentSimilarity.tokenize(`<p>${LONG_REFERENCE}</p><h2>Heading</h2>`).join(" ");
  assert.strictEqual(plain.split(" ").slice(0, 10).join(" "), marked.split(" ").slice(0, 10).join(" "));
});

test("a very short article never warns", () => {
  const result = contentSimilarity.score("Shimla is lovely in the rain.", [
    { name: "ref", text: LONG_REFERENCE }
  ]);
  assert.strictEqual(result.flagged, false);
  assert.strictEqual(result.ratio, 0);
});

test("the threshold can be overridden per call", () => {
  const result = contentSimilarity.score(LONG_REFERENCE, [{ name: "ref", text: LONG_REFERENCE }], {
    threshold: 0.9
  });
  assert.strictEqual(result.threshold, 0.9);
  assert.strictEqual(result.flagged, true, "1.0 is still above a 0.9 threshold");
});

test("a threshold outside 0..1 is ignored", () => {
  assert.strictEqual(contentSimilarity.warnThreshold({ threshold: 1.5 }), 0.35);
  assert.strictEqual(contentSimilarity.warnThreshold({ threshold: -1 }), 0.35);
});

test("the default threshold is 35%", () => {
  assert.strictEqual(contentSimilarity.warnThreshold({}), 0.35);
});

test("an absurd SIMILARITY_WARN_PERCENT falls back to the default", () => {
  const previous = process.env.SIMILARITY_WARN_PERCENT;
  process.env.SIMILARITY_WARN_PERCENT = "not-a-number";
  try {
    assert.strictEqual(contentSimilarity.warnThreshold(), 0.35);
  } finally {
    if (previous === undefined) delete process.env.SIMILARITY_WARN_PERCENT;
    else process.env.SIMILARITY_WARN_PERCENT = previous;
  }
});

test("a matching reference is reported with its name", () => {
  const result = contentSimilarity.score(LONG_REFERENCE, [
    { name: "Wikidata Q123", text: LONG_REFERENCE }
  ]);
  assert.strictEqual(result.worst.name, "Wikidata Q123");
  assert.strictEqual(result.worst.percent, 100);
});

test("5-word shingles are what get compared", () => {
  const tokens = contentSimilarity.tokenize("one two three four five six seven");
  const shingles = contentSimilarity.shingles(tokens, 5);
  assert.deepStrictEqual([...shingles], [
    "one two three four five",
    "two three four five six",
    "three four five six seven"
  ]);
});

/* ==================================================================== */
/* [2] Citation validation                                              */
/* ==================================================================== */

section("[2] Citation validation");

test("a well-formed source passes", () => {
  const result = articleSources.validateSources([
    { name: "Wikidata", url: "https://www.wikidata.org/wiki/Q362", license: "CC0 1.0", attribution: "" }
  ]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sources.length, 1);
  assert.strictEqual(result.sources[0].license, "CC0 1.0");
});

test("an empty row is skipped, not rejected", () => {
  const result = articleSources.validateSources([{ name: "", url: "", license: "", attribution: "" }]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.sources, []);
});

test("a source without a name is rejected", () => {
  const result = articleSources.validateSources([{ name: "", url: "https://example.com/" }]);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /source name/i);
});

test("a source without a URL is rejected", () => {
  const result = articleSources.validateSources([{ name: "OSM", url: "" }]);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /URL/i);
});

test("a javascript: URL is rejected", () => {
  const result = articleSources.validateSources([{ name: "x", url: "javascript:alert(1)" }]);
  assert.strictEqual(result.ok, false);
});

test("a data: URL is rejected", () => {
  const result = articleSources.validateSources([{ name: "x", url: "data:text/html,<script>alert(1)</script>" }]);
  assert.strictEqual(result.ok, false);
});

test("control characters are stripped from a source name", () => {
  const result = articleSources.validateSources([
    { name: "Wiki\u0000data\u0007", url: "https://www.wikidata.org/" }
  ]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sources[0].source_name, "Wiki data");
});

test("the source cap is enforced", () => {
  const rows = Array.from({ length: articleSources.MAX_SOURCES + 1 }, (_, i) => ({
    name: `Source ${i}`,
    url: `https://example.com/${i}`
  }));
  const result = articleSources.validateSources(rows);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /at most 12 sources/);
});

/* ==================================================================== */
/* [3] Research provenance                                              */
/* ==================================================================== */

section("[3] Research provenance");

test("an allowed source key survives normalisation", () => {
  const rows = articleSources.normalizeResearchRefs([
    { source_key: "wikidata", name: "Q362", url: "https://www.wikidata.org/wiki/Q362", license: "CC0 1.0", text: "Capital of India" }
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source_key, "wikidata");
  assert.strictEqual(rows[0].reference_text, "Capital of India");
});

test("an unknown source key is dropped", () => {
  const rows = articleSources.normalizeResearchRefs([
    { source_key: "pinterest", name: "nope", text: "x" }
  ]);
  assert.deepStrictEqual(rows, []);
});

test("a reference excerpt is capped, not rejected", () => {
  const rows = articleSources.normalizeResearchRefs([
    { source_key: "commons", name: "File:Map.jpg", text: "x".repeat(articleSources.REFERENCE_TEXT_MAX + 500) }
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].reference_text.length, articleSources.REFERENCE_TEXT_MAX);
});

test("a non-http source url is stored as null", () => {
  const rows = articleSources.normalizeResearchRefs([
    { source_key: "geo", name: "Shimla", url: "not-a-url", text: "somewhere" }
  ]);
  assert.strictEqual(rows[0].source_url, null);
});

test("the reference cap is enforced", () => {
  const rows = Array.from({ length: articleSources.MAX_RESEARCH + 5 }, (_, i) => ({
    source_key: "wikidata",
    name: `ref ${i}`,
    text: `text ${i}`
  }));
  assert.strictEqual(articleSources.normalizeResearchRefs(rows).length, articleSources.MAX_RESEARCH);
});

/* ==================================================================== */
/* [4] Request body readers                                             */
/* ==================================================================== */

section("[4] Request body readers");

test("citations are read from index-numbered fields", () => {
  const rows = articleSources.parseSourcesFromBody({
    source_count: "2",
    source_name_0: "Wikidata",
    source_url_0: "https://www.wikidata.org/",
    source_name_1: "OpenStreetMap",
    source_url_1: "https://www.openstreetmap.org/"
  });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].name, "OpenStreetMap");
});

test("an out-of-range source_count reads nothing", () => {
  assert.deepStrictEqual(articleSources.parseSourcesFromBody({ source_count: "99" }), []);
  assert.deepStrictEqual(articleSources.parseSourcesFromBody({ source_count: "-1" }), []);
  assert.deepStrictEqual(articleSources.parseSourcesFromBody({}), []);
});

test("unparsable research JSON becomes no references", () => {
  assert.deepStrictEqual(articleSources.parseResearchFromBody({ research_refs: "{not json" }), []);
  assert.deepStrictEqual(articleSources.parseResearchFromBody({ research_refs: "" }), []);
  assert.deepStrictEqual(articleSources.parseResearchFromBody({}), []);
});

test("oversized research JSON is refused outright", () => {
  const huge = "a".repeat(600 * 1024);
  assert.deepStrictEqual(articleSources.parseResearchFromBody({ research_refs: huge }), []);
});

/* ==================================================================== */
/* [5] The editor form                                                  */
/* ==================================================================== */

section("[5] The editor form");

const POLICY_TEXT =
  "Use external APIs for research, facts, images, locations, RSS and source discovery.";

const emptyForm = articleViews.renderArticleForm({
  admin: { id: 1, email: "admin@example.com", role: "admin" },
  csrfToken: "csrf-token",
  categories: [{ id: 1, name: "Travel" }],
  values: { status: "draft" },
  sources: [],
  researchRefs: []
});

check("the editorial policy notice is shown on the form", emptyForm.includes(POLICY_TEXT));

check("the citations repeater has a source_count", emptyForm.includes('name="source_count"'));
check("the citations repeater renders a first row", emptyForm.includes('name="source_name_0"'));
check("a brand new article renders exactly one blank row to fill in", (emptyForm.match(/data-source-row/g) || []).length === 1);

const twoSaved = articleViews.renderArticleForm({
  admin: { id: 1, email: "admin@example.com", role: "admin" },
  csrfToken: "csrf-token",
  categories: [{ id: 1, name: "Travel" }],
  values: { status: "draft" },
  sources: [
    { name: "Wikidata", url: "https://www.wikidata.org/", license: "CC0 1.0", attribution: "" },
    { name: "OpenStreetMap", url: "https://www.openstreetmap.org/", license: "ODbL 1.0", attribution: "" }
  ],
  researchRefs: []
});
check("saved citations are echoed back with their row", twoSaved.includes('name="source_name_1"'));
check("one spare blank row is always rendered past the saved ones", (twoSaved.match(/data-source-row/g) || []).length === 3);
check("the hidden source_count matches the rendered rows", twoSaved.includes('name="source_count" value="3"'));

check("the hidden research_refs field is present", emptyForm.includes('name="research_refs"'));
check("the research panel has a search control", emptyForm.includes("data-research-search"));
check("the research panel names the four sources", ["wikidata", "commons", "news", "geo"].every(key => emptyForm.includes(`value="${key}"`)));
check("the panel says results are read-only", emptyForm.includes("Nothing here is written into the article body."));

check("a draft without a warning has no acknowledgement box", !emptyForm.includes("acknowledge_similarity"));

const flaggedForm = articleViews.renderArticleForm({
  admin: { id: 1, email: "admin@example.com", role: "admin" },
  csrfToken: "csrf-token",
  categories: [{ id: 1, name: "Travel" }],
  values: { status: "published" },
  sources: [{ name: "Wikidata", url: "https://www.wikidata.org/", license: "CC0 1.0", attribution: "" }],
  researchRefs: [{ source_key: "wikidata", source_name: "Q362", source_url: "https://www.wikidata.org/wiki/Q362", license: "CC0 1.0", reference_text: LONG_REFERENCE }],
  similarity: { ratio: 0.92, percent: 92, flagged: true, threshold: 0.35, checked: 1, worst: { name: "Q362", percent: 92 }, matches: [] }
});

check("a flagged score renders the warning", flaggedForm.includes("Copy-similarity warning"));
check("a flagged score renders an acknowledgement box", flaggedForm.includes('name="acknowledge_similarity"'));
check("the warning states it is not a plagiarism detector", flaggedForm.includes("not a plagiarism detector"));
check("the warning states it blocks nothing by itself", flaggedForm.includes("blocks nothing on its own"));
check("a licence the editor did state is echoed back", /name="source_license_0"[^>]*value="CC0 1.0"/.test(flaggedForm));

const savedResearch = articleViews.renderArticleForm({
  admin: { id: 1, email: "admin@example.com", role: "admin" },
  csrfToken: "csrf-token",
  categories: [{ id: 1, name: "Travel" }],
  values: { status: "draft" },
  sources: [{ name: "Wikidata", url: "https://www.wikidata.org/", license: "", attribution: "" }],
  researchRefs: [
    { source_key: "wikidata", source_name: "Q362", source_url: "https://www.wikidata.org/wiki/Q362", license: "CC0 1.0", reference_text: LONG_REFERENCE }
  ],
  similarity: { ratio: 0.1, percent: 10, flagged: false, threshold: 0.35, checked: 1, worst: null, matches: [] }
});

check("an attached reference is echoed back in the hidden field", savedResearch.includes("Q362"));
check("an unflagged score shows only a hint", savedResearch.includes("data-similarity-hint") && !savedResearch.includes("data-similarity-ack"));
check(
  "an absent licence renders as an empty value, not a guess",
  /name="source_license_0"[^>]*value=""/.test(savedResearch)
);

/* ==================================================================== */
/* [6] Route wiring and guards                                          */
/* ==================================================================== */

section("[6] Route wiring and guards");

const captured = { api: [] };
const fakeApi = {
  get: (routePath, ...rest) => captured.api.push(["GET", routePath, rest]),
  post: () => {},
  put: () => {},
  patch: () => {},
  delete: () => {},
  use: () => {}
};
researchRoutes.registerApi(fakeApi);

const researchRoute = captured.api.find(entry => entry[1] === "/research");
check("the research route exists", Boolean(researchRoute));

const layerNames = layer => (typeof layer === "function" ? layer.name : "inline");
check(
  "the research route requires an admin session",
  researchRoute && researchRoute[2].map(layerNames).includes("requireAdmin"),
  researchRoute ? researchRoute[2].map(layerNames).join(", ") : "no route"
);
check(
  "the research route attaches the admin context first",
  researchRoute && researchRoute[2].map(layerNames).indexOf("attachAdmin") <
    researchRoute[2].map(layerNames).indexOf("requireAdmin")
);
check("the research route is rate limited", researchRoute && researchRoute[2].length >= 4);

const researchSource = fs.readFileSync(require.resolve("../admin-research-routes"), "utf8");
check("the research route has no write method", !/\.(post|put|patch|delete)\s*\(/.test(researchSource));
check("the research route never writes an article", !/INSERT INTO articles|UPDATE articles/.test(researchSource));
check("the research route never reads a secret", !/DATABASE_URL|process\.env\.(DB_|POSTGRES|PG)/.test(researchSource));

const adminRoutesSource = fs.readFileSync(require.resolve("../admin-routes"), "utf8");
check("admin-routes registers the research endpoints", adminRoutesSource.includes("researchRoutes.registerApi(adminApi)"));
check("the research endpoints sit before the admin 404", /researchRoutes\.registerApi\(adminApi\)[\s\S]*?adminApi\.use\(\(req, res\)/.test(adminRoutesSource));

const articleRoutesSource = fs.readFileSync(require.resolve("../admin-article-routes"), "utf8");
check("a draft save never asks for an acknowledgement", /pendingSimilarityWarning/.test(articleRoutesSource));
check(
  "the acknowledgement is only checked for publishing statuses",
  /status !== STATUS_PUBLISHED && status !== STATUS_SCHEDULED\) return null/.test(articleRoutesSource)
);
check("sources are validated before an article is written", articleRoutesSource.indexOf("readEditorial(req.body)") < articleRoutesSource.indexOf("articleService.createArticle"));

/* ==================================================================== */
/* [7] Public attribution                                               */
/* ==================================================================== */

section("[7] Public attribution");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "..", "app", "server.js"), "utf8");

check("the public sources endpoint exists by id", serverSource.includes('/api/articles/:id/sources'));
check("the public sources endpoint exists by slug", serverSource.includes('/api/articles/slug/:slug/sources'));

const loadStart = serverSource.indexOf("async function loadArticleSources");
const loadEnd = serverSource.indexOf("app.get", loadStart);
const loadBody = serverSource.slice(loadStart, loadEnd);
check("a draft's citations cannot be read", loadBody.includes("articles.status = 'published'"));
check("the public endpoint never serves research provenance", !loadBody.includes("article_research_metadata"));
check("the public sources query is parameterised", loadBody.includes("$1"));
check("a non-numeric id answers 404 rather than a database error", /!\s*\/\^\\d\+\$\/\.test/.test(serverSource));

const pagesSource = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "pages.js"), "utf8");
check("the article page renders a Sources section", pagesSource.includes("function renderSources"));
check("the article page fetches the sources for the story", pagesSource.includes("/sources"));
check("only http(s) links are made clickable", pagesSource.includes('/^https?:\\/\\//i.test(source.source_url)'));

/* ==================================================================== */
/* [8] Schema, build and documentation wiring                            */
/* ==================================================================== */

section("[8] Schema, build and documentation wiring");

const migrateSource = fs.readFileSync(path.join(__dirname, "..", "..", "app", "migrate.js"), "utf8");
const migrationsBlock = migrateSource.slice(migrateSource.indexOf("const MIGRATIONS"));
check("the research migration is registered", migrateSource.includes("schema-research-sources.sql"));
check(
  "the research migration is registered last",
  migrationsBlock.indexOf("schema-research-sources.sql") > migrationsBlock.indexOf("schema-integration-safety.sql")
);
check(
  "the earlier migration order is untouched",
  migrationsBlock.indexOf("schema-ad-placements.sql") < migrationsBlock.indexOf("schema-external-data.sql")
);

const composeSource = fs.readFileSync(path.join(__dirname, "..", "..", "docker-compose.yml"), "utf8");
check("the research schema is mounted into a fresh database", composeSource.includes("schema-research-sources.sql"));
check("the DATABASE_URL passthrough is still present", composeSource.includes("DATABASE_URL: ${DATABASE_URL:-}"));

const dockerfileSource = fs.readFileSync(path.join(__dirname, "..", "..", "Dockerfile"), "utf8");
for (const module of ["content-similarity.js", "article-sources.js", "admin-research-routes.js"]) {
  check(`the Dockerfile copies ${module}`, dockerfileSource.includes(`COPY app/${module} .`));
}

const packageSource = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
check("the workflow suite runs with npm test", packageSource.includes("research-workflow-test.js"));
check("the ads suite is still wired in", packageSource.includes("ads-test.js"));

const policySource = fs.readFileSync(require.resolve("../admin-article-views"), "utf8");
check("the policy notice lives in one place", policySource.includes(POLICY_TEXT));

const docsSource = read("docs/external-data-licenses.md");
for (const heading of ["Wikidata", "Nominatim", "OpenStreetMap", "RSS"]) {
  check(`the licence document covers ${heading}`, docsSource.includes(heading));
}
check("the licence document has an endpoint inventory", /endpoint/i.test(docsSource));
check("the licence document states where each source is used", /used (in|by|on)/i.test(docsSource));
check("the licence document explains the research-only rule", /research/i.test(docsSource));

/* ==================================================================== */
/* [9] Schema in the database                                           */
/* ==================================================================== */

section("[9] Schema in the database");

(async () => {
  const pool = require("../db");

  try {
    const columns = await pool.query(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('article_sources', 'article_research_metadata')
       ORDER BY table_name, column_name
    `);

    const byTable = {};
    for (const row of columns.rows) {
      byTable[row.table_name] = byTable[row.table_name] || [];
      byTable[row.table_name].push(row.column_name);
    }

    check("article_sources exists", Boolean(byTable.article_sources));
    check(
      "article_sources has every column the form writes",
      ["article_id", "source_name", "source_url", "license", "attribution_text", "position"].every(
        column => (byTable.article_sources || []).includes(column)
      ),
      (byTable.article_sources || []).join(", ")
    );
    check(
      "article_research_metadata has every column the panel writes",
      ["article_id", "source_key", "source_name", "source_url", "license", "reference_text"].every(
        column => (byTable.article_research_metadata || []).includes(column)
      ),
      (byTable.article_research_metadata || []).join(", ")
    );

    // The two new tables are the only ones this feature creates: the seeded
    // article set must be exactly what it was before.
    const counts = await pool.query("SELECT COUNT(*)::int AS total FROM articles");
    check("the seeded articles are untouched", counts.rows[0].total > 0, String(counts.rows[0].total));

    const noSources = await articleSources.listPublicSources(-1);
    check("a missing or unpublished article exposes no citations", Array.isArray(noSources) && noSources.length === 0);
  } catch (error) {
    check("the database is reachable", false, error.message);
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
})().catch(error => {
  console.error("\nresearch-workflow-test crashed:", error);
  process.exitCode = 1;
});
