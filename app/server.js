require("dotenv").config();

const express = require("express");
const path = require("path");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3007;

// Middleware
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, "../frontend")));

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
// There are no user accounts. Every article is published by the single
// seeded author, so the site owner can post anything without signing in.

const SITE_AUTHOR = "kalinova";

let siteAuthorId = null;

// Resolved once on first use and then cached for the process lifetime.
async function getSiteAuthorId() {
    if (siteAuthorId) return siteAuthorId;

    const result = await pool.query(
        "SELECT id FROM users WHERE username = $1",
        [SITE_AUTHOR]
    );

    if (result.rows.length === 0) {
        throw new Error(
            `Author "${SITE_AUTHOR}" is missing. Run the database seed scripts.`
        );
    }

    siteAuthorId = result.rows[0].id;
    return siteAuthorId;
}

// ===============================
// CREATE ARTICLE
// ===============================

app.post("/api/articles", async (req, res) => {
    try {
        const { title, content, cover_image, category_id } = req.body;

        // Validate input
        if (!title || !content) {
            return res.status(400).json({
                error: "Title and content are required"
            });
        }

        // Create URL-friendly slug
        const slug = title
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");

        // Save article
        const result = await pool.query(
            `INSERT INTO articles
            (author_id, title, slug, content, cover_image, category_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, author_id, title, slug, content, cover_image, category_id, created_at`,
            [
                await getSiteAuthorId(),
                title,
                slug,
                content,
                cover_image || null,
                category_id || null
            ]
        );

        res.status(201).json({
            message: "Article created successfully",
            article: result.rows[0]
        });

    } catch (error) {
        console.error("Article creation error:", error);

        res.status(500).json({
            error: "Internal server error"
        });
    }
});
// ===============================
// GET CATEGORIES
// ===============================

app.get("/api/categories", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, slug FROM categories ORDER BY display_order ASC, name ASC"
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

app.get("/api/articles", async (req, res) => {
    try {
        const { search, category, trending } = req.query;

        let query = `
            SELECT
                articles.id,
                articles.title,
                articles.slug,
                articles.content,
                LEFT(articles.content, 200) AS excerpt,
                articles.cover_image,
                articles.is_featured,
                articles.is_trending,
                articles.status,
                articles.published_at,
                articles.created_at,
                users.id AS author_id,
                users.username AS author_username,
                users.avatar_url AS author_avatar,
                users.bio AS author_bio,
                categories.name AS category_name,
                categories.slug AS category_slug
            FROM articles
            JOIN users ON articles.author_id = users.id
            LEFT JOIN categories ON articles.category_id = categories.id
        `;

        const conditions = [];
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

        if (conditions.length > 0) {
            query += " WHERE " + conditions.join(" AND ");
        }

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
    articles.cover_image,
    articles.is_featured,
    articles.is_trending,
    articles.status,
    articles.published_at,
    articles.created_at,
    users.id AS author_id,
    users.username AS author_username,
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

app.get("/api/articles/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT ${ARTICLE_COLUMNS}
            ${ARTICLE_JOINS}
            WHERE articles.id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Article not found" });
        }

        res.json(result.rows[0]);

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
            WHERE articles.slug = $1
        `, [slug]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Article not found" });
        }

        res.json(result.rows[0]);

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

app.get("/api/articles/:id/images", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT
                id,
                file_path,
                position,
                title,
                alt_text,
                creator,
                license,
                source
            FROM article_images
            WHERE article_id = $1
            ORDER BY position ASC
        `, [id]);

        res.json({ images: result.rows });
    } catch (error) {
        console.error("Get article images error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ===============================
// SITEMAP
// ===============================
// Generated from the database on every request so newly published stories are
// discoverable without a deploy. Static pages come from SITE_PAGES; the database
// supplies the article and topic URLs.

const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://kalinova.in";

// Only pages that are genuinely meant to be indexed. Tool and account views are
// deliberately absent.
const SITE_PAGES = [
    { path: "/", changefreq: "daily", priority: "1.0" },
    { path: "/stories", changefreq: "daily", priority: "0.9" },
    { path: "/news", changefreq: "daily", priority: "0.7" },
    { path: "/about", changefreq: "monthly", priority: "0.6" },
    { path: "/services", changefreq: "monthly", priority: "0.6" },
    { path: "/contact", changefreq: "monthly", priority: "0.5" },
    { path: "/careers", changefreq: "monthly", priority: "0.4" },
];

const escapeXml = value =>
    String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

const urlEntry = ({ loc, lastmod, changefreq, priority }) =>
    [
        "  <url>",
        `    <loc>${escapeXml(loc)}</loc>`,
        lastmod ? `    <lastmod>${escapeXml(lastmod)}</lastmod>` : null,
        changefreq ? `    <changefreq>${changefreq}</changefreq>` : null,
        priority ? `    <priority>${priority}</priority>` : null,
        "  </url>"
    ]
        .filter(Boolean)
        .join("\n");

app.get("/sitemap.xml", async (req, res) => {
    try {
        const [articles, categories] = await Promise.all([
            pool.query(`
                SELECT slug, published_at, created_at
                FROM articles
                WHERE status = 'published' AND slug IS NOT NULL
                ORDER BY COALESCE(published_at, created_at) DESC
            `),
            pool.query("SELECT slug FROM categories ORDER BY display_order ASC")
        ]);

        const today = new Date().toISOString().slice(0, 10);

        const entries = SITE_PAGES.map(page =>
            urlEntry({
                loc: `${SITE_ORIGIN}${page.path}`,
                lastmod: today,
                changefreq: page.changefreq,
                priority: page.priority
            })
        );

        for (const category of categories.rows) {
            entries.push(
                urlEntry({
                    loc: `${SITE_ORIGIN}/category/${category.slug}`,
                    changefreq: "weekly",
                    priority: "0.6"
                })
            );
        }

        for (const article of articles.rows) {
            // The articles table tracks no updated_at, so the last change we can
            // honestly report is the publication date.
            const lastmod = article.published_at || article.created_at;
            entries.push(
                urlEntry({
                    loc: `${SITE_ORIGIN}/blog/${article.slug}`,
                    lastmod: lastmod ? new Date(lastmod).toISOString() : undefined,
                    changefreq: "monthly",
                    priority: "0.8"
                })
            );
        }

        const xml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            ...entries,
            "</urlset>",
            ""
        ].join("\n");

        res.set("Content-Type", "application/xml; charset=utf-8");
        res.set("Cache-Control", "public, max-age=1800");
        res.send(xml);

    } catch (error) {
        console.error("Sitemap error:", error);
        res.status(500).type("application/xml").send(
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n'
        );
    }
});

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
    /^\/category\/[^/]+$/,
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

// ===============================
// ERROR HANDLER
// ===============================

app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
});

// ===============================
// START SERVER
// ===============================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
