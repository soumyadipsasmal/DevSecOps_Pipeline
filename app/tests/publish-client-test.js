"use strict";

/**
 * KaliNova — publishing client test
 *
 * Offline unit checks for scripts/publish-article.js. Nothing here opens a
 * socket or a database: the client is loaded as a module and only its pure
 * helpers are exercised. The live create/update/verify path is applied by the
 * operator against a real backend.
 */

const path = require("path");

const client = require(path.join(__dirname, "..", "..", "scripts", "publish-article.js"));

let checks = 0;
let failures = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (condition) return true;
  failures += 1;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

function section(title) {
  console.log(`\n${title}`);
}

section("[1] Argument parsing");

{
  const args = client.parseArgs(["payload.json", "--base-url", "http://localhost:3007", "--update", "--pretty"]);
  check("positional file is captured", args.file === "payload.json", JSON.stringify(args));
  check("--base-url captured", args.baseUrl === "http://localhost:3007");
  check("--update captured", args.update === true);
  check("--pretty captured", args.pretty === true);
}

{
  const args = client.parseArgs(["-f", "a.json", "--dry-run", "--ack-similarity"]);
  check("-f alias works", args.file === "a.json");
  check("--dry-run captured", args.dryRun === true);
  check("--ack-similarity captured", args.ackSimilarity === true);
}

{
  let threw = false;
  try {
    client.parseArgs(["--nope"]);
  } catch (error) {
    threw = /Unknown option/.test(error.message);
  }
  check("an unknown option throws", threw);
}

section("[2] Env-file parsing");

{
  const env = client.parseEnvFile(
    ["# comment", "", "export BASE_URL=http://localhost:3007", 'ADMIN_EMAIL="admin@example.com"', "ADMIN_PASSWORD='x=y'", "bad line"].join("\n")
  );
  check("comments and blanks are skipped", env.BASE_URL === "http://localhost:3007", JSON.stringify(env));
  check("double quotes stripped", env.ADMIN_EMAIL === "admin@example.com");
  check("single quotes stripped and inner equals kept", env.ADMIN_PASSWORD === "x=y");
}

section("[3] Payload loading");

{
  const payload = client.loadPayload('{"title":"Hello"}');
  check("valid JSON object loads", payload.title === "Hello");
}

{
  let threw = false;
  try {
    client.loadPayload("{not json}");
  } catch (error) {
    threw = /not valid JSON/.test(error.message);
  }
  check("invalid JSON is rejected", threw);
}

{
  let threw = false;
  try {
    client.loadPayload("[1,2,3]");
  } catch (error) {
    threw = /must be a JSON object/.test(error.message);
  }
  check("a JSON array is rejected", threw);
}

section("[4] Local validation reuses the real article rules");

{
  const published = client.localValidate({
    title: "A complete enough title",
    category_id: 1,
    meta_description: "A meta description that is comfortably long enough to satisfy the published rule.",
    content: "This body is definitely longer than forty characters so that it can be published.",
    status: "published"
  });
  check("a valid published payload passes", published.ok === true, JSON.stringify(published.errors));
}

{
  const missing = client.localValidate({
    title: "A title",
    category_id: 1,
    content: "short",
    status: "published"
  });
  check("published without meta description fails", missing.ok === false);
  check("meta_description is reported", Boolean(missing.errors.meta_description));
  check("short body is reported", Boolean(missing.errors.content));
}

{
  const draft = client.localValidate({ title: "Draft title", category_id: 2, status: "draft" });
  check("a draft without body or meta passes", draft.ok === true, JSON.stringify(draft.errors));
}

{
  const noCategory = client.localValidate({ title: "T", status: "draft" });
  check("a missing category is reported", noCategory.ok === false && Boolean(noCategory.errors.category_id));
}

section("[5] Tags");

{
  const tags = client.normalizeTags({ tags: [" AI ", "ai", "Tech", ""] });
  check("tags are trimmed and de-duplicated case-insensitively", JSON.stringify(tags) === JSON.stringify(["AI", "Tech"]), JSON.stringify(tags));
}

{
  const tags = client.normalizeTags({ tags: "one, two ,three" });
  check("a comma-separated string is split", JSON.stringify(tags) === JSON.stringify(["one", "two", "three"]));
}

{
  const tags = client.normalizeTags({});
  check("absent tags become an empty array", Array.isArray(tags) && tags.length === 0);
}

section("[6] Sources and research");

{
  const body = client.buildRequestBody(
    {
      title: "T",
      sources: [
        { name: "Reuters", url: "https://reuters.example/a", license: "CC-BY" },
        { name: "AP", url: "https://ap.example/b" },
        { name: "", url: "" }
      ]
    },
    7
  );
  check("source_count counts non-empty rows", body.source_count === 2, JSON.stringify(body));
  check("first source is numbered 0", body.source_name_0 === "Reuters" && body.source_url_0 === "https://reuters.example/a");
  check("license is only set when present", body.source_license_0 === "CC-BY" && body.source_license_1 === undefined);
  check("second source is numbered 1", body.source_name_1 === "AP");
}

{
  const research = client.normalizeResearch([
    { source_key: "wikidata", name: "Q42", url: "https://www.wikidata.org/wiki/Q42", text: "Douglas Adams" },
    { source_key: "", name: "ignored" },
    { name: "also ignored" }
  ]);
  check("research rows need a known-ish key and a name", research.length === 1 && research[0].source_key === "wikidata");

  const body = client.buildRequestBody({ title: "T", research_refs: research }, 1);
  check("research_refs is serialised as a JSON string", typeof body.research_refs === "string");
  check("serialised research round-trips", JSON.parse(body.research_refs)[0].name === "Q42");
}

section("[7] Request body assembly");

{
  const body = client.buildRequestBody(
    { title: "T", slug: "s", status: "published", category_id: 4, tags: ["x"] },
    9,
    { acknowledgeSimilarity: true }
  );
  check("resolved category id wins over the payload", body.category_id === 9);
  check("text fields are copied", body.title === "T" && body.slug === "s" && body.status === "published");
  check("tags are included", Array.isArray(body.tags) && body.tags[0] === "x");
  check("acknowledge_similarity flag is sent as 1", body.acknowledge_similarity === "1");
}

section("[8] Category resolution");

{
  const categories = [
    { id: 1, name: "Technology", slug: "technology" },
    { id: 2, name: "Travel", slug: "travel" }
  ];
  check("resolves by name", client.resolveCategory(categories, { category: "travel" }).id === 2);
  check("resolves by slug", client.resolveCategory(categories, { category: "Technology" }).id === 1);
  check("resolves by category_id", client.resolveCategory(categories, { category_id: 2 }).name === "Travel");
  check("unknown name resolves to null", client.resolveCategory(categories, { category: "Nope" }) === null);
  check("unknown id resolves to null", client.resolveCategory(categories, { category_id: 99 }) === null);
  check("no category at all resolves to null", client.resolveCategory(categories, {}) === null);
}

section("[9] Slug de-duplication");

{
  const articles = [
    { id: 10, slug: "hello-world" },
    { id: 11, slug: "hello-world-2" }
  ];
  check("an exact slug match is found", client.findExactSlug(articles, "hello-world").id === 10);
  check("a near-match is not treated as a duplicate", client.findExactSlug(articles, "hello-world-2").id === 11);
  check("a missing slug returns null", client.findExactSlug(articles, "absent") === null);
}

section("[10] Cookie jar");

{
  const jar = client.createCookieJar();
  const fakeResponse = {
    headers: {
      getSetCookie() {
        return [
          "kalinova_admin_csrf=token123; Path=/; HttpOnly; SameSite=Strict",
          "kalinova_admin_session=abc; Path=/; HttpOnly; SameSite=Lax"
        ];
      }
    }
  };
  jar.store(jar.setCookieHeaders(fakeResponse));
  const header = jar.header();
  check("cookies are stored in the jar header", header.includes("kalinova_admin_csrf=token123") && header.includes("kalinova_admin_session=abc"), header);

  const expired = {
    headers: {
      getSetCookie() {
        return ["kalinova_admin_session=; Path=/; Max-Age=0"];
      }
    }
  };
  jar.store(jar.setCookieHeaders(expired));
  check("an expiring cookie is removed from the jar", !jar.header().includes("kalinova_admin_session"), jar.header());
}

section("[11] Secret redaction");

{
  check("a long token is redacted", client.redact("abcdefghijklmnop").endsWith("[redacted]"));
  check("a short value is fully redacted", client.redact("abc") === "[redacted]");
}

section(`\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
