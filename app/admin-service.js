"use strict";

/**
 * KaliNova — admin data access
 *
 * The project already has a `users` table (it stores the site author's articles
 * and a bcrypt `password_hash`), so admin accounts live there too rather than in
 * a second, parallel identity table. The migration in
 * database/schema-admin-auth.sql adds the columns this module needs:
 *
 *   role             'admin' grants access to /admin; anything else does not
 *   is_active        a disabled account cannot sign in and loses its sessions
 *   session_version  bumped on logout so existing cookies stop validating
 *   last_login_at    audit trail of the last successful sign-in
 *   updated_at       last row change
 *
 * Every query is parameterised. Only the columns listed below are ever selected,
 * so `password_hash` cannot reach a response by accident.
 */

const crypto = require("crypto");

const bcrypt = require("bcrypt");

const config = require("./config");
const pool = require("./db");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const PUBLIC_COLUMNS = "id, email, username, role, is_active, session_version, last_login_at, created_at";
const SECRET_COLUMNS = `${PUBLIC_COLUMNS}, password_hash`;

/**
 * A bcrypt hash of a random value, used when no account matches so that an
 * unknown email costs the same time as a wrong password. Generated once per
 * process and never written anywhere.
 */
let decoyHash = null;
let decoyPromise = null;

async function getDecoyHash() {
  if (decoyHash) return decoyHash;
  if (!decoyPromise) {
    decoyPromise = bcrypt
      .hash(crypto.randomBytes(24).toString("hex"), config.bcryptRounds)
      .then(hash => {
        decoyHash = hash;
        return hash;
      })
      .finally(() => {
        decoyPromise = null;
      });
  }
  return decoyPromise;
}

/** Shape returned to callers. password_hash is deliberately absent. */
function sanitizeAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role
  };
}

async function getAccountById(id) {
  if (!Number.isInteger(id) || id <= 0) return null;

  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/** Active accounts only: a disabled admin loses access without waiting. */
async function getActiveAccount(id) {
  const account = await getAccountById(id);
  if (!account || account.is_active !== true) return null;
  return account;
}

async function findAccountByEmail(email) {
  const { rows } = await pool.query(
    `SELECT ${SECRET_COLUMNS} FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

/**
 * Validate login input. Returns either { ok: true, email, password } or
 * { ok: false, message } for malformed input only — never for a credential
 * failure, so the response cannot be used to probe for accounts.
 */
function validateCredentials(body) {
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (email === "" || password === "") {
    return { ok: false, message: "Enter your email address and password." };
  }
  if (email.length > 255 || !EMAIL_PATTERN.test(email)) {
    return { ok: false, message: "Enter a valid email address." };
  }
  if (password.length > 200) {
    return { ok: false, message: "Enter a valid password." };
  }

  return { ok: true, email, password };
}

/**
 * Check an email/password pair.
 *
 * Always performs exactly one bcrypt comparison, so response time does not
 * reveal whether the address exists. A failure is reported with one generic
 * reason: unknown address, wrong password, disabled account and non-admin role
 * are indistinguishable to the caller.
 */
async function authenticate(email, password) {
  const account = await findAccountByEmail(email);
  const decoy = await getDecoyHash();

  const storedHash =
    account && typeof account.password_hash === "string" && BCRYPT_HASH_PATTERN.test(account.password_hash)
      ? account.password_hash
      : decoy;

  const passwordMatches = await bcrypt.compare(password, storedHash);

  if (!account || !passwordMatches) return { ok: false, reason: "invalid-credentials" };
  if (account.is_active !== true) return { ok: false, reason: "invalid-credentials" };
  if (account.role !== "admin") return { ok: false, reason: "invalid-credentials" };

  return {
    ok: true,
    admin: sanitizeAdmin(account),
    // Kept out of the safe admin object above: it is only used to stamp the
    // session cookie, and is never sent to a client.
    sessionVersion: Number(account.session_version) || 1
  };
}

/** Audit trail for a successful sign-in. Never stores anything about the attempt itself. */
async function recordLogin(id) {
  await pool.query(
    "UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1",
    [id]
  );
}

/**
 * Invalidate every existing session cookie for an account. Called on logout:
 * the browser cookie is cleared *and* the token stops verifying, so a copied
 * cookie cannot be replayed.
 */
async function bumpSessionVersion(id) {
  await pool.query(
    "UPDATE users SET session_version = session_version + 1, updated_at = NOW() WHERE id = $1",
    [id]
  );
}

/* ==================================================================== */
/* Dashboard data                                                       */
/* ==================================================================== */

const RECENT_ARTICLES_LIMIT = 10;

/**
 * Counts and recent articles for the admin dashboard. Two independent queries
 * in parallel; both are plain SELECTs with constant SQL text.
 */
async function getDashboardSummary(limit = RECENT_ARTICLES_LIMIT) {
  const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : RECENT_ARTICLES_LIMIT;

  const [counts, categories, recent] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'published')::int AS published,
        COUNT(*) FILTER (WHERE status <> 'published')::int AS drafts
      FROM articles
    `),
    pool.query("SELECT COUNT(*)::int AS total FROM categories"),
    pool.query(`
      SELECT
        articles.id,
        articles.title,
        articles.slug,
        articles.status,
        articles.published_at,
        articles.created_at,
        articles.updated_at,
        categories.name AS category_name
      FROM articles
      LEFT JOIN categories ON categories.id = articles.category_id
      ORDER BY COALESCE(articles.updated_at, articles.published_at, articles.created_at) DESC, articles.id DESC
      LIMIT $1
    `, [safeLimit])
  ]);

  const row = counts.rows[0] || { total: 0, published: 0, drafts: 0 };

  return {
    stats: {
      totalArticles: row.total,
      publishedArticles: row.published,
      draftArticles: row.drafts,
      categories: categories.rows[0] ? categories.rows[0].total : 0
    },
    recentArticles: recent.rows
  };
}

module.exports = {
  BCRYPT_HASH_PATTERN,
  EMAIL_PATTERN,
  authenticate,
  bumpSessionVersion,
  findAccountByEmail,
  getAccountById,
  getActiveAccount,
  getDashboardSummary,
  recordLogin,
  sanitizeAdmin,
  validateCredentials
};