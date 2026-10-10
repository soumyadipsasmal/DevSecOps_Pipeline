"use strict";

/**
 * KaliNova — admin authentication tests
 *
 * Offline checks: no database, no listening server. They cover the parts that
 * decide whether a request is allowed — cookie handling, token signing and
 * verification, CSRF validation, the login rate limiter, input validation and
 * the output escaping used by the admin templates.
 *
 * The end-to-end HTTP flow (real sign-in against PostgreSQL) is covered by
 * admin-smoke-test.js, which runs against a live server.
 *
 * Run with: npm run test:admin
 */

require("dotenv").config();

process.env.ADMIN_SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET || "test-secret-not-used-anywhere-else-0123456789";

const jwt = require("jsonwebtoken");

const adminService = require("../admin-service");
const adminViews = require("../admin-views");
const config = require("../config");
const security = require("../security");

let failures = 0;
let checks = 0;

function check(label, condition, extra) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${extra ? " -> " + extra : ""}`);
    failures += 1;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* Minimal Express response double. */
function makeRes() {
  const headers = {};
  return {
    statusCode: 200,
    body: null,
    headers,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    set(name, value) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.type = "json";
      return this;
    },
    send(payload) {
      this.body = payload;
      this.type = "text";
      return this;
    },
    redirect(target) {
      this.body = target;
      this.type = "redirect";
      return this;
    },
    type(value) {
      this.type = value;
      return this;
    }
  };
}

function makeReq({ url = "/admin/login", method = "GET", headers = {}, body = {} } = {}) {
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;

  return {
    path: url.split("?")[0],
    originalUrl: url,
    method,
    ip: "203.0.113.10",
    headers: lower,
    body,
    get(name) {
      return lower[name.toLowerCase()];
    }
  };
}

/* ==================================================================== */
section("[1] Cookie parsing and serialisation");
/* ==================================================================== */

{
  const jar = security.parseCookies("a=1; b=hello%20world; c=\"quoted\"; malformed");
  check("plain value parsed", jar.a === "1", JSON.stringify(jar));
  check("percent-encoding decoded", jar.b === "hello world");
  check("quoted value unquoted", jar.c === "quoted");
  check("malformed pair ignored", jar.malformed === undefined);

  const header = security.serializeCookie("sid", "abc def", {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAgeMs: 60000
  });
  check("cookie is percent-encoded in the header", header.includes("sid=abc%20def"), header);
  check("HttpOnly present", header.includes("HttpOnly"));
  check("Secure present", header.includes("Secure"));
  check("SameSite present", header.includes("SameSite=Strict"), header);
  check("Max-Age present", header.includes("Max-Age=60"), header);

  const expired = security.serializeCookie("sid", "", { maxAgeMs: 0, expires: new Date(0) });
  check("deletion sets Max-Age=0", expired.includes("Max-Age=0"), expired);
  check("deletion sets an expiry in the past", /Expires=Thu, 01 Jan 1970/.test(expired), expired);
}

/* ==================================================================== */
section("[2] Session tokens");
/* ==================================================================== */

{
  const admin = { id: 7, email: "admin@example.com", role: "admin", sessionVersion: 3 };
  const token = security.issueSessionToken(admin);
  const claims = security.verifySessionToken(token);

  check("valid token verifies", claims !== null);
  check("subject is the account id", claims && claims.sub === "7");
  check("email claim present", claims && claims.email === "admin@example.com");
  check("role claim present", claims && claims.role === "admin");
  check("session version embedded", claims && Number(claims.sv) === 3);
  check("token id is unique per issue", token !== security.issueSessionToken(admin));

  check("tampered payload rejected", security.verifySessionToken(`${token}x`) === null);
  check("empty token rejected", security.verifySessionToken("") === null);
  check("non-string token rejected", security.verifySessionToken(null) === null);
  check(
    "unsigned (alg=none) token rejected",
    security.verifySessionToken(jwt.sign({ sub: "1" }, "", { algorithm: "none" })) === null
  );
  check(
    "token signed with another secret rejected",
    security.verifySessionToken(
      jwt.sign({ sub: "1" }, "another-secret", { algorithm: "HS256" })
    ) === null
  );
  check(
    "expired token rejected",
    security.verifySessionToken(
      jwt.sign({ sub: "1" }, config.sessionSecret, {
        algorithm: "HS256",
        issuer: "kalinova-admin",
        audience: "kalinova-admin",
        expiresIn: "-1s"
      })
    ) === null
  );
  check(
    "token from another issuer rejected",
    security.verifySessionToken(
      jwt.sign({ sub: "1" }, config.sessionSecret, {
        algorithm: "HS256",
        issuer: "somebody-else",
        audience: "kalinova-admin"
      })
    ) === null
  );
  check(
    "HS512 downgrade rejected",
    security.verifySessionToken(
      jwt.sign({ sub: "1" }, config.sessionSecret, {
        algorithm: "HS512",
        issuer: "kalinova-admin",
        audience: "kalinova-admin"
      })
    ) === null
  );
  check(
    "non numeric subject rejected",
    security.verifySessionToken(
      jwt.sign({ sub: "admin", email: "a@b.co" }, config.sessionSecret, {
        algorithm: "HS256",
        issuer: "kalinova-admin",
        audience: "kalinova-admin"
      })
    ) === null
  );
}

/* ==================================================================== */
section("[3] CSRF protection");
/* ==================================================================== */

{
  const res = makeRes();
  const token = security.createCsrfToken();
  check("token has nonce and signature", token.includes("."), token);
  check(
    "issued token is structurally valid",
    security.verifyCsrfToken(
      makeReq({ method: "POST", headers: { cookie: `${config.csrfCookieName}=${token}` }, body: { _csrf: token } })
    ) === true
  );

  const req = makeReq({
    method: "POST",
    headers: { cookie: `${config.csrfCookieName}=${token}` },
    body: { _csrf: token }
  });
  check("matching token accepted", security.verifyCsrfToken(req) === true);

  req.body._csrf = `${token.slice(0, -1)}x`;
  check("modified token rejected", security.verifyCsrfToken(req) === false);

  req.body._csrf = security.createCsrfToken();
  check("token from another request rejected", security.verifyCsrfToken(req) === false);

  req.body._csrf = token;
  req.headers.cookie = "";
  check("no cookie rejected", security.verifyCsrfToken(req) === false);

  // Mutate the first character to one that differs from it: replacing it
  // with a fixed "n" would be a no-op whenever the token already starts with
  // "n" (1 in 64 base64url tokens), which made this check fail at random.
  const forgedFirst = token.slice(0, 1) === "n" ? "m" : "n";
  req.headers.cookie = `${config.csrfCookieName}=${forgedFirst + token.slice(1)}`;
  check("forged signature rejected", security.verifyCsrfToken(req) === false);

  const headerReq = makeReq({
    method: "POST",
    headers: { cookie: `${config.csrfCookieName}=${token}`, "x-csrf-token": token }
  });
  check("token accepted from the X-CSRF-Token header", security.verifyCsrfToken(headerReq) === true);

  const attachRes = makeRes();
  const attached = makeReq();
  security.attachCsrf(attached, attachRes, () => {});
  check("attachCsrf sets a cookie", Boolean(attachRes.getHeader("set-cookie")));
  check("attachCsrf exposes the token on the request", typeof attached.csrfToken === "string");
  check("issued cookie is HttpOnly", String(attachRes.getHeader("set-cookie")).includes("HttpOnly"));

  const reuseRes = makeRes();
  const reuseReq = makeReq({
    headers: { cookie: `${config.csrfCookieName}=${token}` }
  });
  security.attachCsrf(reuseReq, reuseRes, () => {});
  check("valid existing cookie is not reissued", reuseRes.getHeader("set-cookie") === undefined);
  check("valid existing cookie is reused", reuseReq.csrfToken === token);
}

/* ==================================================================== */
section("[4] Login rate limiter");
/* ==================================================================== */

{
  const limiter = security.createLoginLimiter({
    windowMs: 60000,
    maxAttempts: 3,
    keyFor: (req, email) => `key:${email}`
  });

  check("first attempt allowed", limiter.check("key:a") === null);
  limiter.record("key:a");
  check("second attempt allowed", limiter.check("key:a") === null);
  limiter.record("key:a");
  limiter.record("key:a");
  check("third failure locks the key", Number(limiter.check("key:a")) > 0);
  check("lockout is scoped to the key", limiter.check("key:b") === null);

  limiter.reset("key:a");
  check("successful login clears the counter", limiter.check("key:a") === null);

  const expired = security.createLoginLimiter({ windowMs: 1, maxAttempts: 1, keyFor: () => "k" });
  expired.record("k");
  // Block for a few milliseconds so the one-millisecond window closes. The test
  // file is synchronous, so it waits rather than awaiting.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  check("expired window is discarded", expired.check("k") === null);

  limiter.stop();
  expired.stop();
}

/* ==================================================================== */
section("[5] Login input validation");
/* ==================================================================== */

{
  const accept = adminService.validateCredentials({
    email: "  admin@example.com ",
    password: "correct horse battery"
  });
  check("valid credentials accepted", accept.ok === true);
  check("email trimmed", accept.email === "admin@example.com");

  check("missing email rejected", adminService.validateCredentials({ password: "x".repeat(12) }).ok === false);
  check("missing password rejected", adminService.validateCredentials({ email: "a@b.co" }).ok === false);
  check("non-string email rejected", adminService.validateCredentials({ email: {}, password: "x" }).ok === false);
  check(
    "malformed email rejected",
    adminService.validateCredentials({ email: "not-an-email", password: "x" }).ok === false
  );
  check(
    "overlong email rejected",
    adminService.validateCredentials({ email: `${"a".repeat(260)}@b.co`, password: "x" }).ok === false
  );
  check(
    "overlong password rejected",
    adminService.validateCredentials({ email: "a@b.co", password: "x".repeat(201) }).ok === false
  );

  const message = adminService.validateCredentials({ email: "", password: "" }).message;
  check("validation message is generic", !message.toLowerCase().includes("exist"), message);
}

/* ==================================================================== */
section("[6] Guards reject anonymous and unprivileged callers");
/* ==================================================================== */

{
  const apiRes = makeRes();
  const apiReq = makeReq({ url: "/api/admin/me" });
  security.attachAdmin(apiReq, apiRes, () => {}).catch(() => {});
  security.requireAdmin(apiReq, apiRes, () => {});
  check("admin API answers 401 without a session", apiRes.statusCode === 401);
  check("401 body has no internals", apiRes.body && apiRes.body.error === "Authentication required.");

  const pageRes = makeRes();
  const pageReq = makeReq({ url: "/admin/dashboard" });
  let called = false;
  security.attachAdmin(pageReq, pageRes, () => {}).catch(() => {});
  security.requireAdminPage(pageReq, pageRes, () => {
    called = true;
  });
  check("page guard did not call next()", called === false);
  check("page guard redirects anonymous visitors", pageRes.statusCode === 302);
  check("redirect target is the login form", String(pageRes.body).startsWith("/admin/login"), String(pageRes.body));
  check(
    "redirect remembers the requested page",
    String(pageRes.body).includes(encodeURIComponent("/admin/dashboard")),
    String(pageRes.body)
  );

  const roleRes = makeRes();
  const roleReq = makeReq({ url: "/api/admin/me" });
  roleReq.admin = { id: 1, email: "writer@example.com", role: "author" };
  security.requireAdmin(roleReq, roleRes, () => {});
  check("signed-in non-admin gets 403", roleRes.statusCode === 403);
  check("403 body has no internals", roleRes.body && roleRes.body.error === "Administrator access required.");

  const csrfRes = makeRes();
  security.requireCsrf(makeReq({ method: "POST", url: "/admin/logout" }), csrfRes, () => {});
  check("missing CSRF token rejected", csrfRes.statusCode === 403);
}

/* ==================================================================== */
section("[7] Redirect targets cannot leave the site");
/* ==================================================================== */

{
  check("relative path accepted", security.safeNextPath("/admin/dashboard") === "/admin/dashboard");
  check("protocol-relative URL rejected", security.safeNextPath("//evil.example.com") === null);
  check("absolute URL rejected", security.safeNextPath("https://evil.example.com") === null);
  check("backslash trick rejected", security.safeNextPath("/\\evil.example.com") === null);
  check("empty value rejected", security.safeNextPath("") === null);
  check("non-string rejected", security.safeNextPath(undefined) === null);
}

/* ==================================================================== */
section("[8] Templates escape untrusted data");
/* ==================================================================== */

{
  const escape = adminViews.escapeHtml;
  check("ampersand escaped", escape("a & b") === "a &amp; b");
  check("angle brackets escaped", escape("<script>alert(1)</script>") === "&lt;script&gt;alert(1)&lt;/script&gt;");
  check("double quote escaped", escape('" onload="x') === "&quot; onload=&quot;x");
  check("single quote escaped", escape("it's") === "it&#39;s");
  check("null becomes empty string", escape(null) === "");

  const login = adminViews.renderLoginPage({ csrfToken: "tok", email: "a@b.co" });
  check("login page is noindex", login.includes('content="noindex, nofollow, noarchive"'));
  check("login page has no canonical link", !login.includes('rel="canonical"'));
  check("login form posts to /admin/login", login.includes('action="/admin/login"'));
  check("login form carries the CSRF token", login.includes('name="_csrf"'));
  check("password field is masked", login.includes('type="password"'));
  check("email field is autocomplete=username", login.includes('autocomplete="username"'));
  check("submitted email is escaped", !login.includes("<script"));

  const xss = adminViews.renderDashboardPage({
    admin: { id: 1, email: "admin@example.com", role: "admin" },
    summary: {
      stats: { totalArticles: 1, publishedArticles: 1, draftArticles: 0, categories: 1 },
      recentArticles: [
        {
          id: 1,
          title: "<img src=x onerror=alert(1)>",
          slug: "x",
          status: "published",
          category_name: "<b>news</b>",
          published_at: "2026-01-02T03:04:05.000Z",
          created_at: "2026-01-02T03:04:05.000Z"
        }
      ]
    },
    csrfToken: "tok"
  });

  check("dashboard is noindex", xss.includes('content="noindex, nofollow, noarchive"'));
  check("article title escaped", !xss.includes("<img src=x onerror"));
  check("article title present as text", xss.includes("&lt;img src=x onerror=alert(1)&gt;"));
  check("category name escaped", !xss.includes("<b>news</b>"));
  check("status badge rendered", xss.includes("admin-badge--published"));
  check("date formatted", xss.includes("2026-01-02"));
  check("dashboard offers a logout form", xss.includes('action="/admin/logout"'));
  check("logout form carries a CSRF token", /action="\/admin\/logout">\s*<input type="hidden" name="_csrf"/.test(xss));
  check("login page has no logout form", !login.includes('action="/admin/logout"'));

  const empty = adminViews.renderDashboardPage({
    admin: { id: 1, email: "admin@example.com", role: "admin" },
    summary: {
      stats: { totalArticles: 0, publishedArticles: 0, draftArticles: 0, categories: 0 },
      recentArticles: []
    },
    csrfToken: "tok"
  });
  check("empty dashboard still renders a table", empty.includes("admin-table-empty"));

  const notFound = adminViews.renderNotFoundPage({ csrfToken: "tok" });
  check("404 page links back to the dashboard", notFound.includes('href="/admin/dashboard"'));
}

/* ==================================================================== */
section("[9] No secrets in source");
/* ==================================================================== */

{
  const fs = require("fs");
  const path = require("path");

  const files = [
    "config.js",
    "security.js",
    "admin-service.js",
    "admin-views.js",
    "admin-routes.js",
    "create-admin.js",
    "migrate.js",
    "server.js"
  ];

  const forbidden = [/\bpassword\s*[:=]\s*["'][^"']+["']/gi, /\bADMIN_PASSWORD\s*[:=]\s*["'][^"']+["']/gi];

  /** Comments carry usage examples such as ADMIN_PASSWORD='...'; only code counts. */
  function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  }

  let clean = true;
  for (const file of files) {
    const source = stripComments(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));

    for (const pattern of forbidden) {
      for (const match of source.matchAll(pattern)) {
        // Placeholders are not credentials.
        if (/["'][.]{2,}["']/.test(match[0])) continue;
        console.log(`        ${file}: ${match[0]}`);
        clean = false;
      }
    }
  }
  check("no hardcoded credentials in the app source", clean);

  check("config reads the secret from the environment", config.sessionSecret.length >= 32);
}

section("[10] The app refuses to start with an unusable secret");

{
  // config.js is loaded once per process, so the production cases run in child
  // processes with their own environment.
  const path = require("path");
  const { spawnSync } = require("child_process");

  function loadInProduction(env) {
    // Production now requires DATABASE_URL, so these secret-resolution probes
    // supply a syntactically valid (fake, never connected) URL. Without it the
    // DATABASE_URL gate would throw first and the suite could not isolate the
    // secret checks it is actually testing.
    return spawnSync(
      process.execPath,
      ["-e", "require('./config')"],
      {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        env: Object.assign(
          {},
          process.env,
          {
            NODE_ENV: "production",
            DATABASE_URL: "postgresql://probe-user:probe-password@probe.invalid:5432/probe"
          },
          env
        )
      }
    );
  }

  const missing = loadInProduction({ ADMIN_SESSION_SECRET: "", JWT_SECRET: "" });
  check(
    "production refuses to start without ADMIN_SESSION_SECRET",
    missing.status !== 0 && /ADMIN_SESSION_SECRET/.test(missing.stderr),
    missing.stderr.split("\n")[0]
  );

  const short = loadInProduction({
    ADMIN_SESSION_SECRET: "too-short",
    JWT_SECRET: ""
  });
  check(
    "production refuses a secret shorter than 32 characters",
    short.status !== 0 && /32 characters/.test(short.stderr),
    short.stderr.split("\n")[0]
  );

  const placeholder = loadInProduction({
    ADMIN_SESSION_SECRET: "change-this-in-production",
    JWT_SECRET: ""
  });
  check(
    "production refuses a placeholder secret",
    placeholder.status !== 0 && /placeholder/.test(placeholder.stderr),
    placeholder.stderr.split("\n")[0]
  );

  const devOnly = loadInProduction({
    ADMIN_SESSION_SECRET: "dev-only-secret-replace-me-with-48-random-hex-chars",
    JWT_SECRET: ""
  });
  check(
    "production refuses the value shipped in app/.env",
    devOnly.status !== 0 && /placeholder/.test(devOnly.stderr),
    devOnly.stderr.split("\n")[0]
  );

  const strong = loadInProduction({
    ADMIN_SESSION_SECRET: "b".repeat(48) + "9f3c1a",
    JWT_SECRET: ""
  });
  check(
    "production starts with a strong random secret",
    strong.status === 0 && /Server running/.test(strong.stderr) === false,
    strong.stderr.split("\n")[0]
  );

  const dev = spawnSync(process.execPath, ["-e", "require('./config')"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: Object.assign({}, process.env, { NODE_ENV: "development" })
  });
  check("development starts with the placeholder from app/.env", dev.status === 0, dev.stderr.split("\n")[0]);
}

console.log(
  `\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} CHECK(S) FAILED`}`
);
process.exit(failures === 0 ? 0 : 1);