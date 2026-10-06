"use strict";

/**
 * KaliNova — weekly re-check of stored Wikimedia Commons licences
 *
 * article_images rows that reference a file on Wikimedia Commons (the seeded
 * topic photos carry the curid URL in `source`) keep only the licence and
 * attribution they had when they were stored. A Commons file is not a
 * promise: its author can move it to a non-free licence, or the page can lose
 * the metadata. Once a week this job re-reads the current LicenceShortName
 * for every stored Commons file and, when the licence no longer passes the
 * site's allowlist (PD / CC0 / CC BY / CC BY-SA only), takes the row off the
 * public site. If the licence later returns to the allowlist, the row is
 * restored exactly as it was.
 *
 * Hiding is reversible by construction: the row's `source` keeps a HIDDEN:
 * prefix and `file_path` is never touched, so `/admin/integrations` could
 * undo any decision and the weekly job itself self-heals. Public galleries
 * filter rows whose source starts with HIDDEN:.
 *
 * The re-check is best-effort and budget aware: if the Commons breaker is
 * open or the request envelope is spent, the run stops and waits for the next
 * attempt. A failed run never errors the site and never hides a row on
 * uncertainty.
 */

const config = require("./config");
const pool = require("./db");
const { runExclusive } = require("./background-jobs");
const { run, recordEvent } = require("./circuit-breaker");
const { licenseAllowed } = require("./media-service");

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_INTERVAL_MS = 7 * DAY_MS;
const AUDIT_BATCH_MAX = 50;
const AUDIT_PAGE_SIZE = 200;

function isCommonsRow(row) {
  const haystack = `${String(row.source || "")} ${String(row.file_path || "")} ${String(row.title || "")}`;
  return /upload\.wikimedia\.org|commons\.wikimedia\.org/i.test(haystack);
}

/** Is this row currently taken off the public site? */
function currentlyHidden(row) {
  return String(row.source || "").startsWith("HIDDEN:") || String(row.file_path || "") === "HIDDEN";
}

/**
 * The opaque token that identifies a Commons file for re-checking, in a shape
 * the lookup can answer without ambiguity:
 *   "p:<pageid>" — from the curid=… the seed data stores, fetched by page id
 *   "f:<File:…>" — an explicit Commons file title, fetched by title
 * Returns null when the row gives no way to re-check the file.
 */
function commonsToken(row) {
  const curid = String(row.source || "").match(/[?&]curid=(\d{1,10})/i);
  if (curid) return "p:" + curid[1];
  if (/^File:/i.test(String(row.title || "").trim())) return "f:" + String(row.title).trim();
  return null;
}

/**
 * Decide what to do with one stored row given its current licence name.
 * Returns { action: "hide"|"restore"|"keep", reason, shortName }.
 */
function decide(hidden, { shortName }) {
  const name = String(shortName || "").trim();
  if (!name) {
    return { action: hidden ? "keep" : "hide", reason: "stored file no longer carries licence metadata", shortName: "" };
  }
  if (!licenseAllowed(name)) {
    return { action: hidden ? "keep" : "hide", reason: `stored file licence "${name}" is not on the allowlist`, shortName: name };
  }
  return { action: hidden ? "restore" : "keep", reason: "", shortName: name };
}

/**
 * Pure decision step, separated from the database so it is unit-testable.
 * @param {Array<{id:number, title:string, file_path:string, source:string}>} rows
 * @param {(tokens:string[]) => Promise<Record<string,string>>} fetchLicences
 */
async function decideRows(rows, fetchLicences) {
  const decisions = [];

  const byToken = new Map();
  for (const row of rows) {
    const token = commonsToken(row);
    if (!token) {
      decisions.push({ rowId: row.id, action: "keep", reason: "no usable reference to re-check", shortName: "" });
      continue;
    }
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(row);
  }

  const tokens = [...byToken.keys()];
  for (let start = 0; start < tokens.length; start += AUDIT_BATCH_MAX) {
    const chunk = tokens.slice(start, start + AUDIT_BATCH_MAX);
    let shortNames = {};
    try {
      shortNames = (await fetchLicences(chunk)) || {};
    } catch {
      // A lookup failure (breaker open, budget, network) stops the run: the
      // next attempt re-checks everything. No rows are hidden on uncertainty.
      break;
    }
    for (const token of chunk) {
      for (const row of byToken.get(token)) {
        const outcome = decide(currentlyHidden(row), { shortName: shortNames[token] });
        decisions.push({
          rowId: row.id,
          token,
          action: outcome.action,
          reason: outcome.reason,
          shortName: outcome.shortName
        });
      }
    }
  }

  return decisions;
}

/** Fetch LicenceShortName for a batch of tokens through the Commons breaker. */
async function fetchCommonsLicences(tokens) {
  const pageIds = tokens.filter(token => token.startsWith("p:")).map(token => token.slice(2));
  const titles = tokens.filter(token => token.startsWith("f:")).map(token => token.slice(2));
  const idParam = pageIds.length
    ? "pageids=" + encodeURIComponent(pageIds.join("|"))
    : "titles=" + encodeURIComponent(titles.join("|"));

  const url =
    `${config.commonsApiUrl}?action=query&prop=imageinfo&iiprop=extmetadata` +
    `&format=json&formatversion=2&${idParam}`;

  const payload = await run("commons", () => {
    const { fetchJson } = require("./external-http");
    return fetchJson(url, { timeoutMs: 6000 });
  });

  const query = payload && payload.query;
  const pages = query && query.pages;
  if (!pages || typeof pages !== "object") return {};
  const rows = Array.isArray(pages) ? pages : Object.values(pages);

  const out = {};
  for (const page of rows) {
    const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
    const meta = (info && info.extmetadata) || {};
    const entry = meta.LicenseShortName || meta.License;
    if (!entry || typeof entry.value !== "string") continue;
    const value = entry.value.trim();
    if (Number.isInteger(page.pageid)) out["p:" + page.pageid] = value;
    if (typeof page.title === "string") out["f:" + page.title] = value;
  }
  return out;
}

async function runAuditNow() {
  return runExclusive("license-audit", async () => {
    const candidates = [];
    let after = 0;
    // Walk every stored row in id order so no Commons file is skipped, no
    // matter how large article_images grows.
    for (;;) {
      const { rows } = await pool.query(
        `SELECT id, title, file_path, source, license, creator
           FROM article_images
          WHERE id > $1
          ORDER BY id ASC
          LIMIT ${AUDIT_PAGE_SIZE}`,
        [after]
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      for (const row of rows) {
        if (isCommonsRow(row)) candidates.push(row);
      }
      if (rows.length < AUDIT_PAGE_SIZE) break;
    }

    if (!candidates.length) return { checked: 0, hidden: 0, restored: 0 };

    const decisions = await decideRows(candidates, fetchCommonsLicences);
    let hidden = 0;
    let restored = 0;

    for (const decision of decisions) {
      if (decision.action === "hide") {
        await pool.query(
          `UPDATE article_images
             SET source = CASE WHEN position('HIDDEN:' in COALESCE(source,'')) = 1
                               THEN source
                               ELSE 'HIDDEN:' || COALESCE(source, '') END
           WHERE id = $1`,
          [decision.rowId]
        );
        hidden += 1;
      } else if (decision.action === "restore") {
        await pool.query(
          `UPDATE article_images
             SET source = regexp_replace(COALESCE(source, ''), '^HIDDEN:', '', 1)
           WHERE id = $1`,
          [decision.rowId]
        );
        restored += 1;
      }
    }

    if (hidden + restored > 0) {
      await recordEvent(
        "license-audit",
        hidden ? "license-hide" : "license-restore",
        `${hidden} stored file(s) taken off the site, ${restored} restored`
      );
    }
    return { checked: decisions.length, hidden, restored };
  });
}

async function lastAuditAt() {
  try {
    const { rows } = await pool.query(
      "SELECT last_success_at FROM integration_status WHERE service = 'license-audit'"
    );
    return rows[0] && rows[0].last_success_at ? new Date(rows[0].last_success_at).getTime() : null;
  } catch {
    return null;
  }
}

async function markAudited() {
  try {
    await pool.query(
      `INSERT INTO integration_status (service, module, is_enabled, auto_state, last_success_at, updated_at)
       VALUES ('license-audit', 'audit', TRUE, 'closed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (service) DO UPDATE
         SET last_success_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`
    );
  } catch {
    // Best effort; the marker is only a throttle.
  }
}

async function scheduled() {
  const last = await lastAuditAt();
  if (last !== null && Date.now() - last < AUDIT_INTERVAL_MS) return;
  await runAuditNow();
  await markAudited();
}

let auditTimer = null;

function start() {
  if (auditTimer) return;
  scheduled().catch(() => {});
  auditTimer = setInterval(() => scheduled().catch(() => {}), AUDIT_INTERVAL_MS);
  if (typeof auditTimer.unref === "function") auditTimer.unref();
}

module.exports = {
  AUDIT_BATCH_MAX,
  AUDIT_INTERVAL_MS,
  AUDIT_PAGE_SIZE,
  commonsToken,
  currentlyHidden,
  decide,
  decideRows,
  isCommonsRow,
  runAuditNow,
  scheduled,
  start
};