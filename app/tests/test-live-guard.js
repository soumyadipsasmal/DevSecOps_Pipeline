"use strict";

/**
 * KaliNova — live HTTP test guard (test:admin:live)
 *
 * test:admin:live drives a separately running server over HTTP and performs
 * full CMS create/edit/publish/upload/delete operations. The guard that runs
 * inside this suite cannot redirect the already-running server's database, so
 * before any write this module requires the operator to confirm:
 *
 *   - the target is a loopback address (localhost / 127.0.0.1 / ::1) — the
 *     public production site is never an acceptable target;
 *   - KALINOVA_LIVE_TEST_ENABLED=1 is set explicitly, meaning the operator has
 *     verified that the server listening on BASE_URL is a test-only server
 *     whose database is the disposable test database;
 *   - a validated TEST_DATABASE_URL is configured (via test-db-guard), i.e. the
 *     operator has declared an isolated test database for destructive work.
 *
 * There is no bypass: missing, empty or contradicting configuration refuses.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertSafeLiveTarget() {
  const baseUrl = String(process.env.BASE_URL || "http://localhost:3007").replace(/\/+$/, "");
  let hostname = null;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch (err) {
    hostname = null;
  }

  if (!hostname || !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      "test-live-guard: test:admin:live writes CMS rows over HTTP to the target " +
        "server and refuses to target anything other than a loopback test server " +
        "(BASE_URL=" +
        JSON.stringify(baseUrl) +
        "). Point BASE_URL at a local test-only server whose database is the " +
        "disposable test database."
    );
  }

  if (process.env.KALINOVA_LIVE_TEST_ENABLED !== "1") {
    throw new Error(
      "test-live-guard: set KALINOVA_LIVE_TEST_ENABLED=1 only after verifying the " +
        "server on BASE_URL uses the disposable test database. GitHub Actions sets " +
        "this for its disposable Compose stack (see .github/workflows)."
    );
  }

  // TEST_DATABASE_URL must be configured and validated: the operator has
  // declared an isolated test database for destructive work.
  require("./test-db-guard");
}

module.exports = { assertSafeLiveTarget };