"use strict";

/**
 * KaliNova — circuit breakers for the open-data integrations
 *
 * Every outbound integration (Wikidata, Wikimedia Commons, Nominatim, the OSM
 * tile host, and each reviewed RSS feed on its own) is fronted by a breaker
 * with three automatic states and one manual override:
 *
 *   closed     calls allowed; failures are counted
 *   half-open  one probe request allowed while the upstream is checked
 *   open       calls refused, cache/stale answers or the section hides
 *   locked     three 403 answers in 24h — stays off until an administrator
 *              explicitly re-enables it
 *
 * The breaker opens when:
 *   - the configured number of consecutive failures is reached (default 5)
 *   - more than half of the last N requests failed within the trailing window
 *     (default > 50 % of at least 10 requests in 10 minutes)
 *   - an immediate 429 or 401/403 arrives (429 honours Retry-After)
 *   - a feed's policy rule fires (e.g. a redirect to a different domain)
 *
 * After the cooldown a single probe is let through in HALF-OPEN. Success
 * closes the breaker; another failure reopens it with a doubled cooldown,
 * up to a maximum (default: 5 minutes doubling to 6 hours).
 *
 * State is persisted in integration_status (one row per service) and every
 * state change is appended to integration_events, so a restart hands the
 * breaker back the state it left behind and the admin page can show what
 * happened and when. When the database is unreachable the breaker keeps
 * working from memory and quietly skips persistence.
 *
 * A request budget (hourly + daily envelopes, per service) is enforced next
 * to the breaker: once the envelope is spent, new outbound calls are refused
 * until the window resets and whatever is cached is served instead.
 */

const config = require("./config");
const pool = require("./db");
const { ExternalServiceError } = require("./external-http");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

class BreakerOpenError extends ExternalServiceError {
  constructor(service, reason) {
    super("breaker", `breaker ${service} is refusing outbound requests: ${reason}`);
    this.breakerService = service;
    this.breakerReason = reason;
  }
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

let dbUsable = true;
let dbLostAt = 0;
const DB_RECONNECT_MS = 5 * MINUTE_MS;

function canUseDb() {
  if (dbUsable) return true;
  return Date.now() - dbLostAt >= DB_RECONNECT_MS;
}

function markDbLost() {
  if (dbUsable) {
    dbUsable = false;
    dbLostAt = Date.now();
  }
}

function markDbOk() {
  dbUsable = true;
  dbLostAt = 0;
}

function statusFromRow(row) {
  return {
    service: row.service,
    module: row.module || "external",
    is_enabled: Boolean(row.is_enabled),
    manual_off: Boolean(row.manual_off),
    manual_reason: String(row.manual_reason || ""),
    auto_state: row.auto_state || "closed",
    reason: String(row.reason || ""),
    opened_at: row.opened_at ? new Date(row.opened_at).getTime() : null,
    next_retry_at: row.next_retry_at ? new Date(row.next_retry_at).getTime() : null,
    opened_count: Number(row.opened_count) || 0,
    failure_count: Number(row.failure_count) || 0,
    consecutive_failures: Number(row.consecutive_failures) || 0,
    last_error: String(row.last_error || ""),
    last_success_at: row.last_success_at ? new Date(row.last_success_at).getTime() : null,
    last_failure_at: row.last_failure_at ? new Date(row.last_failure_at).getTime() : null,
    forbidden_24h: Number(row.forbidden_24h) || 0,
    window_started_at: row.window_started_at ? new Date(row.window_started_at).getTime() : null,
    window_requests: Number(row.window_requests) || 0,
    window_failures: Number(row.window_failures) || 0,
    budget_hour_started_at: row.budget_hour_started_at ? new Date(row.budget_hour_started_at).getTime() : null,
    budget_hour_used: Number(row.budget_hour_used) || 0,
    budget_day_started_at: row.budget_day_started_at ? new Date(row.budget_day_started_at).getTime() : null,
    budget_day_used: Number(row.budget_day_used) || 0,
    updated_at: row.updated_at ? new Date(row.updated_at).getTime() : null
  };
}

async function loadStatus(service) {
  if (!canUseDb()) return null;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM integration_status WHERE service = $1",
      [service]
    );
    markDbOk();
    return rows[0] ? statusFromRow(rows[0]) : null;
  } catch (error) {
    markDbLost();
    console.warn("[cb] persistence read skipped:", error.message);
    return null;
  }
}

/**
 * Upsert the full status row. The transition is serialised across processes
 * with a Postgres advisory lock, so two app instances cannot clobber each
 * other's state changes.
 */
async function saveStatus(status) {
  if (!canUseDb()) return;
  const client = await pool.connect().catch(() => null);
  if (!client) {
    markDbLost();
    return;
  }
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["cb:" + status.service]
    );
    await client.query(
      `INSERT INTO integration_status (
         service, module, is_enabled, manual_off, manual_reason, auto_state, reason,
         opened_at, next_retry_at, opened_count, failure_count, consecutive_failures,
         last_error, last_success_at, last_failure_at, forbidden_24h,
         window_started_at, window_requests, window_failures,
         budget_hour_started_at, budget_hour_used, budget_day_started_at, budget_day_used,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20, $21, $22, $23, CURRENT_TIMESTAMP
       )
       ON CONFLICT (service) DO UPDATE SET
         module = EXCLUDED.module,
         is_enabled = EXCLUDED.is_enabled,
         manual_off = EXCLUDED.manual_off,
         manual_reason = EXCLUDED.manual_reason,
         auto_state = EXCLUDED.auto_state,
         reason = EXCLUDED.reason,
         opened_at = EXCLUDED.opened_at,
         next_retry_at = EXCLUDED.next_retry_at,
         opened_count = EXCLUDED.opened_count,
         failure_count = EXCLUDED.failure_count,
         consecutive_failures = EXCLUDED.consecutive_failures,
         last_error = EXCLUDED.last_error,
         last_success_at = EXCLUDED.last_success_at,
         last_failure_at = EXCLUDED.last_failure_at,
         forbidden_24h = EXCLUDED.forbidden_24h,
         window_started_at = EXCLUDED.window_started_at,
         window_requests = EXCLUDED.window_requests,
         window_failures = EXCLUDED.window_failures,
         budget_hour_started_at = EXCLUDED.budget_hour_started_at,
         budget_hour_used = EXCLUDED.budget_hour_used,
         budget_day_started_at = EXCLUDED.budget_day_started_at,
         budget_day_used = EXCLUDED.budget_day_used,
         updated_at = CURRENT_TIMESTAMP`,
      [
        status.service,
        status.module,
        status.is_enabled,
        status.manual_off,
        status.manual_reason,
        status.auto_state,
        status.reason,
        status.opened_at ? new Date(status.opened_at).toISOString() : null,
        status.next_retry_at ? new Date(status.next_retry_at).toISOString() : null,
        status.opened_count,
        status.failure_count,
        status.consecutive_failures,
        status.last_error,
        status.last_success_at ? new Date(status.last_success_at).toISOString() : null,
        status.last_failure_at ? new Date(status.last_failure_at).toISOString() : null,
        status.forbidden_24h,
        status.window_started_at ? new Date(status.window_started_at).toISOString() : null,
        status.window_requests,
        status.window_failures,
        status.budget_hour_started_at ? new Date(status.budget_hour_started_at).toISOString() : null,
        status.budget_hour_used,
        status.budget_day_started_at ? new Date(status.budget_day_started_at).toISOString() : null,
        status.budget_day_used
      ]
    );
    await client.query("COMMIT");
    markDbOk();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    markDbLost();
    console.warn("[cb] persistence write skipped:", error.message);
  } finally {
    client.release();
  }
}

async function recordEvent(service, event, reason) {
  if (!canUseDb()) return;
  try {
    await pool.query(
      "INSERT INTO integration_events (service, event, reason) VALUES ($1, $2, $3)",
      [service, String(event).slice(0, 40), String(reason || "").slice(0, 300)]
    );
  } catch {
    // Best effort only; the breaker itself never depends on the log.
  }
}

/** Short, secret-free description of a failure for the status page. */
function describeError(error) {
  const kind = (error && error.kind) || "error";
  const status = error && Number.isInteger(error.status) ? error.status : null;
  if (status !== null) {
    if (status === 429 && error && Number.isInteger(error.retryAfterSeconds)) {
      return `http 429 (Retry-After ${error.retryAfterSeconds}s)`;
    }
    return `http ${status}`;
  }
  return String(kind).slice(0, 40);
}

/* ------------------------------------------------------------------ */
/* Breaker                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_THRESHOLDS = {
  failureThreshold: config.cbFailureThreshold,
  windowMs: config.cbWindowMinutes * MINUTE_MS,
  minRequests: config.cbMinRequests,
  failureRate: config.cbFailureRate,
  cooldownMs: config.cbCooldownMs,
  maxCooldownMs: config.cbMaxCooldownMs,
  forbiddenDailyMax: config.cbForbiddenDailyMax
};

function budgetFor(service) {
  if (service === "wikidata") return BUDGETS.wikidata;
  if (service === "commons") return BUDGETS.commons;
  if (service === "nominatim") return BUDGETS.nominatim;
  if (service === "map_tiles") return BUDGETS.map_tiles;
  if (service === "rss" || service.startsWith("rss:")) return BUDGETS.rss;
  return null;
}

const BUDGETS = {
  wikidata: { hourly: config.wikidataHourlyLimit, daily: config.wikidataDailyLimit },
  commons: { hourly: config.commonsHourlyLimit, daily: config.commonsDailyLimit },
  nominatim: { hourly: config.nominatimHourlyLimit, daily: config.nominatimDailyLimit },
  map_tiles: { hourly: config.mapTileHourlyLimit, daily: config.mapTileDailyLimit },
  rss: { hourly: config.rssHourlyLimit, daily: config.rssDailyLimit }
};

function createBreaker(service, options = {}) {
  const persist = options.persist !== false;
  const now = options.now || (() => Date.now());
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.thresholds || {})
  };
  const budget = options.budget !== undefined ? options.budget : budgetFor(service);

  const state = {
    service: String(service).slice(0, 60),
    module: options.module || (String(service).startsWith("rss:") ? "rss" : service),
    is_enabled: true,
    manual_off: false,
    manual_reason: "",
    auto_state: "closed",
    reason: "",
    opened_at: null,
    next_retry_at: null,
    opened_count: 0,
    failure_count: 0,
    consecutive_failures: 0,
    last_error: "",
    last_success_at: null,
    last_failure_at: null,
    forbidden_24h: 0,
    window_started_at: null,
    window_requests: 0,
    window_failures: 0,
    budget_hour_started_at: null,
    budget_hour_used: 0,
    budget_day_started_at: null,
    budget_day_used: 0,
    updated_at: null
  };

  let samples = [];
  let trialInFlight = false;
  let persistTimer = null;
  let hydrated = false;

  async function hydrate() {
    if (hydrated || !persist) return;
    const row = await loadStatus(state.service);
    if (row) Object.assign(state, row);
    hydrated = true;
  }

  function persistNow() {
    if (!persist) return Promise.resolve();
    return saveStatus(state);
  }

  function persistSoon() {
    if (!persist) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 1500);
    if (typeof persistTimer.unref === "function") persistTimer.unref();
  }

  function envEnabled() {
    return envEnabledFor(state.service);
  }

  /* Budget windows: roll over when the window ends, count a used slice. */
  function rollBudgetWindows() {
    const t = now();
    if (!state.budget_hour_started_at || t - state.budget_hour_started_at >= HOUR_MS) {
      state.budget_hour_started_at = t;
      state.budget_hour_used = 0;
    }
    if (!state.budget_day_started_at || t - state.budget_day_started_at >= DAY_MS) {
      state.budget_day_started_at = t;
      state.budget_day_used = 0;
    }
  }

  function budgetExhausted() {
    if (!budget) return false;
    rollBudgetWindows();
    const hourUsed = state.budget_hour_used >= budget.hourly;
    const dayUsed = state.budget_day_used >= budget.daily;
    if (hourUsed || dayUsed) {
      return {
        hourly: hourUsed ? { used: state.budget_hour_used, limit: budget.hourly } : null,
        daily: dayUsed ? { used: state.budget_day_used, limit: budget.daily } : null
      };
    }
    return false;
  }

  function countBudgetCall() {
    if (!budget) return;
    rollBudgetWindows();
    state.budget_hour_used += 1;
    state.budget_day_used += 1;
    persistSoon();
  }

  function pruneSamples(t) {
    const keepFrom = t - thresholds.windowMs;
    if (samples.length && samples[0].at < keepFrom) {
      samples = samples.filter(sample => sample.at >= keepFrom);
    }
  }

  /**
   * Should a new outbound request be allowed?
   * Returns { allow: true, kind } or { allow: false, kind, reason, ... }.
   */
  async function gate() {
    await hydrate();

    if (!envEnabled()) {
      return { allow: false, kind: "env-off", reason: "Disabled by environment (ENABLE_*)", envOff: true };
    }
    if (state.manual_off) {
      return {
        allow: false,
        kind: "manual-off",
        reason: state.manual_reason || "Disabled by an administrator"
      };
    }

    const t = now();

    if (state.auto_state === "open") {
      if (state.forbidden_24h >= thresholds.forbiddenDailyMax) {
        return {
          allow: false,
          kind: "locked-403",
          reason: state.reason || "Repeatedly answered 403; requires administrator review"
        };
      }
      if (state.next_retry_at === null || t < state.next_retry_at) {
        const retryAfterMs = state.next_retry_at ? Math.max(0, state.next_retry_at - t) : 0;
        return {
          allow: false,
          kind: "auto",
          reason: state.reason || "Open after repeated failures",
          retryAfterMs,
          nextRetryAt: state.next_retry_at
        };
      }
      // Cooldown elapsed: promote to half-open and let one probe through.
      state.auto_state = "half-open";
      state.reason = "Probing after cooldown";
      trialInFlight = true;
      await recordEvent(state.service, "half-open", "Cooldown ended; one probe request allowed");
      await persistNow();
      return { allow: true, kind: "trial", reason: "Probe request" };
    }

    if (state.auto_state === "half-open") {
      if (trialInFlight) {
        return { allow: false, kind: "probe-in-flight", reason: "A probe request is already in flight" };
      }
      trialInFlight = true;
      countBudgetCall();
      return { allow: true, kind: "trial", reason: "Probe request" };
    }

    // closed
    const exhausted = budgetExhausted();
    if (exhausted) {
      return { allow: false, kind: "budget", reason: "Request budget reached", exhausted };
    }
    countBudgetCall();
    return { allow: true, kind: "closed", reason: "" };
  }

  async function open(reason, { retryAfterMs } = {}) {
    state.auto_state = "open";
    state.opened_at = now();
    state.opened_count += 1;
    const base = thresholds.cooldownMs;
    const doubled = base * 2 ** (state.opened_count - 1);
    const cooldown = retryAfterMs !== undefined ? retryAfterMs : Math.min(thresholds.maxCooldownMs, doubled);
    state.next_retry_at = state.opened_at + Math.min(thresholds.maxCooldownMs, Math.max(cooldown, 1000));
    state.reason = String(reason || "Open after repeated failures").slice(0, 300);
    await recordEvent(state.service, "opened", state.reason);
    await persistNow();
  }

  async function lock(reason) {
    state.auto_state = "locked-403";
    state.opened_at = now();
    state.next_retry_at = null;
    state.reason = String(reason || "Locked: repeated 403 answers").slice(0, 300);
    await recordEvent(state.service, "locked-403", state.reason);
    await persistNow();
  }

  async function close() {
    state.auto_state = "closed";
    state.opened_at = null;
    state.next_retry_at = null;
    state.reason = "";
    state.consecutive_failures = 0;
    await recordEvent(state.service, "closed", "Recovered");
    await persistNow();
  }

  async function maybeOpenOnRate() {
    const t = now();
    pruneSamples(t);
    const requests = samples.length;
    if (requests < thresholds.minRequests) return;
    const failures = samples.filter(sample => !sample.ok).length;
    const rate = failures / requests;
    if (rate > thresholds.failureRate) {
      await open(`${Math.round(rate * 100)}% of the last ${requests} requests failed`);
    }
  }

  /**
   * Record the outcome of one outbound call.
   * @param {{ok: boolean, error?: Error, retryAfterSeconds?: number, immediate?: boolean, reason?: string}} outcome
   */
  async function recordResult(outcome) {
    await hydrate();
    const t = now();
    const ok = Boolean(outcome && outcome.ok);

    samples.push({ at: t, ok });
    pruneSamples(t);
    const status = outcome.error && Number.isInteger(outcome.error.status) ? outcome.error.status : null;
    const kind = (outcome.error && outcome.error.kind) || "error";

    trialInFlight = false;

    state.updated_at = t;
    state.window_started_at = state.window_started_at || t;
    state.window_requests += 1;
    if (!ok) state.window_failures += 1;

    if (ok) {
      state.consecutive_failures = 0;
      state.last_success_at = t;
      state.last_error = "";
      if (state.auto_state !== "closed") await close();
      else persistSoon();
      return;
    }

    state.consecutive_failures += 1;
    state.failure_count += 1;
    state.last_failure_at = t;
    state.last_error = describeError(outcome.error);

    if (status === 403) {
      state.forbidden_24h += 1;
      if (state.forbidden_24h >= thresholds.forbiddenDailyMax) {
        return lock("Three 403 answers within 24h; requires administrator review");
      }
      return open(`Upstream answered 403 (${state.forbidden_24h}/${thresholds.forbiddenDailyMax})`);
    }
    if (status === 401) return open("Upstream answered 401");
    if (status === 429) {
      const retryAfterMs =
        Number.isInteger(outcome.retryAfterSeconds) && outcome.retryAfterSeconds > 0
          ? outcome.retryAfterSeconds * 1000
          : undefined;
      return open("Upstream answered 429 (rate limited)", { retryAfterMs });
    }
    if (outcome.immediate) {
      return open(outcome.reason || "Immediate policy rule");
    }
    if (kind === "timeout" && state.consecutive_failures >= thresholds.failureThreshold) {
      return open(`${state.consecutive_failures} consecutive timeouts`);
    }
    if (state.consecutive_failures >= thresholds.failureThreshold) {
      return open(`${state.consecutive_failures} consecutive failures`);
    }
    await maybeOpenOnRate();
  }

  async function summary() {
    await hydrate();
    const envOff = !envEnabled();
    const label = envOff
      ? "DISABLED"
      : state.manual_off
        ? "MANUAL OFF"
        : state.auto_state === "locked-403"
          ? "OFF (LOCKED)"
          : state.auto_state === "open"
            ? "AUTO OFF"
            : state.auto_state === "half-open"
              ? "RETRYING"
              : "ON";
    const isEnabled = !envOff && !state.manual_off && state.auto_state !== "open" && state.auto_state !== "locked-403";

    let budgetInfo = null;
    if (budget) {
      rollBudgetWindows();
      budgetInfo = {
        hourly: { used: state.budget_hour_used, limit: budget.hourly },
        daily: { used: state.budget_day_used, limit: budget.daily }
      };
    }

    return {
      service: state.service,
      module: state.module,
      label,
      isEnabled,
      envOff,
      manual: { off: state.manual_off, reason: state.manual_reason },
      autoState: state.auto_state,
      reason: state.reason,
      openedAt: state.opened_at,
      nextRetryAt: state.next_retry_at,
      openedCount: state.opened_count,
      failureCount: state.failure_count,
      consecutiveFailures: state.consecutive_failures,
      lastError: state.last_error,
      lastSuccessAt: state.last_success_at,
      lastFailureAt: state.last_failure_at,
      forbidden24h: state.forbidden_24h,
      forbiddenDailyMax: thresholds.forbiddenDailyMax,
      budget: budgetInfo
    };
  }

  async function setManualOff(reason) {
    await hydrate();
    state.manual_off = true;
    state.manual_reason = String(reason || "Disabled by an administrator").slice(0, 300);
    state.auto_state = state.auto_state === "locked-403" ? "locked-403" : state.auto_state;
    await recordEvent(state.service, "manual-off", state.manual_reason);
    await persistNow();
  }

  async function setManualOn(resetReason) {
    await hydrate();
    state.manual_off = false;
    state.manual_reason = "";
    // If the breaker had locked on repeated 403s, an explicit administrator
    // decision now clears it and its counter.
    state.forbidden_24h = 0;
    state.auto_state = "closed";
    state.opened_at = null;
    state.next_retry_at = null;
    state.reason = "";
    await recordEvent(state.service, "manual-on", resetReason || "Re-enabled by an administrator");
    await persistNow();
  }

  async function reset() {
    await hydrate();
    const keep = { service: state.service, module: state.module, is_enabled: state.is_enabled };
    state.auto_state = "closed";
    state.manual_off = false;
    state.manual_reason = "";
    state.reason = "";
    state.opened_at = null;
    state.next_retry_at = null;
    state.opened_count = 0;
    state.failure_count = 0;
    state.consecutive_failures = 0;
    state.last_error = "";
    state.last_success_at = null;
    state.last_failure_at = null;
    state.forbidden_24h = 0;
    state.window_started_at = null;
    state.window_requests = 0;
    state.window_failures = 0;
    state.budget_hour_started_at = null;
    state.budget_hour_used = 0;
    state.budget_day_started_at = null;
    state.budget_day_used = 0;
    samples = [];
    Object.assign(state, keep);
    await recordEvent(state.service, "reset", "Breaker reset by an administrator");
    await persistNow();
  }

  return {
    budget,
    gate,
    recordResult,
    summary,
    setManualOff,
    setManualOn,
    reset,
    service: state.service
  };
}

/* ------------------------------------------------------------------ */
/* Registry + helpers                                                  */
/* ------------------------------------------------------------------ */

const registry = new Map();

/**
 * Get (or lazily create) the breaker for a service name.
 * Options are used only when the breaker does not exist yet.
 */
function getBreaker(service, options = {}) {
  const key = String(service).slice(0, 60);
  if (!registry.has(key)) {
    registry.set(key, createBreaker(key, options));
  }
  return registry.get(key);
}

function feedBreakerKey(source) {
  const slug = String(source || "feed")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `rss:${slug || "feed"}`;
}

function envEnabledFor(service) {
  if (service === "wikidata") return config.enableWikidata;
  if (service === "commons") return config.enableCommons;
  if (service === "nominatim" || service === "map_tiles") return config.enableMaps;
  if (service === "rss" || service.startsWith("rss:")) return config.enableRss;
  return true;
}

/**
 * Run one outbound call behind a breaker.
 * On refusal the work function is never called: a BreakerOpenError is thrown
 * (so the caller's cache can fall back to stale data) unless onRefused is
 * provided, in which case its return value becomes the result.
 */
async function run(service, work, { onRefused } = {}) {
  const breaker = getBreaker(service);
  const gate = await breaker.gate();
  if (!gate.allow) {
    const error = new BreakerOpenError(service, gate.reason);
    if (typeof onRefused === "function") return onRefused(gate, error);
    throw error;
  }
  try {
    const value = await work();
    await breaker.recordResult({ ok: true });
    return value;
  } catch (error) {
    const retryAfterSeconds =
      error && Number.isInteger(error.retryAfterSeconds) ? error.retryAfterSeconds : undefined;
    await breaker.recordResult({ ok: false, error, retryAfterSeconds });
    throw error;
  }
}

async function listSummaries() {
  return Promise.all(
    [...registry.values()].map(breaker => breaker.summary())
  );
}

async function adminSetManual(service, { off, reason }) {
  const breaker = getBreaker(service);
  if (off) await breaker.setManualOff(reason || "");
  else await breaker.setManualOn();
  return breaker.summary();
}

async function adminReset(service) {
  return getBreaker(service).reset();
}

/* ------------------------------------------------------------------ */
/* Housekeeping sweep                                                  */
/* ------------------------------------------------------------------ */

const { runExclusive } = require("./background-jobs");

async function sweep() {
  await runExclusive("integration-sweep", async () => {
    const retentionMs = Number(config.cbEventRetentionDays) * DAY_MS;
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    await pool.query("DELETE FROM integration_events WHERE created_at < $1", [cutoff]);
    await pool.query(
      "DELETE FROM external_data_cache WHERE expires_at < NOW() - INTERVAL '1 day'"
    );
  });
}

let sweepTimer = null;

/**
 * Start the daily housekeeping sweep. Called by server.js from inside its own
 * `require.main === module` block, so a test runner that requires the app
 * never gets a timer. (This module itself can never be "main".)
 */
function startSweeper() {
  if (sweepTimer) return;
  sweep().catch(() => {});
  sweepTimer = setInterval(() => sweep().catch(() => {}), DAY_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

module.exports = {
  BreakerOpenError,
  BUDGETS,
  adminReset,
  adminSetManual,
  createBreaker,
  feedBreakerKey,
  getBreaker,
  listSummaries,
  run,
  recordEvent,
  startSweeper,
  sweep
};