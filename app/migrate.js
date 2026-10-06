"use strict";

/**
 * KaliNova — database migration runner
 *
 * Applies the additive migrations the application needs, in order:
 *
 *   database/schema-admin-auth.sql   role / is_active / session_version on users
 *   database/schema-article-cms.sql  meta_description, banner_alt, updated_at,
 *                                    body_format on articles
 *   database/schema-ad-placements.sql ad_settings / ad_placements (seeded off)
 *   database/schema-external-data.sql external_data_cache (upstream lookups)
 *                                    + rss_items (headline strip)
 *
 * The project has no migration framework; the same files are mounted into
 * docker-entrypoint-initdb.d for a fresh volume, and every statement in them is
 * guarded, so running them against a database that was created by Docker Compose
 * is safe and idempotent.
 *
 * Usage (from the app/ directory):
 *   npm run migrate
 *
 * Public article data is never dropped or rewritten: the migrations only add
 * columns, constraints and indexes, plus one honest backfill of updated_at.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const pool = require("./db");

const DATABASE_DIR = path.join(__dirname, "..", "database");

const MIGRATIONS = [
  { file: "schema-admin-auth.sql", check: { table: "users", columns: ["role", "is_active", "session_version", "last_login_at", "updated_at"] } },
  { file: "schema-article-cms.sql", check: { table: "articles", columns: ["meta_description", "banner_alt", "body_format", "updated_at"] } },
  // Creates two new tables and seeds them disabled, so the presence of these
  // tables is not itself a monetisation switch.
  { file: "schema-ad-placements.sql", check: { table: "ad_placements", columns: ["placement_key", "placement_name", "is_enabled", "ad_type", "ad_slot"] } },
  // Server-side cache for the open-data lookups (Wikidata, Commons, Nominatim)
  // and the reviewed RSS headline store. Additive: two brand-new tables, no
  // existing table is read or rewritten by this file.
  { file: "schema-external-data.sql", check: { table: "rss_items", columns: ["source", "title", "description", "original_url", "published_at", "category", "guid", "created_at"] } },
  // Open-data automatic safety (Phase 2): integration_status (one row per
  // breaker/service) and integration_events (the stop + override log). Runs
  // after the external-data migration so the housekeeping sweep can also
  // purge expired cache rows. Additive: two new tables, guarded.
  { file: "schema-integration-safety.sql", check: { table: "integration_status", columns: ["service", "module", "is_enabled", "manual_off", "auto_state", "reason", "last_error"] } }
];

async function applyMigration(migration) {
  const file = path.join(DATABASE_DIR, migration.file);
  const sql = fs.readFileSync(file, "utf8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = ANY($2)`,
    [migration.check.table, migration.check.columns]
  );

  const present = rows.map(row => row.column_name);
  const missing = migration.check.columns.filter(name => !present.includes(name));

  if (missing.length) {
    throw new Error(`${migration.file}: ${migration.check.table} is still missing columns: ${missing.join(", ")}`);
  }

  console.log(`Applied database/${migration.file}`);
  console.log(`  ${migration.check.table} columns present: ${present.join(", ")}`);
}

async function main() {
  for (const migration of MIGRATIONS) {
    await applyMigration(migration);
  }

  const { rows: counts } = await pool.query(
    "SELECT COUNT(*)::int AS admins FROM users WHERE role = 'admin'"
  );

  console.log(`\nadministrator accounts: ${counts[0].admins}`);
  console.log("\nNext: ADMIN_EMAIL=... ADMIN_PASSWORD='...' npm run create-admin");
}

main()
  .then(() => pool.end())
  .catch(async error => {
    const hint =
      error.code === "ECONNREFUSED"
        ? "\nIs PostgreSQL running? Check the DB_* variables in app/.env."
        : "";
    console.error(`\nmigrate failed: ${error.message}${hint}\n`);
    try {
      await pool.end();
    } catch {
      // The pool may already be closed; nothing to do.
    }
    process.exit(1);
  });