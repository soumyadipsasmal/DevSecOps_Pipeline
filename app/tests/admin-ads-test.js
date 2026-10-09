"use strict";

/**
 * KaliNova — admin ads routes
 *
 * These checks are offline: no server, no database. They read the route source
 * and the view source, and assert the things that would be easy to break by
 * hand:
 *
 *   - every mutating route sits behind the session guard and the CSRF check
 *   - the ads pages are registered before the admin 404 handler
 *   - no ad identifier, script URL or consent provider is hardcoded anywhere
 *   - custom code is escaped in the view, never interpolated raw
 *   - the public shell loads the ad component but no third-party script
 *
 * The database-backed behaviour lives in ads-test.js.
 */

require("dotenv").config();

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    return true;
  }

  failed += 1;
  failures.push({ label, detail });
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

function section(title) {
  console.log(`\n${title}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const routesSource = read("app/admin-ads-routes.js");
const viewsSource = read("app/admin-ads-views.js");
const serviceSource = read("app/ads-service.js");
const adminRoutesSource = read("app/admin-routes.js");
const adminViewsSource = read("app/admin-views.js");
const serverSource = read("app/server.js");
const schemaSource = read("database/schema-ad-placements.sql");
const adsComponent = read("frontend/assets/ads.js");
const shellSource = read("frontend/index.html");
const pagesSource = read("frontend/pages.js");
const headersSource = read("frontend/_headers");
const dockerfile = read("Dockerfile");
const compose = read("docker-compose.yml");
const migrateSource = read("app/migrate.js");
const packageJson = JSON.parse(read("app/package.json"));

/* ==================================================================== */
/* Guards                                                               */
/* ==================================================================== */

section("Route guards");

// Every POST in this module is a state change, so each one has to carry both
// guards. The list is written out rather than derived so a new route that
// forgets one shows up as a failure.
const MUTATING_ROUTES = [
  'pages.post("/ads/settings"',
  'pages.post("/ads/:id"',
  'api.put("/ads/settings"',
  'api.put("/ads/placements/:id"',
  'api.patch("/ads/placements/:id"'
];

for (const route of MUTATING_ROUTES) {
  const start = routesSource.indexOf(route);
  check(`${route} exists`, start !== -1);

  if (start === -1) continue;

  // The guard chain is on the same statement, right after the route.
  const line = routesSource.slice(start, routesSource.indexOf("\n", start));
  check(`${route} requires CSRF`, line.includes("security.requireCsrf"), line);
  // The API routes spread the shared guard pair, which is attachAdmin followed
  // by requireAdmin; the page routes name the guard directly. Either is correct,
  // so both spellings are accepted rather than pinning the routes to one.
  check(
    `${route} requires an admin session`,
    line.includes("security.requireAdmin") || line.includes("...guard"),
    line
  );
}

check(
  "the shared API guard is attachAdmin plus requireAdmin",
  /const guard = \[security\.attachAdmin, security\.requireAdmin\]/.test(routesSource)
);

const PAGE_GUARDS = [
  'pages.get("/ads"',
  'pages.get("/ads/:id/edit"'
];

for (const route of PAGE_GUARDS) {
  const start = routesSource.indexOf(route);
  check(`${route} exists`, start !== -1);

  if (start !== -1) {
    const line = routesSource.slice(start, routesSource.indexOf("\n", start));
    check(`${route} requires an admin session`, line.includes("security.requireAdminPage"), line);
  }
}

section("Registration order");

const adsPages = adminRoutesSource.indexOf("adsRoutes.registerPages(adminPages)");
const articlesPages = adminRoutesSource.indexOf("articleRoutes.registerPages(adminPages)");
const adminNotFound = adminRoutesSource.indexOf("views.renderNotFoundPage");

check("ads pages are registered on the page router", adsPages !== -1);
check("ads pages are registered after the article pages", adsPages > articlesPages);
check("ads pages are registered before the admin 404 handler", adsPages < adminNotFound);

const adsApi = adminRoutesSource.indexOf("adsRoutes.registerApi(adminApi)");
const articlesApi = adminRoutesSource.indexOf("articleRoutes.registerApi(adminApi)");
const apiNotFound = adminRoutesSource.indexOf('res.status(404).json({ error: "Not found" })');

check("ads routes are registered on the API router", adsApi !== -1);
check("ads API routes come after the article API routes", adsApi > articlesApi);
check("ads API routes come before the API 404 handler", adsApi < apiNotFound);

/* ==================================================================== */
/* Nothing hardcoded                                                    */
/* ==================================================================== */

section("No hardcoded identifiers or scripts");

// The critical property: no publisher id, no slot id, no ad script URL in
// shipped code. A real ID would only ever come from the database at runtime.
const BANNED = [
  { label: "a real-looking publisher id", pattern: /ca-pub-\d{10,20}/ },
  { label: "a numeric ad slot id literal", pattern: /["']\d{8,12}["']/ }
];

const SHIPPED_SOURCES = [
  ["app/ads-service.js", serviceSource],
  ["app/admin-ads-views.js", viewsSource],
  ["app/admin-ads-routes.js", routesSource],
  ["app/server.js", serverSource],
  ["database/schema-ad-placements.sql", schemaSource],
  ["frontend/assets/ads.js", adsComponent],
  ["frontend/index.html", shellSource]
];

for (const { label, pattern } of BANNED) {
  for (const [name, source] of SHIPPED_SOURCES) {
    const match = source.match(pattern);
    check(`${name} contains no ${label}`, match === null, match ? match[0] : "");
  }
}

check(
  "the schema seeds an empty publisher id",
  /adsense_client\s+TEXT NOT NULL DEFAULT ''/.test(schemaSource)
);

check(
  "the schema seeds every placement disabled",
  /is_enabled\s+BOOLEAN NOT NULL DEFAULT FALSE/.test(schemaSource) &&
    /'header-top',[\s\S]*'footer',[\s\S]*\nON CONFLICT \(placement_key\) DO NOTHING/.test(schemaSource)
);

check(
  "the schema seeds every placement as ad type none",
  !/'[a-z-]+',\s*'(header|sidebar|content|footer)'\s*,\s*'adsense'/.test(schemaSource)
);

// The service has to mention the ca-pub- prefix, because it validates the
// format. What must not appear anywhere is a filled-in one.
check(
  "no application module contains a complete publisher id",
  !/ca-pub-\d{5,}/.test(serviceSource) &&
    !/ca-pub-\d{5,}/.test(viewsSource) &&
    !/ca-pub-\d{5,}/.test(routesSource) &&
    !/ca-pub-\d{5,}/.test(serverSource)
);

check(
  "the validation pattern is anchored so nothing can be appended to it",
  /PUBLISHER_ID_PATTERN = \/\^ca-pub-\\d\{10,20\}\$\//.test(serviceSource)
);

// The Google script host is a constant in the component, but it is only ever
// requested behind the manifest and consent gates. Assert the gates are there.
check("the component names the Google script host", /pagead2\.googlesyndication\.com/.test(adsComponent));
check("the script is only requested after a consent decision", /consentGiven\(\)/.test(adsComponent));
check(
  "the script is only requested when the manifest is enabled",
  /if \(!manifest\.enabled \|\| !manifest\.publisher_id \|\| !consentGiven\(\)\)/.test(adsComponent)
);
check("the component fetches the manifest from /api/ads", /var MANIFEST_URL = "\/api\/ads"/.test(adsComponent));

section("The public shell does not load a third-party script");

// The page itself must not include a third-party script tag. ads.js adds one at
// runtime, and only after an administrator has configured ads.
const SCRIPT_SRC = /<script[^>]+src=["']([^"']+)["']/gi;
const shellScripts = [...shellSource.matchAll(SCRIPT_SRC)].map(match => match[1]);

for (const src of shellScripts) {
  check(`${src} is same-origin`, src.startsWith("/") || src.startsWith("assets/") || src.startsWith("seo.js") || !/^https?:/i.test(src));
}

check("the shell loads no ad network script", !/googlesyndication|doubleclick|adsbygoogle/i.test(shellSource));
check("the shell loads the ad component", /assets\/ads\.js/.test(shellSource));
check("the shell loads the ad stylesheet", /assets\/ads\.css/.test(shellSource));

section("Custom code is not public");

// The public query and the admin query are different statements, so the check is
// made on the text of each rather than on a loose proximity match. custom_html
// appearing anywhere inside getPublicManifest would be the failure.
const manifestFn = serviceSource.slice(
  serviceSource.indexOf("async function getPublicManifest"),
  serviceSource.indexOf("module.exports")
);

check("getPublicManifest does not select custom_html", !/custom_html/.test(manifestFn), "custom_html is read inside getPublicManifest");
check("getPublicManifest never returns custom code", !/custom_html:/.test(manifestFn));
check("the admin list does select custom_html", /custom_html[\s\S]*?ORDER BY sort_order/.test(serviceSource));
check("custom code is escaped in the view", viewsSource.includes("escapeHtml(shown.custom_html)"));
check("custom code is shown as text, not markup", viewsSource.includes("admin-code-preview"));
check("the view never assigns custom code to innerHTML", !/innerHTML\s*=\s*[^;]*custom/i.test(viewsSource));

section("The public manifest cannot be widened from the browser");

check("there is no public write route for ads", !/app\.(post|put|patch|delete)\("\/api\/ads/.test(serverSource));
check("GET /api/ads is registered on the public surface", /app\.get\("\/api\/ads"/.test(serverSource));
check("the endpoint is read-only in the router", !/adsRoutes\.registerApi\(app\)/.test(serverSource));
check("the public endpoint sets no-store on failure", /"Cache-Control", "no-store"/.test(serverSource));

/* ==================================================================== */
/* Views                                                                */
/* ==================================================================== */

section("Admin views");

check("the settings page uses the shared admin chrome", viewsSource.includes("adminHeader"));
check("the settings page uses the shared layout", viewsSource.includes("layout("));
check("the placement form uses the shared admin chrome", viewsSource.includes("adminHeader"));
check("the ads page requires a session to reach", routesSource.includes("security.requireAdminPage"));

check("the settings form posts to /admin/ads/settings", viewsSource.includes('action="/admin/ads/settings"'));
check("the placement form posts to the placement id", /action="\/admin\/ads\/\$\{id\}"/.test(viewsSource));
check("both forms carry a CSRF token", (viewsSource.match(/name="_csrf"/g) || []).length >= 2);

check("the nav has an Ads link", adminViewsSource.includes('item("Ads", "/admin/ads", "ads")'));
check("the nav has an Ads link before the Monetization link", adminViewsSource.indexOf('item("Ads", "/admin/ads", "ads")') < adminViewsSource.indexOf('item("Monetization", "/admin/monetization", "monetization")'));

// The checkbox helper takes its name as a JS argument, not as rendered markup,
// so the assertion is on that call rather than on a name="..." attribute.
for (const field of ["ads_enabled", "adsense_enabled", "adsense_script_enabled", "consent_required"]) {
  check(`the settings form has a ${field} control`, viewsSource.includes(`name: "${field}"`));
}
check("the publisher id field is validated in the form", /pattern=/.test(viewsSource) || viewsSource.includes("ca-pub-"));

check(
  "the page says nothing is rendered while ads are off",
  /Nothing is rendered on the public site/.test(viewsSource)
);

// Rendered output is checked, not the source: the source comments legitimately
// discuss what "ads are live" would mean, and a comment is not a claim a
// reader ever sees.
const adsViews = require("../admin-ads-views");

const RENDERED_CLAIM = /ads are live|is monetised|is monetized|earning from ads|ads are now running/i;

const renderedOff = adsViews.renderAdsPage({
  admin: { email: "admin@example.com", role: "admin" },
  csrfToken: "token",
  settings: {
    ads_enabled: false,
    adsense_enabled: false,
    adsense_client: "",
    adsense_script_enabled: false,
    consent_required: true,
    consent_script_url: ""
  },
  placements: [
    {
      id: 1,
      placement_key: "sidebar-top",
      placement_name: "Sidebar Top",
      placement_zone: "sidebar",
      is_enabled: false,
      ad_type: "none",
      ad_slot: "",
      publisher_id: "",
      custom_html: "",
      show_desktop: true,
      show_mobile: true,
      min_height: 0,
      content_position: null,
      sort_order: 30,
      updated_at: new Date("2026-10-05T00:00:00Z")
    }
  ]
});

check("the rendered ads page makes no claim that ads are running", !RENDERED_CLAIM.test(renderedOff));
check("the rendered ads page states the state plainly", /Ads are switched off site-wide/.test(renderedOff));
check("the rendered ads page shows every seeded placement", /Sidebar Top/.test(renderedOff) && /sidebar-top/.test(renderedOff));

// An enabled-but-unconfigured site must not read as live either.
const renderedUnconfigured = adsViews.renderAdsPage({
  admin: { email: "admin@example.com", role: "admin" },
  csrfToken: "token",
  settings: {
    ads_enabled: true,
    adsense_enabled: true,
    adsense_client: "",
    adsense_script_enabled: true,
    consent_required: true,
    consent_script_url: ""
  },
  placements: []
});

check("ads on without a publisher id is called out as unserveable", /no publisher ID is saved/i.test(renderedUnconfigured));
check("ads on without a publisher id is not presented as running", !RENDERED_CLAIM.test(renderedUnconfigured));

/* ==================================================================== */
/* Frontend wiring                                                      */
/* ==================================================================== */

section("Frontend wiring");

const PLACEMENT_KEYS = [
  "header-top",
  "below-nav",
  "sidebar-top",
  "sidebar-middle",
  "sidebar-bottom",
  "before-article",
  "in-article",
  "after-article",
  "footer"
];

for (const key of PLACEMENT_KEYS) {
  check(`${key} is seeded in the migration`, schemaSource.includes(`'${key}'`));
}

check("the sidebar has a top slot", /AdSlot\.placeholder\("sidebar-top"\)/.test(pagesSource));
check("the sidebar has a middle slot", /AdSlot\.placeholder\("sidebar-middle"\)/.test(pagesSource));
check("the sidebar has a bottom slot", /AdSlot\.placeholder\("sidebar-bottom"\)/.test(pagesSource));
check("the article has a slot before it", /AdSlot\.placeholder\("before-article"\)/.test(pagesSource));
check("the article has a slot after it", /AdSlot\.placeholder\("after-article"\)/.test(pagesSource));
check("the article body takes an in-content slot", /AdSlot\.inArticle\("in-article"/.test(pagesSource));
check("the footer has a slot", /id="footer-ad-slot"/.test(shellSource) && /placeholder\("footer"\)/.test(adsComponent));

check("the homepage hydrates its slots", /AdSlot\.hydrate/.test(pagesSource));
check("the article page hydrates its slots", /AdSlot\.hydrate/.test(pagesSource));
check("hydration is called after the first render", /Router\.init\(\)/.test(read("frontend/script.js")));
check("the manifest is fetched before the first route renders", /KaliNovaAds\.ready\(\)/.test(read("frontend/script.js")));

section("In-content placement does not split a paragraph");

// The position is resolved against top-level blocks of the rendered body, so a
// paragraph can never be cut in half by a percentage calculation.
check("the body is built as DOM before the slot is placed", /document\.createElement\("div"\)/.test(pagesSource));
check("the block count comes from the body's top-level children", /holder\.children/.test(pagesSource));
check("the slot node is the placeholder's first element child", /slot\.firstElementChild/.test(pagesSource));
check("the slot is inserted after a whole block", /\.after\(element\)/.test(pagesSource));
check("no paragraph is split by string surgery", !/content\.slice\(|split\("<p"/.test(pagesSource));
check("a short article gets no in-content ad", /blockCount < 3|blocks\.length < 3/.test(pagesSource) || /blocks\.length < 3/.test(pagesSource));

section("Reservations and device flags");

check("the reserved height is written as an inline min-height", /min-height:/.test(adsComponent));
check("the reserved height comes from the placement config", /slot\.min_height/.test(adsComponent));
check("device visibility is carried on the element", /data-ad-desktop/.test(adsComponent) && /data-ad-mobile/.test(adsComponent));
check("a hidden device flag hides the slot and its reserved space", /node\.style\.display = "none"/.test(adsComponent));
check("an empty slot has no box", /\.ad-slot:empty/.test(read("frontend/assets/ads.css")));
check("no transition or animation is applied to a slot", !/\.ad-slot[^{]*\{[^}]*(transition|animation)/.test(read("frontend/assets/ads.css")));

section("Failure isolation");

check("a load failure resolves rather than throwing", /resolve\(false\)/.test(adsComponent));
check("a load failure does not retry", /manifestPromise = null/.test(adsComponent) && /catch\(function \(\)/.test(adsComponent));
check("each slot is pushed in its own try", /catch \(err\) \{\s*\/\* One bad slot/.test(adsComponent));
check("a script failure leaves the page alone", /loaded\)/.test(adsComponent));
check("the stylesheet hides an unfilled slot", /\.ad-slot:empty/.test(read("frontend/assets/ads.css")));

section("Consent");

check("the consent decision is stored locally", /localStorage/.test(adsComponent));
check("consent defaults to not given", /readConsent\(\) === true/.test(adsComponent));
check("ads are withheld until consent is given", /if \(manifest\.consent_required && !consentGiven\(\)\) return null/.test(adsComponent));
check("consent can be changed later", /grant: grantConsent/.test(adsComponent) && /deny: denyConsent/.test(adsComponent));
// Isolated to the buildBanner function body: the footer fill elsewhere in the
// component does use innerHTML, on markup this same file generated.
const bannerFn = adsComponent.slice(
  adsComponent.indexOf("function buildBanner"),
  adsComponent.indexOf("function hideBanner")
);

check("the banner body is present", bannerFn.length > 0);
check("the banner copy is set with textContent", /text\.textContent =/.test(bannerFn));

// Comments are stripped first: the body explains that it does not use innerHTML,
// and that sentence is not a use of it.
const bannerCode = bannerFn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

check("the banner body assigns no innerHTML", !/innerHTML/.test(bannerCode), "innerHTML inside buildBanner");
check("the banner links to the privacy policy", /policy\.href = "\/privacy"/.test(adsComponent));
check("the banner copy does not claim ads are running", /does not run advertising today/.test(adsComponent));

section("Legal pages");

check("/privacy is a registered route", /Router\.register\("\/privacy"/.test(pagesSource));
check("/terms is a registered route", /Router\.register\("\/terms"/.test(pagesSource));
check("/privacy reaches the SPA shell from the server", /\/\^\\\/privacy\$\//.test(serverSource));
check("/terms reaches the SPA shell from the server", /\/\^\\\/terms\$\//.test(serverSource));
check("the privacy page has SEO metadata", /privacy: \{/.test(read("frontend/seo.js")));
check("the terms page has SEO metadata", /terms: \{/.test(read("frontend/seo.js")));
check("the privacy page says advertising is not running", /does not run advertising at present/.test(pagesSource));
check("the terms page says advertising is not running", /does not run advertising at present/.test(pagesSource));
check("the footer links to the privacy policy", /href="\/privacy"/.test(shellSource));
check("the footer links to the terms", /href="\/terms"/.test(shellSource));

/* ==================================================================== */
/* Packaging                                                            */
/* ==================================================================== */

section("Packaging and deployment");

check("the migration is registered in the runner", /schema-ad-placements\.sql/.test(migrateSource));
check(
  "the migration is listed after the article CMS migration",
  migrateSource.indexOf("schema-article-cms.sql") < migrateSource.indexOf("schema-ad-placements.sql")
);
check("the migration runs against a fresh volume in compose", /10-ad-placements\.sql/.test(compose));
check("the service is in the image", /COPY app\/ads-service\.js \./.test(dockerfile));
check("the admin views are in the image", /COPY app\/admin-ads-views\.js \./.test(dockerfile));
check("the admin routes are in the image", /COPY app\/admin-ads-routes\.js \./.test(dockerfile));
check("the component is in the image via COPY frontend", /COPY frontend \/frontend/.test(dockerfile));
check("the ads suite is wired into npm test", /ads-test\.js/.test(packageJson.scripts.test));

section("CSP");

// The shipped policy stays closed for advertising. What matters is that the
// file says what to add and when, rather than being widened in advance for an
// ad network that is not being used. The only third-party script host allowed
// is the opt-in analytics loader (consent-gated, off by default).
const publicCspLine =
  headersSource
    .split(/\r?\n/)
    .find(line => line.trim().startsWith("Content-Security-Policy:")) || "";

check("the public CSP is not widened for Google ads", !/googlesyndication/.test(publicCspLine));
check("the public CSP still allows same-origin scripts", /script-src 'self'/.test(publicCspLine));
check(
  "the public CSP allows no ad-network script host",
  !/script-src[^;]*(googlesyndication|doubleclick)/.test(publicCspLine)
);
check("the CSP file documents that ads are not enabled", /ADS \/ ADSENSE ARE NOT YET ENABLED/.test(headersSource));
check("the CSP file lists the script hosts to add later", /script-src  \+= https:\/\/pagead2\.googlesyndication\.com/.test(headersSource));
check("the CSP file warns against unsafe-inline", /do not add 'unsafe-inline'/.test(headersSource));
check("the admin CSP is unchanged by this work", /adminCsp/.test(read("app/config.js")));

section("No Google API integration");

// The task was an architecture, not an integration: nothing here should talk to
// a Google reporting or management API. The font stylesheet in the shell is not
// an ad request, so the ad and management hosts are matched specifically.
// fonts.googleapis.com in the shell is the webfont stylesheet, not an ad or
// management API, so only the reporting and ad-serving hosts are matched here.
const GOOGLE_AD_API =
  /adsense\.google\.com\/management|adwords\.google\.com|googleapis\.com\/adsense|doubleclick\.net/;

for (const [name, source] of SHIPPED_SOURCES) {
  check(`${name} makes no Google ads or management API request`, !GOOGLE_AD_API.test(source));
}

check(
  "the shell's only Google request is the webfont stylesheet",
  (shellSource.match(/https:\/\/fonts\.googleapis\.com/g) || []).length > 0 &&
    !/https:\/\/(?!fonts\.googleapis\.com)[^"']*google/.test(shellSource)
);

// The ad script host is named in exactly one place, and only as a constant that
// is unreachable until an administrator configures ads.
const adHostUses = (adsComponent.match(/pagead2\.googlesyndication\.com/g) || []).length;
check("the Google ad script host appears once, as a constant", adHostUses === 1, `${adHostUses} occurrences`);
check("no server or admin module names the ad script host", !GOOGLE_AD_API.test(serviceSource + serverSource + shellSource + viewsSource + routesSource));

/* ==================================================================== */

console.log(`\n${passed} checks passed, ${failed} failed`);

if (failed > 0) {
  console.log("\nFailures:");
  for (const failure of failures) {
    console.log(`  - ${failure.label}${failure.detail ? ` (${failure.detail})` : ""}`);
  }
  process.exitCode = 1;
}
