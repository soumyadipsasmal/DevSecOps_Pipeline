"use strict";

/**
 * KaliNova — scheduled article publisher
 *
 * An article saved with status "scheduled" and a scheduled_at in the past is
 * promoted to "published" by this small poller. It runs on the server only and
 * is intentionally boring:
 *
 *   * one UPDATE per tick, driven by articleService.publishDueScheduled, so two
 *     instances cannot double-publish a row (the UPDATE ... WHERE status =
 *     'scheduled' clause is atomic)
 *   * every failure is logged and swallowed: a scheduled article being late is
 *     an inconvenience, the process crashing is an outage
 *   * unref()d timer plus a stop() hook so a test runner that imports the app
 *     is never kept alive by it
 */

const articleService = require("./article-service");

const DEFAULT_INTERVAL_MS = 60 * 1000;

let timer = null;

async function tick() {
  try {
    const published = await articleService.publishDueScheduled();
    if (published.length) {
      console.log(`[scheduled-publisher] published ${published.length} article(s): ${published.map(row => row.slug).join(", ")}`);
    }
  } catch (error) {
    console.error("[scheduled-publisher] sweep failed:", error.message);
  }
}

function start(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return timer;

  // Catch anything already due from before the last restart, then keep polling.
  tick();
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick };
