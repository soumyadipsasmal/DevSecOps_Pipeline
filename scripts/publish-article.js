"use strict";

const fs = require("fs");
const path = require("path");

const APP_DIR = path.join(__dirname, "..", "app");
const validation = require(path.join(APP_DIR, "article-validation"));

const DEFAULT_BASE_URL = "http://localhost:3007";
const SIMILARITY_CODE = "SIMILARITY_ACK_REQUIRED";

const TEXT_FIELDS = [
  "title",
  "slug",
  "meta_description",
  "meta_title",
  "excerpt",
  "content",
  "cover_image",
  "banner_alt",
  "canonical_url",
  "robots_index",
  "robots_follow",
  "og_title",
  "og_description",
  "og_image",
  "twitter_title",
  "twitter_description",
  "twitter_image",
  "schema_type",
  "focus_keyword",
  "scheduled_at",
  "status"
];

function parseArgs(argv) {
  const options = {
    file: "",
    baseUrl: "",
    envFile: "",
    dryRun: false,
    update: false,
    ackSimilarity: false,
    pretty: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === "--file" || arg === "-f") options.file = next();
    else if (arg === "--base-url") options.baseUrl = next();
    else if (arg === "--env-file") options.envFile = next();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--ack-similarity") options.ackSimilarity = true;
    else if (arg === "--pretty") options.pretty = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (!options.file) options.file = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
}

function parseEnvFile(text) {
  const out = {};
  if (typeof text !== "string") return out;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separator = withoutExport.indexOf("=");
    if (separator < 1) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }

  return out;
}

function loadPayload(raw) {
  if (raw === undefined || raw === null) {
    throw new Error("No payload provided. Pass a JSON file path as the first argument or with --file.");
  }

  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error(`Payload is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object.");
  }

  return parsed;
}

function localValidate(payload) {
  const status = String(payload.status || "draft").trim().toLowerCase();
  const hasCategoryName = categoryName(payload) !== "";
  const categoryId = payload.category_id ?? payload.categoryId ?? (hasCategoryName ? 1 : undefined);
  const result = validation.validateArticle(
    {
      title: payload.title,
      slug: payload.slug,
      category_id: categoryId,
      meta_description: payload.meta_description,
      content: payload.content,
      cover_image: payload.cover_image,
      banner_alt: payload.banner_alt,
      excerpt: payload.excerpt,
      meta_title: payload.meta_title,
      canonical_url: payload.canonical_url,
      robots_index: payload.robots_index,
      robots_follow: payload.robots_follow,
      og_title: payload.og_title,
      og_description: payload.og_description,
      og_image: payload.og_image,
      twitter_title: payload.twitter_title,
      twitter_description: payload.twitter_description,
      twitter_image: payload.twitter_image,
      schema_type: payload.schema_type,
      focus_keyword: payload.focus_keyword,
      scheduled_at: payload.scheduled_at,
      ads_enabled: payload.ads_enabled,
      status
    },
    { isDraft: status !== validation.STATUS_PUBLISHED && status !== validation.STATUS_SCHEDULED }
  );

  return result;
}

function categoryName(payload) {
  const raw = payload.category ?? payload.category_name ?? payload.categoryName;
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizeSources(payload) {
  const list = Array.isArray(payload.sources) ? payload.sources : [];
  const sources = [];

  for (let i = 0; i < list.length; i += 1) {
    const row = list[i] && typeof list[i] === "object" ? list[i] : {};
    const name = String(row.name ?? row.source_name ?? "").trim();
    const url = String(row.url ?? row.source_url ?? "").trim();
    const license = String(row.license ?? "").trim();
    const attribution = String(row.attribution ?? row.attribution_text ?? "").trim();
    if (name === "" && url === "" && license === "" && attribution === "") continue;
    sources.push({ name, url, license, attribution });
  }

  return sources;
}

function researchList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const raw = payload.research_refs ?? payload.research;
    return Array.isArray(raw) ? raw : [];
  }
  return [];
}

function normalizeResearch(payload) {
  const list = researchList(payload);
  const out = [];

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const sourceKey = String(raw.source_key ?? raw.sourceKey ?? "").trim().toLowerCase();
    const name = String(raw.name ?? raw.source_name ?? "").trim();
    if (!sourceKey || !name) continue;
    out.push({
      source_key: sourceKey,
      name,
      url: String(raw.url ?? raw.source_url ?? "").trim(),
      license: String(raw.license ?? "").trim(),
      text: String(raw.text ?? raw.reference_text ?? "")
    });
  }

  return out;
}

function normalizeTags(payload) {
  const raw = payload.tags ?? payload.tag_list ?? payload.tagList;
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const seen = new Set();
  const tags = [];
  for (const value of list) {
    const name = String(value ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(name);
  }
  return tags;
}

function buildRequestBody(payload, categoryId, { acknowledgeSimilarity = false } = {}) {
  const body = {};

  for (const field of TEXT_FIELDS) {
    if (payload[field] !== undefined && payload[field] !== null) body[field] = payload[field];
  }

  body.category_id = categoryId !== undefined && categoryId !== null ? categoryId : payload.category_id;

  const tags = normalizeTags(payload);
  if (tags.length) body.tags = tags;

  const sources = normalizeSources(payload);
  if (sources.length) {
    body.source_count = sources.length;
    sources.forEach((source, index) => {
      body[`source_name_${index}`] = source.name;
      body[`source_url_${index}`] = source.url;
      if (source.license) body[`source_license_${index}`] = source.license;
      if (source.attribution) body[`source_attribution_${index}`] = source.attribution;
    });
  }

  const research = normalizeResearch(payload);
  if (research.length) body.research_refs = JSON.stringify(research);

  if (acknowledgeSimilarity) body.acknowledge_similarity = "1";

  return body;
}

function resolveCategory(categories, payload) {
  const wantedId = payload.category_id ?? payload.categoryId;
  if (wantedId !== undefined && wantedId !== null && String(wantedId).trim() !== "") {
    const id = Number.parseInt(String(wantedId), 10);
    const match = categories.find(category => Number(category.id) === id);
    return match ? { id: match.id, name: match.name } : null;
  }

  const name = categoryName(payload);
  if (name === "") return null;
  const needle = name.toLowerCase();
  const match = categories.find(
    category =>
      String(category.name).toLowerCase() === needle ||
      String(category.slug).toLowerCase() === needle
  );
  return match ? { id: match.id, name: match.name } : null;
}

function findExactSlug(articles, slug) {
  const needle = String(slug || "").toLowerCase();
  if (!needle) return null;
  return articles.find(article => String(article.slug).toLowerCase() === needle) || null;
}

function createCookieJar() {
  const jar = new Map();

  function store(setCookieHeaders) {
    for (const entry of setCookieHeaders || []) {
      const [pair, ...attributes] = entry.split(";");
      const separator = pair.indexOf("=");
      if (separator < 1) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some(
        attribute =>
          /max-age\s*=\s*0/i.test(attribute.trim()) ||
          /expires\s*=\s*thu, 01 jan 1970/i.test(attribute.trim())
      );

      if (value === "" || expired) jar.delete(name);
      else jar.set(name, value);
    }
  }

  function header() {
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  function setCookieHeaders(response) {
    if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
    const single = response.headers.get("set-cookie");
    return single ? [single] : [];
  }

  return { jar, store, header, setCookieHeaders };
}

function createHttpClient(baseUrl, cookieJar) {
  async function request(pathname, { method = "GET", headers = {}, body } = {}) {
    const finalHeaders = { Accept: "application/json", ...headers };
    const cookie = cookieJar.header();
    if (cookie && !finalHeaders.Cookie) finalHeaders.Cookie = cookie;

    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: finalHeaders,
      body,
      redirect: "manual"
    });

    cookieJar.store(cookieJar.setCookieHeaders(response));

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return { status: response.status, headers: response.headers, text, json };
  }

  return { request };
}

function redact(value) {
  if (typeof value === "string" && value.length > 12) return `${value.slice(0, 4)}…[redacted]`;
  return "[redacted]";
}

async function login(http, email, password) {
  const csrfResponse = await http.request("/api/admin/csrf");
  const token = csrfResponse.json && csrfResponse.json.token;
  if (!token) throw new Error("Could not obtain a CSRF token from GET /api/admin/csrf.");

  const loginResponse = await http.request("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ email, password })
  });

  if (loginResponse.status !== 200 || !loginResponse.json || !loginResponse.json.admin) {
    const message = loginResponse.json && loginResponse.json.error ? loginResponse.json.error : "login failed";
    throw new Error(`Admin login failed (HTTP ${loginResponse.status}): ${message}`);
  }

  return { token, admin: loginResponse.json.admin };
}

async function resolveCategoryId(http, payload) {
  const response = await http.request("/api/admin/categories");
  const categories = response.json && Array.isArray(response.json.categories) ? response.json.categories : [];
  const match = resolveCategory(categories, payload);
  if (!match) {
    const wanted = categoryName(payload) || String(payload.category_id ?? "");
    const available = categories.map(category => category.name).join(", ");
    throw new Error(`Category "${wanted}" was not found. Existing categories: ${available}`);
  }
  return match;
}

async function findExistingBySlug(http, slug) {
  if (!slug) return null;
  const response = await http.request(`/api/admin/articles?search=${encodeURIComponent(slug)}&perPage=100`);
  const articles = response.json && Array.isArray(response.json.articles) ? response.json.articles : [];
  return findExactSlug(articles, slug);
}

async function submitCreate(http, body, { acknowledgeSimilarity }) {
  const response = await http.request("/api/admin/articles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (response.status === 422 && response.json && response.json.code === SIMILARITY_CODE && !acknowledgeSimilarity) {
    return { needsSimilarity: true, response };
  }

  if (response.status !== 201 || !response.json || !response.json.article) {
    const detail = response.json ? JSON.stringify(response.json) : response.text.slice(0, 300);
    throw new Error(`Create failed (HTTP ${response.status}): ${detail}`);
  }

  return { article: response.json.article };
}

async function submitUpdate(http, id, body) {
  const response = await http.request(`/api/admin/articles/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (response.status !== 200 || !response.json || !response.json.article) {
    const detail = response.json ? JSON.stringify(response.json) : response.text.slice(0, 300);
    throw new Error(`Update failed (HTTP ${response.status}): ${detail}`);
  }

  return response.json.article;
}

async function verify(http, article) {
  const result = { admin: null, public: null, sitemap: null };

  const adminResponse = await http.request(`/api/admin/articles/${article.id}`);
  if (adminResponse.status === 200 && adminResponse.json) result.admin = adminResponse.json.article;

  if (article.status === validation.STATUS_PUBLISHED && article.slug) {
    const publicResponse = await http.request(`/api/articles/slug/${encodeURIComponent(article.slug)}`);
    if (publicResponse.status === 200 && publicResponse.json) result.public = publicResponse.json;
    else result.sitemap = "article is published but not yet visible on /api/articles/slug";
  }

  return result;
}

function emit(payload, { pretty = false } = {}) {
  process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`);
}

function helpText() {
  return [
    "Usage: node scripts/publish-article.js <payload.json> [options]",
    "",
    "Options:",
    "  -f, --file <path>      Payload JSON file (or first positional argument)",
    "      --base-url <url>   Backend origin (default $BASE_URL or http://localhost:3007)",
    "      --env-file <path>  Optional KEY=VALUE file for BASE_URL/ADMIN_EMAIL/ADMIN_PASSWORD",
    "      --dry-run          Validate and build the request locally; make no HTTP calls",
    "      --update           Update an existing article when the slug already exists",
    "      --ack-similarity   Re-submit with acknowledge_similarity=1 when the server asks",
    "      --pretty           Pretty-print the JSON result",
    "  -h, --help             Show this help",
    "",
    "Environment: BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD (password is never printed)."
  ].join("\n");
}

async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  if (!options.file) {
    emit({ ok: false, stage: "config", errors: ["No payload file given. Provide a JSON path or use --file."] }, options);
    return 2;
  }

  const envFile = options.envFile ? parseEnvFile(fs.readFileSync(options.envFile, "utf8")) : {};
  const baseUrl = (options.baseUrl || envFile.BASE_URL || process.env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const email = envFile.ADMIN_EMAIL || process.env.ADMIN_EMAIL || "";
  const password = envFile.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "";

  const payload = loadPayload(fs.readFileSync(options.file, "utf8"));

  const local = localValidate(payload);
  const localErrors = [];
  if (!local.ok) {
    for (const [field, message] of Object.entries(local.errors || {})) localErrors.push(`${field}: ${message}`);
  }
  if (!payload.category_id && !categoryName(payload)) {
    localErrors.push("category: a category name or category_id is required");
  }

  if (localErrors.length) {
    emit({ ok: false, stage: "local-validation", errors: localErrors }, options);
    return 2;
  }

  if (options.dryRun) {
    const requestBody = buildRequestBody(payload, payload.category_id, {
      acknowledgeSimilarity: options.ackSimilarity
    });
    emit(
      {
        ok: true,
        stage: "dry-run",
        base_url: baseUrl,
        status: payload.status || "draft",
        slug: local.values.slug,
        request: requestBody
      },
      options
    );
    return 0;
  }

  if (!email || !password) {
    emit(
      { ok: false, stage: "config", errors: ["ADMIN_EMAIL and ADMIN_PASSWORD must be set (environment or --env-file)"] },
      options
    );
    return 2;
  }

  const cookieJar = createCookieJar();
  const http = createHttpClient(baseUrl, cookieJar);

  const session = await login(http, email, password);
  const category = await resolveCategoryId(http, payload);

  const requestBody = buildRequestBody(payload, category.id, {
    acknowledgeSimilarity: options.ackSimilarity
  });

  let article;
  let action;

  const existing = await findExistingBySlug(http, local.values.slug);
  if (existing) {
    if (!options.update) {
      emit(
        {
          ok: false,
          stage: "duplicate",
          errors: [`An article with slug "${existing.slug}" already exists (id ${existing.id}). Re-run with --update to replace it.`],
          article: { id: existing.id, slug: existing.slug, status: existing.status }
        },
        options
      );
      return 4;
    }
    article = await submitUpdate(http, existing.id, requestBody);
    action = "updated";
  } else {
    const result = await submitCreate(http, requestBody, { acknowledgeSimilarity: options.ackSimilarity });
    if (result.needsSimilarity) {
      const similarity = result.response.json.similarity || {};
      emit(
        {
          ok: false,
          stage: "similarity-ack-required",
          errors: ["The server requested a copy-similarity acknowledgement before publishing."],
          similarity,
          hint: "Re-run with --ack-similarity after reviewing the match, or publish as a draft."
        },
        options
      );
      return 3;
    }
    article = result.article;
    action = "created";
  }

  const verification = await verify(http, article);

  emit(
    {
      ok: true,
      stage: action,
      base_url: baseUrl,
      admin: { id: session.admin.id, email: session.admin.email },
      category,
      article: {
        id: article.id,
        slug: article.slug,
        status: article.status,
        public_url: article.public_url
      },
      verified: {
        admin_visible: Boolean(verification.admin),
        public_visible: Boolean(verification.public)
      }
    },
    options
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      emit({ ok: false, stage: "error", errors: [error.message] }, { pretty: false });
      process.exit(1);
    });
}

module.exports = {
  buildRequestBody,
  categoryName,
  createCookieJar,
  findExactSlug,
  helpText,
  loadPayload,
  localValidate,
  normalizeResearch,
  normalizeSources,
  normalizeTags,
  parseArgs,
  parseEnvFile,
  redact,
  resolveCategory
};
