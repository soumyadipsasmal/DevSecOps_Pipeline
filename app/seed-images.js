/**
 * KaliNova — Article image seeder
 *
 * Scores every photo catalogued in scripts/topic-images.tsv against every
 * article, then writes the best matches into article_images and points each
 * article's cover_image at its top-ranked photo. Safe to re-run: the table is
 * truncated first, so the assignment is rebuilt from scratch each time.
 *
 * Usage:
 *   npm run seed:images                  # default 300 images
 *   npm run seed:images -- --total 240   # fewer images
 *   npm run seed:images -- --dry-run     # report the plan, write nothing
 */

require("dotenv").config();

const pool = require("./db");
const {
    assignImages,
    buildAltText,
    defaultTsvPath,
    parseTsv,
    prepareImages,
} = require("./article-images");

const CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS article_images (
        id SERIAL PRIMARY KEY,
        article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        position INTEGER NOT NULL,
        title TEXT,
        alt_text TEXT,
        creator TEXT,
        license TEXT,
        source TEXT,
        topic_slug VARCHAR(100),
        score NUMERIC(8, 4),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (article_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_article_images_article_id
        ON article_images(article_id, position ASC);
`;

function parseArgs(argv) {
    const args = { total: 300, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--total" || arg === "-n") {
            args.total = parseInt(argv[++i], 10);
        } else if (arg.startsWith("--total=")) {
            args.total = parseInt(arg.split("=")[1], 10);
        } else if (arg === "--dry-run") {
            args.dryRun = true;
        }
    }
    if (!Number.isFinite(args.total) || args.total <= 0) {
        args.total = 300;
    }
    return args;
}

async function fetchArticles() {
    const { rows } = await pool.query(`
        SELECT
            articles.id,
            articles.title,
            articles.content,
            articles.cover_image,
            categories.slug AS category_slug,
            categories.name AS category_name
        FROM articles
        JOIN users ON articles.author_id = users.id
        LEFT JOIN categories ON articles.category_id = categories.id
        WHERE articles.status = 'published'
        ORDER BY articles.id ASC
    `);
    return rows;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const tsvPath = defaultTsvPath();

    const images = prepareImages(parseTsv(tsvPath));
    if (!images.length) {
        throw new Error(`No images catalogued in ${tsvPath}`);
    }

    const articles = await fetchArticles();
    if (!articles.length) {
        throw new Error("No published articles found. Run the seed scripts first.");
    }

    const wanted = Math.min(args.total, images.length);
    if (wanted < args.total) {
        console.log(`Only ${images.length} images catalogued; capping total at ${wanted}`);
    }

    const { assignments, imageCount, categoryQuota, articleQuota } = assignImages({
        articles,
        images,
        totalWanted: wanted,
    });

    console.log(`\ncatalogue : ${images.length} photos from ${tsvPath}`);
    console.log(`articles  : ${articles.length}`);
    console.log(`assigned  : ${imageCount} unique images\n`);

    for (const { article, images: list } of assignments) {
        const label = article.category_slug || "uncategorised";
        console.log(
            `  #${String(article.id).padStart(3)} ${label.padEnd(13)} ` +
            `${String(list.length).padStart(3)}/${articleQuota.get(article.id) || 0}  ${article.title.slice(0, 52)}`
        );
        for (const pair of list.slice(0, 3)) {
            console.log(`         ${pair.score.toFixed(2).padStart(6)}  ${pair.image.fileName}  ${(pair.image.title || "").slice(0, 46)}`);
        }
        if (list.length > 3) console.log(`         ... ${list.length - 3} more`);
    }

    console.log("\ncategory quota:");
    for (const [slug, quota] of [...categoryQuota].sort()) {
        console.log(`  ${slug.padEnd(13)} ${quota}`);
    }

    if (args.dryRun) {
        console.log("\ndry run: nothing written.");
        await pool.end();
        return;
    }

    await pool.query(CREATE_TABLE_SQL);
    await pool.query("TRUNCATE article_images RESTART IDENTITY");

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const insertImage = `
            INSERT INTO article_images
                (article_id, file_path, position, title, alt_text, creator, license, source, topic_slug, score)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;
        const setCover = "UPDATE articles SET cover_image = $1 WHERE id = $2";

        let rows = 0;
        for (const { article, images: list } of assignments) {
            if (!list.length) continue;

            for (let i = 0; i < list.length; i++) {
                const pair = list[i];
                await client.query(insertImage, [
                    article.id,
                    pair.image.filePath,
                    i + 1,
                    pair.image.title || null,
                    buildAltText(pair.image, article),
                    pair.image.creator || null,
                    pair.image.license || null,
                    pair.image.source || null,
                    pair.image.topicSlug || null,
                    pair.score.toFixed(4),
                ]);
                rows++;
            }

            // Cover is the strongest match, so the card and the gallery agree.
            await client.query(setCover, [list[0].image.filePath, article.id]);
        }

        await client.query("COMMIT");
        console.log(`\nwrote ${rows} article_images rows and updated ${assignments.filter(a => a.images.length).length} cover images`);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    await pool.end();
}

main().catch(async error => {
    console.error("seed-images failed:", error.message);
    try { await pool.end(); } catch {}
    process.exit(1);
});