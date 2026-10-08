"use strict";

/**
 * KaliNova — URL redirect data access
 *
 * KaliNova publishes articles under /blog/<slug>. When an editor renames a
 * published slug the CMS writes a 301 from the old URL to the new one, and an
 * administrator can manage the table by hand on /admin/redirects.
 *
 * Rules that hold for every row:
 *   - source_path is a normalised site path (leading slash, no query string,
 *     no fragment, no trailing slash) on the public surface — never /api,
 *     /admin, /assets or /go
 *   - destination_path is either another normalised site path or an absolute
 *     http(s) URL; a destination pointing back at the site must also avoid the
 *     reserved prefixes, so a redirect can never shunt a visitor into the admin
 *     area or a JSON API
 *   - everything is parameterised; the unique index on source_path is the
 *     real duplicate guard and the validation below is the friendly first line
 */

const pool = require("./db");
const config = require("./config");

/* Paths the public redirect surface must never touch. A redirect cannot claim
 * one of these as a source, and a same-site destination must not point at one.
 * /go is the affiliate redirect surface, /assets serves static files, /admin
 * and /api are the management and JSON surfaces, /health is the liveness probe.
 */
const RESERVED_PREFIXES = ["/api", "/admin", "/assets", "/go", "/health"];

const MAX_PATH_LENGTH = 2000;

/**
 * Strip a leading "/blog/" from a slug when present, so callers can hand the
 * service either a bare slug or the path it appeared at.
 */
function slugValue(value) {
  const raw = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  return raw.replace(/^blog\//i, "");
}

/** Collapse // and strip trailing slashes, keeping the leading one. */
function tidySitePath(value) {
  const cleaned = String(value || "")
    .replace(/[?#].*$/, "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  if (cleaned === "/") return "/";
  return cleaned.replace(/\/+$/, "") || "/";
}

function isReserved(path) {
  const lower = path.toLowerCase();
  return RESERVED_PREFIXES.some(prefix => lower === prefix || lower.startsWith(`${prefix}/`));
}

/**
 * Normalise a public site path, or return null when it cannot be used.
 * A source path is where a redirect starts, so query strings, fragments and
 * trailing slashes are all stripped to keep one canonical row per URL.
 */
function normalizeSourcePath(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;

  const path = tidySitePath(raw);
  if (path === "/") return null;
  if (!path.startsWith("/")) return null;
  if (path.length > MAX_PATH_LENGTH) return null;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(path)) return null;
  if (isReserved(path)) return null;

  return path;
}

/**
 * Normalise a destination. A same-site path follows the same rules as the
 * source; an absolute http(s) URL is allowed as-is unless it points back at the
 * configured site origin, in which case it is re-checked as a site path so a
 * redirect cannot land on /admin from the outside either.
 */
function normalizeDestinationPath(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;

  if (raw.startsWith("/")) {
    return normalizeSourcePath(raw);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;

  try {
    const origin = new URL(config.siteOrigin);
    if (parsed.hostname === origin.hostname) {
      const path = parsed.pathname.replace(/\/+$/, "");
      if (path === "") return null;
      if (isReserved(path)) return null;
      return path !== "/" ? path : "/";
    }
  } catch {
    // Unknown site origin; fall through to the plain remote-URL rule.
  }

  return parsed.toString().replace(/\/+$/, "");
}

/** 301 is the SEO default; 302 stays available for genuinely temporary moves. */
function normalizeStatusCode(value, fallback = 301) {
  const raw = value === undefined || value === null ? fallback : Number.parseInt(String(value), 10);
  return raw === 301 || raw === 302 ? raw : null;
}

/**
 * Validate a redirect submission.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {number|null} [options.id] existing row id when editing (dedupe
 *   against itself)
 * @returns {{ ok: boolean, values?: object, errors?: object }}
 */
async function validateRedirect(input, options = {}) {
  const body = input && typeof input === "object" ? input : {};
  const errors = {};

  const sourcePath = normalizeSourcePath(body.source_path ?? body.sourcePath ?? "");
  if (!sourcePath) {
    errors.source_path =
      "Use a public site path such as /blog/old-title. Admin, API, asset and affiliate paths are reserved.";
  }

  const destinationPath = normalizeDestinationPath(body.destination_path ?? body.destinationPath ?? "");
  if (!destinationPath) {
    errors.destination_path =
      "Use a site path or an absolute https:// URL. Admin, API and asset paths are reserved.";
  }

  if (sourcePath && destinationPath) {
    if (String(sourcePath).toLowerCase() === String(destinationPath).toLowerCase()) {
      errors.destination_path = "A redirect cannot point at its own source.";
    } else if (isReserved(destinationPath.toLowerCase())) {
      errors.destination_path = "The destination points at a reserved path.";
    }
  }

  const statusCode = normalizeStatusCode(body.status_code ?? body.statusCode, 301);
  if (statusCode === null) {
    errors.status_code = "Status code must be 301 or 302.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // The unique index is the real guard; this friendly check reports a clash
  // before the insert can fail with a raw driver error.
  const exists = await pool.query(
    "SELECT id FROM redirects WHERE source_path = $1 AND ($2::integer IS NULL OR id <> $2) LIMIT 1",
    [sourcePath, options.id ?? null]
  );
  if (exists.rows.length > 0) {
    errors.source_path = "A redirect for this source already exists.";
    return { ok: false, errors };
  }

  return {
    ok: true,
    values: {
      sourcePath,
      destinationPath,
      statusCode,
      isActive: body.is_active !== undefined
        ? Boolean(body.is_active) || String(body.is_active) === "1" || String(body.is_active) === "on"
        : true
    }
  };
}

const REDIRECT_COLUMNS = `
    id,
    source_path,
    destination_path,
    status_code,
    is_active,
    created_at,
    updated_at
  `;

/** All redirects, newest change first. */
async function listRedirects({ search = "" } = {}) {
  const needle = String(search || "").trim().slice(0, 120);
  if (needle) {
    const { rows } = await pool.query(
      `SELECT ${REDIRECT_COLUMNS}
         FROM redirects
        WHERE source_path ILIKE '%' || $1 || '%'
           OR destination_path ILIKE '%' || $1 || '%'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1000`,
      [needle]
    );
    return rows;
  }

  const { rows } = await pool.query(
    `SELECT ${REDIRECT_COLUMNS} FROM redirects ORDER BY updated_at DESC, id DESC LIMIT 1000`
  );
  return rows;
}

/** One redirect for the edit form. */
async function getRedirect(id) {
  const parsed = Number.parseInt(String(id), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;

  const { rows } = await pool.query(
    `SELECT ${REDIRECT_COLUMNS} FROM redirects WHERE id = $1`,
    [parsed]
  );
  return rows[0] || null;
}

/** Create a redirect after validation. */
async function createRedirect(values) {
  const { rows } = await pool.query(
    `INSERT INTO redirects (source_path, destination_path, status_code, is_active)
     VALUES ($1, $2, $3, $4)
     RETURNING ${REDIRECT_COLUMNS.replace(/\n\s+/g, " ")}`,
    [values.sourcePath, values.destinationPath, values.statusCode, values.isActive]
  );
  return rows[0];
}

/** Update a redirect after validation. */
async function updateRedirect(id, values) {
  const parsed = Number.parseInt(String(id), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;

  const { rows } = await pool.query(
    `UPDATE redirects
        SET source_path = $2,
            destination_path = $3,
            status_code = $4,
            is_active = $5
      WHERE id = $1
      RETURNING ${REDIRECT_COLUMNS.replace(/\n\s+/g, " ")}`,
    [parsed, values.sourcePath, values.destinationPath, values.statusCode, values.isActive]
  );
  return rows[0] || null;
}

/** Delete one redirect. */
async function deleteRedirect(id) {
  const parsed = Number.parseInt(String(id), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;

  const { rows } = await pool.query(
    "DELETE FROM redirects WHERE id = $1 RETURNING id, source_path, destination_path",
    [parsed]
  );
  return rows[0] || null;
}

/**
 * Resolve one path for the public redirect middleware. Only active rows answer;
 * paused redirects fall through to their normal routes.
 */
async function findBySource(sourcePath) {
  const path = tidySitePath(sourcePath);
  if (path === "/" || path === "" || isReserved(path)) return null;

  const { rows } = await pool.query(
    `SELECT source_path, destination_path, status_code
       FROM redirects
      WHERE source_path = $1 AND is_active = true
      LIMIT 1`,
    [path]
  );
  return rows[0] || null;
}

/**
 * Write the 301 the CMS owes a published article whose slug just changed.
 *
 * Only runs for published articles (their old URL is in backlinks and feeds by
 * then) and only when the slug actually differs. A conflict is a no-op: the
 * administrator may already own that source, and it must not be overwritten.
 *
 * @returns {Promise<{created: boolean, redirect: object|null}>}
 */
async function recordSlugChange({ articleId = null, oldSlug = "", newSlug = "" } = {}) {
  const oldValue = slugValue(oldSlug);
  const newValue = slugValue(newSlug);

  if (articleId === null || !oldValue || !newValue || oldValue.toLowerCase() === newValue.toLowerCase()) {
    return { created: false, redirect: null };
  }

  const sourcePath = `/blog/${oldValue}`;
  const destinationPath = `/blog/${newValue}`;

  const { rows } = await pool.query(
    `INSERT INTO redirects (source_path, destination_path, status_code)
     VALUES ($1, $2, 301)
     ON CONFLICT (source_path) DO NOTHING
     RETURNING id, source_path, destination_path, status_code, is_active`,
    [sourcePath, destinationPath]
  );

  if (rows.length === 0) return { created: false, redirect: null };
  return { created: true, redirect: rows[0] };
}

module.exports = {
  RESERVED_PREFIXES,
  createRedirect,
  deleteRedirect,
  findBySource,
  getRedirect,
  listRedirects,
  normalizeDestinationPath,
  normalizeSourcePath,
  normalizeStatusCode,
  recordSlugChange,
  slugValue,
  updateRedirect,
  validateRedirect
};