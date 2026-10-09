"use strict";

/**
 * KaliNova — optional analytics tests
 *
 * The analytics loader is a privacy feature as much as a measurement one, so
 * the checks pin down the decisions that make it safe:
 *
 *   1. it is OFF by default — a build with no GA_MEASUREMENT_ID answers
 *      `enabled: false` and makes no third-party request
 *   2. a GA4 id is parsed strictly; a malformed value is ignored, never
 *      half-enabling the loader
 *   3. the browser waits for advertising consent and honours Do Not Track /
 *      Global Privacy Control before anything loads
 *   4. the config endpoint, the HTML include and the Cloudflare CSP are all
 *      wired together
 *
 * Config parsing is exercised in child processes so the real module is loaded
 * with controlled environment values. No database is touched.
 *
 * Run with:  node tests/analytics-test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

require("dotenv").config();

const monetization = require("../monetization-service");

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

const CONFIG_PATH = require.resolve("../config");
const MONETIZATION_PATH = require.resolve("../monetization-service");

/** Load the real config + service under a controlled environment. */
function loadConfig(overrides) {
  const env = { ...process.env };
  delete env.GA_MEASUREMENT_ID;
  delete env.ENABLE_ANALYTICS;
  // db.js loads dotenv, whose v17 banner would otherwise pollute stdout before
  // our JSON. Silence it so the child prints exactly one line.
  env.DOTENV_CONFIG_QUIET = "true";
  Object.assign(env, overrides);

  const script = `
    const cfg = require(${JSON.stringify(CONFIG_PATH)});
    const svc = require(${JSON.stringify(MONETIZATION_PATH)});
    process.stdout.write(JSON.stringify({
      gaMeasurementId: cfg.gaMeasurementId,
      enableAnalytics: cfg.enableAnalytics,
      analytics: svc.getAnalyticsConfig()
    }));
  `;

  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return JSON.parse(out);
}

/* ==================================================================== */
/* [1] Default is off                                                    */
/* ==================================================================== */

section("[1] Default is off");

const defaultConfig = monetization.getAnalyticsConfig();
check("the analytics config is a plain object", defaultConfig && typeof defaultConfig === "object");
check("analytics is disabled when no id is configured", defaultConfig.enabled === false);
check("no measurement id is leaked when disabled", defaultConfig.measurement_id === "");
check("consent is always required", defaultConfig.consent_required === true);

/* ==================================================================== */
/* [2] GA4 id parsing                                                     */
/* ==================================================================== */

section("[2] GA4 id parsing");

const valid = loadConfig({ GA_MEASUREMENT_ID: "G-ABC1234567" });
check("a valid GA4 id is accepted", valid.gaMeasurementId === "G-ABC1234567", valid.gaMeasurementId);
check("a valid id enables the loader", valid.analytics.enabled === true);
check("an enabled loader returns the id", valid.analytics.measurement_id === "G-ABC1234567");

const invalid = loadConfig({ GA_MEASUREMENT_ID: "not-a-real-id" });
check("a malformed id is ignored", invalid.gaMeasurementId === "", invalid.gaMeasurementId);
check("a malformed id leaves the loader off", invalid.analytics.enabled === false);

const lowered = loadConfig({ GA_MEASUREMENT_ID: "g-lowercase1" });
check("a lowercase id is rejected", lowered.gaMeasurementId === "", lowered.gaMeasurementId);

const switchedOff = loadConfig({ GA_MEASUREMENT_ID: "G-ABC1234567", ENABLE_ANALYTICS: "false" });
check("the master switch turns a configured id off", switchedOff.analytics.enabled === false);
check("the switched-off loader returns no id", switchedOff.analytics.measurement_id === "");

/* ==================================================================== */
/* [3] Route wiring                                                       */
/* ==================================================================== */

section("[3] Route wiring");

const routesSource = read("app/monetization-routes.js");
check("the public config endpoint is registered", routesSource.includes('"/analytics/config"'));
check("the endpoint serves the service config", routesSource.includes("monetization.getAnalyticsConfig()"));

const serviceSource = read("app/monetization-service.js");
check("the analytics config builder exists", serviceSource.includes("function getAnalyticsConfig"));
check("it is exported", /getAnalyticsConfig,/.test(serviceSource));

const configSource = read("app/config.js");
check("the measurement id env var is read", configSource.includes("GA_MEASUREMENT_ID"));
check("the master switch is read", /ENABLE_ANALYTICS/.test(configSource));

/* ==================================================================== */
/* [4] Frontend loader                                                    */
/* ==================================================================== */

section("[4] Frontend loader");

const loader = read("frontend/assets/analytics.js");
check("the loader exists", loader.length > 500);
check("it reads the same-origin config endpoint", loader.includes("/api/analytics/config"));
check("it refuses to run when disabled", /!data\.enabled/.test(loader));
check("it refuses to run without a measurement id", /!data\.measurement_id/.test(loader));
check("it honours Do Not Track", loader.includes("doNotTrack"));
check("it honours Global Privacy Control", loader.includes("globalPrivacyControl"));
check("it waits for advertising consent", loader.includes("consentGiven"));
check("it injects the gtag loader", loader.includes("googletagmanager.com/gtag/js"));
check("it anonymises the IP", loader.includes("anonymize_ip"));
check("it lets the SPA own pageviews", loader.includes("send_page_view: false"));
check("it tracks page_view events", loader.includes('"page_view"'));
check("it follows SPA route changes", loader.includes('"kal:route"'));
check("it reacts to a late consent decision", loader.includes('"kal:consent"'));
check("it never uses document.write", !/document\.write\s*\(/.test(loader));
check("it exposes a small API", /window\.KaliNovaAnalytics\s*=/.test(loader));

/* ==================================================================== */
/* [5] HTML + startup + consent event                                     */
/* ==================================================================== */

section("[5] HTML + startup + consent event");

const indexHtml = read("frontend/index.html");
check("the page loads the analytics loader", indexHtml.includes("/assets/analytics.js"));
check(
  "the loader loads after the ad component",
  indexHtml.indexOf("/assets/ads.js") < indexHtml.indexOf("/assets/analytics.js")
);

const scriptSource = read("frontend/script.js");
check("startup initialises analytics", scriptSource.includes("KaliNovaAnalytics.init()"));

const adsComponent = read("frontend/assets/ads.js");
check("granting consent emits kal:consent", adsComponent.includes('new CustomEvent("kal:consent"'));
check("the consent event carries the decision", /detail:\s*\{\s*granted:/.test(adsComponent));

/* ==================================================================== */
/* [6] CSP and documentation                                              */
/* ==================================================================== */

section("[6] CSP and documentation");

const headers = read("frontend/_headers");
// Scope the checks to the directive itself: the explanatory comments below it
// mention "unsafe-eval" and would otherwise defeat the assertion.
const cspLine = headers
  .split(/\r?\n/)
  .find(line => line.trim().startsWith("Content-Security-Policy:"));

check("a CSP directive is present", Boolean(cspLine));
check("the CSP allows the gtag script origin", /script-src[^;]*https:\/\/www\.googletagmanager\.com/.test(cspLine));
check("the CSP allows the analytics connect origins", /connect-src[^;]*https:\/\/www\.google-analytics\.com/.test(cspLine));
check("the CSP still forbids eval", cspLine && !/unsafe-eval/.test(cspLine));
check("the CSP keeps scripts otherwise same-origin", /script-src 'self'/.test(cspLine));

const envExample = read(".env.example");
check("the env example documents the GA4 id", envExample.includes("GA_MEASUREMENT_ID"));
check("the env example documents the master switch", /ENABLE_ANALYTICS/.test(envExample));

console.log(`\n${passed} checks passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) {
    console.log(`  - ${failure.name}: ${failure.error.message}`);
  }
  process.exitCode = 1;
}
