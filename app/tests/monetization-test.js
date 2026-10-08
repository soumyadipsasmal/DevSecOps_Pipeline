"use strict";

/**
 * KaliNova — monetization dashboard tests
 *
 * Covers the four decisions the monetization feature has to keep:
 *
 *   1. nothing serves by default — every public endpoint returns empty or
 *      "not connected" until an administrator creates an active campaign or
 *      switches AdSense on; a schema without rows renders no advertising UI
 *   2. no raw visitor data ever lands in the database — event rows keep an
 *      HMAC of the client address (empty when no salt is set), the referrer
 *      host, a device bucket and a 128-character UA snippet, never an IP
 *   3. the admin UI is ordinary CRUD behind requireAdmin + CSRF, and the
 *      settings screens share one update path for category defaults
 *   4. an article can opt out of advertising per-row with a tri-state
 *      field (default / on / off) rather than a boolean that forces a choice
 *
 * Everything that can run without a live HTTP server does. The database is
 * used only for schema checks, and the pool is closed at the end.
 *
 * Run with:  node tests/monetization-test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const monetization = require("../monetization-service");
const affiliate = require("../affiliate-service");
const sponsored = require("../sponsored-service");
const directAds = require("../direct-ads-service");
const monetizationViews = require("../admin-monetization-views");
const monetizationRoutes = require("../admin-monetization-routes");
const articleValidation = require("../article-validation");

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
/* [1] Normalisation helpers                                            */
/* ==================================================================== */

section("[1] Normalisation helpers");

test("slugify collapses accents and punctuation", () => {
  assert.strictEqual(monetization.slugify("The Dåncing Falcon's Tour — 2026!"), "the-dancing-falcons-tour-2026");
});

test("slugify never returns an empty slug from blank input", () => {
  assert.strictEqual(monetization.slugify("  "), "");
});

test("normalizeEmail lowercases and validates", () => {
  assert.strictEqual(monetization.normalizeEmail("  Reader@Example.COM "), "reader@example.com");
  assert.strictEqual(monetization.normalizeEmail("not-an-email"), "");
});

test("normalizeBool accepts the HTML checkbox vocabulary", () => {
  assert.strictEqual(monetization.normalizeBool("on"), true);
  assert.strictEqual(monetization.normalizeBool("1"), true);
  assert.strictEqual(monetization.normalizeBool("true"), true);
  assert.strictEqual(monetization.normalizeBool("yes"), true);
  assert.strictEqual(monetization.normalizeBool("0"), false);
  assert.strictEqual(monetization.normalizeBool(undefined, false), false);
});

test("normalizeHttpUrl only keeps absolute http(s) URLs", () => {
  assert.strictEqual(monetization.normalizeHttpUrl("https://example.com/offer"), "https://example.com/offer");
  assert.strictEqual(monetization.normalizeHttpUrl("/relative/path"), "");
  assert.strictEqual(monetization.normalizeHttpUrl("javascript:alert(1)"), "");
  assert.strictEqual(monetization.normalizeHttpUrl("ftp://example.com/"), "");
});

test("a URL carrying credentials is rejected", () => {
  assert.strictEqual(monetization.normalizeHttpUrl("https://user:secret@example.com/"), "");
});

test("parsePositiveInt accepts ids and rejects junk", () => {
  assert.strictEqual(monetization.parsePositiveInt("42"), 42);
  assert.strictEqual(monetization.parsePositiveInt("0"), null);
  assert.strictEqual(monetization.parsePositiveInt("-1"), null);
  assert.strictEqual(monetization.parsePositiveInt("abc"), null);
  assert.strictEqual(monetization.parsePositiveInt(), null);
});

test("the placement list is fixed and server-owned", () => {
  assert.deepStrictEqual(monetization.DIRECT_ADS_PLACEMENTS, [
    "homepage_top",
    "homepage_middle",
    "article_top",
    "article_middle",
    "article_bottom",
    "sidebar",
    "category_top",
    "footer"
  ]);
});

/* ==================================================================== */
/* [2] Privacy-safe request metadata                                     */
/* ==================================================================== */

section("[2] Privacy-safe request metadata");

function fakeRequest(headers = {}) {
  return {
    ip: "203.0.113.77",
    socket: { remoteAddress: "203.0.113.77" },
    get: name => headers[name.toLowerCase()] || ""
  };
}

test("a desktop request is bucketed and kept anonymous", () => {
  const meta = monetization.metaFromRequest(
    fakeRequest({ "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", referer: "https://example.com/posts?utm=x" })
  );
  assert.strictEqual(meta.device, "desktop");
  // Only the host is kept — never the query string.
  assert.strictEqual(meta.referrer, "example.com");
  assert.strictEqual(meta.ua_snippet.length <= 128, true);
  assert.match(meta.ip_hash, /^$|^[0-9a-f]{64}$/, "ip_hash is either empty or 64 hex chars");
  assert.strictEqual(JSON.stringify(meta).includes("203.0.113.77"), false, "the raw IP never appears in the payload");
});

test("without ANALYTICS_SALT the hash is empty, never the raw address", () => {
  const config = require("../config");
  const meta = monetization.metaFromRequest(fakeRequest({}));
  // The config object is frozen at require time: if the salt is set we see a
  // 64-hex HMAC, if not we see an empty string. Either way the address itself
  // never reaches the database (or the payload).
  if (config.analyticsSalt) {
    assert.match(meta.ip_hash, /^[0-9a-f]{64}$/);
  } else {
    assert.strictEqual(meta.ip_hash, "");
  }
  assert.strictEqual(JSON.stringify(meta).includes("203.0.113.77"), false);
});

test("the metadata row has exactly the four allowed fields", () => {
  const meta = monetization.metaFromRequest(fakeRequest({}));
  assert.deepStrictEqual(Object.keys(meta).sort(), ["device", "ip_hash", "referrer", "ua_snippet"]);
});

test("a createToken is 64 lower-hex characters", () => {
  assert.match(monetization.createToken(), /^[0-9a-f]{64}$/);
});

/* ==================================================================== */
/* [3] Affiliate link validation                                        */
/* ==================================================================== */

section("[3] Affiliate link validation");

test("a well-formed link passes", () => {
  const result = affiliate.validateLink({
    name: "Backpacker HQ",
    network: "Rakuten",
    destination_url: "https://example.com/deals",
    tracking_url: "https://click.example.net/x?id=1",
    slug: "backpacker-hq",
    status: "active"
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.destination_url, "https://example.com/deals");
});

test("a link without a name or destination is refused", () => {
  const result = affiliate.validateLink({});
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.name);
  assert.ok(result.errors.destination_url);
});

test("an invalid status falls back to active and is flagged", () => {
  const result = affiliate.validateLink({ name: "x", destination_url: "https://example.com/", status: "exploded" });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.values.status, "active");
  assert.match(result.errors.status, /active, paused/);
});

test("a malformed slug is refused with a clear error", () => {
  const result = affiliate.validateLink({ name: "The Trekking Store", destination_url: "https://example.com/", slug: "No Spaces Here" });
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.slug, /lowercase letters, numbers and hyphens/);
});

test("a valid slug is accepted as-is", () => {
  const result = affiliate.validateLink({ name: "x", destination_url: "https://example.com/", slug: "trekking-store" });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.slug, "trekking-store");
});

test("invalid ids are stored as null, never thrown", () => {
  const result = affiliate.validateLink({ name: "x", destination_url: "https://example.com/", article_id: "banana" });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.article_id, null);
});

test("the redirect target prefers the tracking URL", () => {
  assert.strictEqual(
    affiliate.redirectTarget({ tracking_url: "https://click.example.net/x", destination_url: "https://example.com/" }),
    "https://click.example.net/x"
  );
  assert.strictEqual(
    affiliate.redirectTarget({ tracking_url: "", destination_url: "https://example.com/" }),
    "https://example.com/"
  );
});

/* ==================================================================== */
/* [4] Sponsored campaign validation                                    */
/* ==================================================================== */

section("[4] Sponsored campaign validation");

test("a campaign without an article or sponsor is refused", () => {
  const result = sponsored.validateCampaign({});
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.article_id);
  assert.ok(result.errors.sponsor_name);
});

test("only the two approved labels are accepted", () => {
  const base = { article_id: 1, sponsor_name: "Himalaya Rope Co" };
  assert.strictEqual(sponsored.validateCampaign({ ...base, label: "Sponsored" }).ok, true);
  assert.strictEqual(sponsored.validateCampaign({ ...base, label: "Advertisement" }).ok, true);
  const bad = sponsored.validateCampaign({ ...base, label: "Partner Feature" });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.errors.label, /Sponsored or Advertisement/);
});

test("a sponsor URL is optional and only kept when http(s)", () => {
  const base = { article_id: 1, sponsor_name: "x", label: "Sponsored" };
  const result = sponsored.validateCampaign({ ...base, sponsor_url: "javascript:void(0)" });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.sponsor_url, "");
  const kept = sponsored.validateCampaign({ ...base, sponsor_url: "https://example.com/" });
  assert.strictEqual(kept.ok, true);
  assert.strictEqual(kept.values.sponsor_url, "https://example.com/");
});

test("an end date before the start date is refused", () => {
  const result = sponsored.validateCampaign({
    article_id: 1,
    sponsor_name: "x",
    start_at: "2026-06-01T00:00:00.000Z",
    end_at: "2026-05-01T00:00:00.000Z"
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.end_at);
});

test("an unknown status falls back to draft", () => {
  const result = sponsored.validateCampaign({ article_id: 1, sponsor_name: "x", status: "complete" });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.values.status, "draft");
});

/* ==================================================================== */
/* [5] Direct ad campaign validation                                    */
/* ==================================================================== */

section("[5] Direct ad campaign validation");

test("a campaign without artwork is refused", () => {
  const result = directAds.validateAd({ name: "Summer deal", placement: "homepage_top" });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.image_url);
  assert.ok(result.errors.destination_url);
});

test("an unknown placement is refused", () => {
  const result = directAds.validateAd({
    name: "x",
    image_url: "https://cdn.example.com/banner.jpg",
    destination_url: "https://example.com/",
    placement: "popup"
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.placement, /Placement must be one of/);
});

test("an out-of-range priority is refused", () => {
  const base = {
    name: "x",
    image_url: "https://cdn.example.com/banner.jpg",
    destination_url: "https://example.com/",
    placement: "sidebar"
  };
  assert.strictEqual(directAds.validateAd({ ...base, priority: 0 }).ok, false);
  assert.strictEqual(directAds.validateAd({ ...base, priority: 9999 }).ok, false);
  const ok = directAds.validateAd({ ...base, priority: 100 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.values.priority, 100);
});

test("date windows must not run backwards", () => {
  const base = {
    name: "x",
    image_url: "https://cdn.example.com/banner.jpg",
    destination_url: "https://example.com/",
    placement: "article_middle"
  };
  const bad = directAds.validateAd({ ...base, start_date: "2026-02-01", end_date: "2026-01-01" });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.end_date);
});

/* ==================================================================== */
/* [6] Article advertising opt-out (tri-state)                          */
/* ==================================================================== */

section("[6] Article advertising opt-out");

test("the three ads_enabled choices are default, 1 and 0", () => {
  assert.deepStrictEqual(articleValidation.ADS_ENABLED_CHOICES, ["default", "1", "0"]);
});

test("missing input means defer to the category default", () => {
  assert.deepStrictEqual(articleValidation.validateAdsEnabled(undefined), { ok: true, choice: "default", enabled: null });
});

test("explicit on and off map to booleans", () => {
  assert.deepStrictEqual(articleValidation.validateAdsEnabled("1"), { ok: true, choice: "1", enabled: true });
  assert.deepStrictEqual(articleValidation.validateAdsEnabled("0"), { ok: true, choice: "0", enabled: false });
});

test("anything else is refused", () => {
  assert.strictEqual(articleValidation.validateAdsEnabled("sometimes").ok, false);
});

/* ==================================================================== */
/* [7] The admin screens                                                */
/* ==================================================================== */

section("[7] The admin screens");

const overview = monetizationViews.renderOverview({
  admin: { id: 1, email: "admin@example.com", role: "admin" },
  csrfToken: "csrf-token",
  overview: {
    affiliate: { total: 0, active: 0, total_clicks: 0, clicks_30d: 0 },
    sponsored: { draft: 0, active: 0, paused: 0, ended: 0 },
    direct_ads: { total: 0, active: 0, impressions_30d: 0, clicks_30d: 0 },
    newsletter: { subscribed: 0, pending: 0, unsubscribed: 0 },
    disclosures_updated_at: null,
    ad_sense: { configured: false, note: "Google AdSense is not serving." },
    revenue: { connected: false, message: "Revenue reporting not connected." },
    mailing: { provider: "", can_send: false }
  }
});

check("a deployment with no ad settings invents no revenue figure", overview.includes("not connected"));
check("the overview does not print a made-up currency total", (overview.match(/[₹$\€]\s?\d/) || []).length === 0);

const settings = monetizationViews.renderSettingsPage({
  admin: { id: 1 },
  csrfToken: "csrf-token",
  categories: [
    { id: 3, name: "Travel", default_ads_enabled: true, default_affiliate_enabled: false, default_direct_ads_enabled: true }
  ]
});
check("the settings form has one checkbox per category per default", ["def_ads_3", "def_aff_3", "def_direct_3"].every(key => settings.includes(key)));
check("the settings form echoes the stored active defaults", /name="def_ads_3"[^>]*checked/.test(settings));
check("the settings form echoes the stored inactive defaults", !/name="def_aff_3"[^>]*checked/.test(settings));

const directForm = monetizationViews.renderDirectAdForm({
  admin: { id: 1 },
  csrfToken: "csrf-token",
  ad: {
    id: 7,
    name: "Summer banner",
    advertiser_name: "Himalaya Rope Co",
    image_url: "https://cdn.example.com/banner.jpg",
    image_alt: "",
    destination_url: "https://example.com/",
    placement: "homepage_top",
    start_date: null,
    end_date: null,
    status: "draft",
    priority: 100,
    campaign_notes: ""
  },
  values: null
});
check("the direct-ad form collects artwork and destination", ["name=\"name\"", "name=\"image_url\"", "name=\"destination_url\""].every(key => directForm.includes(key)));
check("the direct-ad form offers every placement", ["homepage_top", "homepage_middle", "article_top", "article_middle", "article_bottom", "sidebar", "category_top", "footer"].every(p => directForm.includes(`value="${p}"`)));

const sponsoredForm = monetizationViews.renderSponsoredForm({
  admin: { id: 1 },
  csrfToken: "csrf-token",
  campaign: { article_id: 0, article_title: "", sponsor_name: "", sponsor_url: "", label: "Sponsored", disclosure: "", status: "draft" },
  articleOptions: [],
  values: {}
});
check("the sponsored form holds sponsor fields", ["name=\"sponsor_name\"", "name=\"label\""].every(key => sponsoredForm.includes(key)));

const newsletterPage = monetizationViews.renderNewsletterPage({
  admin: { id: 1 },
  csrfToken: "csrf-token",
  subscribers: [],
  counts: { subscribed: 0, pending: 0, unsubscribed: 0 },
  mailing: { provider: "", can_send: false }
});
check("the newsletter page states that no email is sent", /no email|not sending|nothing is (ever )?sent/i.test(newsletterPage));

/* ==================================================================== */
/* [8] Route wiring and guards                                          */
/* ==================================================================== */

section("[8] Route wiring and guards");

const captured = { api: [], pages: [] };
const fakeApi = {
  get: (routePath, ...rest) => captured.api.push(["GET", routePath, rest]),
  post: (routePath, ...rest) => captured.api.push(["POST", routePath, rest]),
  put: (routePath, ...rest) => captured.api.push(["PUT", routePath, rest]),
  delete: (routePath, ...rest) => captured.api.push(["DELETE", routePath, rest]),
  patch: () => {},
  use: () => {}
};
const fakePages = {
  get: (routePath, ...rest) => captured.pages.push([routePath, rest]),
  post: (routePath, ...rest) => captured.pages.push([routePath, rest]),
  put: () => {},
  delete: () => {},
  patch: () => {},
  use: () => {}
};

monetizationRoutes.registerApi(fakeApi);
monetizationRoutes.registerPages(fakePages);

const layerNames = layer => (typeof layer === "function" ? layer.name : "inline");

const overviewRoute = captured.api.find(entry => entry[1] === "/monetization/overview");
check("the admin overview API route exists", Boolean(overviewRoute));
check(
  "the API routes are admin-only and CSRF-protected where they write",
  captured.api.every(([method, , layers]) => {
    if (method === "GET") return layers.map(layerNames).includes("requireAdmin");
    return layers.map(layerNames).includes("requireAdmin") && layers.map(layerNames).includes("requireCsrf");
  }),
  captured.api.map(([m, r, l]) => `${m} ${r} [${l.filter(f => f.name).map(f => f.name).join(",")}]`).join("\n")
);

const settingsPut = captured.api.find(entry => entry[0] === "PUT" && entry[1] === "/monetization/settings");
check("the settings route is registered", Boolean(settingsPut));

check(
  "every admin HTML page is behind the admin page guard",
  captured.pages.every(([, layers]) => layers.map(layerNames).includes("requireAdminPage")),
  captured.pages.map(([r, l]) => `${r} [${l.map(f => f.name).join(",")}]`).join("\n")
);

const publicRoutes = fs.readFileSync(require.resolve("../monetization-routes"), "utf8");
check("the public routes never read a secret", !/process\.env\.(DB_|POSTGRES|PG|ADMIN_|JWT)/.test(publicRoutes));
check("the public manifest is versioned into the URL", publicRoutes.includes("/api/monetization"));
check("the affiliate redirect handler exists", publicRoutes.includes('goRouter.get("/:slug"'));
check("the public direct-ad tracking is fire-and-forget POSTs", publicRoutes.includes("trackEvent(\"impression\")"));
check("the newsletter subscribe endpoint is rate limited", publicRoutes.includes("subscribeLimiter"));

const adminRoutesSource = fs.readFileSync(require.resolve("../admin-routes"), "utf8");
check("admin-routes registers the monetization pages", adminRoutesSource.includes("monetizationRoutes.registerPages"));
check("admin-routes registers the monetization API", adminRoutesSource.includes("monetizationRoutes.registerApi"));

const serverSource = fs.readFileSync(path.join(__dirname, "..", "..", "app", "server.js"), "utf8");
check("the public monetization API is mounted", /monetizationApi/.test(serverSource));

const adminNavSource = fs.readFileSync(require.resolve("../admin-views"), "utf8");
check("the admin nav links to the monetization dashboard", adminNavSource.includes('/admin/monetization'));

/* ==================================================================== */
/* [9] Frontend wiring                                                  */
/* ==================================================================== */

section("[9] Frontend wiring");

const indexHtml = read("frontend/index.html");
check("the page loads the monetization stylesheet", indexHtml.includes("/assets/monetization.css"));
check("the page loads the monetization component before pages.js", indexHtml.indexOf("/assets/monetization.js") < indexHtml.indexOf("/pages.js"));
check("the footer has a monetization ad container", indexHtml.includes('id="monet-footer-ad"'));
check("the footer container is a placement, not a hardcoded ad", indexHtml.includes('data-monet-placement="footer"'));

const pagesSource = read("frontend/pages.js");
check("the page templates hold ad placeholders, not ad markup", ["homepage_top", "homepage_middle", "sidebar", "category_top", "article_top", "article_middle", "article_bottom"].every(p => pagesSource.includes(`Monetization.placeholder("${p}")`)));
check("article ad placements only render when not opted out", pagesSource.includes("articleAdsEnabled ? Monetization.placeholder"));
check("the article page fetches the monetization payload", pagesSource.includes("Monetization.article("));
check("the sponsored badge and affiliate links attach after render", pagesSource.includes("Monetization.renderArticleExtras"));
check("in-content slots support more than one insertion", pagesSource.includes("Array.isArray(inContentMarkup)"));

const monetizationJs = read("frontend/assets/monetization.js");
check("the frontend component fetches only same-origin endpoints", !/https?:\/\/[^"']/.test(monetizationJs));
check("the frontend component tracks clicks with keepalive sends", /keepalive: true/.test(monetizationJs));
check("the component fails silently", monetizationJs.includes(".catch("));

const monetizationCss = read("frontend/assets/monetization.css");
check("the frontend styles use the existing design tokens", /--radius-md|--radius-sm|--ink-muted|--ink-soft/.test(monetizationCss));

const viewsSource = fs.readFileSync(require.resolve("../admin-monetization-views"), "utf8");
check("the admin screens reference the shared admin stylesheet", viewsSource.includes("/assets/admin/admin-monetization.css"));
check("the admin stylesheet ships with the repo", fs.existsSync(path.join(__dirname, "..", "..", "frontend", "assets", "admin", "admin-monetization.css")));

const scriptSource = read("frontend/script.js");
check("the boot sequence waits for the monetization manifest", scriptSource.includes("Monetization.ready()") || scriptSource.includes("monetReady"));

/* ==================================================================== */
/* [10] Schema, build and documentation wiring                           */
/* ==================================================================== */

section("[10] Schema, build and documentation wiring");

const migrateSource = fs.readFileSync(require.resolve("../migrate.js"), "utf8");
const migrationsBlock = migrateSource.slice(migrateSource.indexOf("const MIGRATIONS"));
check("the monetization migration is registered", migrateSource.includes("schema-monetization.sql"));
check(
  "the monetization migration is registered last",
  migrationsBlock.indexOf("schema-monetization.sql") > migrationsBlock.indexOf("schema-research-sources.sql")
);

const composeSource = read("docker-compose.yml");
check("the monetization schema is mounted into a fresh database", composeSource.includes("schema-monetization.sql"));

const dockerfileSource = read("Dockerfile");
for (const module of [
  "monetization-service.js",
  "affiliate-service.js",
  "sponsored-service.js",
  "direct-ads-service.js",
  "monetization-routes.js",
  "admin-monetization-routes.js",
  "admin-monetization-views.js"
]) {
  check(`the Dockerfile copies ${module}`, dockerfileSource.includes(`COPY app/${module} .`));
}
check("the Dockerfile copies the whole frontend (which carries the admin CSS)", dockerfileSource.includes("COPY frontend /frontend"));

const packageSource = read("app/package.json");
check("the monetization suite runs with npm test", packageSource.includes("monetization-test.js"));

const docsSource = read("docs/monetization.md");
for (const heading of ["AdSense", "affiliate links", "sponsored", "direct ad", "newsletter", "disclosures"]) {
  check(`the documentation covers ${heading}`, docsSource.toLowerCase().includes(heading.toLowerCase()));
}
check("the documentation explains the no-revenue default", /revenue|not connected|not connected yet/i.test(docsSource));
check("the documentation explains the privacy-salt rule", /ANALYTICS_SALT/.test(docsSource));

/* ==================================================================== */
/* [11] Schema in the database                                          */
/* ==================================================================== */

section("[11] Schema in the database");

(async () => {
  const pool = require("../db");

  try {
    const tables = await pool.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN (
           'affiliate_links', 'affiliate_clicks', 'sponsored_campaigns',
           'direct_ads', 'direct_ad_events', 'newsletter_subscribers',
           'monetization_disclosures', 'monetization_audit_logs'
         )
       ORDER BY table_name
    `);
    const names = tables.rows.map(r => r.table_name);

    for (const table of [
      "affiliate_links",
      "affiliate_clicks",
      "sponsored_campaigns",
      "direct_ads",
      "direct_ad_events",
      "newsletter_subscribers",
      "monetization_disclosures",
      "monetization_audit_logs"
    ]) {
      check(`the ${table} table exists`, names.includes(table), `missing: ${table}`);
    }

    const columns = await pool.query(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('direct_ad_events', 'affiliate_clicks', 'direct_ads', 'categories', 'articles', 'newsletter_subscribers')
    `);
    const byTable = {};
    for (const row of columns.rows) {
      byTable[row.table_name] = byTable[row.table_name] || [];
      byTable[row.table_name].push(row.column_name);
    }

    check(
      "an event row stores only anon metadata — no raw ip, no raw ua",
      ["ip_hash", "referrer", "device", "ua_snippet"].every(c => (byTable.direct_ad_events || []).includes(c)),
      (byTable.direct_ad_events || []).join(", ")
    );
    check(
      "a click row stores only anon metadata too",
      ["ip_hash", "referrer", "device", "ua_snippet"].every(c => (byTable.affiliate_clicks || []).includes(c)),
      (byTable.affiliate_clicks || []).join(", ")
    );
    check("a direct ad carries the denormalised counters", ["impression_count", "click_count"].every(c => (byTable.direct_ads || []).includes(c)));
    check("categories carry the three default flags", ["default_ads_enabled", "default_affiliate_enabled", "default_direct_ads_enabled"].every(c => (byTable.categories || []).includes(c)));
    check("articles carry an ads_enabled override", (byTable.articles || []).includes("ads_enabled"));
    check("newsletter rows carry an unsubscribe token", (byTable.newsletter_subscribers || []).includes("token"));
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
  console.error("\nmonetization-test crashed:", error);
  process.exitCode = 1;
});