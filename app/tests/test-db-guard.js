"use strict";

/**
 * KaliNova — test database isolation guard (fail-closed)
 *
 * The destructive suites (ads, SEO engine, SEO master, external, admin smoke)
 * write to the database they are pointed at. Loaded from app/, they would
 * otherwise inherit app/.env's DATABASE_URL — the production pool — and mutate
 * it. This module is required first by those suites and refuses to let them
 * guess where they may write:
 *
 *   - TEST_DATABASE_URL is REQUIRED. There is no environment bypass: CI=true,
 *     GITHUB_ACTIONS=true or any other variable never authorises destructive
 *     testing by itself (GitHub Actions still sets TEST_DATABASE_URL to its
 *     disposable Compose database, see .github/workflows).
 *   - The URL must parse with protocol          postgres|postgresql,
 *     a hostname, a (default-normalised) port, a database name and a username.
 *     Any missing or invalid component is a refusal.
 *   - The target must not share its endpoint with the DATABASE_URL read from
 *     app/.env. Endpoints compare on (port, hostname) with the Neon pooler
 *     marker normalised away, so a direct endpoint, its pooled alias and a
 *     differing default port all refuse. A different hostname is NECESSARY but
 *     not by itself evidence of physical separation: the operator must point at
 *     a genuinely throwaway database (a separate Neon branch, or a local
 *     disposable PostgreSQL).
 *   - On success, process.env.DATABASE_URL is replaced with the validated test
 *     target before ../db or ../server can be required, so every pool the suite
 *     (or anything it imports) opens is bound to the test database. dotenv
 *     never overrides an already-set variable, so later dotenv.config() calls
 *     cannot fall back to app/.env.
 *
 * Nothing here is printed, so no connection string ever reaches the log.
 */

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const PG_PROTOCOLS = new Set(["postgres", "postgresql"]);
const DEFAULT_PG_PORT = "5432";

/** The Neon pooler endpoint is <ep-id>-pooler.<region>.aws.neon.tech against the
 * direct <ep-id>.<region>.aws.neon.tech of the same branch. Normalising away the
 * "-pooler." marker lets the two spellings compare as the same branch endpoint.
 */
function poolerFreeHostname(hostname) {
  return String(hostname).replace(/-pooler\./gi, ".");
}

function parsePgIdentity(connectionString) {
  try {
    const url = new URL(connectionString);

    const protocol = url.protocol.slice(0, -1).toLowerCase();
    if (!PG_PROTOCOLS.has(protocol)) return null;

    const hostname = url.hostname.toLowerCase();
    const port = url.port || DEFAULT_PG_PORT;
    const database = decodeURIComponent(url.pathname.replace(/^\//, "")).toLowerCase();
    const username = url.username === "" ? null : decodeURIComponent(url.username).toLowerCase();

    if (!hostname || !database || !username || !/^\d+$/.test(port)) return null;
    return { protocol, hostname, port, database, username };
  } catch (err) {
    return null;
  }
}

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();
const productionUrl = String(process.env.DATABASE_URL || "").trim();

if (!testDatabaseUrl) {
  throw new Error(
    "test-db-guard: this suite writes to its database and refuses to guess which " +
      "one. Set TEST_DATABASE_URL to a genuinely separate disposable test database. " +
      "CI=true (or any other variable) does NOT bypass this check. See README " +
      "\u201CTest database isolation\u201D."
  );
}

const testIdentity = parsePgIdentity(testDatabaseUrl);
if (!testIdentity) {
  throw new Error(
    "test-db-guard: TEST_DATABASE_URL is not a valid PostgreSQL URL. It needs a " +
      "postgres:// or postgresql:// protocol, a hostname, a port (or the default), " +
      "a database name in the path, and a username. Protecting against copy/paste " +
      "mistakes is cheaper than a destructive test run."
  );
}

const productionIdentity = productionUrl ? parsePgIdentity(productionUrl) : null;
if (productionUrl && !productionIdentity) {
  throw new Error(
    "test-db-guard: the DATABASE_URL read from app/.env is not a valid PostgreSQL " +
      "URL, so test vs production identity cannot be compared. Fix DATABASE_URL or " +
      "remove it before running destructive suites."
  );
}

if (productionIdentity) {
  const sameEndpoint =
    testIdentity.port === productionIdentity.port &&
    poolerFreeHostname(testIdentity.hostname) === poolerFreeHostname(productionIdentity.hostname);

  if (sameEndpoint) {
    throw new Error(
      "test-db-guard: TEST_DATABASE_URL points at the same database endpoint as " +
        "app/.env's DATABASE_URL (same port and hostname after Neon pooler " +
        "normalisation — database name and username are not enough to separate " +
        "them). Use a genuinely separate database on a different host."
    );
  }

  // A different hostname is necessary but not proof of physical separation. The
  // guard deliberately does not claim otherwise: it requires the operator to
  // point TEST_DATABASE_URL at an explicitly configured throwaway database and
  // only refuses the endpoints it can prove are (or could be) shared.
}

// Bind the pool to the validated test target before any ../db import.
process.env.DATABASE_URL = testDatabaseUrl;