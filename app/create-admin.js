"use strict";

/**
 * KaliNova — administrator bootstrap
 *
 * Creates the first administrator, or repairs an existing one. There is no
 * registration endpoint anywhere in this project: this script is the only way an
 * admin account comes into existence.
 *
 * The password is read from the environment and is never written to disk, never
 * printed, and never logged. Only its bcrypt hash reaches the database.
 *
 * Usage (from the app/ directory):
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a-long-unique-passphrase' npm run create-admin
 *
 * Behaviour
 *   - A new account is inserted with role 'admin' and is_active true.
 *   - An existing account with that email is promoted to admin and reactivated.
 *     Its password is only rewritten when it does not already match, so
 *     re-running the script after a password change does not undo it.
 *   - Re-running never creates a duplicate: the email is the unique key.
 */

require("dotenv").config();

const bcrypt = require("bcrypt");

const adminService = require("./admin-service");
const config = require("./config");
const pool = require("./db");

const MIN_PASSWORD_LENGTH = 12;

// A short deny list. A minimum length is the real control; this only catches
// the handful of values that pass a length check and are still worthless.
const WEAK_PASSWORDS = new Set([
  "password1234",
  "password123",
  "123456789012",
  "1234567890ab",
  "administrator",
  "changeme1234",
  "kalinova1234",
  "qwertyuiop12"
]);

function fail(message) {
  console.error(`\ncreate-admin failed: ${message}\n`);
  process.exit(1);
}

/** Usernames are display handles, so they are slugged and kept unique. */
function usernameFromEmail(email) {
  const local = email.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return local.slice(0, 50) || "administrator";
}

async function uniqueUsername(base) {
  const { rows } = await pool.query("SELECT 1 FROM users WHERE username = $1", [base]);
  if (rows.length === 0) return base;

  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base.slice(0, 46)}-${suffix}`;
    const taken = await pool.query("SELECT 1 FROM users WHERE username = $1", [candidate]);
    if (taken.rows.length === 0) return candidate;
  }
  return `${base.slice(0, 42)}-${Date.now().toString(36)}`;
}

async function main() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");

  if (!email) fail("ADMIN_EMAIL is not set.");
  if (!adminService.EMAIL_PATTERN.test(email) || email.length > 255) {
    fail("ADMIN_EMAIL is not a valid email address.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 200) {
    fail("ADMIN_PASSWORD must be 200 characters or fewer.");
  }
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    fail("ADMIN_PASSWORD is too easy to guess. Choose a longer passphrase.");
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const existing = await adminService.findAccountByEmail(email);

  if (!existing) {
    const username = await uniqueUsername(usernameFromEmail(email));

    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, session_version)
       VALUES ($1, $2, $3, 'admin', true, 1)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = 'admin',
             is_active = true,
             updated_at = NOW()
       RETURNING id, email, role, is_active, created_at`,
      [username, email, passwordHash]
    );

    const admin = rows[0];
    console.log(`\nAdministrator ready: ${admin.email} (id ${admin.id}, role ${admin.role})`);
    console.log("Sign in at /admin/login");
    return;
  }

  const alreadyAdmin = existing.role === "admin" && existing.is_active === true;
  const passwordMatches = adminService.BCRYPT_HASH_PATTERN.test(existing.password_hash || "")
    ? await bcrypt.compare(password, existing.password_hash)
    : false;

  const { rows } = await pool.query(
    `UPDATE users
        SET role = 'admin',
            is_active = true,
            password_hash = CASE WHEN $2::boolean THEN password_hash ELSE $3 END,
            session_version = session_version + 1,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, email, role, is_active`,
    [existing.id, passwordMatches, passwordHash]
  );

  const admin = rows[0];

  console.log(`\nAdministrator updated: ${admin.email} (id ${admin.id}, role ${admin.role})`);
  if (alreadyAdmin) {
    console.log("Role was already admin and active.");
  }
  console.log(
    passwordMatches
      ? "Password unchanged (it already matched). Existing sessions were invalidated."
      : "Password hash updated and existing sessions were invalidated."
  );
  console.log("Sign in at /admin/login");
}

main()
  .then(() => pool.end())
  .catch(async error => {
    // Connection errors are the common case, so name the likely cause.
    const hint =
      error.code === "ECONNREFUSED"
        ? "\nIs PostgreSQL running? Check the DB_* variables in app/.env."
        : "";

    console.error(`\ncreate-admin failed: ${error.message}${hint}\n`);
    try {
      await pool.end();
    } catch {
      // The pool may already be closed; nothing to do.
    }
    process.exit(1);
  });