"use strict";

/**
 * KaliNova — open-data integration tests (offline)
 *
 * Everything this suite touches is either pure logic or a fixture served by a
 * local HTTP server started inside the test. No request ever leaves 127.0.0.1:
 * Wikidata, Wikimedia Commons, Nominatim and the RSS feeds all have stand-ins,
 * which also proves the *_API_URL / GEOCODER_URL overrides in app/config.js
 * work exactly as the documentation promises.
 *
 * What is covered:
 *   - feed parsing (CDATA, entities, Atom, malformed items, dedupe, ordering)
 *   - the RSS ingestion service with one good, one broken and one overlapping
 *     feed (failure isolation, single-flight refresh, category filtering)
 *   - Wikidata claim/entity extraction and the curated-fact allowlist
 *   - Commons licence/attribution extraction and the drop-list (non-free,
 *     unlicensed, non-raster)
 *   - geocode row validation, cache TTL / stale / single-flight behaviour,
 *     and the bounded outbound HTTP client (timeout, size cap, error kinds)
 *   - the seven public endpoints: 200s against fixtures, 400s for every input
 *     class, a generic 503 when the upstream breaks, and the per-IP 429
 *   - static guardrails: Dockerfile COPY lines, migration order, CSP, the
 *     vendored Leaflet files, the licence document, and the page hooks
 *
 * /api/news/latest is deliberately NOT called with a valid category here: the
 * registry feeds are real publisher URLs, and this suite must stay offline.
 * Its 400 paths (validated before any service call) are covered, and the
 * ingestion pipeline itself is tested through the factory above.
 *
 * Run with:  node tests/external-test.js
 */

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const FIXTURE_TIMEOUT_MS = 1200;

/* ==================================================================== */
/* Fixtures                                                             */
/* ==================================================================== */

const WIKIDATA_SEARCH = JSON.stringify({
  search: [
    { id: "Q169997", label: "Darjeeling", description: "City in West Bengal, India" },
    { id: "Q1134759", label: "Darjeeling district", description: "district in West Bengal, India" },
    // Must be filtered out by the Q-id pattern.
    { id: "not-an-id", label: "Broken row", description: "should never survive" }
  ]
});

const WIKIDATA_ENTITY = JSON.stringify({
  entities: {
    Q169997: {
      id: "Q169997",
      labels: { en: { value: "Darjeeling" } },
      descriptions: { en: { value: "City in West Bengal, India" } },
      claims: {
        // Curated: entityid resolved to a label through the batched request.
        P31: [{ mainsnak: { snaktype: "value", datavalue: { type: "entityid", value: { id: "Q486972" } } } }],
        // Curated: unitless quantity renders as a bare amount.
        P1082: [{ mainsnak: { snaktype: "value", datavalue: { type: "quantity", value: { amount: "118805", unit: "1" } } } }],
        // Curated: known unit (Q11573 = metre) renders with its label.
        P2044: [{ mainsnak: { snaktype: "value", datavalue: { type: "quantity", value: { amount: "2115", unit: "http://www.wikidata.org/entity/Q11573" } } } }],
        // Curated: coordinates.
        P625: [{ mainsnak: { snaktype: "value", datavalue: { type: "geo-coordinate", value: { latitude: 27.041, longitude: 88.266 } } } }],
        // NOT in the allowlist: must never appear in the facts.
        P99999: [{ mainsnak: { snaktype: "value", datavalue: { type: "string", value: "should be ignored" } } }]
      }
    }
  }
});

const WIKIDATA_LABELS = JSON.stringify({
  entities: {
    Q486972: { id: "Q486972", labels: { en: { value: "municipality" } } }
  }
});

const WIKIDATA_MISSING = JSON.stringify({
  entities: { Q999999999: { id: "Q999999999", missing: "" } }
});

const COMMONS_PAGES = JSON.stringify({
  query: {
    pages: [
      {
        title: "File:Fixture railway.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Fixture_railway.jpg",
          thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/Fixture_railway.jpg/600px-Fixture_railway.jpg",
          mime: "image/jpeg",
          width: 1600,
          height: 900,
          extmetadata: {
            LicenseShortName: { value: "CC BY-SA 4.0" },
            LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
            AttributionRequired: { value: "1" },
            Artist: { value: '<a href="https://commons.wikimedia.org/wiki/User:Fixture">Fixture&nbsp;Author</a>' }
          }
        }]
      },
      {
        // SVG is not a raster format the pages render: dropped.
        title: "File:Fixture diagram.svg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/wikipedia/commons/b/bb/Fixture_diagram.svg",
          mime: "image/svg+xml",
          extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, AttributionRequired: { value: "1" } }
        }]
      },
      {
        // No licence metadata at all: dropped rather than guessed.
        title: "File:Fixture unknown.jpg",
        imageinfo: [{ url: "https://upload.wikimedia.org/c/ce/Fixture_unknown.jpg", mime: "image/jpeg", extmetadata: {} }]
      },
      {
        // Explicitly non-free: dropped.
        title: "File:Fixture poster.png",
        imageinfo: [{
          url: "https://upload.wikimedia.org/d/dd/Fixture_poster.png",
          mime: "image/png",
          extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, NonFree: { value: "true" }, AttributionRequired: { value: "1" } }
        }]
      },
      {
        // Public domain with the attribution flag off.
        title: "File:Fixture old photo.jpg",
        imageinfo: [{
          url: "https://upload.wikimedia.org/e/ee/Fixture_old.jpg",
          mime: "image/jpeg",
          extmetadata: { LicenseShortName: { value: "PD-old" }, AttributionRequired: { value: "0" } }
        }]
      }
    ]
  }
});

const NOMINATIM_ROWS = JSON.stringify([
  { lat: "27.0377554", lon: "88.2631760", name: "Fixtureville", display_name: "Fixtureville, Testland, India" },
  // Invalid rows must be dropped by normalisation.
  { lat: "not-a-number", lon: "88.0", name: "Broken A" },
  { lat: "95.0", lon: "191.0", name: "Broken B" }
]);

const RSS_GOOD = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Fixture Feed</title>
    <link>https://fixtures.example/</link>
    <item>
      <title><![CDATA[Second &amp; finest]]></title>
      <link>https://example.com/second</link>
      <description><![CDATA[<p>A short excerpt with <b>markup</b> in it.</p>]]></description>
      <pubDate>Mon, 06 Oct 2026 10:00:00 +0000</pubDate>
      <guid>g-second</guid>
    </item>
    <item>
      <title>Oldest story</title>
      <link>https://example.com/oldest</link>
      <description>Plain &amp; simple excerpt</description>
      <pubDate>Sun, 04 Oct 2026 08:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Broken item without a link</title>
      <description>It has no destination, so it must be skipped.</description>
    </item>
    <item>
      <title>Tomorrow&#8217;s news</title>
      <link>https://example.com/future</link>
      <pubDate>Tue, 07 Oct 2026 09:00:00 +0000</pubDate>
      <guid>g-future</guid>
    </item>
    <item>
      <title>Undated story</title>
      <link>https://example.com/undated</link>
    </item>
  </channel>
</rss>`;

const RSS_DUPE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Fixture Overlap Feed</title>
    <item>
      <title>The same story from another feed</title>
      <link>https://example.com/second</link>
      <pubDate>Mon, 06 Oct 2026 11:00:00 +0000</pubDate>
      <guid>different-guid-same-url</guid>
    </item>
    <item>
      <title>Exclusive dupe-feed story</title>
      <link>https://example.com/dupe-exclusive</link>
      <pubDate>Mon, 05 Oct 2026 12:00:00 +0000</pubDate>
      <guid>g-dupe-exclusive</guid>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Fixture</title>
  <entry>
    <title type="html">&lt;em&gt;Emphasised&lt;/em&gt; headline</title>
    <link href="https://example.org/atom-story" rel="alternate"/>
    <id>urn:fixture:1</id>
    <published>2026-10-06T12:30:00Z</published>
    <summary>An Atom summary.</summary>
  </entry>
</feed>`;

/* ==================================================================== */
/* Test harness                                                         */
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ==================================================================== */
/* Local fixture upstream                                               */
/* ==================================================================== */

function createFixtureServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const sendJson = body => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
    };
    const sendXml = body => {
      res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
      res.end(body);
    };

    if (url.pathname === "/feed-good.xml") return sendXml(RSS_GOOD);
    if (url.pathname === "/feed-dupe.xml") return sendXml(RSS_DUPE);
    if (url.pathname === "/feed-broken.xml") {
      res.writeHead(500);
      return res.end("upstream is down");
    }

    if (url.pathname === "/slow") {
      const timer = setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("too late");
      }, FIXTURE_TIMEOUT_MS);
      res.on("close", () => clearTimeout(timer));
      return undefined;
    }

    if (url.pathname === "/big") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(5 * 1024 * 1024) });
      return res.end(Buffer.alloc(5 * 1024 * 1024, "x"));
    }

    if (url.pathname === "/boom") {
      res.writeHead(500);
      return res.end("boom");
    }

    if (url.pathname === "/notjson") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html>definitely not JSON</html>");
    }

    const action = url.searchParams.get("action") || "";
    if (action === "wbsearchentities") {
      if (url.searchParams.get("search") === "FORCEFAIL") {
        res.writeHead(500);
        return res.end("wikidata exploded");
      }
      return sendJson(WIKIDATA_SEARCH);
    }
    if (action === "wbgetentities") {
      const ids = url.searchParams.get("ids") || "";
      const props = url.searchParams.get("props") || "";
      if (props === "labels") return sendJson(WIKIDATA_LABELS);
      if (ids === "Q999999999") return sendJson(WIKIDATA_MISSING);
      return sendJson(WIKIDATA_ENTITY);
    }
    if (action === "query") return sendJson(COMMONS_PAGES);

    if (url.pathname === "/search") {
      if (url.searchParams.get("q") === "FORCEFAIL") {
        res.writeHead(500);
        return res.end("geocoder exploded");
      }
      return sendJson(NOMINATIM_ROWS);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "fixture route not found", path: url.pathname }));
  });
}

/* ==================================================================== */
/* Main                                                                 */
/* ==================================================================== */

(async () => {
  /* The fixture server is started first so app/config.js can be pointed at
     its (ephemeral) port before any application module reads the environment. */
  const fixture = createFixtureServer();
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;

  process.env.WIKIDATA_API_URL = `${fixtureOrigin}/w/api.php`;
  process.env.COMMONS_API_URL = `${fixtureOrigin}/w/api.php`;
  process.env.GEOCODER_URL = fixtureOrigin;
  // Deterministic UA in tests: the default is fine, but pinning it keeps the
  // outbound-header assertion below stable if the default ever changes.
  process.env.SITE_URL = "https://kalinova.in";
  delete process.env.OSM_TILE_URL;

  /* ------------------------------ pure units ----------------------------- */

  section("Feed parser (RSS 2.0 / Atom)");
  const feedParser = require("../feed-parser");

  test("CDATA titles are unwrapped and entities decoded", () => {
    const { items } = feedParser.parseFeed(RSS_GOOD, { source: "Fixture" });
    const second = items.find(item => item.guid === "g-second");
    assert.strictEqual(second.title, "Second & finest");
    assert.strictEqual(second.description, "A short excerpt with markup in it.");
  });

  test("named and numeric entities are decoded in plain text", () => {
    const { items } = feedParser.parseFeed(RSS_GOOD, { source: "Fixture" });
    const oldest = items.find(item => item.link === "https://example.com/oldest");
    assert.strictEqual(oldest.description, "Plain & simple excerpt");
    const future = items.find(item => item.guid === "g-future");
    assert.strictEqual(future.title, "Tomorrow\u2019s news");
  });

  test("items without a destination or a headline are skipped", () => {
    const { items } = feedParser.parseFeed(RSS_GOOD, { source: "Fixture" });
    assert.ok(!items.some(item => item.title.includes("without a link")));
    assert.strictEqual(items.length, 4);
  });

  test("guid falls back to the permalink when a feed omits it", () => {
    const { items } = feedParser.parseFeed(RSS_GOOD, { source: "Fixture" });
    const oldest = items.find(item => item.title === "Oldest story");
    assert.strictEqual(oldest.guid, "https://example.com/oldest");
  });

  test("RFC-822 pubDate becomes an ISO timestamp, missing dates stay null", () => {
    const { items } = feedParser.parseFeed(RSS_GOOD, { source: "Fixture" });
    assert.strictEqual(items.find(item => item.guid === "g-second").publishedAt, "2026-10-06T10:00:00.000Z");
    assert.strictEqual(items.find(item => item.link === "https://example.com/undated").publishedAt, null);
  });

  test("Atom entries resolve link href, published date and HTML titles", () => {
    const { title, items } = feedParser.parseFeed(ATOM_FEED, { source: "Atom" });
    assert.strictEqual(title, "Atom Fixture");
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].link, "https://example.org/atom-story");
    assert.strictEqual(items[0].title, "Emphasised headline");
    assert.strictEqual(items[0].publishedAt, "2026-10-06T12:30:00.000Z");
    assert.strictEqual(items[0].guid, "urn:fixture:1");
  });

  test("an HTML error page yields no items instead of throwing", () => {
    const { items } = feedParser.parseFeed("<html><body>503 Service Unavailable</body></html>", { source: "Fixture" });
    assert.deepStrictEqual(items, []);
  });

  test("an oversized document is refused outright", () => {
    const big = `<?xml version="1.0"?><rss><channel><title>${"x".repeat(1024 * 1024)}</title></channel></rss>`;
    const { items } = feedParser.parseFeed(big, { source: "Fixture" });
    assert.deepStrictEqual(items, []);
  });

  test("dedupe keys on guid first, then on URL", () => {
    const merged = feedParser.dedupeAndSort([
      { guid: "g1", link: "https://a.example/1", title: "One", publishedAt: "2026-10-06T00:00:00.000Z" },
      { guid: "g1", link: "https://a.example/other", title: "Same guid", publishedAt: "2026-10-06T00:00:00.000Z" },
      { guid: "g2", link: "https://a.example/1", title: "Same URL", publishedAt: "2026-10-06T00:00:00.000Z" },
      { guid: "g3", link: "https://a.example/3", title: "Unique", publishedAt: "2026-10-06T00:00:00.000Z" }
    ]);
    assert.strictEqual(merged.length, 2);
    assert.deepStrictEqual(merged.map(item => item.title).sort(), ["One", "Unique"]);
  });

  test("ordering is newest first with undated items last, capped by limit", () => {
    const merged = feedParser.dedupeAndSort([
      { guid: "a", link: "https://x/a", publishedAt: "2026-10-01T00:00:00.000Z" },
      { guid: "b", link: "https://x/b", publishedAt: null },
      { guid: "c", link: "https://x/c", publishedAt: "2026-10-03T00:00:00.000Z" },
      { guid: "d", link: "https://x/d", publishedAt: "2026-10-02T00:00:00.000Z" }
    ], 3);
    assert.deepStrictEqual(merged.map(item => item.guid), ["c", "d", "a"]);
  });

  test("excerpts cut on a word boundary and stay within budget", () => {
    const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november";
    const short = feedParser.excerpt(text, 30);
    assert.ok(short.length <= 30);
    assert.ok(short.endsWith("\u2026"));
    assert.ok(!/^\S*\u2026$/.test(short), "cut landed mid-word");
    assert.strictEqual(feedParser.excerpt("short one", 30), "short one");
  });

  /* --------------------------- RSS ingestion ---------------------------- */

  section("RSS ingestion service (good / broken / overlapping feeds)");
  const { fetchText } = require("../external-http");
  const { createRssService, createMemoryStore, isValidHttpUrl, normalizeItems } = require("../rss-service");

  function countingFetch(counter) {
    return async (url, options) => {
      counter.set(url, (counter.get(url) || 0) + 1);
      return fetchText(url, options);
    };
  }

  const registryFeeds = [
    { source: "Fixture Good", url: `${fixtureOrigin}/feed-good.xml`, category: "latest-news", enabled: true },
    { source: "Fixture Broken", url: `${fixtureOrigin}/feed-broken.xml`, category: "latest-news", enabled: true },
    { source: "Fixture Overlap", url: `${fixtureOrigin}/feed-dupe.xml`, category: "latest-news", enabled: true }
  ];

  await testAsync("one dead feed fails alone while the others publish", async () => {
    const hits = new Map();
    const service = createRssService({
      feeds: registryFeeds,
      fetchImpl: countingFetch(hits),
      store: createMemoryStore()
    });

    const result = await service.getLatest({ limit: 20 });

    const bySource = Object.fromEntries(result.sources.map(entry => [entry.source, entry.status]));
    assert.strictEqual(bySource["Fixture Good"], "ok");
    assert.strictEqual(bySource["Fixture Broken"], "failed");
    assert.strictEqual(bySource["Fixture Overlap"], "ok");
    assert.strictEqual(result.degraded, true, "a failed feed must mark the snapshot degraded");

    // 4 usable items from the good feed + 1 exclusive from the overlap feed;
    // the shared https://example.com/second URL collapses to one entry.
    assert.strictEqual(result.items.length, 5);
    assert.ok(result.items.every(item => item.source !== "Fixture Broken"));
    assert.strictEqual(
      result.items.filter(item => item.url === "https://example.com/second").length,
      1,
      "the same story arriving twice must appear once"
    );
  });

  await testAsync("headlines come back newest first and undated last", async () => {
    const service = createRssService({ feeds: registryFeeds, fetchImpl: fetchText, store: createMemoryStore() });
    const { items } = await service.getLatest({ limit: 20 });
    const dated = items.filter(item => item.published_at);
    const order = dated.map(item => Date.parse(item.published_at));
    assert.deepStrictEqual(order, order.slice().sort((a, b) => b - a));
    assert.strictEqual(items[items.length - 1].published_at, null, "undated item belongs at the end");
  });

  await testAsync("category filtering only returns that category", async () => {
    const service = createRssService({ feeds: registryFeeds, fetchImpl: fetchText, store: createMemoryStore() });
    const all = await service.getLatest({ limit: 20 });
    assert.ok(all.items.length > 0);

    const wildlife = await service.getLatest({ category: "wildlife", limit: 20 });
    assert.deepStrictEqual(wildlife.items, []);

    const localised = await service.getLatest({ category: "latest-news", limit: 20 });
    assert.strictEqual(localised.items.length, all.items.length);
  });

  await testAsync("a second read does not refetch while the snapshot is fresh", async () => {
    const hits = new Map();
    const service = createRssService({
      feeds: registryFeeds,
      fetchImpl: countingFetch(hits),
      store: createMemoryStore()
    });
    await service.getLatest({ limit: 5 });
    const afterFirst = hits.get(`${fixtureOrigin}/feed-good.xml`);
    assert.strictEqual(afterFirst, 1);

    await service.getLatest({ limit: 5 });
    assert.strictEqual(hits.get(`${fixtureOrigin}/feed-good.xml`), 1, "fresh snapshot must be reused");
  });

  await testAsync("concurrent cold reads share one refresh (single flight)", async () => {
    const hits = new Map();
    const service = createRssService({
      feeds: registryFeeds,
      fetchImpl: countingFetch(hits),
      store: createMemoryStore()
    });
    await Promise.all([service.getLatest({ limit: 5 }), service.getLatest({ limit: 5 }), service.getLatest({ limit: 5 })]);
    assert.strictEqual(hits.get(`${fixtureOrigin}/feed-good.xml`), 1, "three cold readers must produce one fetch");
    assert.strictEqual(hits.get(`${fixtureOrigin}/feed-broken.xml`), 1);
  });

  await testAsync("normalisation drops unusable rows and keeps the contract fields", async () => {
    const rows = normalizeItems(
      { source: "Fixture", category: "latest-news" },
      [
        { title: "  Needs   collapsing  ", link: "https://example.com/ok", description: "d", guid: "", publishedAt: null },
        { title: "", link: "https://example.com/no-title", description: "d" },
        { title: "No URL", link: "", description: "d" },
        { title: "Bad scheme", link: "javascript:alert(1)", description: "d" },
        { title: "T".repeat(400), link: "https://example.com/long", description: "d" }
      ]
    );
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].title, "Needs collapsing");
    assert.strictEqual(rows[0].guid, "https://example.com/ok");
    assert.ok(rows[1].title.length <= 300);
    assert.ok(isValidHttpUrl("https://example.com"));
    assert.strictEqual(isValidHttpUrl("ftp://example.com"), false);
    assert.strictEqual(isValidHttpUrl("not a url"), false);
  });

  /* --------------------------- Wikidata --------------------------------- */

  section("Wikidata extraction (curated facts only)");
  const wikidata = require("../wikidata-service");

  test("search results are filtered to well-formed Q-ids", () => {
    const results = wikidata.extractSearchResults(JSON.parse(WIKIDATA_SEARCH));
    assert.deepStrictEqual(results.map(row => row.id), ["Q169997", "Q1134759"]);
    assert.strictEqual(results[0].url, "https://www.wikidata.org/wiki/Q169997");
  });

  test("facts only contain allowlisted properties", () => {
    const entity = JSON.parse(WIKIDATA_ENTITY).entities.Q169997;
    const facts = wikidata.extractFacts(entity);
    assert.deepStrictEqual(
      facts.map(fact => fact.label),
      ["instance of", "coordinate location", "population", "elevation"]
    );
    assert.ok(!JSON.stringify(facts).includes("should be ignored"));
  });

  test("quantity values render with a labelled unit, not an entity id", () => {
    const entity = JSON.parse(WIKIDATA_ENTITY).entities.Q169997;
    const facts = wikidata.extractFacts(entity);
    const elevation = facts.find(fact => fact.label === "elevation");
    assert.strictEqual(elevation.values[0], "2115 m");
    const population = facts.find(fact => fact.label === "population");
    assert.strictEqual(population.values[0], "118805");
  });

  test("referenced entity ids are resolved to labels before answering", async () => {
    const entity = await wikidata.getEntity("Q169997");
    assert.strictEqual(entity.label, "Darjeeling");
    const instanceOf = entity.facts.find(fact => fact.property === "P31");
    assert.strictEqual(instanceOf.values[0], "municipality", "Q486972 must arrive as its label");
    assert.strictEqual(entity.source.license, "CC0 1.0");
  });

  test("a missing entity answers 404, a malformed id answers 400", async () => {
    await assert.rejects(() => wikidata.getEntity("Q999999999"), error => error.status === 404);
    await assert.rejects(() => wikidata.getEntity("not-a-qid"), error => error.status === 400);
    await assert.rejects(() => wikidata.getEntity("Q0"), error => error.status === 400);
  });

  test("time, coordinate and string values format predictably", () => {
    const time = value => wikidata.formatDataValue({ type: "time", value: { time: value } });
    assert.strictEqual(time("+1950-03-15T00:00:00Z"), "1950-03-15");
    assert.strictEqual(time("+1950-00-00T00:00:00Z"), "1950");
    assert.strictEqual(time("-0044-03-15T00:00:00Z"), "43 BCE");
    assert.strictEqual(
      wikidata.formatDataValue({ type: "geo-coordinate", value: { latitude: 27.041, longitude: 88.266 } }),
      "27.0410, 88.2660"
    );
    assert.strictEqual(wikidata.formatDataValue({ type: "string", value: "hello" }), "hello");
    assert.strictEqual(wikidata.formatDataValue({ type: "string", value: null }), null);
    assert.strictEqual(wikidata.formatDataValue({ type: "string", value: undefined }), null);
    assert.strictEqual(wikidata.formatDataValue(null), null);
  });

  /* --------------------------- Commons ---------------------------------- */

  section("Wikimedia Commons licence metadata");
  const media = require("../media-service");

  test("only raster files with licence metadata survive the filter", () => {
    const results = media.extractResults(JSON.parse(COMMONS_PAGES));
    assert.deepStrictEqual(results.map(row => row.title), ["File:Fixture railway.jpg", "File:Fixture old photo.jpg"]);
  });

  test("attribution requirements are reported, not assumed away", () => {
    const results = media.extractResults(JSON.parse(COMMONS_PAGES));
    const ccBySa = results.find(row => row.title === "File:Fixture railway.jpg");
    assert.strictEqual(ccBySa.requires_attribution, true);
    assert.strictEqual(ccBySa.licence, "CC BY-SA 4.0");
    assert.strictEqual(ccBySa.licence_url, "https://creativecommons.org/licenses/by-sa/4.0");
    assert.ok(ccBySa.attribution.includes("Fixture railway.jpg"));
    assert.ok(ccBySa.attribution.includes("CC BY-SA 4.0"));
    assert.ok(ccBySa.attribution.includes("Fixture Author"), "credit comes from the file's Artist field");
    assert.strictEqual(ccBySa.page_url, "https://commons.wikimedia.org/wiki/File:Fixture_railway.jpg");

    const pd = results.find(row => row.title === "File:Fixture old photo.jpg");
    assert.strictEqual(pd.requires_attribution, false);
  });

  test("HTML in credit fields is stripped before it can be rendered", () => {
    const results = media.extractResults(JSON.parse(COMMONS_PAGES));
    const row = results.find(row_ => row_.title === "File:Fixture railway.jpg");
    assert.ok(!row.author.includes("<"));
    assert.strictEqual(row.author, "Fixture Author");
  });

  test("licence assessment never returns a blanket 'free to use'", () => {
    assert.strictEqual(media.assessLicence("", "").present, false, "unknown licence must not be returned at all");
    assert.strictEqual(media.assessLicence("CC0 1.0", "").requiresAttribution, false);
    assert.strictEqual(media.assessLicence("CC BY 4.0", "1").requiresAttribution, true);
    assert.strictEqual(media.assessLicence("CC BY 4.0", "0").requiresAttribution, false);
    assert.strictEqual(media.assessLicence("Some Custom License", "").requiresAttribution, true);
  });

  /* ---------------------------- Geocoding -------------------------------- */

  section("OpenStreetMap geocoding");
  const geo = require("../geo-service");

  test("invalid or out-of-range coordinates are dropped", () => {
    const rows = geo.normalizeNominatimRows(JSON.parse(NOMINATIM_ROWS));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, "Fixtureville");
    assert.strictEqual(rows[0].lat, 27.0377554);
    assert.deepStrictEqual(geo.normalizeNominatimRows("not an array"), []);
  });

  test("the map config carries the mandatory OpenStreetMap attribution", () => {
    const mapConfig = geo.mapConfig();
    assert.strictEqual(mapConfig.attribution, "\u00a9 OpenStreetMap contributors");
    assert.ok(mapConfig.tileUrl.includes("{z}") && mapConfig.tileUrl.includes("{x}") && mapConfig.tileUrl.includes("{y}"));
    assert.strictEqual(mapConfig.attributionUrl, "https://www.openstreetmap.org/copyright");
  });

  test("the destination list is config-only and Q-id validated", () => {
    const destinations = geo.listDestinations();
    assert.ok(destinations.length >= 1);
    const darjeeling = destinations.find(entry => entry.id === "darjeeling");
    assert.ok(darjeeling, "the Darjeeling example destination must be configured");
    assert.strictEqual(darjeeling.wikidataId, "Q169997");
    assert.strictEqual(darjeeling.places.length, 4);
    assert.ok(darjeeling.places.every(place => place.name && place.query));
  });

  await testAsync("geocode answers from the fixture, normalised and bounded", async () => {
    const { results, query } = await geo.geocode("Testville, Fixtureland");
    assert.strictEqual(query, "Testville, Fixtureland");
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, "Fixtureville");
  });

  await testAsync("an empty query is a 400 from the service itself", async () => {
    await assert.rejects(() => geo.geocode("   "), error => error.status === 400);
  });

  /* ------------------------ Outbound HTTP client ------------------------- */

  section("Bounded outbound HTTP");
  const httpx = require("../external-http");

  await testAsync("a slow upstream becomes a timeout error", async () => {
    await assert.rejects(
      () => httpx.fetchText(`${fixtureOrigin}/slow`, { timeoutMs: 250 }),
      error => error instanceof httpx.ExternalServiceError && error.kind === "timeout"
    );
  });

  await testAsync("an oversized body is refused mid-stream", async () => {
    await assert.rejects(
      () => httpx.fetchText(`${fixtureOrigin}/big`, { maxBytes: 64 * 1024 }),
      error => error instanceof httpx.ExternalServiceError && error.kind === "too-large"
    );
  });

  await testAsync("a 500 upstream and a dead port keep their error kinds", async () => {
    await assert.rejects(
      () => httpx.fetchText(`${fixtureOrigin}/boom`),
      error => error.kind === "http" && error.status === 500
    );
    await assert.rejects(
      () => httpx.fetchText("http://127.0.0.1:9/never", { timeoutMs: 1500 }),
      error => error.kind === "network" || error.kind === "timeout"
    );
  });

  await testAsync("non-JSON bodies become bad-response, not a crash", async () => {
    await assert.rejects(
      () => httpx.fetchJson(`${fixtureOrigin}/notjson`),
      error => error.kind === "bad-response"
    );
  });

  test("unsafe URLs never reach the wire", () => {
    assert.throws(() => httpx.assertSafeUrl("ftp://example.com/x"), error => error.kind === "bad-response");
    assert.throws(() => httpx.assertSafeUrl("https://user:pass@example.com/x"), error => error.kind === "bad-response");
    assert.throws(() => httpx.assertSafeUrl("/relative/only"), error => error.kind === "bad-response");
  });

  test("every request identifies the application and its operator", async () => {
    const config = require("../config");
    assert.match(config.wikimediaUserAgent, /^Kalinova\//);
    assert.ok(config.wikimediaUserAgent.includes("kalinova.in"));
    assert.match(config.contactEmail, /@/);
  });

  /* ------------------------------ Cache ---------------------------------- */

  section("TTL cache (fresh / stale / single flight)");
  const { createCache } = require("../external-cache");

  await testAsync("a fresh value is served without running the loader again", async () => {
    const cache = createCache({ maxEntries: 10 });
    let loads = 0;
    const loader = async () => { loads += 1; return "value"; };

    const first = await cache.getOrLoad("k", loader, { ttlMs: 1000, staleMs: 1000 });
    const second = await cache.getOrLoad("k", loader, { ttlMs: 1000, staleMs: 1000 });
    assert.strictEqual(first.value, "value");
    assert.strictEqual(second.stale, false);
    assert.strictEqual(loads, 1);
  });

  await testAsync("concurrent misses share a single loader call", async () => {
    const cache = createCache({ maxEntries: 10 });
    let loads = 0;
    const loader = async () => { loads += 1; await sleep(20); return loads; };

    const results = await Promise.all([
      cache.getOrLoad("same", loader, { ttlMs: 1000, staleMs: 1000 }),
      cache.getOrLoad("same", loader, { ttlMs: 1000, staleMs: 1000 }),
      cache.getOrLoad("same", loader, { ttlMs: 1000, staleMs: 1000 })
    ]);
    assert.strictEqual(loads, 1);
    assert.ok(results.every(result => result.value === 1));
  });

  await testAsync("past freshUntil the value is stale but still served", async () => {
    const cache = createCache({ maxEntries: 10 });
    await cache.getOrLoad("k", async () => "old", { ttlMs: 5, staleMs: 60_000 });
    await sleep(15);
    const result = await cache.getOrLoad("k", async () => "new", { ttlMs: 60_000, staleMs: 60_000 });
    assert.strictEqual(result.value, "old", "stale data is handed over immediately");
    assert.strictEqual(result.stale, true);
  });

  await testAsync("a failed refresh falls back to the stale copy", async () => {
    const cache = createCache({ maxEntries: 10 });
    await cache.getOrLoad("k", async () => "cached answer", { ttlMs: 5, staleMs: 60_000 });
    await sleep(15);
    const result = await cache.getOrLoad("k", async () => { throw new Error("upstream down"); }, { ttlMs: 5, staleMs: 60_000 });
    assert.strictEqual(result.value, "cached answer");
    assert.strictEqual(result.stale, true);
  });

  await testAsync("past the hard window the loader must succeed", async () => {
    const cache = createCache({ maxEntries: 10 });
    cache.set("k", "gone soon", { ttlMs: 1, staleMs: 1 });
    await sleep(10);
    assert.strictEqual(cache.get("k"), null);
    await assert.rejects(() => cache.getOrLoad("k", async () => { throw new Error("still down"); }, { ttlMs: 10, staleMs: 10 }));
  });

  test("the store is bounded, so public query keys cannot leak memory", () => {
    const cache = createCache({ maxEntries: 3 });
    for (let index = 0; index < 10; index += 1) cache.set(`key-${index}`, index, { ttlMs: 60_000 });
    assert.strictEqual(cache.size(), 3);
    cache.reset();
    assert.strictEqual(cache.size(), 0);
  });

  /* ---------------------------- Public API ------------------------------- */

  section("Public endpoints (fixtures, validation, limits)");

  /* The FORCEFAIL probes below record real failures against the breakers,
     which are persisted in integration_status. Left alone, the nominatim
     breaker eventually opens (5 consecutive failures) and geocode then
     answers 200 with an empty list instead of throwing, so this suite would
     fail on every run after the first few. Start from a known-closed state. */
  const circuit = require("../circuit-breaker");
  for (const service of ["nominatim", "wikidata", "commons"]) {
    await circuit.adminReset(service);
  }

  const app = require("../server");
  const listener = app.listen(0, "127.0.0.1");
  await new Promise(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;

  async function get(pathname) {
    const response = await fetch(origin + pathname, { headers: { Accept: "application/json" } });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, headers: response.headers, body, text };
  }

  await testAsync("GET /api/geo/config answers with tiles and attribution", async () => {
    const { status, body } = await get("/api/geo/config");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.attribution, "\u00a9 OpenStreetMap contributors");
    assert.ok(body.tileUrl.startsWith("https://"));
  });

  await testAsync("GET /api/geo/destinations ships config without an upstream call", async () => {
    const { status, body } = await get("/api/geo/destinations");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.destinations[0].id, "darjeeling");
    assert.strictEqual(body.map.geocoder, "Nominatim (OpenStreetMap)");
  });

  await testAsync("GET /api/wikidata/search honours q and limit", async () => {
    const one = await get("/api/wikidata/search?q=Fixture+Place&limit=1");
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body.results.length, 1);
    assert.strictEqual(one.body.source.license, "CC0 1.0");
    assert.match(one.headers.get("cache-control") || "", /public, max-age=\d+/);

    const two = await get("/api/wikidata/search?q=Fixture+Place&limit=2");
    assert.strictEqual(two.body.results.length, 2);
    assert.ok(!JSON.stringify(two.body).includes("not-an-id"));
  });

  await testAsync("GET /api/wikidata/entity/Q169997 returns the curated facts", async () => {
    const { status, body } = await get("/api/wikidata/entity/Q169997");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, "Q169997");
    const labels = body.facts.map(fact => fact.label);
    assert.deepStrictEqual(labels, ["instance of", "coordinate location", "population", "elevation"]);
    assert.strictEqual(body.facts.find(fact => fact.property === "P2044").values[0], "2115 m");
    assert.strictEqual(body.source.license, "CC0 1.0");
  });

  await testAsync("GET /api/media/search returns licence metadata only", async () => {
    const { status, body } = await get("/api/media/search?q=Fixture+railway&limit=5");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.results.length, 2);
    assert.ok(!JSON.stringify(body.results).includes("svg"), "non-raster files must not appear");
    assert.ok(!JSON.stringify(body.results).includes("unknown"), "unlicensed files must not appear");
    assert.match(body.note, /licence/i);
    assert.ok(body.results.every(row => row.page_url && row.licence));
  });

  await testAsync("GET /api/geo/place geocodes through the fixture", async () => {
    const { status, body } = await get("/api/geo/place?q=Testville+Route+Check");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.results.length, 1);
    assert.strictEqual(body.results[0].name, "Fixtureville");
  });

  section("Validation answers 400 before anything leaves the building");

  const invalidRequests = [
    ["/api/wikidata/search", "missing q"],
    ["/api/wikidata/search?q=&limit=5", "empty q"],
    ["/api/wikidata/search?q=one&q=two", "repeated q"],
    ["/api/wikidata/search?q=Darjeeling&limit=999", "limit above range"],
    ["/api/wikidata/search?q=Darjeeling&limit=0", "limit below range"],
    ["/api/wikidata/search?q=Darjeeling&limit=abc", "non-numeric limit"],
    ["/api/wikidata/entity/not-a-qid", "malformed entity id"],
    ["/api/wikidata/entity/Q0", "zero entity id"],
    ["/api/media/search", "missing media q"],
    ["/api/media/search?q=" + "x".repeat(200), "oversized media q"],
    ["/api/geo/place", "missing geocode q"],
    ["/api/news/latest?limit=abc", "non-numeric news limit"],
    ["/api/news/latest?limit=999", "news limit above range"],
    ["/api/news/latest?category=Bogus+City", "category with a space"],
    ["/api/news/latest?category=../etc/passwd", "category that is not a slug"]
  ];

  for (const [pathname, label] of invalidRequests) {
    await testAsync(`${label} → 400 with a fixed message`, async () => {
      const { status, body } = await get(pathname);
      assert.strictEqual(status, 400, `${pathname} answered ${status}`);
      assert.strictEqual(typeof body.error, "string");
      assert.ok(!/http:\/\/|127\.0\.0\.1|at .*\.js|ECONN|wikidata\.org/i.test(body.error), "no internals may leak");
    });
  }

  await testAsync("an exploding upstream answers one generic 503", async () => {
    const { status, body } = await get("/api/wikidata/search?q=FORCEFAIL");
    assert.strictEqual(status, 503);
    assert.strictEqual(body.error, "Data service temporarily unavailable. Try again shortly.");

    const geocodeFailure = await get("/api/geo/place?q=FORCEFAIL");
    assert.strictEqual(geocodeFailure.status, 503);
    assert.strictEqual(geocodeFailure.body.error, "Data service temporarily unavailable. Try again shortly.");
    assert.ok(!JSON.stringify(geocodeFailure.body).includes("FORCEFAIL"), "the query must not be echoed back");
  });

  section("Rate limiting (per IP, sliding window)");

  await testAsync("the search endpoints answer 429 with Retry-After once the budget is spent", async () => {
    let limited = null;
    // The budget is 30 requests/minute across the search routes; earlier tests
    // in this file have already consumed some of it, so loop until blocked.
    for (let attempt = 0; attempt <= 40 && !limited; attempt += 1) {
      const result = await get(`/api/media/search?q=Hammer${attempt}`);
      if (result.status === 429) limited = result;
      else assert.strictEqual(result.status, 200, `unexpected ${result.status} while consuming the budget`);
    }
    assert.ok(limited, "the limiter never engaged");
    assert.match(limited.body.error, /Too many requests/);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1, "Retry-After must be present and positive");
  });

  /* --------------------------- Static guards ----------------------------- */

  section("Repository guardrails (build, policy and licences)");

  const read = rel => fs.readFileSync(path.join(REPO, rel), "utf8");

  test("the image contains every open-data module explicitly", () => {
    const dockerfile = read("Dockerfile");
    for (const file of [
      "external-http.js", "external-cache.js", "external-routes.js",
      "wikidata-service.js", "media-service.js", "geo-service.js",
      "travel-destinations.js", "feed-parser.js", "rss-feeds.js", "rss-service.js"
    ]) {
      assert.ok(dockerfile.includes(`COPY app/${file} .`), `Dockerfile is missing COPY app/${file}`);
    }
  });

  test("the migration runs after the ad placements it must not disturb", () => {
    const migrate = read("app/migrate.js");
    assert.ok(migrate.includes("schema-external-data.sql"));
    assert.ok(
      migrate.indexOf("schema-article-cms.sql") < migrate.indexOf("schema-ad-placements.sql"),
      "the guarded migration order changed"
    );
    assert.ok(
      migrate.indexOf("schema-ad-placements.sql") < migrate.indexOf("schema-external-data.sql"),
      "the external-data migration must come last"
    );
  });

  test("compose mounts the new schema and passes the open-data environment through", () => {
    const compose = read("docker-compose.yml");
    assert.ok(compose.includes("./database/schema-external-data.sql:/docker-entrypoint-initdb.d/11-external-data.sql:ro"));
    for (const key of ["CONTACT_EMAIL", "OSM_TILE_URL", "GEOCODER_URL", "EXTERNAL_FETCH_TIMEOUT_MS"]) {
      assert.ok(compose.includes(`${key}:`), `docker-compose.yml does not pass ${key}`);
    }
    assert.ok(read(".env.example").includes("EXTERNAL_FETCH_TIMEOUT_MS"));
  });

  test("the schema keeps the data policy it promises", () => {
    const schema = read("database/schema-external-data.sql");
    assert.ok(schema.includes("external_data_cache"));
    assert.ok(schema.includes("rss_items"));
    assert.ok(/guid\s+VARCHAR\(500\)\s+NOT NULL\s+UNIQUE/.test(schema), "guid must be UNIQUE for idempotent ingestion");
    assert.ok(schema.includes("expires_at"), "cache rows must expire");
    assert.ok(schema.includes("rss_items_url_is_web"), "stored URLs must be constrained to the open web");
    assert.ok(!/body\s+TEXT/.test(schema), "no column for third-party article bodies may exist");
  });

  test("only reviewed feeds are enabled, each with its licence decision recorded", () => {
    const feeds = require("../rss-feeds");
    const enabled = feeds.filter(feed => feed.enabled);
    assert.deepStrictEqual(enabled.map(feed => feed.source).sort(), ["Mongabay News", "Wikimedia Foundation"]);
    for (const feed of feeds) {
      assert.ok(feed.termsNote && feed.reviewedAt, `${feed.source} has no recorded terms review`);
      if (feed.enabled) assert.ok(feed.license, `${feed.source} has no licence recorded`);
    }
    const guardian = feeds.find(feed => feed.source === "The Guardian");
    assert.ok(guardian && guardian.enabled === false, "The Guardian must stay refused and documented");
  });

  test("the licence document covers every integration", () => {
    const doc = read("docs/external-data-licenses.md");
    for (const needle of ["Wikidata", "CC0", "Wikimedia Commons", "CC BY-SA", "CC BY-ND", "OpenStreetMap", "The Guardian", "attribution"]) {
      assert.ok(doc.includes(needle), `docs/external-data-licenses.md does not mention ${needle}`);
    }
  });

  test("the public shell only loads same-origin scripts, open-data included", () => {
    const shell = read("frontend/index.html");
    assert.ok(shell.includes('<script src="/assets/open-data.js"></script>'));
    const scripts = [...shell.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(match => match[1]);
    assert.ok(scripts.length > 0);
    for (const src of scripts) assert.ok(!/^https?:/i.test(src), `${src} is third-party`);
  });

  test("the CSP allows tiles and nothing else new", () => {
    const headers = read("frontend/_headers");
    assert.ok(headers.includes("script-src 'self';"), "script-src must stay same-origin only");
    assert.ok(
      headers.includes("img-src 'self' data: https://*.tile.openstreetmap.org"),
      "the tile host must be added to img-src"
    );
    assert.ok(headers.includes("script-src  += https://pagead2.googlesyndication.com"), "the documented AdSense note must remain");
  });

  test("the pages call the open-data component where it belongs", () => {
    const pages = read("frontend/pages.js");
    assert.ok(pages.includes("hydrateNewsHeadlines"), "the news page hook is missing");
    assert.ok(pages.includes("hydrateTravelMap"), "the travel map hook is missing");
    assert.ok(/slug === "travel"/.test(pages), "the map must be gated to the travel category");
  });

  test("Leaflet is vendored locally, complete and licensed", () => {
    const vendor = path.join(REPO, "frontend", "vendor", "leaflet");
    const js = fs.statSync(path.join(vendor, "leaflet.js")).size;
    const css = fs.statSync(path.join(vendor, "leaflet.css")).size;
    assert.ok(js > 100_000, "leaflet.js looks truncated");
    assert.ok(css > 10_000, "leaflet.css looks truncated");
    const marker = fs.readFileSync(path.join(vendor, "images", "marker-icon.png"));
    assert.deepStrictEqual([...marker.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "marker-icon.png is not a PNG");
    const licence = fs.readFileSync(path.join(vendor, "LICENSE"), "utf8");
    assert.match(licence, /2-Clause|Leaflet/i);
  });

  test("the stylesheet knows the sections it is asked to render", () => {
    const css = read("frontend/style.css");
    for (const selector of [".open-data-section", ".destination-card", ".travel-map {", ".headline-list"]) {
      assert.ok(css.includes(selector), `style.css is missing ${selector}`);
    }
  });

  test("npm test runs this suite alongside the existing ones", () => {
    const packageJson = JSON.parse(read("app/package.json"));
    assert.ok(packageJson.scripts.test.includes("external-test.js"));
    assert.ok(packageJson.scripts.test.includes("ads-test.js"), "the ads suite must stay wired in");
  });

  /* ------------------------------ Shutdown -------------------------------- */

  console.log(`\n${passed}/${passed + failed} passed`);

  if (failed) {
    console.log("\nFailures:");
    for (const failure of failures) {
      console.log(`\n  ${failure.name}`);
      console.log(`    ${failure.error.stack}`);
    }
  }

  await new Promise(resolve => listener.close(resolve));
  await new Promise(resolve => fixture.close(resolve));
  if (typeof fixture.closeAllConnections === "function") fixture.closeAllConnections();

  try {
    await require("../db").end();
  } catch {
    // No database was needed to prove any of this.
  }

  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error("\nexternal-test crashed:", error);
  process.exitCode = 1;
});
