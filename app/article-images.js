/**
 * KaliNova — Article image relevancy scoring
 *
 * Matches the freely-licensed photos catalogued in scripts/topic-images.tsv
 * against the articles that reference them. Used by seed-images.js.
 */

const path = require("path");
const fs = require("fs");

/* Words that carry no signal when comparing a photo caption to an article. */
const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am",
  "an", "and", "any", "are", "as", "at", "be", "because", "been", "before",
  "being", "below", "between", "both", "but", "by", "can", "cannot", "could",
  "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from",
  "further", "had", "has", "have", "having", "he", "her", "here", "hers",
  "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it",
  "its", "itself", "just", "me", "more", "most", "my", "myself", "no", "nor",
  "not", "now", "of", "off", "on", "once", "only", "or", "other", "ought",
  "our", "ours", "ourselves", "out", "over", "own", "same", "she", "should",
  "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "would", "you", "your", "yours", "yourself", "yourselves", "will", "one",
  "two", "new", "old", "first", "last", "next", "many", "much", "part", "way",
  "even", "well", "back", "still", "much", "lot", "get", "got", "make", "made",
  "read", "full", "com", "www", "https", "http", "html", "jpg", "jpeg", "png",
]);

/* Extra search vocabulary per category. The photo captions are short, so the
   article words alone rarely line up; these terms bridge the two. */
const CATEGORY_KEYWORDS = {
    bollywood: [
        "bollywood", "hindi", "film", "movie", "cinema", "actor", "actress",
        "star", "song", "trailer", "premiere", "director", "cast", "script",
        "box", "office", "sequel", "shoot", "debut", "ensemble", "feature",
        "screening", "poster", "projector", "release", "studio", "character",
    ],
    tollywood: [
        "tollywood", "telugu", "andhra", "hyderabad", "tamil", "kannada",
        "malayalam", "south", "temple", "festival", "dubbed", "regional",
        "andhra", "pradesh", "deccan", "cinema", "film", "industry",
    ],
    fashion: [
        "fashion", "style", "clothing", "clothes", "dress", "saree", "lehenga",
        "textile", "weaving", "weave", "embroidery", "embroidered", "runway",
        "model", "boutique", "garment", "fabric", "tailor", "designer",
        "jewellery", "jewelry", "accessory", "accessories", "outfit", "wear",
        "cotton", "silk", "sustainable", "supply", "chain",
    ],
    "latest-news": [
        "news", "newsroom", "newspaper", "press", "conference", "government",
        "parliament", "city", "traffic", "market", "crowd", "protest",
        "election", "minister", "report", "headline", "telecommunication",
        "street", "announcement", "official",
    ],
    wildlife: [
        "tiger", "elephant", "leopard", "rhino", "rhinoceros", "bird", "deer",
        "forest", "sanctuary", "butterfly", "insect", "animal", "wildlife",
        "jungle", "migration", "migratory", "wetland", "species", "snake",
        "frog", "owl", "national", "park", "camera", "trap", "habitat", "fauna",
    ],
    travel: [
        "travel", "train", "journey", "mountain", "himalaya", "himalayan", "taj",
        "beach", "river", "boat", "backwater", "backwaters", "monsoon", "island",
        "landscape", "valley", "lake", "station", "kerala", "city", "street",
        "temple", "bridge", "sunset", "horizon", "explore", "destination",
    ],
};

/* Relative pull of each signal towards the final score. */
const WEIGHT_TOPIC_MATCH = 4;
const WEIGHT_TITLE_TOKEN = 2.5;
const WEIGHT_BODY_TOKEN = 1;
const WEIGHT_CATEGORY_TERM = 1.75;

function normaliseToken(token) {
    // Collapse simple plurals so "posters" and "poster" are one term.
    if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (token.length > 3 && token.endsWith("es") && !token.endsWith("ses")) {
        return token.slice(0, -2);
    }
    if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
        return token.slice(0, -1);
    }
    return token;
}

function tokenize(text) {
    if (!text) return [];
    const tokens = String(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const out = [];
    for (const token of tokens) {
        if (token.length < 3) continue;
        if (STOPWORDS.has(token)) continue;
        const folded = normaliseToken(token);
        if (STOPWORDS.has(folded)) continue;
        out.push(folded);
    }
    return out;
}

/**
 * Inverse document frequency over the photo corpus, so a caption word shared by
 * a third of the photos ("back", "view", "india") counts for much less than a
 * word that pins one photo down ("tiger", "lehenga").
 */
function buildIdf(docs) {
    const df = new Map();
    for (const tokens of docs) {
        for (const token of new Set(tokens)) {
            df.set(token, (df.get(token) || 0) + 1);
        }
    }
    const total = docs.length || 1;
    const idf = new Map();
    for (const [token, count] of df) {
        idf.set(token, Math.log((total + 1) / (count + 0.5)));
    }
    return idf;
}

/* Parse the Openverse attribution TSV into usable records. */
function parseTsv(tsvPath) {
    const raw = fs.readFileSync(tsvPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) return [];

    const header = lines[0].split("\t");
    const col = name => header.indexOf(name);

    const fileIdx = col("file");
    if (fileIdx === -1) {
        throw new Error(`${tsvPath} has no "file" column`);
    }
    const titleIdx = col("title");
    const creatorIdx = col("creator");
    const licenseIdx = col("license");
    const sourceIdx = col("source");

    const records = [];
    for (const line of lines.slice(1)) {
        const parts = line.split("\t");
        const filePath = (parts[fileIdx] || "").trim();
        if (!filePath) continue;

        // /assets/topics/<topic>/<nn>.jpg
        const topicMatch = filePath.match(/^\/assets\/topics\/([^/]+)\//);
        const fileName = filePath.split("/").pop();

        records.push({
            filePath,
            fileName,
            topicSlug: topicMatch ? topicMatch[1] : null,
            title: titleIdx >= 0 ? (parts[titleIdx] || "").trim() : "",
            creator: creatorIdx >= 0 ? (parts[creatorIdx] || "").trim() : "",
            license: licenseIdx >= 0 ? (parts[licenseIdx] || "").trim() : "",
            source: sourceIdx >= 0 ? (parts[sourceIdx] || "").trim() : "",
        });
    }
    return records;
}

function resolveTsvPath() {
    const candidates = [
        process.env.IMAGE_TSV,
        path.join(__dirname, "..", "scripts", "topic-images.tsv"),
        "/seed-data/topic-images.tsv",
        path.join(__dirname, "..", "..", "scripts", "topic-images.tsv"),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`topic-images.tsv not found; looked in: ${candidates.join(", ")}`);
}

function prepareImages(records) {
    const docs = records.map(r => tokenize(`${r.title} ${r.creator}`));
    const idf = buildIdf(docs);
    return records.map((record, i) => ({
        ...record,
        tokens: docs[i],
        tokenSet: new Set(docs[i]),
    }));
}

function prepareArticle(article) {
    const categorySlug = article.category_slug || "";
    const categoryName = article.category_name || "";
    const extra = CATEGORY_KEYWORDS[categorySlug] || [];

    return {
        ...article,
        categorySlug,
        titleTokens: tokenize(article.title),
        bodyTokens: tokenize(article.content),
        categoryTerms: new Set(tokenize([categorySlug, categoryName, ...extra].join(" "))),
    };
}

/** Score one prepared image against one prepared article. */
function scoreImage(image, article, idf) {
    let score = 0;

    if (image.topicSlug && image.topicSlug === article.categorySlug) {
        score += WEIGHT_TOPIC_MATCH;
    }

    const shared = [];
    for (const token of image.tokenSet) {
        if (article.titleTokens.includes(token)) shared.push(token);
    }
    for (const token of shared) {
        score += WEIGHT_TITLE_TOKEN * (idf.get(token) || 1);
    }

    for (const token of image.tokenSet) {
        if (article.bodyTokens.includes(token)) {
            score += WEIGHT_BODY_TOKEN * (idf.get(token) || 1);
        }
    }

    for (const token of image.tokenSet) {
        if (article.categoryTerms.has(token)) {
            score += WEIGHT_CATEGORY_TERM;
        }
    }

    return score;
}

/**
 * Split `total` across `groups` in proportion to `weights`, largest remainder
 * first, so the parts sum to exactly `total`.
 */
function apportion(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!sum) return weights.map(() => 0);

    const exact = weights.map(w => (total * w) / sum);
    const parts = exact.map(v => Math.floor(v));
    let remainder = total - parts.reduce((a, b) => a + b, 0);

    const order = exact
        .map((value, index) => ({ index, frac: value - Math.floor(value) }))
        .sort((a, b) => b.frac - a.frac || a.index - b.index);

    for (const { index } of order) {
        if (remainder <= 0) break;
        parts[index] += 1;
        remainder -= 1;
    }
    return parts;
}

/**
 * Assign exactly `totalWanted` images across `articles`, scored by relevancy and
 * with every image used at most once.
 *
 * A story only ever receives photos from its own topic folder. Caps are set per
 * category first (in proportion to the photos available for that topic) and
 * then per article within the category, so one long-running story cannot absorb
 * a whole topic. A greedy pass over the highest-scoring pairs fills the caps,
 * then a second pass tops up any short article from what is left in its own
 * category. An image is never reused, and topics never borrow from each other.
 */
function assignImages({ articles, images, totalWanted }) {
    const idf = buildIdf(images.map(i => i.tokens));
    const prepared = articles.map(prepareArticle);

    const articlesByCategory = new Map();
    for (const article of prepared) {
        const list = articlesByCategory.get(article.categorySlug) || [];
        list.push(article);
        articlesByCategory.set(article.categorySlug, list);
    }

    // How many photos each topic folder can actually contribute.
    const availableByCategory = new Map();
    for (const image of images) {
        const key = image.topicSlug || "";
        availableByCategory.set(key, (availableByCategory.get(key) || 0) + 1);
    }

    const categoryKeys = [...articlesByCategory.keys()];
    const categoryQuota = new Map();
    apportion(
        totalWanted,
        categoryKeys.map(k => availableByCategory.get(k) || 0)
    ).forEach((value, i) => categoryQuota.set(categoryKeys[i], value));

    const articleQuota = new Map();
    for (const [categorySlug, list] of articlesByCategory) {
        apportion(categoryQuota.get(categorySlug) || 0, list.map(() => 1))
            .forEach((value, i) => articleQuota.set(list[i].id, value));
    }

    // Every (article, image) pair, best first. A story only ever draws from its own
    // topic folder: those photos were fetched with category-specific search
    // terms, so they are relevant by construction. Keyword scoring then only
    // decides the order within that folder. Zero-score pairs are kept so a
    // category with a thin pool can still be filled to its quota.
    const pairs = [];
    for (const article of prepared) {
        for (const image of images) {
            if (image.topicSlug !== article.categorySlug) continue;
            pairs.push({ article, image, score: scoreImage(image, article, idf) });
        }
    }
    pairs.sort((a, b) =>
        b.score - a.score ||
        a.article.id - b.article.id ||
        a.image.filePath.localeCompare(b.image.filePath)
    );

    const used = new Set();
    const takenByArticle = new Map(prepared.map(a => [a.id, 0]));
    const takenByCategory = new Map(categoryKeys.map(k => [k, 0]));
    const assignments = new Map(prepared.map(a => [a.id, []]));

    const place = pair => {
        const { article, image } = pair;
        if (used.has(image.filePath)) return false;
        if ((takenByArticle.get(article.id) || 0) >= (articleQuota.get(article.id) || 0)) return false;
        const key = article.categorySlug;
        if ((takenByCategory.get(key) || 0) >= (categoryQuota.get(key) || 0)) return false;
        used.add(image.filePath);
        takenByArticle.set(article.id, (takenByArticle.get(article.id) || 0) + 1);
        takenByCategory.set(key, (takenByCategory.get(key) || 0) + 1);
        assignments.get(article.id).push(pair);
        return true;
    };

    for (const pair of pairs) {
        if (used.size >= totalWanted) break;
        place(pair);
    }

    // Caps were unreachable for some article (its category ran out of unused
    // photos). Top up from whatever is still free in the same category so the
    // per-category quota still balances, instead of letting one topic swell.
    for (const article of prepared) {
        const list = assignments.get(article.id);
        const key = article.categorySlug;
        while ((takenByArticle.get(article.id) || 0) < (articleQuota.get(article.id) || 0)) {
            if ((takenByCategory.get(key) || 0) >= (categoryQuota.get(key) || 0)) break;
            const spare = images.find(img => !used.has(img.filePath) && img.topicSlug === key);
            if (!spare) break;
            used.add(spare.filePath);
            takenByArticle.set(article.id, takenByArticle.get(article.id) + 1);
            takenByCategory.set(key, takenByCategory.get(key) + 1);
            list.push({ article, image: spare, score: 0 });
        }
    }

    const result = [];
    for (const article of prepared) {
        const list = assignments.get(article.id) || [];
        list.sort((a, b) => b.score - a.score);
        result.push({ article, images: list });
    }

    return {
        assignments: result,
        imageCount: used.size,
        articleQuota,
        categoryQuota,
    };
}

function buildAltText(image, article) {
    if (image.title) return image.title;
    const topic = image.topicSlug || article.categorySlug || "story";
    return `${article.categoryName || topic} photograph`;
}

function defaultTsvPath() {
    return resolveTsvPath();
}

module.exports = {
    assignImages,
    buildAltText,
    defaultTsvPath,
    parseTsv,
    prepareImages,
    tokenize,
};