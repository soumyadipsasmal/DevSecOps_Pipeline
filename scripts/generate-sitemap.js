#!/usr/bin/env node
/**
 * Generate the static sitemap at frontend/sitemap.xml.
 *
 * The sitemap is a real file rather than a per-request database query, so it is
 * served identically by Express (app/server.js -> express.static) and by
 * Cloudflare Pages straight out of the frontend directory.
 *
 * Run this after publishing or unpublishing anything:
 *     node scripts/generate-sitemap.js
 *
 * DB_* environment variables come from app/.env (see app/db.js).
 */
const fs = require("fs");
const path = require("path");

// Point dotenv at app/.env explicitly so the script works from the repo root as
// well as from app/. node_modules lives under app/, so dotenv is resolved
// through that directory rather than from scripts/. db.js calls dotenv.config()
// again, but dotenv never overwrites variables that are already set.
const APP_DIR = path.join(__dirname, "..", "app");
require(require.resolve("dotenv", { paths: [APP_DIR] })).config({
    path: path.join(APP_DIR, ".env"),
});

const pool = require(path.join(APP_DIR, "db.js"));

// SITE_ORIGIN is the URL emitted in the static sitemap — a separate variable
// from SITE_URL, which config.js uses as the User-Agent origin for open-data
// calls. Both default to the production origin https://kalinova.in.
const ORIGIN = (process.env.SITE_ORIGIN || "https://kalinova.in").replace(/\/+$/, "");
const OUT = path.join(__dirname, "..", "frontend", "sitemap.xml");

// Only pages that are genuinely meant to be indexed. Tool and account views are
// deliberately absent, and /stories is absent because it canonicalises to /blog.
const SITE_PAGES = [
    { path: "/", changefreq: "daily", priority: "1.0" },
    { path: "/blog", changefreq: "daily", priority: "0.9" },
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
        "  </url>",
    ]
        .filter(Boolean)
        .join("\n");

const today = new Date().toISOString().slice(0, 10);

async function main() {
    const [articles, categories] = await Promise.all([
        // status is the gate: a draft never reaches this file, so an unpublished
        // article disappears from search results on the next run.
        pool.query(`
            SELECT slug, published_at, created_at, updated_at
            FROM articles
            WHERE status = 'published' AND slug IS NOT NULL AND slug <> ''
            ORDER BY COALESCE(published_at, created_at) DESC
        `),
        pool.query(`
            SELECT c.slug,
                   c.display_order,
                   MAX(COALESCE(a.updated_at, a.published_at, a.created_at)) AS lastmod
            FROM categories c
            LEFT JOIN articles a
                   ON a.category_id = c.id
                  AND a.status = 'published'
            GROUP BY c.slug, c.display_order
            ORDER BY c.display_order ASC
        `),
    ]);

    const entries = SITE_PAGES.map(page =>
        urlEntry({
            loc: `${ORIGIN}${page.path}`,
            lastmod: today,
            changefreq: page.changefreq,
            priority: page.priority,
        })
    );

    for (const category of categories.rows) {
        // Newest story in the topic, so a topic page's lastmod reflects a real
        // content change rather than the date the file happened to be built.
        const lastmod = category.lastmod
            ? new Date(category.lastmod).toISOString().slice(0, 10)
            : today;
        entries.push(
            urlEntry({
                loc: `${ORIGIN}/category/${encodeURIComponent(category.slug)}`,
                lastmod,
                changefreq: "weekly",
                priority: "0.6",
            })
        );
    }

    for (const article of articles.rows) {
        // updated_at is maintained by a trigger in
        // database/schema-article-cms.sql, so editing a published article tells
        // search engines the content changed. The publication date is the
        // fallback for a row written before that column existed.
        const lastmod = article.updated_at || article.published_at || article.created_at;
        entries.push(
            urlEntry({
                loc: `${ORIGIN}/blog/${encodeURIComponent(article.slug)}`,
                lastmod: lastmod ? new Date(lastmod).toISOString() : undefined,
                changefreq: "monthly",
                priority: "0.8",
            })
        );
    }

    // A sitemap must not list the same URL twice.
    const seen = new Set();
    const deduped = entries.filter(entry => {
        const loc = entry.match(/<loc>(.*)<\/loc>/)[1];
        if (seen.has(loc)) return false;
        seen.add(loc);
        return true;
    });

    const xml =
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            ...deduped,
            "</urlset>",
            "",
        ].join("\n");

    fs.writeFileSync(OUT, xml, "utf8");

    console.log(`wrote ${deduped.length} URLs to ${path.relative(process.cwd(), OUT)}`);
    console.log(`  ${SITE_PAGES.length} static pages, ${categories.rows.length} topics, ${articles.rows.length} articles`);
    if (entries.length !== deduped.length) {
        console.log(`  dropped ${entries.length - deduped.length} duplicate(s)`);
    }

    await pool.end();
}

main().catch(async error => {
    console.error("generate-sitemap failed:", error.message);
    try {
        await pool.end();
    } catch {
        /* already closed */
    }
    process.exit(1);
});