"use strict";

/**
 * KaliNova — admin end-to-end verification
 *
 * Drives a running server over HTTP exactly as a browser would, so it proves
 * the wiring (routes, cookies, redirects, guards, database) rather than the
 * individual helpers covered by admin-auth-test.js.
 *
 * Requirements:
 *   - the application is running and reachable
 *   - PostgreSQL has been migrated and an administrator exists
 *
 * Usage (from the app/ directory):
 *   BASE_URL=http://localhost:3007 \
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='your-password' \
 *   npm run test:admin:live
 *
 * Without ADMIN_EMAIL and ADMIN_PASSWORD the script exits 0 with a SKIP notice,
 * so `npm test` still works on a machine with no admin account.
 */

const { assertSafeLiveTarget } = require("./test-live-guard");

require("dotenv").config();

const BASE_URL = (process.env.BASE_URL || "http://localhost:3007").replace(/\/+$/, "");
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "");
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");

let checks = 0;
let failures = 0;
const cookies = new Map();

function check(label, condition, extra) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${extra !== undefined ? " -> " + extra : ""}`);
    failures += 1;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function storeCookies(response) {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);

  for (const entry of raw) {
    const [pair, ...attributes] = entry.split(";");
    const separator = pair.indexOf("=");
    if (separator < 1) continue;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();

    const expired = attributes.some(attribute =>
      /max-age\s*=\s*0/i.test(attribute.trim()) ||
      /expires\s*=\s*thu, 01 jan 1970/i.test(attribute.trim())
    );

    if (value === "" || expired) cookies.delete(name);
    else cookies.set(name, value);
  }
}

function cookieHeader() {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function setCookieHeaders(response) {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  return raw.join("\n");
}

/** Minimal cookie jar: the server sets cookies, the jar replays them. */
async function request(path, options = {}) {
  const headers = { Accept: "text/html", ...(options.headers || {}) };

  const jar = cookieHeader();
  if (jar && !headers.Cookie && !headers.cookie) headers.Cookie = jar;

  const response = await fetch(`${BASE_URL}${path}`, { ...options, headers, redirect: "manual" });
  storeCookies(response);

  const text = await response.text();

  return {
    status: response.status,
    location: response.headers.get("location"),
    setCookie: setCookieHeaders(response),
    contentType: response.headers.get("content-type") || "",
    cacheControl: response.headers.get("cache-control"),
    csp: response.headers.get("content-security-policy"),
    robots: response.headers.get("x-robots-tag") || "",
    body: text,
    json() {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
  };
}

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

/** The login form ships the token in a hidden field. */
function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : "";
}

/** The JSON API publishes the token in the response body of /api/admin/csrf. */
async function fetchCsrfToken() {
  const response = await request("/api/admin/csrf", { headers: { Accept: "application/json" } });
  const token = response.json() && response.json().token;
  return typeof token === "string" ? token : "";
}

async function postForm(path, fields) {
  return request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html"
    },
    body: formBody(fields)
  });
}

async function sendJson(method, path, fields, { withCsrf = true } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };

  if (withCsrf) {
    const token = await fetchCsrfToken();
    if (token) headers["X-CSRF-Token"] = token;
  }

  return request(path, { method, headers, body: JSON.stringify(fields) });
}

async function postJson(path, fields, options) {
  return sendJson("POST", path, fields, options);
}

async function patchJson(path, fields, options) {
  return sendJson("PATCH", path, fields, options);
}

/* ==================================================================== */
/* 0. Preconditions                                                     */
/* ==================================================================== */

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log(
      "SKIP  admin-smoke-test.js needs ADMIN_EMAIL and ADMIN_PASSWORD.\n" +
        "      Start the server, create an administrator with `npm run create-admin`, then run:\n" +
        "      BASE_URL=http://localhost:3007 ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run test:admin:live"
    );
    return;
  }

  const reachable = await request("/health").catch(() => null);
  if (!reachable || reachable.status >= 500) {
    console.log(`SKIP  ${BASE_URL} is not serving a healthy application (is it running? is PostgreSQL up?)`);
    return;
  }

  // Only now, with a live target confirmed, is the target verified as a
  // test-only environment (loopback, explicit operator confirmation, and a
  // validated TEST_DATABASE_URL). Refusals happen before any write.
  assertSafeLiveTarget();

  /* ==================================================================== */
  /* 1. Anonymous access                                                  */
  /* ==================================================================== */

  section("[1] Public site before any admin traffic");

  {
    const home = await request("/");
    check("GET / serves the public homepage", home.status === 200 && home.body.includes("KaliNova"), home.status);

    const shell = await request("/blog");
    check("GET /blog still serves the SPA shell", shell.status === 200 && shell.body.includes("<div id=\"app\">"), shell.status);

    const articles = await request("/api/articles", { headers: { Accept: "application/json" } });
    const articlesJson = articles.json();
    check("GET /api/articles still returns articles", articles.status === 200 && Array.isArray(articlesJson.articles), articles.status);

    const categories = await request("/api/categories", { headers: { Accept: "application/json" } });
    const categoriesJson = categories.json();
    check("GET /api/categories still returns categories", categories.status === 200 && Array.isArray(categoriesJson.categories), categories.status);

    if (Array.isArray(articlesJson.articles) && articlesJson.articles.length) {
      const slug = articlesJson.articles[0].slug;
      const bySlug = await request(`/api/articles/slug/${encodeURIComponent(slug)}`, { headers: { Accept: "application/json" } });
      check("GET /api/articles/slug/:slug still works", bySlug.status === 200 && bySlug.json().slug === slug, bySlug.status);
    }

    const stylesheet = await request("/assets/admin/admin.css");
    check("admin stylesheet is served as a static asset", stylesheet.status === 200, stylesheet.status);
  }

  section("[2] Admin pages reject anonymous visitors");

  {
    const login = await request("/admin/login");
    check("GET /admin/login returns the form", login.status === 200 && login.body.includes('action="/admin/login"'), login.status);
    check("login page is not indexable", login.body.includes('content="noindex, nofollow, noarchive"'));
    check("login page sets a CSRF cookie", /kalinova_admin_csrf/i.test(login.setCookie), login.setCookie);
    check("login page is not cached", String(login.cacheControl).includes("no-store"), login.cacheControl);
    // The login page shows the CMS links, so the only thing that matters is that
    // following one does not disclose anything — each redirects to the form.
    check("the login page offers no logout form to an anonymous visitor", !login.body.includes('action="/admin/logout"'));

    const dashboard = await request("/admin/dashboard");
    check("GET /admin/dashboard redirects when anonymous", dashboard.status === 302, dashboard.status);
    check("redirect points at the login form", String(dashboard.location).startsWith("/admin/login"), dashboard.location);

    const root = await request("/admin");
    check("GET /admin redirects", root.status === 302 && root.location === "/admin/dashboard", `${root.status} ${root.location}`);

    const me = await request("/api/admin/me", { headers: { Accept: "application/json" } });
    check("GET /api/admin/me answers 401", me.status === 401, me.status);

    const stats = await request("/api/admin/dashboard", { headers: { Accept: "application/json" } });
    check("GET /api/admin/dashboard answers 401", stats.status === 401, stats.status);

    const create = await request("/api/articles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ title: "Unauthorised post", content: "should never be stored" })
    });
    check("POST /api/articles is closed to the public (401)", create.status === 401, create.status);

    const missing = await request("/admin/no-such-page");
    check("unknown /admin page answers 404", missing.status === 404, missing.status);

    // Every CMS page and endpoint has to be closed before sign-in too.
    for (const page of ["/admin/articles", "/admin/articles/new", "/admin/articles/1/edit", "/admin/articles/1/preview", "/admin/articles/1/delete"]) {
      const guarded = await request(page);
      check(`GET ${page} redirects an anonymous visitor`, guarded.status === 302, `${guarded.status} ${guarded.location}`);
    }

    for (const endpoint of ["/api/admin/articles", "/api/admin/articles/1", "/api/admin/categories", "/api/admin/uploads"]) {
      const guarded = await request(endpoint, { headers: { Accept: "application/json" } });
      check(`GET ${endpoint} answers 401 without a session`, guarded.status === 401, guarded.status);
    }

    const uploadAttempt = await request("/api/admin/uploads", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47])
    });
    check("POST /api/admin/uploads is closed without a session", uploadAttempt.status === 401, uploadAttempt.status);
  }

  section("[3] Failed sign-in");

  {
    const csrf = csrfFrom((await request("/admin/login")).body);

    const unknown = await postForm("/admin/login", {
      _csrf: csrf,
      email: "nobody-here@example.com",
      password: "whatever-password"
    });
    check("unknown email is rejected with 401", unknown.status === 401, unknown.status);
    check("unknown email shows the generic message", unknown.body.includes("Invalid email or password."));
    check("unknown email sets no session cookie", !/kalinova_admin_session=[^;]/.test(unknown.setCookie), unknown.setCookie);

    const wrongPassword = await postForm("/admin/login", {
      _csrf: csrf,
      email: ADMIN_EMAIL,
      password: `definitely-not-${ADMIN_PASSWORD}`
    });
    check("wrong password is rejected with 401", wrongPassword.status === 401, wrongPassword.status);
    check("wrong password shows the same generic message", wrongPassword.body.includes("Invalid email or password."));
    check("failure does not reveal whether the address exists", unknown.body.includes("Invalid email or password.") && wrongPassword.body.includes("Invalid email or password."));

    const malformed = await postForm("/admin/login", {
      _csrf: csrf,
      email: "not-an-email",
      password: "some-password"
    });
    check("malformed email is rejected with 400", malformed.status === 400, malformed.status);

    const noCsrf = await postForm("/admin/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD
    });
    check("sign-in without a CSRF token is rejected with 403", noCsrf.status === 403, noCsrf.status);
    check("rejected sign-in issues no session cookie", !/kalinova_admin_session=[^;]/.test(noCsrf.setCookie));
  }

  section("[4] Successful sign-in");

  let sessionCookie = null;

  {
    const csrf = csrfFrom((await request("/admin/login")).body);

    const login = await postForm("/admin/login", {
      _csrf: csrf,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD
    });

    check("valid credentials redirect with 303", login.status === 303, login.status);
    check("redirect target is the dashboard", login.location === "/admin/dashboard", login.location);
    check("session cookie issued", /kalinova_admin_session=/.test(login.setCookie), login.setCookie);
    check("session cookie is HttpOnly", /HttpOnly/i.test(login.setCookie));
    check("session cookie is SameSite protected", /SameSite=(Lax|Strict)/i.test(login.setCookie), login.setCookie);

    const match = login.setCookie.match(/kalinova_admin_session=([^;]+)/);
    sessionCookie = match ? match[1] : null;
  }

  section("[5] Authenticated dashboard");

  {
    const dashboard = await request("/admin/dashboard");
    check("GET /admin/dashboard is served", dashboard.status === 200, dashboard.status);
    check("header reads Kalinova Admin", dashboard.body.includes("Kalinova Admin"));
    check("navigation lists the CMS sections", ["Dashboard", "Articles", "New Article", "Categories", "Logout"].every(label => dashboard.body.includes(label)));
    check("stat cards rendered", dashboard.body.includes("Total articles") && dashboard.body.includes("Published") && dashboard.body.includes("Drafts") && dashboard.body.includes("Categories"));
    check("recent articles table rendered", dashboard.body.includes("Recent articles") && dashboard.body.includes("<table"));
    // The template escapes interpolated values, so compare against the escaped form too.
    const escapedEmail = ADMIN_EMAIL.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    check("signed-in address shown", dashboard.body.includes(escapedEmail), escapedEmail);
    check("dashboard is not indexable", dashboard.body.includes('content="noindex, nofollow, noarchive"'));
    check("dashboard is not cached", String(dashboard.cacheControl).includes("no-store"));
    check("admin Content-Security-Policy applied", String(dashboard.csp || "").includes("default-src 'self'"), dashboard.csp);

    const loginAgain = await request("/admin/login");
    check("signed-in administrator skips the login form", loginAgain.status === 303 && loginAgain.location === "/admin/dashboard", `${loginAgain.status} ${loginAgain.location}`);

    const me = await request("/api/admin/me", { headers: { Accept: "application/json" } });
    const meJson = me.json();
    check("GET /api/admin/me returns the account", me.status === 200 && meJson.email === ADMIN_EMAIL.toLowerCase(), me.status);
    check("me response has no password_hash", !("password_hash" in (meJson || {})) && !me.body.includes("password_hash"));
    check("me response exposes the role", meJson && meJson.role === "admin", JSON.stringify(meJson));

    const stats = await request("/api/admin/dashboard", { headers: { Accept: "application/json" } });
    const statsJson = stats.json();
    check("GET /api/admin/dashboard returns counts", stats.status === 200 && statsJson.stats && typeof statsJson.stats.totalArticles === "number", stats.status);
    check("dashboard API separates published from drafts", statsJson.stats.publishedArticles + statsJson.stats.draftArticles === statsJson.stats.totalArticles, JSON.stringify(statsJson.stats));
    check("dashboard API returns recent articles", Array.isArray(statsJson.recentArticles));

    const create = await request("/api/articles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ title: "", content: "" })
    });
    check("authenticated article creation reaches validation (400, not 401)", create.status === 400, create.status);
  }

  section("[6] Article CMS");

  /* A published article is created, checked on the public site, then deleted. */
  {
    const stamp = Date.now().toString(36);
    const title = `Smoke test article ${stamp}`;
    const body = `A CMS smoke test body written at ${stamp}. ` + "It is long enough to satisfy the published rules and verifies the whole publishing path end to end. ".repeat(3);
    let createdId = null;

    // The CMS requires a category, so the test needs a real one rather than a
    // hard-coded id that would only be valid on a freshly seeded database.
    const categoryList = await request("/api/admin/categories", { headers: { Accept: "application/json" } });
    const availableCategories = categoryList.json() && categoryList.json().categories;
    check("the category picker returns categories", Array.isArray(availableCategories) && availableCategories.length > 0, categoryList.status);

    const categoryId = Array.isArray(availableCategories) && availableCategories.length
      ? availableCategories[0].id
      : null;

    if (categoryId === null) {
      skip("the article CMS round trip", "the database has no categories to attach an article to");
    } else {
    const noCsrf = await postJson("/api/admin/articles", { title, content: body, category_id: categoryId, status: "published" }, { withCsrf: false });
    check("article creation without a CSRF token is rejected (403)", noCsrf.status === 403, noCsrf.status);

    const tooShort = await postJson("/api/admin/articles", { title: "Tiny", content: "no", category_id: categoryId, status: "published" });
    check("publishing a too-short body is refused (422)", tooShort.status === 422, tooShort.status);
    check("the refusal names the body field", tooShort.json() && tooShort.json().errors && "content" in tooShort.json().errors, tooShort.body);

    const badStatus = await postJson("/api/admin/articles", { title, content: body, category_id: categoryId, status: "deleted" });
    check("an unknown status is refused (422)", badStatus.status === 422, badStatus.status);

    const created = await postJson("/api/admin/articles", {
      title,
      content: body,
      category_id: categoryId,
      status: "published",
      meta_description: `Smoke test summary ${stamp}`
    });
    const createdJson = created.json();
    createdId = createdJson && createdJson.article ? createdJson.article.id : null;
    check("article creation succeeds (201)", created.status === 201 && createdId !== null, `${created.status} ${created.body.slice(0, 200)}`);
    check(
      "the stored body is sanitised HTML",
      createdJson && createdJson.article.body_format === "html" && !/<script/i.test(createdJson.article.content || ""),
      createdJson && createdJson.article.body_format
    );
    check("a slug was generated from the title", createdJson && typeof createdJson.article.slug === "string" && createdJson.article.slug.length > 0, createdJson && createdJson.article.slug);
    check("the public projection carries meta_description", createdJson && createdJson.article.meta_description === `Smoke test summary ${stamp}`, createdJson && createdJson.article.meta_description);

    const xss = await postJson("/api/admin/articles", {
      title: `Sanitiser ${stamp}`,
      content: `${body}<script>alert(1)</script><img src=x onerror=alert(2)>`,
      category_id: categoryId,
      status: "draft"
    });
    const xssJson = xss.json();
    const xssBody = xssJson && xssJson.article ? xssJson.article.content : "";
    check(
      "an unsafe draft body is sanitised on save",
      Boolean(xssBody) && !/<script/i.test(xssBody) && !/onerror/i.test(xssBody),
      xssBody.slice(-140) || (xssJson && JSON.stringify(xssJson.errors))
    );

    if (xssJson && xssJson.article && xssJson.article.id) {
      // This draft exists only to prove the sanitiser; it must never survive.
      await request(`/api/admin/articles/${xssJson.article.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": await fetchCsrfToken() }
      });
    }

    const publicBySlug = await request(`/api/articles/slug/${encodeURIComponent(createdJson.article.slug)}`, { headers: { Accept: "application/json" } });
    check("the published article is publicly readable", publicBySlug.status === 200 && publicBySlug.json().id === createdId, publicBySlug.status);

    const listPage = await request("/admin/articles");
    check("GET /admin/articles is served", listPage.status === 200, listPage.status);
    check("the list links to the new article", listPage.body.includes(`/admin/articles/${createdId}/edit`));
    check("the list ships the CMS stylesheet", listPage.body.includes("admin-cms.css"));

    const editPage = await request(`/admin/articles/${createdId}/edit`);
    check("GET /admin/articles/:id/edit is served", editPage.status === 200, editPage.status);
    check("the edit form is prefilled", editPage.body.includes(title));
    check("the edit form ships the editor script", editPage.body.includes("admin-article-form.js"));

    const previewPage = await request(`/admin/articles/${createdId}/preview`);
    check("GET /admin/articles/:id/preview is served", previewPage.status === 200, previewPage.status);
    check("the preview renders the body", previewPage.body.includes(stamp));

    const updated = await patchJson(`/api/admin/articles/${createdId}`, {
      title: `${title} edited`,
      content: body,
      category_id: categoryId,
      status: "published",
      meta_description: `Smoke test summary ${stamp}`
    });
    check("an update is stored", updated.status === 200 && updated.json().article.title === `${title} edited`, updated.status);

    const drafts = await request("/admin/articles?status=draft", { headers: { Accept: "application/json" } });
    check("the list filters by status", drafts.status === 200, drafts.status);

    const unpublished = await postJson(`/api/admin/articles/${createdId}/status`, { status: "draft" });
    check("unpublishing succeeds", unpublished.status === 200 && unpublished.json().article.status === "draft", unpublished.status);

    const hiddenWhileDraft = await request(`/api/articles/slug/${encodeURIComponent(createdJson.article.slug)}`, { headers: { Accept: "application/json" } });
    check("a draft disappears from the public API", hiddenWhileDraft.status === 404, hiddenWhileDraft.status);

    // A draft slug must answer 404 with the styled page rather than a 200 shell a
    // crawler could index, and the 404 must not mention the draft's title.
    const draftPage = await request(`/blog/${encodeURIComponent(createdJson.article.slug)}`);
    check("a draft slug answers 404, not a 200 shell", draftPage.status === 404, draftPage.status);
    check("the draft 404 is not indexable", String(draftPage.robots || "").includes("noindex"), draftPage.robots);
    check("the draft 404 does not leak the title", !draftPage.body.includes(title), "the title appears on the 404 page");
    check("the draft 404 is the styled page, not an error", draftPage.body.includes("<html") && !/cannot read properties|stack trace/i.test(draftPage.body));

    const draftInList = await request("/api/articles", { headers: { Accept: "application/json" } });
    const leaked = Array.isArray(draftInList.json().articles) && draftInList.json().articles.some(a => a.id === createdId);
    check("a draft is absent from the public list", !leaked);

    const categories = await request("/api/admin/categories", { headers: { Accept: "application/json" } });
    check("GET /api/admin/categories returns categories", categories.status === 200 && Array.isArray(categories.json().categories), categories.status);

    /* An upload has to be refused for the wrong bytes before a real one is sent. */
    const notAnImage = await request("/api/admin/uploads", {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-CSRF-Token": await fetchCsrfToken() },
      body: Buffer.from("this is definitely not a png")
    });
    check("a non-image upload is refused (400)", notAnImage.status === 400, notAnImage.status);

    /* A real 1x1 PNG, so the storage path is exercised and not just rejected. */
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const uploaded = await request("/api/admin/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        "X-CSRF-Token": await fetchCsrfToken(),
        "X-File-Name": "smoke.png",
        Accept: "application/json"
      },
      body: png
    });
    const uploadedJson = uploaded.json();
    check(
      "a real PNG is accepted and stored under a generated name",
      uploaded.status === 201 && uploadedJson && uploadedJson.upload && /^\/assets\/uploads\//.test(uploadedJson.upload.path),
      `${uploaded.status} ${uploaded.body.slice(0, 160)}`
    );
    check(
      "the stored name is not the one that was sent",
      uploadedJson && uploadedJson.upload && uploadedJson.upload.file_name !== "smoke.png",
      uploadedJson && uploadedJson.upload && uploadedJson.upload.file_name
    );

    if (uploadedJson && uploadedJson.upload && uploadedJson.upload.path) {
      const served = await request(uploadedJson.upload.path);
      check("the uploaded image is served back as a static asset", served.status === 200, served.status);

      // Attach it so the delete path can prove it cleans up an orphan.
      const withBanner = await patchJson(`/api/admin/articles/${createdId}`, {
        title: `${title} edited`,
        content: body,
        category_id: categoryId,
        status: "draft",
        cover_image: uploadedJson.upload.path,
        banner_alt: "A one pixel test image"
      });
      check("a banner path with alt text is accepted", withBanner.status === 200, `${withBanner.status} ${withBanner.body.slice(0, 160)}`);
    }

    const removed = await request(`/api/admin/articles/${createdId}`, { method: "DELETE", headers: { "X-CSRF-Token": await fetchCsrfToken(), Accept: "application/json" } });
    check("the article is deleted", removed.status === 200, removed.status);

    const gone = await request(`/api/articles/slug/${encodeURIComponent(createdJson.article.slug)}`, { headers: { Accept: "application/json" } });
    check("the deleted article is gone from the public API", gone.status === 404, gone.status);

    /* Leave no residue behind if anything above failed midway. */
    const leftover = await request(`/api/admin/articles/${createdId}`, { method: "DELETE", headers: { "X-CSRF-Token": await fetchCsrfToken() } });
    check("deleting an already-removed article is a clean 404", leftover.status === 404, leftover.status);
    }
  }

  section("[7] Admin JSON API sign-in");

  {
    const withoutCsrf = await postJson(
      "/api/admin/login",
      { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      { withCsrf: false }
    );
    check("POST /api/admin/login without a CSRF token is rejected", withoutCsrf.status === 403, withoutCsrf.status);

    const withCsrf = await postJson("/api/admin/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD
    });
    const body = withCsrf.json();
    check("POST /api/admin/login succeeds", withCsrf.status === 200 && body.admin && body.admin.email === ADMIN_EMAIL.toLowerCase(), withCsrf.status);
    check("API sign-in response hides password_hash", !withCsrf.body.includes("password_hash"));

    const wrong = await postJson("/api/admin/login", {
      email: ADMIN_EMAIL,
      password: "not-the-password"
    });
    check("API sign-in with a wrong password is 401", wrong.status === 401, wrong.status);
    check("API failure uses the generic message", wrong.json().error === "Invalid email or password.", JSON.stringify(wrong.json()));
  }

  /* ==================================================================== */
  /* 7. Logout                                                            */
  /* ==================================================================== */

  section("[7] Logout");

  {
    const noCsrf = await postForm("/admin/logout", {});
    check("logout without a CSRF token is rejected", noCsrf.status === 403, noCsrf.status);

    const csrf = csrfFrom((await request("/admin/dashboard")).body);
    const logout = await postForm("/admin/logout", { _csrf: csrf });

    check("POST /admin/logout redirects", logout.status === 303, logout.status);
    check("redirect target is the login form", String(logout.location).startsWith("/admin/login"), logout.location);
    check("session cookie cleared", /kalinova_admin_session=;/i.test(logout.setCookie), logout.setCookie);

    const afterLogout = await request("/admin/dashboard");
    check("dashboard is no longer reachable after logout", afterLogout.status === 302, afterLogout.status);

    if (sessionCookie) {
      const replay = await request("/admin/dashboard", {
        headers: { Cookie: `kalinova_admin_session=${sessionCookie}` }
      });
      check("a replayed session cookie is rejected server-side", replay.status === 302, replay.status);
    }

    const me = await request("/api/admin/me", { headers: { Accept: "application/json" } });
    check("GET /api/admin/me is 401 after logout", me.status === 401, me.status);

    // The notice only appears on the redirect target the logout handler sent us to.
    check("redirect target is the login form with a sign-out notice", logout.location === "/admin/login?logged_out=1", logout.location);

    const loginPage = await request(logout.location);
    check("login page confirms the sign-out", loginPage.body.includes("You have been signed out."), loginPage.status);
  }

  section("[8] Public site after admin traffic");

  {
    const home = await request("/");
    check("GET / still serves the public homepage", home.status === 200, home.status);

    const blog = await request("/blog");
    check("GET /blog still serves the SPA shell", blog.status === 200, blog.status);

    const articles = await request("/api/articles", { headers: { Accept: "application/json" } });
    check("GET /api/articles still works", articles.status === 200 && Array.isArray(articles.json().articles), articles.status);

    const categories = await request("/api/categories", { headers: { Accept: "application/json" } });
    check("GET /api/categories still works", categories.status === 200 && Array.isArray(categories.json().categories), categories.status);

    const unknownApi = await request("/api/does-not-exist", { headers: { Accept: "application/json" } });
    check("unknown API path answers 404 JSON", unknownApi.status === 404 && unknownApi.json() !== null, unknownApi.status);

    const robots = await request("/robots.txt");
    check("robots.txt keeps /admin out of the index", robots.status === 200 && robots.body.includes("Disallow: /admin"), robots.status);
  }

    console.log(
      `\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECK(S) FAILED`}`
    );
    process.exit(failures === 0 ? 0 : 1);
}

main();