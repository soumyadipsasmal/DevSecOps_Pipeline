"use strict";

/**
 * KaliNova — background jobs with a cross-process lock
 *
 * Periodic work (tile health checks, licence re-audit, housekeeping sweeps)
 * must never run twice when more than one app process is alive, and a crash
 * inside a job must never take the web server down. runExclusive() wraps a
 * job in a Postgres advisory lock: only one process at a time runs the job,
 * and any failure inside it is caught and reported instead of thrown.
 *
 * When the database is unreachable the job is simply skipped — background
 * work is optional, the site is not.
 */

const pool = require("./db");

/**
 * Run fn under a non-blocking advisory lock keyed by name.
 * Returns { skipped, result? } — never throws.
 */
async function runExclusive(name, fn) {
  const client = await pool.connect().catch(() => null);
  if (!client) {
    console.warn(`[jobs] ${name}: skipped (database unreachable)`);
    return { skipped: true };
  }

  try {
    const probe = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      ["job:" + name]
    );
    if (!probe.rows[0] || probe.rows[0].locked !== true) {
      return { skipped: true };
    }
    try {
      const result = await fn();
      return { skipped: false, result };
    } catch (error) {
      // A background crash is a log line, never a crashed server.
      console.warn(`[jobs] ${name}: failed:`, error && error.message ? error.message : error);
      return { skipped: false, error };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", ["job:" + name]);
    }
  } catch (error) {
    console.warn(`[jobs] ${name}: skipped:`, error && error.message ? error.message : error);
    return { skipped: true };
  } finally {
    client.release();
  }
}

module.exports = { runExclusive };