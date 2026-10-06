"use strict";

/**
 * KaliNova — automatic open-data safety tests (offline)
 *
 * Everything here runs in memory with fake clocks and stubbed fetches. No
 * request leaves this process and no table needs to exist:
 *
 *   - breaker lifecycle: closed → open (consecutive failures, rate rule,
 *     timeouts, immediate 429/403) → half-open probe → closed
 *   - the 403 lock (three in 24h offs the service until an admin intervenes)
 *   - request envelopes (hourly / daily budgets refuse further calls)
 *   - environment switches (ENABLE_*) and the manual admin override
 *   - the licence allowlist (media-service) and the licence re-audit logic
 *   - RSS quiet states: breaker-refused and duty-cycled feeds are neither
 *     published nor "degraded"; a redirected feed stops writing headlines
 *
 * Run with:  node tests/circuit-breaker-test.js
 */

const assert = require("assert");

const circuit = require("../circuit-breaker");
const { licenseAllowed } = require("../media-service");
const licenseAudit = require("../license-audit");
const { createRssService, createMemoryStore } = require("../rss-service");
const config = require("../config");

/* ==================================================================== */
/* Test harness (same shape as the external suite)                      */
/* ==================================================================== */

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

async function testAsync(name, fn) {
  try {
    await fn();
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

/** A runnable clock: the test moves time forward by hand. */
function makeClock() {
  const clock = { t: Date.UTC(2026, 9, 6, 12, 0, 0) };
  clock.now = () => clock.t;
  clock.advance = ms => {
    clock.t += ms;
  };
  return clock;
}

/** A tiny fake upstream error with the same surface as ExternalServiceError. */
function makeError(kind, status) {
  const error = new Error(kind === "http" ? `upstream answered ${status}` : kind);
  error.kind = kind;
  if (status !== undefined) error.status = status;
  return error;
}

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fixture</title>
  <item><title>A headline</title><link>https://fixture.example/story</link><guid>g-1</guid><description>A short excerpt.</description></item>
</channel></rss>`;

/* ==================================================================== */
/* Breaker lifecycle                                                     */
/* ==================================================================== */

(function breakerLifecycle() {
  section("Circuit breaker lifecycle");

  test("a closed breaker allows and counts one request per gate call", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-closed", { persist: false, now: clock.now });
    const first = await breaker.gate();
    assert.strictEqual(first.allow, true);
    const second = await breaker.gate();
    assert.strictEqual(second.allow, true);
    assert.strictEqual((await breaker.summary()).budget.hourly.used, 2);
  });

  test("the configured number of consecutive failures opens the breaker", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-consecutive", {
      persist: false,
      now: clock.now,
      thresholds: { failureThreshold: 3, cooldownMs: 60000 }
    });
    for (let i = 0; i < 2; i++) {
      await breaker.recordResult({ ok: false, error: makeError("http", 500) });
      assert.strictEqual((await breaker.summary()).label, "ON", "must stay closed below the threshold");
    }
    await breaker.recordResult({ ok: false, error: makeError("http", 500) });
    const summary = await breaker.summary();
    assert.strictEqual(summary.autoState, "open");
    assert.strictEqual(summary.label, "AUTO OFF");
    const gate = await breaker.gate();
    assert.strictEqual(gate.allow, false);
    assert.strictEqual(gate.kind, "auto");
  });

  test("a cooldown lets one probe through; its success closes the breaker", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-probe", {
      persist: false,
      now: clock.now,
      thresholds: { failureThreshold: 2, cooldownMs: 60000 }
    });
    for (let i = 0; i < 2; i++) await breaker.recordResult({ ok: false, error: makeError("http", 500) });
    assert.strictEqual((await breaker.summary()).autoState, "open");

    clock.advance(60 * 1000); // cooldown elapsed
    const probeGate = await breaker.gate();
    assert.strictEqual(probeGate.allow, true, "exactly one probe is allowed after cooldown");
    assert.strictEqual(probeGate.kind, "trial");
    const blocked = await breaker.gate();
    assert.strictEqual(blocked.allow, false, "no second probe while one is in flight");
    assert.strictEqual(blocked.kind, "probe-in-flight");

    await breaker.recordResult({ ok: true });
    const summary = await breaker.summary();
    assert.strictEqual(summary.autoState, "closed");
    assert.strictEqual(summary.label, "ON");
  });

  test("a failing probe reopens; the cooldown doubles each open", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-double", {
      persist: false,
      now: clock.now,
      thresholds: { failureThreshold: 2, cooldownMs: 60000, maxCooldownMs: 600000 }
    });
    for (let i = 0; i < 2; i++) await breaker.recordResult({ ok: false, error: makeError("http", 500) });
    const first = await breaker.summary();
    assert.ok(first.nextRetryAt - first.openedAt >= 60000);

    clock.advance(60 * 1000);
    const probeGate = await breaker.gate();
    assert.strictEqual(probeGate.allow, true);
    await breaker.recordResult({ ok: false, error: makeError("timeout") });
    const second = await breaker.summary();
    assert.strictEqual(second.autoState, "open");
    assert.ok(second.nextRetryAt - second.openedAt >= 120000, "cooldown must double after a failed probe");
  });

  test("more than half of the last requests failing trips the rate rule", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-rate", {
      persist: false,
      now: clock.now,
      thresholds: { minRequests: 10, windowMs: 60 * 60 * 1000, failureRate: 0.5, failureThreshold: 100 }
    });
    // 10 requests, 6 failures, 4 wins — > 50 %.
    for (let i = 0; i < 10; i++) {
      await breaker.recordResult({ ok: i >= 4, error: i >= 4 ? makeError("http", 502) : undefined });
    }
    const summary = await breaker.summary();
    assert.strictEqual(summary.autoState, "open");
    assert.match(summary.reason, /% of the last/);
  });

  test("a burst of timeouts opens early when they are all timeouts", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-timeout", {
      persist: false,
      now: clock.now,
      thresholds: { failureThreshold: 3 }
    });
    for (let i = 0; i < 3; i++) await breaker.recordResult({ ok: false, error: makeError("timeout") });
    assert.strictEqual((await breaker.summary()).autoState, "open");
    assert.match((await breaker.summary()).reason, /timeouts/);
  });

  test("a 429 opens immediately and honours Retry-After", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-429", {
      persist: false,
      now: clock.now,
      thresholds: { cooldownMs: 60000 }
    });
    const error = makeError("http", 429);
    error.retryAfterSeconds = 300;
    await breaker.recordResult({ ok: false, error });
    const summary = await breaker.summary();
    assert.strictEqual(summary.autoState, "open");
    assert.ok(summary.nextRetryAt - summary.openedAt >= 300 * 1000, "Retry-After must shape the cooldown");
  });

  test("three 403 answers in 24h lock the breaker off", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-403", {
      persist: false,
      now: clock.now,
      thresholds: { forbiddenDailyMax: 3, cooldownMs: 60000 }
    });

    await breaker.recordResult({ ok: false, error: makeError("http", 403) });
    assert.strictEqual((await breaker.summary()).autoState, "open");
    await breaker.recordResult({ ok: false, error: makeError("http", 403) });
    assert.strictEqual((await breaker.summary()).autoState, "open");

    await breaker.recordResult({ ok: false, error: makeError("http", 403) });
    const locked = await breaker.summary();
    assert.strictEqual(locked.autoState, "locked-403");
    assert.strictEqual(locked.label, "OFF (LOCKED)");

    const gate = await breaker.gate();
    assert.strictEqual(gate.allow, false);
    assert.strictEqual(gate.kind, "locked-403");
  });
})();

/* ==================================================================== */
/* Budgets, switches and manual control                                  */
/* ==================================================================== */

(function budgetsAndControls() {
  section("Request envelopes and admin control");

  test("a spent hourly envelope refuses further calls until the window rolls", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-budget", {
      persist: false,
      now: clock.now,
      budget: { hourly: 3, daily: 100 }
    });
    for (let i = 0; i < 3; i++) {
      const gate = await breaker.gate();
      assert.strictEqual(gate.allow, true);
    }
    const refused = await breaker.gate();
    assert.strictEqual(refused.allow, false);
    assert.strictEqual(refused.kind, "budget");

    clock.advance(60 * 60 * 1000); // new hourly window
    const again = await breaker.gate();
    assert.strictEqual(again.allow, true);
  });

  test("an ENABLE_ switch set false refuses calls whatever the breaker says", async () => {
    const original = config.enableWikidata;
    try {
      config.enableWikidata = false;
      const clock = makeClock();
      const breaker = circuit.createBreaker("wikidata", { persist: false, now: clock.now });
      const gate = await breaker.gate();
      assert.strictEqual(gate.allow, false);
      assert.strictEqual(gate.kind, "env-off");
    } finally {
      config.enableWikidata = original;
    }

    const clock = makeClock();
    const breaker = circuit.createBreaker("wikidata", { persist: false, now: clock.now });
    const gate = await breaker.gate();
    assert.strictEqual(gate.allow, true, "restoring the switch re-enables the service");
  });

  test("manual off freezes a service; an admin reset restores it", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-manual", { persist: false, now: clock.now });
    await breaker.setManualOff("Blocked while the data supplier changes licences");
    let summary = await breaker.summary();
    assert.strictEqual(summary.label, "MANUAL OFF");
    assert.strictEqual(summary.manual.reason, "Blocked while the data supplier changes licences");
    assert.strictEqual((await breaker.gate()).allow, false);

    await breaker.reset();
    summary = await breaker.summary();
    assert.strictEqual(summary.label, "ON");
    assert.strictEqual((await breaker.gate()).allow, true);
  });

  test("an admin reset also clears a 403 lock", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-lock-reset", {
      persist: false,
      now: clock.now,
      thresholds: { forbiddenDailyMax: 3 }
    });
    for (let i = 0; i < 3; i++) await breaker.recordResult({ ok: false, error: makeError("http", 403) });
    assert.strictEqual((await breaker.summary()).autoState, "locked-403");

    await breaker.reset();
    const summary = await breaker.summary();
    assert.strictEqual(summary.autoState, "closed");
    assert.strictEqual(summary.forbidden24h, 0);
    assert.strictEqual((await breaker.gate()).allow, true);
  });

  test("circuit.run throws a BreakerOpenError when the breaker refuses", async () => {
    const clock = makeClock();
    const breaker = circuit.getBreaker("cbt-run-refused", { persist: false, now: clock.now });
    await breaker.setManualOff("under test");
    let threw = false;
    try {
      await circuit.run("cbt-run-refused", async () => ({ nope: true }));
    } catch (error) {
      threw = true;
      assert.strictEqual(error.kind, "breaker");
      assert.strictEqual(error.status, 503);
      assert.strictEqual(error.breakerService, "cbt-run-refused");
    }
    assert.ok(threw, "refused work must throw BreakerOpenError");
    await breaker.reset();
  });

  test("circuit.run records successes and failures on the breaker", async () => {
    const clock = makeClock();
    circuit.getBreaker("cbt-run-ok", { persist: false, now: clock.now });
    const value = await circuit.run("cbt-run-ok", async () => ({ ok: true }));
    assert.deepStrictEqual(value, { ok: true });
    const summary = await circuit.getBreaker("cbt-run-ok").summary();
    assert.strictEqual(summary.consecutiveFailures, 0);
    assert.strictEqual(summary.windowRequests, 1);

    await assert.rejects(
      () => circuit.run("cbt-run-ok", async () => {
        throw makeError("http", 502);
      }),
      error => error.kind === "http"
    );
    assert.strictEqual((await circuit.getBreaker("cbt-run-ok").summary()).consecutiveFailures, 1);
  });

  test("feed breaker keys slugify a feed source", () => {
    assert.strictEqual(circuit.feedBreakerKey("Wikimedia Foundation"), "rss:wikimedia-foundation");
    assert.strictEqual(circuit.feedBreakerKey("Mongabay News!"), "rss:mongabay-news");
    assert.strictEqual(circuit.feedBreakerKey(""), "rss:feed");
  });
})();

/* ==================================================================== */
/* Licence allowlist and re-audit                                        */
/* ==================================================================== */

(function licenceSafety() {
  section("Commons licence allowlist and re-audit");

  test("the allowlist accepts PD / CC0 / CC BY / CC BY-SA", () => {
    assert.strictEqual(licenseAllowed("Public Domain Mark 1.0"), true);
    assert.strictEqual(licenseAllowed("PD-old", "attribution not required"), true);
    assert.strictEqual(licenseAllowed("CC0 1.0", ""), true);
    assert.strictEqual(licenseAllowed("Creative Commons Attribution 4.0", "1"), true);
    assert.strictEqual(licenseAllowed("CC BY 4.0", "0"), true);
    assert.strictEqual(licenseAllowed("CC BY-SA 4.0", "1"), true);
  });

  test("the allowlist rejects non-commercial, no-derivatives and unclear", () => {
    assert.strictEqual(licenseAllowed("CC BY-NC 4.0", "1"), false);
    assert.strictEqual(licenseAllowed("CC BY-ND 4.0", "1"), false);
    assert.strictEqual(licenseAllowed("CC BY-NC-ND 4.0", "1"), false);
    assert.strictEqual(licenseAllowed("Non-commercial use only", "1"), false);
    assert.strictEqual(licenseAllowed("Fair use", "0"), false);
    assert.strictEqual(licenseAllowed("unknown", ""), false);
    assert.strictEqual(licenseAllowed("", ""), false);
    assert.strictEqual(licenseAllowed("Some Custom License", ""), false);
  });

  test("stored Commons rows are recognised and their re-check token recovered", () => {
    assert.strictEqual(
      licenseAudit.isCommonsRow({ file_path: "x", source: "https://commons.wikimedia.org/w/index.php?curid=40963012", title: "Tirumala" }),
      true
    );
    assert.strictEqual(
      licenseAudit.isCommonsRow({ file_path: "/assets/topics/bollywood/01.jpg", source: "https://www.flickr.com/x/1", title: "Back-view" }),
      false
    );
    assert.strictEqual(
      licenseAudit.commonsToken({ file_path: "x", source: "https://commons.wikimedia.org/w/index.php?curid=40963012", title: "Tirumala" }),
      "p:40963012"
    );
    assert.strictEqual(licenseAudit.commonsToken({ file_path: "x", source: "", title: "File:Given.jpg" }), "f:File:Given.jpg");
    assert.strictEqual(licenseAudit.commonsToken({ file_path: "x", source: "", title: "caption only" }), null);
  });

  test("a licence that drops off the allowlist marks the row hidden; recovery restores it", async () => {
    const rows = [
      { id: 1, title: "A", source: "https://commons.wikimedia.org/w/index.php?curid=1001" },
      { id: 2, title: "B", source: "https://commons.wikimedia.org/w/index.php?curid=1002" },
      { id: 3, title: "C", source: "https://commons.wikimedia.org/w/index.php?curid=1003", file_path: "/assets/a.jpg" }
    ];
    const decisions = await licenseAudit.decideRows(rows, async tokens => {
      assert.deepStrictEqual(tokens.sort(), ["p:1001", "p:1002", "p:1003"]);
      return {
        "p:1001": "CC BY-SA 4.0",
        "p:1002": "CC BY-NC 4.0",
        "p:1003": ""
      };
    });

    assert.deepStrictEqual(
      decisions.filter(decision => decision.action === "hide").map(decision => decision.rowId),
      [2, 3]
    );
    assert.strictEqual(decisions[0].action, "keep");

    // A previously hidden row whose licence is back on the allowlist restores.
    const hiddenRow = { id: 4, title: "D", source: "HIDDEN:https://commons.wikimedia.org/w/index.php?curid=1004" };
    const towardRestore = await licenseAudit.decideRows([hiddenRow], async () => ({ "p:1004": "CC0 1.0" }));
    assert.strictEqual(towardRestore[0].action, "restore");
  });
})();

/* ==================================================================== */
/* RSS quiet states                                                      */
/* ==================================================================== */

(function rssSafety() {
  section("RSS quiet states (disabled, duty-cycle, redirects)");

  test("breakered-off feeds silently stop publishing without a degraded flag", async () => {
    const clock = makeClock();
    const breaker = circuit.createBreaker("cbt-rss-off", { persist: false, now: clock.now });
    await breaker.setManualOff("feeding test");

    const service = createRssService({
      feeds: [{ source: "Fixture Off", url: "https://fixture.example/off.xml", category: "latest-news", enabled: true }],
      store: createMemoryStore(),
      breakerFor: () => breaker,
      fetchImpl: async () => {
        throw new Error("must not be called");
      }
    });

    assert.deepStrictEqual(service.approved.map(feed => feed.source), ["Fixture Off"]);
    const latest = await service.getLatest();
    assert.deepStrictEqual(latest.items, []);
    assert.deepStrictEqual(latest.sources, []);
    assert.strictEqual(latest.degraded, false);
  });

  test("a feed that redirects to another domain is stopped before any headline is written", async () => {
    const breaker = circuit.createBreaker("cbt-rss-redirect", { persist: false });
    const service = createRssService({
      feeds: [
        { source: "Fixture Redirect", url: "https://fixture.example/feed.xml", category: "latest-news", enabled: true }
      ],
      store: createMemoryStore(),
      breakerFor: () => breaker,
      fetchImpl: async () => ({ text: FEED_XML, finalUrl: "https://someone-else.example/feed.xml" })
    });

    const latest = await service.getLatest();
    assert.deepStrictEqual(latest.items, [], "no headline may be written from the new domain");
    assert.strictEqual(latest.degraded, false);
    assert.strictEqual((await breaker.summary()).autoState, "open");
  });

  test("a duty cycle spaces fetches; repeats are skipped, not refetched", async () => {
    let calls = 0;
    const service = createRssService({
      feeds: [
        { source: "Fixture Cycle", url: "https://fixture.example/cycle.xml", category: "latest-news", enabled: true }
      ],
      store: createMemoryStore(),
      dutyCycle: { minIntervalMs: 60 * 60 * 1000 },
      fetchImpl: async () => {
        calls += 1;
        return FEED_XML;
      }
    });

    await service.refresh();
    assert.strictEqual(calls, 1);
    await service.refresh(); // inside the interval → skipped
    assert.strictEqual(calls, 1, "a refresh inside the duty cycle must not hit the feed again");

    const latest = await service.getLatest();
    assert.strictEqual(latest.items.length, 1, "the last good snapshot still answers");
  });

  test("a feed in the registry without termsReviewed passes; one marked false is refused", () => {
    const service = createRssService({
      feeds: [
        { source: "No flag", url: "https://a.example/feed.xml", category: "latest-news", enabled: true },
        { source: "Refused", url: "https://b.example/feed.xml", category: "latest-news", enabled: true, termsReviewed: false }
      ],
      store: createMemoryStore(),
      fetchImpl: async () => ({ text: "" })
    });
    assert.deepStrictEqual(service.approved.map(feed => feed.source), ["No flag"]);
  });
})();

/* ==================================================================== */
/* Static guardrails                                                     */
/* ==================================================================== */

(function guardrails() {
  section("Repository guardrails");

  test("the integrations admin page is registered on both routers", () => {
    const fs = require("fs");
    const path = require("path");
    const routes = fs.readFileSync(path.join(__dirname, "..", "admin-routes.js"), "utf8");
    assert.ok(routes.includes('require("./admin-integrations-routes")'), "routes must require the integrations module");
    assert.ok(routes.includes("integrationsRoutes.registerPages"), "the page router must mount the integrations screens");
    assert.ok(routes.includes("integrationsRoutes.registerApi"), "the API router must mount the integrations endpoints");
  });

  test("the admin navigation exposes the integrations section", () => {
    const fs = require("fs");
    const path = require("path");
    const views = fs.readFileSync(path.join(__dirname, "..", "admin-views.js"), "utf8");
    assert.match(views, /Integrations/, "/admin/integrations");
    assert.ok(views.includes("/admin/integrations"), "nav link must point at the integrations page");
  });

  test("the Dockerfile lists every new runtime module explicitly", () => {
    const fs = require("fs");
    const path = require("path");
    const dockerfile = fs.readFileSync(path.join(__dirname, "..", "..", "Dockerfile"), "utf8");
    for (const moduleName of ["circuit-breaker.js", "background-jobs.js", "map-health.js", "license-audit.js", "admin-integrations-routes.js", "admin-integrations-views.js"]) {
      assert.ok(dockerfile.includes(`COPY app/${moduleName}`), `Dockerfile must COPY app/${moduleName}`);
    }
  });

  test("the compose file mounts the integration safety schema and passes the new variables", () => {
    const fs = require("fs");
    const path = require("path");
    const compose = fs.readFileSync(path.join(__dirname, "..", "..", "docker-compose.yml"), "utf8");
    assert.ok(compose.includes("12-integration-safety.sql"), "the safety schema must be mounted in initdb order");
    for (const variable of ["ENABLE_WIKIDATA", "ENABLE_COMMONS", "ENABLE_MAPS", "ENABLE_RSS", "CB_FAILURE_THRESHOLD", "CB_FORBIDDEN_DAILY_MAX", "RSS_MIN_INTERVAL_MS", "MAP_TILE_HEALTHCHECK_MS"]) {
      assert.ok(compose.includes(variable), `compose must pass ${variable}`);
    }
  });

  test("the migration runner applies the safety schema after the open-data schema", () => {
    const fs = require("fs");
    const path = require("path");
    const migrate = fs.readFileSync(path.join(__dirname, "..", "migrate.js"), "utf8");
    const externalIndex = migrate.indexOf("schema-external-data.sql");
    const safeIndex = migrate.indexOf("schema-integration-safety.sql");
    assert.ok(externalIndex !== -1 && safeIndex !== -1, "both schemas must be wired into the runner");
    assert.ok(safeIndex > externalIndex, "the safety schema must run after the open-data schema");
  });

  test("the public images endpoint hides rows the licence audit marked HIDDEN", () => {
    const fs = require("fs");
    const path = require("path");
    const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    assert.ok(server.includes("NOT LIKE 'HIDDEN:%'"), "server-side gallery query must filter hidden rows");
  });

  test("the frontend falls back to a text index when the maps feature is off", () => {
    const fs = require("fs");
    const path = require("path");
    const openData = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "assets", "open-data.js"), "utf8");
    assert.ok(openData.includes("mapsEnabled"), "the frontend must read the mapsEnabled flag");
    assert.ok(openData.includes("locationIndexMarkup"), "the text index renderer must exist");
    assert.ok(openData.includes("tileerror"), "tile failures must trigger the fallback");
  });
})();

/* ==================================================================== */
/* Report                                                               */
/* ==================================================================== */

console.log(`\n${passed}/${passed + failed} passed`);

if (failed) {
  console.log("\nFailures:");
  for (const failure of failures) {
    console.log(`\n  ${failure.name}`);
    console.log(`    ${failure.error.stack}`);
  }
}

process.exit(failed ? 1 : 0);