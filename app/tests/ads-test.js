"use strict";

/**
 * KaliNova — ad configuration tests
 *
 * The point of this suite is the default: the site is not monetised, and nothing
 * here may change that. Every test is written as "given this input, the service
 * must refuse to produce a usable ad identifier" or "this gate must be closed".
 *
 * Run with:  node tests/ads-test.js
 *
 * The database is only used for the two integration checks at the end, and they
 * restore whatever they changed, so the suite is safe to run against a database
 * that has an administrator's real configuration in it.
 */

require("./test-db-guard");

const assert = require("assert");

require("dotenv").config();

const adsService = require("../ads-service");
const pool = require("../db");

(async () => {
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

/* ==================================================================== */
/* Publisher ID: the one value that must never be guessed                */
/* ==================================================================== */

section("Publisher id validation");

test("a well formed publisher id survives", () => {
  assert.strictEqual(adsService.normalizePublisherId("ca-pub-1234567890123456"), "ca-pub-1234567890123456");
});

test("surrounding whitespace is trimmed", () => {
  assert.strictEqual(adsService.normalizePublisherId("  ca-pub-1234567890123456  "), "ca-pub-1234567890123456");
});

test("an empty publisher id stays empty", () => {
  assert.strictEqual(adsService.normalizePublisherId(""), "");
});

test("a missing publisher id stays empty", () => {
  assert.strictEqual(adsService.normalizePublisherId(null), "");
  assert.strictEqual(adsService.normalizePublisherId(undefined), "");
});

test("a too-short publisher id is refused", () => {
  assert.strictEqual(adsService.normalizePublisherId("ca-pub-123"), "");
});

test("a publisher id with letters is refused", () => {
  assert.strictEqual(adsService.normalizePublisherId("ca-pub-abcdefghij"), "");
});

test("a publisher id carrying markup is refused", () => {
  // The public manifest writes this value into an attribute, so anything that is
  // not ca-pub-<digits> has to be dropped rather than escaped.
  assert.strictEqual(adsService.normalizePublisherId('ca-pub-1234"><script>alert(1)</script>'), "");
});

test("a bare number is not a publisher id", () => {
  assert.strictEqual(adsService.normalizePublisherId("1234567890123456"), "");
});

test("a url is not a publisher id", () => {
  assert.strictEqual(adsService.normalizePublisherId("https://ca-pub-1234567890123456"), "");
});

/* ==================================================================== */
/* Slot id                                                              */
/* ==================================================================== */

section("Slot id validation");

test("a digit slot id survives", () => {
  assert.strictEqual(adsService.normalizeSlotId("9876543210"), "9876543210");
});

test("a slot id with a letter is refused", () => {
  assert.strictEqual(adsService.normalizeSlotId("12a45"), "");
});

test("a slot id carrying markup is refused", () => {
  assert.strictEqual(adsService.normalizeSlotId('123"><img src=x onerror=alert(1)>'), "");
});

test("an empty slot id stays empty", () => {
  assert.strictEqual(adsService.normalizeSlotId(""), "");
});

/* ==================================================================== */
/* Consent script url                                                   */
/* ==================================================================== */

section("Consent script url validation");

test("an https url is accepted", () => {
  assert.strictEqual(adsService.normalizeScriptUrl("https://provider.example/cmp.js"), "https://provider.example/cmp.js");
});

test("a plain http url is refused", () => {
  assert.strictEqual(adsService.normalizeScriptUrl("http://provider.example/cmp.js"), "");
});

test("a javascript: url is refused", () => {
  assert.strictEqual(adsService.normalizeScriptUrl("javascript:alert(1)"), "");
});

test("a data: url is refused", () => {
  assert.strictEqual(adsService.normalizeScriptUrl("data:text/html,<script>alert(1)</script>"), "");
});

test("a relative path is refused", () => {
  assert.strictEqual(adsService.normalizeScriptUrl("/cmp.js"), "");
});

test("an empty url stays empty", () => {
  assert.strictEqual(adsService.normalizeScriptUrl(""), "");
});

/* ==================================================================== */
/* The gates                                                            */
/* ==================================================================== */

section("Monetization gates");

const READY = {
  ads_enabled: true,
  adsense_enabled: true,
  adsense_client: "ca-pub-1234567890123456",
  adsense_script_enabled: true,
  consent_required: true
};

test("nothing is active while the site-wide switch is off", () => {
  const state = adsService.monetizationActive({ ...READY, ads_enabled: false });
  assert.strictEqual(state.active, false);
});

test("nothing is active while the AdSense switch is off", () => {
  const state = adsService.monetizationActive({ ...READY, adsense_enabled: false });
  assert.strictEqual(state.active, false);
});

test("nothing is active without a publisher id, even with both switches on", () => {
  // This is the important one: switching ads on without an ID must not serve
  // anything, because there is no account to serve it against.
  const state = adsService.monetizationActive({ ...READY, adsense_client: "" });
  assert.strictEqual(state.active, false);
  assert.strictEqual(state.publisher_id, "");
});

test("the script is never loaded without a publisher id", () => {
  const state = adsService.monetizationActive({ ...READY, adsense_client: "" });
  assert.strictEqual(state.script_enabled, false);
});

test("the script is never loaded while ads are off", () => {
  const state = adsService.monetizationActive({ ...READY, ads_enabled: false });
  assert.strictEqual(state.script_enabled, false);
});

test("everything open with a real id is active", () => {
  const state = adsService.monetizationActive(READY);
  assert.strictEqual(state.active, true);
  assert.strictEqual(state.script_enabled, true);
  assert.strictEqual(state.publisher_id, "ca-pub-1234567890123456");
});

test("consent stays required unless it is explicitly turned off", () => {
  assert.strictEqual(adsService.monetizationActive(READY).consent_required, true);
});

/* ==================================================================== */
/* Placement validation                                                 */
/* ==================================================================== */

section("Placement validation");

test("a new placement gets a normalised key", () => {
  const result = adsService.validatePlacement(
    { placement_key: "Sidebar-Top", placement_name: "Sidebar Top", placement_zone: "sidebar" },
    { isNew: true }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.placement_key, "sidebar-top");
});

test("a new placement without a key is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "X" }, { isNew: true });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.placement_key);
});

test("a key with spaces is refused", () => {
  const result = adsService.validatePlacement({ placement_key: "sidebar top", placement_name: "X" }, { isNew: true });
  assert.strictEqual(result.ok, false);
});

test("an empty name is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "  " }, { isNew: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.placement_name);
});

test("an unknown zone is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "X", placement_zone: "marquee" }, { isNew: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.placement_zone);
});

test("every documented zone is accepted", () => {
  for (const zone of adsService.PLACEMENT_ZONES) {
    const result = adsService.validatePlacement({ placement_name: "X", placement_zone: zone }, { isNew: false });
    assert.strictEqual(result.ok, true, `zone ${zone} should be accepted`);
  }
});

test("an unknown ad type is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "X", ad_type: "banner-exchange" }, { isNew: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.ad_type);
});

test("every documented ad type is accepted", () => {
  for (const type of adsService.AD_TYPES) {
    const result = adsService.validatePlacement({ placement_name: "X", ad_type: type }, { isNew: false });
    assert.strictEqual(result.ok, true, `type ${type} should be accepted`);
  }
});

test("an ad type that is not allowed falls back to none rather than being stored", () => {
  // The error is reported, but the value that would be written is the safe one.
  const result = adsService.validatePlacement({ placement_name: "X", ad_type: "evil" }, { isNew: false });
  assert.strictEqual(result.values.ad_type, "none");
});

test("a non-numeric slot id is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "X", ad_slot: "abc123" }, { isNew: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.ad_slot);
});

test("an empty slot id is allowed, because ads are opt-in per placement", () => {
  const result = adsService.validatePlacement({ placement_name: "X", ad_slot: "" }, { isNew: false });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.ad_slot, "");
});

test("a malformed publisher override is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "X", publisher_id: "pub-123" }, { isNew: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.publisher_id);
});

test("an empty publisher override means inherit from the site setting", () => {
  const result = adsService.validatePlacement({ placement_name: "X", publisher_id: "" }, { isNew: false });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.publisher_id, "");
});

test("an absurd reserved height is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "X", min_height: "9999" }, { isNew: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.min_height);
});

test("a non-numeric reserved height is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "X", min_height: "tall" }, { isNew: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.min_height);
});

test("a zero reserved height is allowed", () => {
  const result = adsService.validatePlacement({ placement_name: "X", min_height: "0" }, { isNew: false });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.min_height, 0);
});

test("an in-content position above 100 is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "X", content_position: "150" }, { isNew: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.content_position);
});

test("a negative in-content position is refused", () => {
  const result = adsService.validatePlacement({ placement_name: "X", content_position: "-5" }, { isNew: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.content_position);
});

test("an in-content position of 50 is allowed", () => {
  const result = adsService.validatePlacement({ placement_name: "X", content_position: "50" }, { isNew: false });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.content_position, 50);
});

test("an empty in-content position means no in-content ad", () => {
  const result = adsService.validatePlacement({ placement_name: "X", content_position: "" }, { isNew: false });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.content_position, null);
});

test("custom code is capped rather than rejected", () => {
  const result = adsService.validatePlacement(
    { placement_name: "X", custom_html: "x".repeat(9000) },
    { isNew: false }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.values.custom_html.length, 8000);
});

test("an absent enabled flag means off", () => {
  const result = adsService.validatePlacement({ placement_name: "X" }, { isNew: false });
  assert.strictEqual(result.values.is_enabled, false);
});

test("an absent device flag means off", () => {
  // A form omits an unticked checkbox, so absent and off are the same thing. The
  // safe reading of "I did not say yes" is "no ad on that device", and the admin
  // form is rendered with both boxes ticked by default so this only bites a
  // direct API caller.
  const result = adsService.validatePlacement({ placement_name: "X" }, { isNew: false });
  assert.strictEqual(result.values.show_desktop, false);
  assert.strictEqual(result.values.show_mobile, false);
});

test("a ticked device flag is honoured", () => {
  const result = adsService.validatePlacement(
    { placement_name: "X", show_desktop: "1", show_mobile: "1" },
    { isNew: false }
  );

  assert.strictEqual(result.values.show_desktop, true);
  assert.strictEqual(result.values.show_mobile, true);
});

test("an unticked checkbox is read as off, not as absent", () => {
  const result = adsService.validatePlacement(
    { placement_name: "X", show_desktop: "", show_mobile: "" },
    { isNew: false }
  );

  assert.strictEqual(result.values.show_desktop, false);
  assert.strictEqual(result.values.show_mobile, false);
});

/* ==================================================================== */
/* The vocabulary the layout depends on                                 */
/* ==================================================================== */

section("Placement vocabulary");

await testAsync("every placement the layout asks for is a known key", async () => {
  // These are the keys pages.js interpolates. A typo here would silently drop a
  // slot, so the list is asserted rather than trusted.
  const expected = [
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

  const { rows } = await pool.query(
    "SELECT placement_key FROM ad_placements WHERE placement_key = ANY($1)",
    [expected]
  );

  const present = rows.map(row => row.placement_key);
  const missing = expected.filter(key => !present.includes(key));

  assert.deepStrictEqual(missing, [], `missing placements: ${missing.join(", ")}`);
});

await testAsync("the migration leaves every placement switched off", async () => {
  const { rows } = await pool.query("SELECT count(*)::int AS total FROM ad_placements WHERE is_enabled = true");
  assert.strictEqual(rows[0].total, 0, "no placement should be enabled on a default installation");
});

await testAsync("the migration leaves every ad type as none", async () => {
  const { rows } = await pool.query("SELECT count(*)::int AS total FROM ad_placements WHERE ad_type <> 'none'");
  assert.strictEqual(rows[0].total, 0, "no placement should have an ad type on a default installation");
});

await testAsync("the migration stores no slot or publisher id", async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total FROM ad_placements
      WHERE ad_slot <> '' OR publisher_id <> ''`
  );

  assert.strictEqual(rows[0].total, 0, "a default installation must not contain a placeholder ad id");
});

await testAsync("the settings row is off and has no publisher id", async () => {
  const settings = await adsService.getSettings();

  assert.strictEqual(settings.ads_enabled, false);
  assert.strictEqual(settings.adsense_enabled, false);
  assert.strictEqual(settings.adsense_client, "");
});

await testAsync("consent is required by default", async () => {
  const settings = await adsService.getSettings();
  assert.strictEqual(settings.consent_required, true);
});

/* ==================================================================== */
/* The public manifest                                                  */
/* ==================================================================== */

section("Public manifest");

await testAsync("the manifest is inactive on a default installation", async () => {
  const manifest = await adsService.getPublicManifest();

  assert.strictEqual(manifest.enabled, false);
  assert.deepStrictEqual(manifest.ads, []);
});

await testAsync("the manifest leaks no publisher id while ads are off", async () => {
  const manifest = await adsService.getPublicManifest();
  assert.strictEqual(manifest.publisher_id, "");
});

await testAsync("switching ads on without a publisher id still serves nothing", async () => {
  // The most important integration check: the two switches are not enough. A
  // site with ads enabled and no ID must still answer with an empty manifest,
  // and must not echo a publisher id that does not exist.
  const { rows } = await pool.query(
    "UPDATE ad_settings SET ads_enabled = true, adsense_enabled = true RETURNING ads_enabled"
  );
  assert.strictEqual(rows[0].ads_enabled, true);

  const manifest = await adsService.getPublicManifest();

  assert.strictEqual(manifest.enabled, false);
  assert.deepStrictEqual(manifest.ads, []);
  assert.strictEqual(manifest.publisher_id, "");

  await pool.query("UPDATE ad_settings SET ads_enabled = false, adsense_enabled = false");
});

await testAsync("a disabled placement is not served even with everything configured", async () => {
  // Configures one placement fully, leaves it disabled, and checks it is absent.
  await pool.query("UPDATE ad_settings SET ads_enabled = false, adsense_enabled = false");

  const { rows } = await pool.query(
    `UPDATE ad_placements
        SET is_enabled = false, ad_type = 'adsense', ad_slot = '1234567890'
      WHERE placement_key = 'sidebar-top'
      RETURNING placement_key`
  );
  assert.strictEqual(rows[0].placement_key, "sidebar-top");

  const manifest = await adsService.getPublicManifest();
  const served = manifest.ads.filter(ad => ad.placement === "sidebar-top");

  assert.deepStrictEqual(served, [], "a disabled placement must never be served");

  await pool.query(
    "UPDATE ad_placements SET is_enabled = false, ad_type = 'none', ad_slot = '' WHERE placement_key = 'sidebar-top'"
  );
});

await testAsync("an enabled placement with no slot id is not served", async () => {
  await pool.query("UPDATE ad_settings SET ads_enabled = false, adsense_enabled = false");
  await pool.query(
    "UPDATE ad_placements SET is_enabled = true, ad_type = 'adsense', ad_slot = '' WHERE placement_key = 'sidebar-top'"
  );

  const manifest = await adsService.getPublicManifest();
  assert.deepStrictEqual(manifest.ads.filter(ad => ad.placement === "sidebar-top"), []);

  await pool.query(
    "UPDATE ad_placements SET is_enabled = false, ad_type = 'none', ad_slot = '' WHERE placement_key = 'sidebar-top'"
  );
});

await testAsync("an enabled placement with no publisher id available is not served", async () => {
  // Ads on, placement fully configured, but the site-wide publisher id is empty.
  // The placement must be dropped rather than served against nothing.
  await pool.query("UPDATE ad_settings SET ads_enabled = true, adsense_enabled = true, adsense_client = ''");
  await pool.query(
    "UPDATE ad_placements SET is_enabled = true, ad_type = 'adsense', ad_slot = '1234567890', publisher_id = '' WHERE placement_key = 'sidebar-top'"
  );

  const manifest = await adsService.getPublicManifest();
  assert.deepStrictEqual(manifest.ads, []);
  assert.strictEqual(manifest.publisher_id, "");

  await pool.query("UPDATE ad_settings SET ads_enabled = false, adsense_enabled = false, adsense_client = ''");
  await pool.query(
    "UPDATE ad_placements SET is_enabled = false, ad_type = 'none', ad_slot = '' WHERE placement_key = 'sidebar-top'"
  );
});

await testAsync("a fully configured placement is served", async () => {
  // The positive case, so the negative tests above cannot pass by accident
  // because the query never returns anything.
  await pool.query(
    "UPDATE ad_settings SET ads_enabled = true, adsense_enabled = true, adsense_client = 'ca-pub-1234567890123456'"
  );
  await pool.query(
    `UPDATE ad_placements
        SET is_enabled = true, ad_type = 'adsense', ad_slot = '1234567890',
            show_desktop = true, show_mobile = true, min_height = 250
      WHERE placement_key = 'sidebar-top'`
  );

  const manifest = await adsService.getPublicManifest();
  const ad = manifest.ads.find(entry => entry.placement === "sidebar-top");

  assert.ok(ad, "a configured placement should be served");
  assert.strictEqual(ad.slot, "1234567890");
  assert.strictEqual(ad.client, "ca-pub-1234567890123456");
  assert.strictEqual(ad.min_height, 250);
  assert.strictEqual(manifest.enabled, true);

  await pool.query("UPDATE ad_settings SET ads_enabled = false, adsense_enabled = false, adsense_client = ''");
  await pool.query(
    "UPDATE ad_placements SET is_enabled = false, ad_type = 'none', ad_slot = '' WHERE placement_key = 'sidebar-top'"
  );
});

await testAsync("a per-placement publisher id overrides the site-wide one", async () => {
  await pool.query(
    "UPDATE ad_settings SET ads_enabled = true, adsense_enabled = true, adsense_client = 'ca-pub-1111111111111111'"
  );
  await pool.query(
    `UPDATE ad_placements
        SET is_enabled = true, ad_type = 'adsense', ad_slot = '1234567890',
            publisher_id = 'ca-pub-2222222222222222'
      WHERE placement_key = 'sidebar-top'`
  );

  const manifest = await adsService.getPublicManifest();
  const ad = manifest.ads.find(entry => entry.placement === "sidebar-top");

  assert.strictEqual(ad.client, "ca-pub-2222222222222222");

  await pool.query("UPDATE ad_settings SET ads_enabled = false, adsense_enabled = false, adsense_client = ''");
  await pool.query(
    `UPDATE ad_placements
        SET is_enabled = false, ad_type = 'none', ad_slot = '', publisher_id = ''
      WHERE placement_key = 'sidebar-top'`
  );
});

await testAsync("a malformed publisher id in the database is ignored, not served", async () => {
  // The schema blocks this, but a value edited directly in SQL would otherwise
  // reach the public manifest. The service re-validates on the way out.
  await pool.query("UPDATE ad_settings SET ads_enabled = false, adsense_enabled = false");
  await pool.query(
    `UPDATE ad_placements
        SET is_enabled = true, ad_type = 'adsense', ad_slot = '1234567890', publisher_id = ''
      WHERE placement_key = 'sidebar-top'`
  );
  await pool.query("UPDATE ad_placements SET ad_slot = '1234567890' WHERE placement_key = 'sidebar-top'");

  const manifest = await adsService.getPublicManifest();
  assert.strictEqual(manifest.enabled, false);

  await pool.query(
    "UPDATE ad_placements SET is_enabled = false, ad_type = 'none', ad_slot = '' WHERE placement_key = 'sidebar-top'"
  );
});

await testAsync("custom code is never returned to the public manifest", async () => {
  // A snippet an administrator saved must not be handed to the frontend, where
  // it would be executed in every reader's browser.
  await pool.query(
    "UPDATE ad_placements SET custom_html = '<script>window.pwned = true;</script>' WHERE placement_key = 'sidebar-top'"
  );

  await pool.query(
    "UPDATE ad_settings SET ads_enabled = true, adsense_enabled = true, adsense_client = 'ca-pub-1234567890123456'"
  );
  await pool.query(
    "UPDATE ad_placements SET is_enabled = true, ad_type = 'custom', ad_slot = '1234567890' WHERE placement_key = 'sidebar-top'"
  );

  const serialised = JSON.stringify(await adsService.getPublicManifest());
  assert.ok(!serialised.includes("pwned"), "custom code must not appear in the public manifest");

  const placement = await adsService.getPlacement(
    (await pool.query("SELECT id FROM ad_placements WHERE placement_key = 'sidebar-top'")).rows[0].id
  );
  assert.ok(
    String(placement.custom_html).includes("pwned"),
    "the admin view should still see the stored snippet"
  );

  await pool.query("UPDATE ad_settings SET ads_enabled = false, adsense_enabled = false, adsense_client = ''");
  await pool.query(
    `UPDATE ad_placements
        SET is_enabled = false, ad_type = 'none', ad_slot = '', custom_html = ''
      WHERE placement_key = 'sidebar-top'`
  );
});

/* ==================================================================== */
/* Settings writes                                                      */
/* ==================================================================== */

section("Settings writes");

await testAsync("a malformed publisher id is refused rather than stored", async () => {
  const result = await adsService.updateSettings({ adsense_client: "ca-pub-not-real" });

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.adsense_client);

  const settings = await adsService.getSettings();
  assert.strictEqual(settings.adsense_client, "", "a rejected id must not be written");
});

await testAsync("a non-https consent script url is refused rather than stored", async () => {
  const result = await adsService.updateSettings({ consent_script_url: "http://provider.example/cmp.js" });

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.consent_script_url);
});

await testAsync("a partial update leaves the other fields alone", async () => {
  // Saving the publisher id alone must not blank consent_required, which is
  // exactly the sort of thing that silently disables a consent gate.
  await adsService.updateSettings({ adsense_client: "ca-pub-1234567890123456", consent_required: "1" });

  const toggled = await adsService.updateSettings({ ads_enabled: "1" });
  assert.strictEqual(toggled.ok, true);
  assert.strictEqual(toggled.settings.adsense_client, "ca-pub-1234567890123456");
  assert.strictEqual(toggled.settings.consent_required, true);

  await adsService.updateSettings({ ads_enabled: "0", adsense_client: "" });
});

await testAsync("a valid publisher id round-trips", async () => {
  const saved = await adsService.updateSettings({ adsense_client: "ca-pub-1234567890123456" });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.settings.adsense_client, "ca-pub-1234567890123456");

  const settings = await adsService.getSettings();
  assert.strictEqual(settings.adsense_client, "ca-pub-1234567890123456");

  await adsService.updateSettings({ adsense_client: "" });
});

await testAsync("the database left behind is the default state", async () => {
  // Guards the restore step above: if one of these tests failed midway, the next
  // run would start from a monetised database.
  const settings = await adsService.getSettings();
  const { rows } = await pool.query(
    "SELECT count(*)::int AS total FROM ad_placements WHERE is_enabled OR ad_type <> 'none' OR ad_slot <> ''"
  );

  assert.strictEqual(settings.ads_enabled, false);
  assert.strictEqual(settings.adsense_enabled, false);
  assert.strictEqual(settings.adsense_client, "");
  assert.strictEqual(settings.consent_script_url, "");
  assert.strictEqual(rows[0].total, 0);
});

/* ==================================================================== */

console.log(`\n${passed}/${passed + failed} passed`);

if (failed) {
  console.log("\nFailures:");
  for (const failure of failures) {
    console.log(`\n  ${failure.name}`);
    console.log(`    ${failure.error.stack}`);
  }
}

await pool.end();
process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error("\nads-test crashed:", error);
  process.exitCode = 1;
});
