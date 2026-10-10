require("dotenv").config();

const express = require("express");
const path = require("path");

const config = require("./config");
const pool = require("./db");
const adsService = require("./ads-service");
const security = require("./security");
const { adminApi, adminPages } = require("./admin-routes");
const { externalApi } = require("./external-routes");
const redirects = require("./redirect-service");
const tagService = require("./tag-service");
const { seoRouter, seoPageRouter } = require("./seo-master-routes");

const app = express();
const PORT = process.env.PORT || config.port;

// Rate limiting and secure cookies depend on req.ip, which is only accurate
// when the deployment tells us a proxy sits in front. Off by default because a
// trusted header can be spoofed by any client that reaches the app directly.
app.set("trust proxy", config.trustProxy);

// Middleware
// JSON bodies are capped tightly by default; the admin article endpoints carry
// article text, so they get their own (still bounded) limit. Registered before
// the default parser for the same reason as the form parser: whichever parser
// reads the body first wins.
const adminArticleJson = express.json({ limit: config.adminBodyLimit });
const standardJson = express.json({ limit: "100kb" });

app.use((req, res, next) => {
  const parser = req.path.startsWith("/api/admin/articles")
    ? adminArticleJson
    : standardJson;

  return parser(req, res, next);
});

// Baseline response hardening for the whole site. The stricter
// Content-Security-Policy for the admin surface is set by admin-routes.
app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "SAMEORIGIN");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
});

// Dynamic SEO surface first: /sitemap.xml, its child sitemaps, /robots.txt and
// the read-only /api/search, /api/tags and /api/authors endpoints. Registering
// this ahead of the static handler lets the generated sitemap and robots win
// over the frontend/sitemap.xml and frontend/robots.txt files of the same name
// that express.static would otherwise serve.
app.use(seoRouter);

// Serve frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// ===============================
// ADMIN
// ===============================
// Registered after the static handler so real files under /assets win, and
// before the SPA fallback so the admin area can never be answered with the
// public shell. /admin/* is server-rendered and requires an administrator
// session; there is no public registration and no public write path.
app.use("/admin", adminPages);
app.use("/api/admin", adminApi);

// Open-data API (Wikidata, Wikimedia Commons, OpenStreetMap, reviewed RSS).
// Mounted under /api alongside the article endpoints: read-only, rate limited,
// and registered before the SPA fallback so /api/* never falls through to the
// HTML shell.
app.use("/api", externalApi);

// Monetization API (disclosures, direct-ads, newsletter, article monetization)
// and the affiliate redirect surface. Mounted before the SPA fallback so /go/*
// and /api/monetization* never fall through to the HTML shell.
const { goRouter, monetizationApi } = require("./monetization-routes");
app.use("/api", monetizationApi);
app.use("/go", goRouter);

// ===============================
// SLUG-CHANGE REDIRECTS
// ===============================
// The redirects table (database/schema-seo-engine.sql) answers every clean GET
// against a retired URL. Sources are strictly public site paths, so /admin,
// /api, /assets, /go and /health never reach this middleware; a paused row
// simply falls through to its normal route. A redirect is a terminal answer:
// no store caching, because the table can be silenced at any time.
//
// This runs after the real routes — nothing forwards over a living endpoint —
// and before the home page and the SPA fallback, so an old /blog slug is
// forwarded before it can be served as an empty shell. Database trouble here
// must not take the site down, so any error falls through unanswered.
app.use(async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();

  const path = req.path;
  if (
    path === "/" ||
    path.startsWith("/api/") ||
    path.startsWith("/admin") ||
    path.startsWith("/assets/") ||
    path.startsWith("/go/") ||
    path === "/health"
  ) {
    return next();
  }

  try {
    const target = await redirects.findBySource(path);
    if (!target) return next();

    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, follow");
    return res.redirect(target.status_code, target.destination_path);
  } catch (error) {
    // A redirect lookup failing must not take the public site down.
    return next();
  }
});

// Home page
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// Health check
app.get("/health", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");

        res.json({
            status: "UP",
            database: "Connected",
            time: result.rows[0].now
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: "DOWN",
            database: "Disconnected"
        });
    }
});

// ===============================
// SITE AUTHOR
// ===============================
// There are no public user accounts. Articles are attributed to the single
// seeded author, so the public site's byline never changes; the admin account
// is what authorises writing them (see the requireAdmin guard below).
//
// The lookup lives in article-service so the admin CMS attributes new articles
// to the same row instead of keeping a second copy of the query.

const articleService = require("./article-service");
const articleValidation = require("./article-validation");

// ===============================
// CREATE ARTICLE
// ===============================
// Administrators only. security.requireAdminSession answers 401 when there is no
// valid session and 403 for a signed-in account without the admin role, so a
// visitor cannot create content even by calling this endpoint directly.
//
// This legacy endpoint predates the CMS and stays in place for any existing
// caller, but it now shares the CMS path: the same validation, the same slug
// generation and the same sanitiser. New work should use
// POST /api/admin/articles, which additionally supports drafts, meta
// descriptions and banner alt text.

app.post("/api/articles", security.requireAdminSession, async (req, res, next) => {
    try {
        const { title, content, cover_image, category_id } = req.body || {};

        const validation = articleValidation.validateArticle(
            {
                title,
                content,
                cover_image,
                category_id,
                meta_description: "Article created through the legacy API endpoint.",
                // The legacy endpoint has always published immediately.
                status: articleValidation.STATUS_PUBLISHED
            },
            { isDraft: false }
        );

        if (!validation.ok) {
            return res.status(400).json({
                error: "Validation failed",
                errors: validation.errors
            });
        }

        const article = await articleService.createArticle(validation.values);

        return res.status(201).json({
            message: "Article created successfully",
            article: {
                id: article.id,
                author_id: article.author_id,
                title: article.title,
                slug: article.slug,
                content: article.content,
                cover_image: article.cover_image,
                category_id: article.category_id,
                status: article.status,
                created_at: article.created_at
            }
        });
    } catch (error) {
        return next(error);
    }
});
// ===============================
// GET CATEGORIES
// ===============================

app.get("/api/categories", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, slug, image FROM categories ORDER BY display_order ASC, name ASC"
        );
        res.json({ categories: result.rows });
    } catch (error) {
        console.error("Get categories error:", error);
        res.json({ categories: [] });
    }
});

// ===============================
// GET ALL ARTICLES
// ===============================
// PUBLIC SURFACE: published articles only. The status filter is not a query
// parameter, so no request shape can ask for a draft. Drafts are reachable
// exclusively through /api/admin/articles, which requires an admin session.

app.get("/api/articles", async (req, res) => {
    try {
        const { search, category, trending } = req.query;

        let query = `
            SELECT
                articles.id,
                articles.title,
                articles.slug,
                articles.content,
                articles.body_format,
                COALESCE(articles.excerpt, LEFT(articles.content, 200)) AS excerpt,
                articles.meta_title,
                articles.meta_description,
                articles.canonical_url,
                articles.robots_index,
                articles.robots_follow,
                articles.cover_image,
                articles.banner_alt,
                articles.og_title,
                articles.og_description,
                articles.og_image,
                articles.twitter_title,
                articles.twitter_description,
                articles.twitter_image,
                articles.schema_type,
                articles.focus_keyword,
                articles.is_featured,
                articles.is_trending,
                articles.status,
                articles.published_at,
                articles.created_at,
                articles.updated_at,
                users.id AS author_id,
                users.username AS author_username,
                users.slug AS author_slug,
                users.avatar_url AS author_avatar,
                users.bio AS author_bio,
                categories.name AS category_name,
                categories.slug AS category_slug
            FROM articles
            JOIN users ON articles.author_id = users.id
            LEFT JOIN categories ON articles.category_id = categories.id
        `;

        const conditions = ["articles.status = 'published'"];
        const params = [];

        if (search) {
            params.push(`%${search}%`);
            conditions.push(`(articles.title ILIKE $${params.length} OR articles.content ILIKE $${params.length})`);
        }

        if (category) {
            params.push(category);
            conditions.push(`categories.slug = $${params.length}`);
        }

        if (trending === "true") {
            conditions.push(`articles.is_trending = true`);
        }

        query += " WHERE " + conditions.join(" AND ");

        query += " ORDER BY articles.created_at DESC LIMIT 50";

        const result = await pool.query(query, params);
        res.json({ articles: result.rows });

    } catch (error) {
        console.error("Get articles error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ===============================
// GET SINGLE ARTICLE
// ===============================
// Shared projection for both the numeric and slug lookups below.
const ARTICLE_COLUMNS = `
    articles.id,
    articles.title,
    articles.slug,
    articles.content,
    articles.body_format,
    COALESCE(articles.excerpt, LEFT(articles.content, 200)) AS excerpt,
    articles.meta_title,
    articles.meta_description,
    articles.canonical_url,
    articles.robots_index,
    articles.robots_follow,
    articles.cover_image,
    articles.banner_alt,
    articles.og_title,
    articles.og_description,
    articles.og_image,
    articles.twitter_title,
    articles.twitter_description,
    articles.twitter_image,
    articles.schema_type,
    articles.focus_keyword,
    articles.is_featured,
    articles.is_trending,
    articles.status,
    articles.published_at,
    articles.created_at,
    articles.updated_at,
    users.id AS author_id,
    users.username AS author_username,
    users.slug AS author_slug,
    users.avatar_url AS author_avatar,
    users.bio AS author_bio,
    categories.name AS category_name,
    categories.slug AS category_slug
`;

const ARTICLE_JOINS = `
    FROM articles
    JOIN users ON articles.author_id = users.id
    LEFT JOIN categories ON articles.category_id = categories.id
`;

/* A draft answers exactly like a slug that does not exist: same status, same
 * body, so the public URL of an unpublished article cannot be probed. */
const ARTICLE_NOT_FOUND = { error: "Article not found" };

app.get("/api/articles/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT ${ARTICLE_COLUMNS}
            ${ARTICLE_JOINS}
            WHERE articles.id = $1 AND articles.status = 'published'
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json(ARTICLE_NOT_FOUND);
        }

        const article = result.rows[0];
        const tags = await tagService.getTagsForArticle(article.id);
        res.json({ ...article, tags: tags.map(tag => tag.name) });

    } catch (error) {
        console.error("Get article error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ===============================
// GET SINGLE ARTICLE BY SLUG
// ===============================
// The canonical article URL is /blog/<slug>, so the frontend resolves stories
// by slug. Registered before /api/articles/:id so the literal "slug" segment is
// never mistaken for a numeric id.

app.get("/api/articles/slug/:slug", async (req, res) => {
    try {
        const { slug } = req.params;
        const result = await pool.query(`
            SELECT ${ARTICLE_COLUMNS}
            ${ARTICLE_JOINS}
            WHERE articles.slug = $1 AND articles.status = 'published'
        `, [slug]);

        if (result.rows.length === 0) {
            return res.status(404).json(ARTICLE_NOT_FOUND);
        }

        const article = result.rows[0];
        const tags = await tagService.getTagsForArticle(article.id);
        res.json({ ...article, tags: tags.map(tag => tag.name) });

    } catch (error) {
        console.error("Get article by slug error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ===============================
// GET ARTICLE IMAGES
// ===============================
// Images embedded in an article body, best match first. Seeded by
// `npm run seed:images`, which scores them against the article text.
// Joined to articles so a draft's gallery cannot be read.

app.get("/api/articles/:id/images", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT
                article_images.id,
                article_images.file_path,
                article_images.position,
                article_images.title,
                article_images.alt_text,
                article_images.creator,
                article_images.license,
                article_images.source
            FROM article_images
            JOIN articles ON articles.id = article_images.article_id
            WHERE article_images.article_id = $1
              AND articles.status = 'published'
              AND article_images.source NOT LIKE 'HIDDEN:%'
            ORDER BY article_images.position ASC
        `, [id]);

        res.json({ images: result.rows });
    } catch (error) {
        console.error("Get article images error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ===============================
// GET ARTICLE SOURCES
// ===============================
// The citations an editor attached, published with the article. Joined to
// articles so a draft's reference list can never be read, exactly like the
// gallery above. Provenance rows (article_research_metadata) are internal and
// are never served from here.

async function loadArticleSources(column, keyValue) {
    // The column name is never taken from the request: each caller names one
    // of these two literal keys, so nothing can be interpolated from input.
    const SOURCE_KEY_COLUMNS = { id: "articles.id", slug: "articles.slug" };
    const qualified = SOURCE_KEY_COLUMNS[column];
    if (!qualified) return [];

    const result = await pool.query(`
        SELECT
            article_sources.id,
            article_sources.source_name,
            article_sources.source_url,
            article_sources.license,
            article_sources.attribution_text
        FROM article_sources
        JOIN articles ON articles.id = article_sources.article_id
        WHERE ${qualified} = $1
          AND articles.status = 'published'
        ORDER BY article_sources.position ASC, article_sources.id ASC
    `, [keyValue]);

    return result.rows;
}

app.get("/api/articles/:id/sources", async (req, res) => {
    try {
        // A non-numeric id is a 404 rather than a database error.
        if (!/^\d+$/.test(String(req.params.id))) {
            return res.status(404).json(ARTICLE_NOT_FOUND);
        }

        const rows = await loadArticleSources("id", req.params.id);
        res.json({ sources: rows });
    } catch (error) {
        console.error("Get article sources error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/api/articles/slug/:slug/sources", async (req, res) => {
    try {
        const rows = await loadArticleSources("slug", req.params.slug);
        res.json({ sources: rows });
    } catch (error) {
        console.error("Get article sources error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ===============================
// PUBLIC AD MANIFEST
// ===============================
// Read-only and unauthenticated, because the frontend needs it before anything
// can be rendered. The response is assembled by ads-service, which returns an
// empty `ads` array and `enabled: false` while the site-wide switch is off, no
// AdSense network is enabled, or no valid publisher id is saved. In that state
// this endpoint leaks nothing about the site's ad configuration.
//
// A database failure answers with the all-off manifest rather than a 500, so a
// broken database cannot make the frontend retry in a loop while trying to show
// an ad. The site loses its ads; it does not lose its content.

app.get("/api/ads", async (req, res) => {
    try {
        const manifest = await adsService.getPublicManifest();

        // Short shared cache: one place on the edge serves the same manifest to
        // many readers, and a switch-off has to reach readers promptly.
        res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
        res.json(manifest);
    } catch (error) {
        console.error("Get ad manifest error:", error);
        res.set("Cache-Control", "no-store");
        res.json({
            enabled: false,
            consent_required: true,
            consent_script_url: "",
            publisher_id: "",
            ads: []
        });
    }
});

// ===============================
// SITEMAP
// ===============================
// /sitemap.xml, /sitemap-<child>.xml and /robots.txt are generated dynamically
// by the SEO router mounted at the top of this file (before express.static), so
// the dynamic routes win over any static file. See app/seo-master-routes.js.
//
// frontend/sitemap.xml is the generated static copy that static hosting relies
// on; regenerate it after publishing with:  node scripts/generate-sitemap.js
// Docs: README (Public site -> SEO and ops).

// ===============================
// PUBLIC CONTENT PAGES
// ===============================
// /blog/<slug>, /stories/<slug>, /category/<slug>, /tag/<slug> and
// /author/<slug> are real pages, not client-side guesses. seoPageRouter checks
// that the entity exists and is public, then answers with the SPA shell carrying
// server-rendered title/description/canonical/robots/social tags and JSON-LD, so
// a crawler that does not run JavaScript still sees the right metadata. A slug
// that does not exist — or belongs to a draft — answers 404 with the styled page
// instead of a 200 shell that would let a crawler index an empty document.
//
// Registered after the redirect middleware (so a retired slug still forwards)
// and before the SPA fallback. If the database is unreachable the router calls
// next() and the fallback serves the shell, because a working site matters more
// than the status code of one URL during an outage.
app.use(seoPageRouter);

// ===============================
// SPA FALLBACK
// ===============================
// Every clean route (/about, /blog/<slug>, /contact, ...) is rendered by the
// frontend router, so it must return index.html rather than 404. Static assets
// are served by express.static above and never reach this handler. The same
// behaviour is declared in frontend/_redirects for Cloudflare Pages.

const SPA_ROUTES = [
    /^\/$/,
    /^\/stories$/,
    /^\/news$/,
    /^\/about$/,
    /^\/services$/,
    /^\/contact$/,
    /^\/careers$/,
    /^\/search$/,
    /^\/guest-posts$/,
    // Legal pages, linked from the footer and the sidebar signup copy.
    /^\/privacy$/,
    /^\/terms$/,
    /^\/category\/[^/]+$/,
    // Tag and author archives are server-rendered by seoPageRouter; they are
    // listed here too so a database outage still serves the shell rather than a
    // 404 for a page that exists.
    /^\/tag\/[^/]+$/,
    /^\/author\/[^/]+$/,
    // The blog listing is /blog; /stories is its older alias. Both render the
    // same page, so both must reach the shell rather than the 404.
    /^\/blog\/?$/,
    /^\/blog\/[^/]+$/,
    /^\/stories\/[^/]+$/,
    /^\/profile\/[^/]+$/,
    /^\/portfolio$/,
    /^\/marketplace$/,
    /^\/cv$/,
    /^\/dashboard$/,
    /^\/settings$/
];

// Registered as middleware rather than app.get("*") because Express 5 removed
// bare wildcard path strings.
app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
        return next();
    }

    const isSpaRoute = SPA_ROUTES.some(pattern => pattern.test(req.path));
    const shell = path.join(__dirname, "../frontend/index.html");

    if (isSpaRoute) {
        // Clean paths are canonical; any legacy #/ fragment never reaches the
        // server, so nothing here needs to rewrite the fragment.
        return res.sendFile(shell);
    }

    // Genuinely unknown URL: serve the styled 404 with a real 404 status so
    // crawlers do not index the shell at unknown addresses.
    res.status(404).sendFile(path.join(__dirname, "../frontend/404.html"), err => {
        if (err) next(err);
    });
});

// Unmatched API paths have no HTML representation. Without this they would fall
// through to the Express default 404 page, which returns markup to clients that
// asked for JSON.
app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
});

// ===============================
// ERROR HANDLER
// ===============================
// Only the message is logged. Stack traces and database details never reach a
// response, in development or production.

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    console.error("Unhandled error:", err.message);

    if (req.path.startsWith("/admin") && !security.wantsJson(req)) {
        res.set("Content-Type", "text/plain; charset=utf-8");
        return res.status(500).send("Internal server error");
    }

    res.status(500).json({ error: "Internal server error" });
});

// ===============================
// START SERVER
// ===============================
// Exporting the app lets a test runner mount it without opening a port; the
// container still starts the listener directly.

if (require.main === module) {
    // Automatic open-data safety only starts when the real server boots.
    // Test runners mount the app without starting timers or probing upstreams.
    try {
        const circuit = require("./circuit-breaker");
        const mapHealth = require("./map-health");
        const licenseAudit = require("./license-audit");
        const scheduledPublisher = require("./scheduled-publisher");
        circuit.startSweeper();
        mapHealth.start();
        licenseAudit.start();
        scheduledPublisher.start();
    } catch (error) {
        console.error("Failed to start background safety jobs:", error.message);
    }

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;
