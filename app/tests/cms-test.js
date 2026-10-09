"use strict";

/**
 * KaliNova — admin article CMS test
 *
 * Everything here runs offline: no PostgreSQL and no HTTP server. It covers the
 * parts of the CMS that are pure logic and the parts that decide what reaches a
 * page.
 *
 *   [1] HTML sanitiser      what survives, what is stripped, what is refused
 *   [2] Validation          titles, slugs, meta, body, category, status
 *   [3] Slug uniqueness     generation and clash handling
 *   [4] Upload safety       magic bytes, generated names, managed deletion
 *   [5] Admin views         escaping, CSRF tokens, no leaked draft URLs
 *   [6] Routing and guards  every mutating route requires CSRF
 *   [7] Public visibility   drafts are filtered out of the public queries
 *
 * The authenticated end-to-end flow lives in admin-smoke-test.js, which needs a
 * running server and real credentials.
 */

require("dotenv").config();

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const config = require("../config");
const security = require("../security");
const articleService = require("../article-service");
const uploads = require("../article-uploads");
const validation = require("../article-validation");
const articleHtml = require("../article-html");
const articleViews = require("../admin-article-views");
const adminViews = require("../admin-views");

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    return true;
  }

  failed += 1;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP ${label} — ${reason}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ==================================================================== */
/* [1] HTML sanitiser                                                    */
/* ==================================================================== */

section("[1] HTML sanitiser");

{
  const { html } = articleHtml.sanitizeBody("<p>Hello <strong>world</strong></p>");
  check("paragraphs and strong survive", html === "<p>Hello <strong>world</strong></p>", html);
}

{
  const { html } = articleHtml.sanitizeBody(
    '<a href="https://example.test/a" target="_blank">link</a>'
  );
  check(
    "external links keep href and gain rel=noopener",
    html.includes('href="https://example.test/a"') && html.includes('rel="noopener noreferrer"'),
    html
  );
}

{
  const { html } = articleHtml.sanitizeBody(
    '<img src="/assets/uploads/a.webp" alt="A cat" width="10" height="5">'
  );
  check("images keep src, alt, width and height", html.includes('alt="A cat"') && html.includes('width="10"'), html);
}

{
  const { html } = articleHtml.sanitizeBody('<p onclick="evil()" style="color:red" class="x">t</p>');
  check("event handlers, inline styles and class are removed", html === "<p>t</p>", html);
}

{
  const { html } = articleHtml.sanitizeBody("<script>alert(1)</script><p>ok</p>");
  check("script and its content are removed", html === "<p>ok</p>", html);
}

{
  const { html } = articleHtml.sanitizeBody('<iframe src="https://evil.test"></iframe><p>ok</p>');
  check("iframes are removed", !html.includes("iframe") && html === "<p>ok</p>", html);
}

{
  const { html } = articleHtml.sanitizeBody('<a href="javascript:alert(1)">x</a>');
  check("javascript: URLs are dropped, text kept", html === "<a>x</a>", html);
}

{
  const { html } = articleHtml.sanitizeBody('<a href="data:text/html;base64,PHNjcmlwdD4=">d</a>');
  check("data: URLs are dropped", !html.includes("data:"), html);
}

{
  const { html } = articleHtml.sanitizeBody('<img src="x" onerror="alert(1)">');
  check("img onerror is removed", !html.includes("onerror"), html);
}

{
  const { html } = articleHtml.sanitizeBody("<video src='/a.mp4'></video><p>ok</p>");
  check("video is removed", !html.includes("video") && html === "<p>ok</p>", html);
}

{
  const { html } = articleHtml.sanitizeBody("<h2>Heading</h2><ul><li>a</li><li>b</li></ul><blockquote>q</blockquote>");
  check(
    "headings, lists and quotes survive",
    html.includes("<h2>Heading</h2>") && html.includes("<ul><li>a</li>") && html.includes("<blockquote>q</blockquote>"),
    html
  );
}

{
  const { html } = articleHtml.sanitizeBody("<p>a<br>b</p>");
  check("line breaks survive", html.includes("<br />"), html);
}

{
  const { html } = articleHtml.sanitizeBody('<!-- comment --><p>z</p>');
  check("comments are removed", !html.includes("comment") && html === "<p>z</p>", html);
}

{
  const { html } = articleHtml.sanitizeBody("<p>unclosed <b>bold");
  check("unclosed tags are closed, not dropped", html === "<p>unclosed <strong>bold</strong></p>", html);
}

{
  // The bug this guards: an escaped entity must not be escaped a second time,
  // or the author sees a literal "&amp;" on the page.
  const { html } = articleHtml.sanitizeBody("<p>a &amp; b &lt;i&gt;</p>");
  check("entities are decoded then re-escaped exactly once", html === "<p>a &amp; b &lt;i&gt;</p>", html);
}

{
  const { html } = articleHtml.sanitizeBody('<a href="https://example.test/?a=1&amp;b=2">t</a>');
  check("entities inside attribute values survive round-tripping", html.includes("a=1&amp;b=2"), html);
}

{
  const { html } = articleHtml.sanitizeBody("<p>plain text</p>");
  check("html input is not re-wrapped in paragraphs", html === "<p>plain text</p>", html);
}

{
  const { html } = articleHtml.sanitizeBody("first block\n\nsecond block");
  check("plain text becomes paragraphs", html === "<p>first block</p><p>second block</p>", html);
}

{
  const { html } = articleHtml.sanitizeBody("one\ntwo");
  check("single newlines become line breaks, not paragraphs", html === "<p>one<br />two</p>", html);
}

{
  const { html } = articleHtml.sanitizeBody("<p>5 &lt; 10 &amp;&amp; 10 &gt; 5</p>");
  check("comparison operators survive without becoming markup", !html.includes("5 < 10"), html);
}

{
  const { text } = articleHtml.sanitizeBody("<p>a &amp; b</p>");
  check("plain-text form is decoded for word counts", text === "a & b", text);
}

{
  check("word count ignores markup", articleHtml.countWords("<p>one two</p><p>three</p>") === 3);
  check("stripTags returns readable text", articleHtml.stripTags("<p>Hello <em>there</em></p>") === "Hello there");
}

{
  let threw = false;
  try {
    articleHtml.sanitizeBody("x".repeat(500 * 1024));
  } catch (error) {
    threw = error.code === "BODY_TOO_LARGE";
  }
  check("an oversized body is refused rather than truncated", threw);
}

{
  check("safeUrl allows an absolute https URL", articleHtml.safeUrl("https://a.test/x.png") === "https://a.test/x.png");
  check("safeUrl allows a site-relative path", articleHtml.safeUrl("/x.png") === "/x.png");
  check("safeUrl refuses javascript:", articleHtml.safeUrl("javascript:alert(1)") === null);
  check("safeUrl refuses a protocol-relative URL", articleHtml.safeUrl("//evil.test/x.png") === null);
}

/* ==================================================================== */
/* [2] Validation                                                        */
/* ==================================================================== */

section("[2] Article validation");

const goodBody = "This is a long enough article body to satisfy the publishing minimum rule for sure.";
const goodInput = {
  title: "Top 10 Bollywood Movies to Watch in 2026",
  category_id: "3",
  meta_description: "Our pick of the ten best Bollywood films of 2026, from opening weekend winners to quiet critical hits.",
  content: `<p>${goodBody}</p>`,
  status: "published"
};

{
  const result = validation.validateArticle(goodInput);
  check("a complete article validates", result.ok, JSON.stringify(result.errors));
  check("slug is generated from the title", result.values.slug === "top-10-bollywood-movies-to-watch-in-2026", result.values.slug);
  check("category id becomes an integer", result.values.categoryId === 3, String(result.values.categoryId));
  check("html body is marked as html", result.values.bodyFormat === "html", result.values.bodyFormat);
  check("status is carried through", result.values.status === "published", result.values.status);
}

{
  const result = validation.validateArticle({ ...goodInput, title: "   " });
  check("a blank title is rejected", !result.ok && Boolean(result.errors.title));
}

{
  const result = validation.validateArticle({ ...goodInput, title: "x".repeat(201) });
  check("an over-long title is rejected", !result.ok && Boolean(result.errors.title));
}

{
  const result = validation.validateArticle({ ...goodInput, category_id: "" });
  check("a missing category is rejected", !result.ok && Boolean(result.errors.category_id));
}

{
  const result = validation.validateArticle({ ...goodInput, category_id: "abc" });
  check("a non-numeric category is rejected", !result.ok && Boolean(result.errors.category_id));
}

{
  const result = validation.validateArticle({ ...goodInput, meta_description: "Too short." });
  check("an empty-ish meta description is allowed (length is not enforced)", result.ok, JSON.stringify(result.errors));
}

{
  const result = validation.validateArticle({ ...goodInput, meta_description: "y".repeat(161) });
  check("an over-long meta description is rejected rather than truncated", !result.ok && Boolean(result.errors.meta_description));
}

{
  const result = validation.validateArticle({ ...goodInput, content: "<p>short</p>" });
  check("publishing requires a body of real length", !result.ok && Boolean(result.errors.content));
}

{
  const result = validation.validateArticle({ ...goodInput, content: "<p>short</p>", status: "draft" });
  check("a draft may have a short or empty body", result.ok, JSON.stringify(result.errors));
}

{
  const result = validation.validateArticle({ ...goodInput, content: "", status: "draft" });
  check("a draft may be empty", result.ok, JSON.stringify(result.errors));
}

{
  const result = validation.validateArticle({ ...goodInput, meta_description: "", status: "draft" });
  check("a draft may omit the meta description", result.ok, JSON.stringify(result.errors));
}

{
  // schema-seo-master.sql widened the editorial workflow to four statuses.
  const result = validation.validateArticle({ ...goodInput, status: "archived" });
  check("archived is an accepted status", result.ok && result.values.status === "archived", JSON.stringify(result.errors));
}

{
  const result = validation.validateArticle({ ...goodInput, status: "deleted" });
  check("an unknown status is rejected", !result.ok && Boolean(result.errors.status), JSON.stringify(result.errors));
}

{
  // A scheduled article needs a real body and meta description like a published
  // one, and a moment to go live at.
  const missing = validation.validateArticle({ ...goodInput, status: "scheduled" });
  check("scheduling without a date is rejected", !missing.ok && Boolean(missing.errors.scheduled_at), JSON.stringify(missing.errors));

  const ok = validation.validateArticle({
    ...goodInput,
    status: "scheduled",
    scheduled_at: "2027-01-01T09:00:00Z"
  });
  check("scheduling with a date is accepted", ok.ok && ok.values.status === "scheduled", JSON.stringify(ok.errors));
}

{
  const result = validation.validateArticle({ ...goodInput, status: "" });
  check("an absent status defaults to draft", result.ok && result.values.status === "draft", result.ok ? result.values.status : JSON.stringify(result.errors));
}

{
  const body = `<p>${goodBody}</p><script>alert(1)</script>`;
  const result = validation.validateArticle({ ...goodInput, content: body });
  check(
    "markup in the body is sanitised before it is stored",
    result.ok && !result.values.bodyHtml.includes("script") && result.values.bodyHtml.includes(goodBody.slice(0, 20)),
    result.values ? result.values.bodyHtml : JSON.stringify(result.errors)
  );
}

{
  // The default must follow the submitted status, not an option a caller forgot.
  const result = validation.validateArticle({ ...goodInput, status: "draft", content: "<p>tiny</p>" });
  check("draft rules apply from the submitted status alone", result.ok, JSON.stringify(result.errors));
}

{
  const forced = validation.validateArticle({ ...goodInput, status: "published", content: "<p>tiny</p>" }, { isDraft: true });
  check("an explicit isDraft can still relax the rules", forced.ok, JSON.stringify(forced.errors));
}

{
  const result = validation.validateArticle({
    ...goodInput,
    cover_image: "/assets/uploads/abc.webp"
  });
  check("a banner requires alt text", !result.ok && Boolean(result.errors.banner_alt), JSON.stringify(result.errors));
}

{
  const result = validation.validateArticle({
    ...goodInput,
    cover_image: "/assets/uploads/abc.webp",
    banner_alt: "A film poster on a wall"
  });
  check("a banner with alt text is accepted", result.ok, JSON.stringify(result.errors));
}

{
  const result = validation.validateArticle({ ...goodInput, cover_image: "/etc/passwd" });
  check("an arbitrary path is refused as a banner", !result.ok && Boolean(result.errors.cover_image));
}

{
  const result = validation.validateArticle({
    ...goodInput,
    cover_image: "https://images.example.test/x.jpg",
    banner_alt: "Still from the trailer"
  });
  check("an https banner URL is accepted for seeded-style covers", result.ok, JSON.stringify(result.errors));
}

{
  const result = validation.validateArticle({
    ...goodInput,
    cover_image: "/assets/topics/cinema/01.jpg",
    banner_alt: "A cinema audience waiting for the lights to dim"
  });
  check("an existing /assets/topics banner can be kept", result.ok, JSON.stringify(result.errors));
}

{
  const result = validation.validateArticle({ ...goodInput, cover_image: "/assets/uploads/evil.php" });
  check("a non-image extension is refused", !result.ok && Boolean(result.errors.cover_image));
}

{
  const result = validation.validateArticle({ ...goodInput, slug: "Not A Slug!!" });
  check("a messy slug is normalised", result.ok && result.values.slug === "not-a-slug", result.ok ? result.values.slug : JSON.stringify(result.errors));
}

check("slugify drops accents", validation.slugify("Café Culture") === "cafe-culture", validation.slugify("Café Culture"));
check("slugify collapses separators", validation.slugify("Top   10!! Movies") === "top-10-movies", validation.slugify("Top   10!! Movies"));

/* ==================================================================== */
/* [3] Slug uniqueness                                                   */
/* ==================================================================== */

section("[3] Slug uniqueness");

(async () => {
  const taken = new Set(["my-article", "my-article-2"]);
  const unique = await validation.ensureUniqueSlug("my-article", slug => Promise.resolve(taken.has(slug)));
  check("a clash gets a numeric suffix", unique === "my-article-3", unique);

  const free = await validation.ensureUniqueSlug("brand-new", () => Promise.resolve(false));
  check("a free slug is used unchanged", free === "brand-new", free);

  const fromEmpty = await validation.ensureUniqueSlug("", () => Promise.resolve(false));
  check("an empty candidate still produces a slug", fromEmpty === "article", fromEmpty);

  let exhausted = false;
  try {
    await validation.ensureUniqueSlug("busy", () => Promise.resolve(true));
  } catch (error) {
    exhausted = error.code === "SLUG_EXHAUSTED";
  }
  check("an impossible clash raises a clear error rather than looping forever", exhausted);

  /* ================================================================== */
  /* [4] Upload safety                                                   */
  /* ================================================================== */

  section("[4] Upload safety");

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(32)]);
  const avif = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif"), Buffer.alloc(32)]);

  check("JPEG magic bytes are detected", uploads.detectImageType(jpeg)?.name === "jpeg");
  check("PNG magic bytes are detected", uploads.detectImageType(png)?.name === "png");
  check("WebP magic bytes are detected", uploads.detectImageType(webp)?.name === "webp");
  check("AVIF magic bytes are detected", uploads.detectImageType(avif)?.name === "avif");

  const php = Buffer.from("<?php system($_GET['c']); ?>");
  check("PHP is not accepted", uploads.detectImageType(php) === null);
  check("SVG is not accepted", uploads.detectImageType(Buffer.from("<svg xmlns='x'></svg>")) === null);
  check("an empty buffer is not accepted", uploads.detectImageType(Buffer.alloc(0)) === null);

  // A file that claims to be an image in its header but is not one by content:
  // the declared Content-Type is deliberately ignored.
  const disguised = Buffer.from("#!/bin/sh\nrm -rf /\n");
  check("a shell script is not accepted regardless of declared type", uploads.detectImageType(disguised) === null);

  let emptyError = "";
  try {
    await uploads.storeBannerImage(Buffer.alloc(0));
  } catch (error) {
    emptyError = error.code;
  }
  check("an empty upload is refused", emptyError === "EMPTY_FILE", emptyError);

  let wrongTypeError = "";
  try {
    await uploads.storeBannerImage(php, { declaredType: "image/jpeg", declaredName: "photo.jpg" });
  } catch (error) {
    wrongTypeError = error.code;
  }
  check("a mislabelled non-image is refused", wrongTypeError === "UNSUPPORTED_IMAGE_TYPE", wrongTypeError);

  let tooLargeError = "";
  try {
    await uploads.storeBannerImage(Buffer.concat([jpeg, Buffer.alloc(config.uploadMaxBytes)]));
  } catch (error) {
    tooLargeError = error.code;
  }
  check("an oversized upload is refused", tooLargeError === "FILE_TOO_LARGE", tooLargeError);

  // Store a real PNG so the generated name and the delete guard can be checked.
  const stored = await uploads.storeBannerImage(png, { declaredName: "../../evil.png" });
  check("the stored name is generated, not the submitted one", !stored.fileName.includes("evil") && /^[a-z0-9]+-[a-f0-9]{24}\.png$/.test(stored.fileName), stored.fileName);
  check("the stored path is under /assets/uploads/", stored.path.startsWith("/assets/uploads/"), stored.path);
  check("a traversal attempt in the filename does not escape the directory", uploads.isManagedUpload(stored.path));

  const listed = await uploads.listUploads();
  check("a stored upload appears in the picker list", listed.some(row => row.path === stored.path));

  check("delete refuses a path outside the upload directory", (await uploads.deleteManagedUpload("/assets/topics/1.jpg")) === false);
  check("delete refuses a traversal path", (await uploads.deleteManagedUpload("/assets/uploads/../../config.js")) === false);
  check("delete removes a managed upload", (await uploads.deleteManagedUpload(stored.path)) === true);
  check("deleting a missing upload is not an error", (await uploads.deleteManagedUpload(stored.path)) === false);

  /* ================================================================== */
  /* [5] Admin views                                                     */
  /* ================================================================== */

  section("[5] Admin views");

  const admin = { id: 1, email: "admin@kalinova.in", role: "admin" };
  const csrfToken = security.createCsrfToken();
  const categories = [{ id: 1, name: "Cinema", slug: "cinema", article_count: 4 }];

  const listPage = articleViews.renderArticleList({
    admin,
    csrfToken,
    result: {
      rows: [
        {
          id: 7,
          title: "A published story",
          slug: "a-published-story",
          status: "published",
          category_name: "Cinema",
          updated_at: "2026-03-01T10:00:00.000Z",
          cover_image: "/assets/topics/cinema/01.jpg"
        },
        {
          id: 8,
          title: "A hidden draft",
          slug: "a-hidden-draft",
          status: "draft",
          category_name: "Cinema",
          updated_at: "2026-03-02T10:00:00.000Z",
          cover_image: null
        }
      ],
      total: 2,
      page: 1,
      pages: 1,
      perPage: 25,
      counts: { all: 2, draft: 1, published: 1 }
    },
    filters: { search: "", status: "", category: "", sort: "updated", perPage: 25, page: 1 },
    categories,
    notice: "Saved."
  });

  check("the list page carries a CSRF token", listPage.includes(csrfToken));
  check("the list page shows the draft badge", listPage.includes("admin-badge--draft"));
  check("the list page shows the published badge", listPage.includes("admin-badge--published"));
  check("a draft links to the admin preview, not the public URL", listPage.includes("/admin/articles/8/preview") && !listPage.includes('href="/blog/a-hidden-draft"'));
  check("a published article links to its public URL", listPage.includes("/blog/a-published-story"));
  check("every row offers a delete confirmation link", listPage.includes("/admin/articles/7/delete") && listPage.includes("/admin/articles/8/delete"));
  check("the status filter tabs show counts", listPage.includes("admin-tab-count"));
  check("the filter form is a GET form so it is bookmarkable", listPage.includes('<form class="admin-filters" method="get"'));
  check("the form and list load the CMS stylesheet", listPage.includes("/assets/admin/admin-cms.css"));
  check("every admin page is noindex", listPage.includes('content="noindex, nofollow, noarchive"'));

  const xssArticle = {
    id: 9,
    title: '"><img src=x onerror=alert(1)>',
    slug: "xss",
    status: "published",
    category_name: "<script>Cinema</script>",
    updated_at: "2026-03-03T10:00:00.000Z",
    cover_image: "/assets/topics/cinema/01.jpg"
  };

  const xssPage = articleViews.renderArticleList({
    admin,
    csrfToken,
    result: { rows: [xssArticle], total: 1, page: 1, pages: 1, perPage: 25, counts: { all: 1, draft: 0, published: 1 } },
    filters: {},
    categories: [{ id: 1, name: "Cinema", slug: "cinema", article_count: 1 }]
  });

  check("a script tag in a category name is escaped", !xssPage.includes("<script>Cinema"), "raw script survived");
  check("an img/onerror title is escaped", !xssPage.includes('onerror=alert(1)>'), "raw handler survived");

  /* Every status form on the dashboard needs the token too, otherwise the row
   * actions silently fail with a 403. */
  const dashboardPage = adminViews.renderDashboardPage({
    admin,
    csrfToken,
    summary: {
      stats: { totalArticles: 2, publishedArticles: 1, draftArticles: 1, categoryCount: 1 },
      recentArticles: [
        { id: 7, title: "A published story", slug: "a-published-story", status: "published", category_name: "Cinema", updated_at: "2026-03-01T10:00:00.000Z" },
        { id: 8, title: "A hidden draft", slug: "a-hidden-draft", status: "draft", category_name: "Cinema", updated_at: "2026-03-02T10:00:00.000Z" }
      ]
    }
  });

  check("the dashboard recent table renders", dashboardPage.includes("Recent articles"));
  check("dashboard status forms carry the CSRF token", !dashboardPage.includes('name="_csrf" value=""'), "a dashboard row has an empty CSRF value");
  check("dashboard rows offer publish and unpublish", dashboardPage.includes("/admin/articles/8/status") && dashboardPage.includes("/admin/articles/7/status"));

  const formPage = articleViews.renderArticleForm({
    admin,
    csrfToken,
    article: {
      id: 12,
      title: "Edit me",
      slug: "edit-me",
      content: "<p>Body with a script tag: <script>alert(1)</script>alert(2)</p>",
      cover_image: "/assets/uploads/x.png",
      banner_alt: "A still from the film",
      category_id: 2,
      status: "published"
    },
    categories,
    uploads: [{ path: "/assets/uploads/x.png", fileName: "x.png", bytes: 1200 }]
  });

  check("the form carries the CSRF token", formPage.includes(csrfToken));
  check("the form posts to the article URL, not to /new", formPage.includes('action="/admin/articles/12"'));
  check("the stored body is escaped inside the textarea", !formPage.includes("<script>alert(1)</script>"), "raw script inside textarea");
  check("the textarea keeps the stored value", formPage.includes("Edit me"));
  check("the banner alt text is populated", formPage.includes("A still from the film"));
  check("the form offers draft and published radios", formPage.includes('value="draft"') && formPage.includes('value="published"'));
  check("each submit button states its intent", (formPage.match(/name="intent"/g) || []).length === 5);
  check("the editor loads its script", formPage.includes("/assets/admin/admin-article-form.js"));
  check("the uploaded image library is offered", formPage.includes('data-insert-image="/assets/uploads/x.png"'));

  const newPage = articleViews.renderArticleForm({
    admin,
    csrfToken,
    categories,
    values: { status: "draft" }
  });
  check("the new-article form posts to /admin/articles", newPage.includes('action="/admin/articles"'));
  check("the new-article form defaults to draft", /value="draft"[^>]*checked/.test(newPage));
  check("the new form has no delete action", !newPage.includes("/delete"));

  const invalidPage = articleViews.renderArticleForm({
    admin,
    csrfToken,
    article: { id: 3, title: "Keep my title" },
    categories,
    errors: { title: "Title is required", content: "Article body is required" }
  });
  check("validation errors are shown as an alert", invalidPage.includes('role="alert"') && invalidPage.includes("Title is required"));
  check("an invalid submission keeps the submitted title", invalidPage.includes("Keep my title"));

  const deletePage = articleViews.renderDeleteConfirm({
    admin,
    csrfToken,
    article: {
      id: 15,
      title: "Delete me",
      slug: "delete-me",
      status: "draft",
      category_name: "Cinema",
      updated_at: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z"
    }
  });

  check("deletion requires a POST with a CSRF token", deletePage.includes('method="post"') && deletePage.includes('name="_csrf"'));
  check("the delete form targets the delete URL", deletePage.includes('action="/admin/articles/15/delete"'));
  check("the confirmation names what will be removed", deletePage.includes("Delete me") && deletePage.includes("delete-me"));

  const previewPage = articleViews.renderPreview({
    admin,
    csrfToken,
    isUnsaved: true,
    values: {
      title: "Preview me",
      meta_description: "A description.",
      banner_alt: "Alt for the banner",
      cover_image: "/assets/uploads/p.png",
      category_name: "Cinema"
    },
    bodyHtml: "<p>Rendered body</p>"
  });

  check("the preview is marked noindex", previewPage.includes('content="noindex, nofollow, noarchive"'));
  check("the preview says nothing was saved", previewPage.includes("Unsaved changes"));
  check("the preview renders the sanitised body", previewPage.includes("<p>Rendered body</p>"));

  check("the admin 404 page is scoped to the admin shell", adminViews.renderNotFoundPage({ csrfToken }).includes("/assets/admin/admin.css"));

  /* The browser-side editor is enhancement only, but two of its details have
   * to agree with the template: the counter is looked up by id, and no
   * author-supplied value is interpolated into an HTML string. */
  const formScript = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "assets", "admin", "admin-article-form.js"), "utf8");

  check(
    "the character counter is matched by id, not by an empty attribute",
    formScript.includes('counter.id') && !formScript.includes('counter.getAttribute("data-counter")'),
    "the counter lookup still reads data-counter as a value"
  );
  check(
    "the meta field and the counter marker agree",
    formPage.includes('id="article-meta-count" data-counter') && formPage.includes('data-counter-for="article-meta-count"')
  );
  check(
    "the editor never interpolates a prompt value into HTML",
    !formScript.includes("insertHTML") && !/<img src="'\s*\+/.test(formScript),
    "author input reaches innerHTML"
  );
  check("the editor validates URLs before inserting them", formScript.includes("safeUrl"));
  check("inserted links get noopener", formScript.includes("noopener"));

  /* ================================================================== */
  /* [6] Routing and guards                                              */
  /* ================================================================== */

  section("[6] Routing and guards");

  // Every mutating admin route must sit behind the CSRF guard. The routes are
  // re-created here the same way admin-routes.js builds them, and each recorded
  // middleware name is checked.
  const express = require("express");
  const captured = { pages: [], api: [] };

  const fakePages = {
    get: (path, ...rest) => captured.pages.push(["GET", path, rest]),
    post: (path, ...rest) => captured.pages.push(["POST", path, rest]),
    use: () => {}
  };
  const fakeApi = {
    get: (path, ...rest) => captured.api.push(["GET", path, rest]),
    post: (path, ...rest) => captured.api.push(["POST", path, rest]),
    put: (path, ...rest) => captured.api.push(["PUT", path, rest]),
    patch: (path, ...rest) => captured.api.push(["PATCH", path, rest]),
    delete: (path, ...rest) => captured.api.push(["DELETE", path, rest]),
    use: () => {}
  };

  const articleRoutes = require("../admin-article-routes");
  articleRoutes.registerPages(fakePages);
  articleRoutes.registerApi(fakeApi);

  const names = entry => entry[2].map(layer => (typeof layer === "function" ? layer.name : "inline"));

  const pageRoutes = captured.pages.map(entry => [entry[0], entry[1], entry[2]]);
  const apiRoutes = captured.api.map(entry => [entry[0], entry[1], entry[2]]);

  const mutations = [...pageRoutes, ...apiRoutes].filter(entry => entry[0] !== "GET");

  check("there are mutating admin article routes to protect", mutations.length >= 8, String(mutations.length));

  for (const [method, path, middleware] of mutations) {
    const list = names([method, path, middleware]);
    check(`${method} ${path} requires a CSRF token`, list.includes("requireCsrf"), list.join(", "));
  }

  for (const [method, path, middleware] of pageRoutes) {
    const list = names([method, path, middleware]);
    check(
      `${method} ${path} requires an admin session`,
      list.includes("requireAdminPage") || path === "/articles/preview",
      list.join(", ")
    );
  }

  for (const [method, path, middleware] of apiRoutes) {
    if (path === "/uploads") continue;
    const list = names([method, path, middleware]);
    check(`${method} ${path} requires the admin role`, list.includes("requireAdmin"), list.join(", "));
  }

  const uploadRoute = apiRoutes.find(entry => entry[1] === "/uploads" && entry[0] === "POST");
  check("the upload route requires a CSRF token", names(uploadRoute).includes("requireCsrf"));
  check("the upload route requires the admin role", names(uploadRoute).includes("requireAdmin"));

  const pagePaths = pageRoutes.map(entry => `${entry[0]} ${entry[1]}`);
  for (const required of [
    "GET /articles",
    "GET /articles/new",
    "POST /articles",
    "GET /articles/:id/edit",
    "POST /articles/:id",
    "GET /articles/:id/preview",
    "POST /articles/:id/status",
    "GET /articles/:id/delete",
    "POST /articles/:id/delete"
  ]) {
    check(`the ${required.split(" ")[0]} ${required.split(" ")[1]} route exists`, pagePaths.includes(required), pagePaths.join(" | "));
  }

  const apiPaths = apiRoutes.map(entry => `${entry[0]} ${entry[1]}`);
  for (const required of [
    "GET /articles",
    "POST /articles",
    "GET /articles/:id",
    "PUT /articles/:id",
    "PATCH /articles/:id",
    "POST /articles/:id/status",
    "DELETE /articles/:id",
    "GET /uploads",
    "POST /uploads"
  ]) {
    check(`the JSON API exposes ${required}`, apiPaths.includes(required), apiPaths.join(" | "));
  }

  // Route order matters: /articles/new and /articles/preview must be matched
  // before /articles/:id, or they would be read as an id.
  const newIndex = pagePaths.indexOf("GET /articles/new");
  const idIndex = pagePaths.indexOf("GET /articles/:id");
  check("/articles/new is registered before /articles/:id", newIndex !== -1 && idIndex !== -1 && newIndex < idIndex, `${newIndex} < ${idIndex}`);

  check("the article form parser has a larger limit than the 16kb default", config.adminBodyLimit !== "16kb", config.adminBodyLimit);

  /* ================================================================== */
  /* [7] Public visibility                                               */
  /* ================================================================== */

  section("[7] Public visibility of drafts");

  const serverSource = fs.readFileSync(require.resolve("../server"), "utf8");

  check(
    "the public article list filters on status",
    /status = 'published'/.test(serverSource),
    "no published-only filter found in the public list query"
  );

  const publicQueries = serverSource.split("app.get").slice(1).join("app.get");
  for (const route of ['"/api/articles/:id"', '"/api/articles/slug/:slug"', '"/api/articles/:id/images"']) {
    const start = publicQueries.indexOf(route);
    check(`${route} is present in the public API`, start !== -1);
    if (start === -1) continue;

    const block = publicQueries.slice(start, start + 900);
    check(`${route} only returns published articles`, /status = 'published'/.test(block), route);
  }

  // The /blog/:slug page moved to seo-master-routes.js when it gained
  // server-rendered metadata; it must still filter on status there.
  const pageRouteSource = fs.readFileSync(require.resolve("../seo-master-routes"), "utf8");
  check(
    "the public article page 404s a draft",
    /a\.status = 'published'/.test(pageRouteSource),
    "the /blog/:slug existence check does not filter on status"
  );

  check("the public API projects meta_description", /articles\.meta_description/.test(serverSource));
  check("the public API projects banner_alt", /articles\.banner_alt/.test(serverSource));
  check("the public API projects updated_at", /articles\.updated_at/.test(serverSource));
  check("the public API projects body_format", /articles\.body_format/.test(serverSource));

  check("public article creation still requires an admin session", /app\.post\("\/api\/articles", security\.requireAdminSession/.test(serverSource));

  const sitemapSource = require("fs").readFileSync(
    require.resolve("../../scripts/generate-sitemap"),
    "utf8"
  );
  check("the sitemap generator filters on published status", /WHERE status = 'published'/.test(sitemapSource));
  check("the sitemap generator reports updated_at", /a\.updated_at/.test(sitemapSource) && /article\.updated_at/.test(sitemapSource));

  /* ================================================================== */
  /* Summary                                                             */
  /* ================================================================== */

  const pool = require("../db");
  try {
    await pool.end();
  } catch {
    /* nothing was ever connected */
  }

  console.log(`\n${passed} checks passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
})().catch(error => {
  console.error("\ncms-test crashed:", error);
  process.exitCode = 1;
});