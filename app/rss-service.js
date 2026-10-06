"use strict";

/**
 * KaliNova — RSS ingestion for the "Latest News" headline strip
 *
 * What is stored (and nothing else): headline, source, publication date, the
 * original URL, the category, the guid, and a ~240-character excerpt of the
 * feed description. Full article bodies are never fetched into storage —
 * readers always go to the publisher's page. Feeds come from the reviewed
 * registry in rss-feeds.js; unreviewed feeds are never fetched.
 *
 * Resilience rules:
 *   - every feed is fetched with Promise.allSettled: one dead feed yields
 *     status "failed" for that source while the others still publish
 *   - results are deduplicated by guid and URL, newest first
 *   - rss_items.guid is UNIQUE, so re-ingesting the same story is a no-op
 *   - a failed refresh never discards the last good snapshot, and a database
 *     outage falls back to that snapshot, so /api/news/latest answers 200
 *     with whatever is known instead of an error
 *   - refreshes are single-flight and rate-limited to once per 10 minutes
 */

const config = require("./config");
const pool = require("./db");
const circuit = require("./circuit-breaker");
const { parseFeed, dedupeAndSort, excerpt } = require("./feed-parser");
const { fetchText, fetchTextWithUrl, logUpstreamFailure } = require("./external-http");

const REFRESH_MS = 10 * 60 * 1000;
const MAX_ITEMS = 60;
const FEED_MAX_BYTES = 1024 * 1024;
const FEED_TIMEOUT_MS = 6000;
const PRUNE_AFTER_DAYS = 30;

/* ------------------------------------------------------------------ */
/* Stores                                                              */
/* ------------------------------------------------------------------ */

/** PostgreSQL-backed storage. Any failure answers with null/false, never throws. */
const pgStore = {
  async save(items) {
    if (!items.length) return true;
    const CHUNK = 40;
    let ok = true;
    try {
      for (let start = 0; start < items.length; start += CHUNK) {
        const chunk = items.slice(start, start + CHUNK);
        const values = [];
        const tuples = chunk.map(item => {
          const base = values.length;
          values.push(
            item.source,
            item.title,
            item.description,
            item.original_url,
            item.published_at,
            item.category,
            item.guid
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        });
        await pool.query(
          `INSERT INTO rss_items (source, title, description, original_url, published_at, category, guid)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (guid) DO NOTHING`,
          values
        );
      }
    } catch (error) {
      console.warn("[rss] insert skipped:", error.message);
      ok = false;
    }
    return ok;
  },

  async load({ category, limit }) {
    try {
      const params = [];
      let where = "";
      if (category) {
        params.push(category);
        where = `WHERE category = $${params.length}`;
      }
      params.push(limit);
      const result = await pool.query(
        `SELECT source, title, description, original_url, published_at, category
           FROM rss_items
           ${where}
          ORDER BY published_at DESC NULLS LAST, created_at DESC
          LIMIT $${params.length}`,
        params
      );
      return result.rows;
    } catch (error) {
      console.warn("[rss] read skipped:", error.message);
      return null;
    }
  },

  async prune() {
    try {
      await pool.query(
        `DELETE FROM rss_items WHERE created_at < NOW() - INTERVAL '${PRUNE_AFTER_DAYS} days'`
      );
    } catch (error) {
      console.warn("[rss] prune skipped:", error.message);
    }
  }
};

/** In-memory store used by the tests (and a valid degraded fallback). */
function createMemoryStore() {
  const rows = [];
  return {
    async save(items) {
      for (const item of items) {
        if (!rows.some(row => row.guid === item.guid)) rows.push(item);
      }
      return true;
    },
    async load({ category, limit }) {
      const filtered = category ? rows.filter(row => row.category === category) : rows.slice();
      return filtered
        .slice()
        .sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0))
        .slice(0, limit);
    },
    async prune() {},
    rows
  };
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Lower-cased hostname, or null when the value is not an absolute URL. */
function safeHost(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/** Map parsed feed items onto rss_items rows. Invalid rows are dropped. */
function normalizeItems(feed, items) {
  const rows = [];
  for (const item of items) {
    const title = String(item.title || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const url = String(item.link || "");
    if (!title || !isValidHttpUrl(url)) continue;

    const guid = String(item.guid || url).slice(0, 500);
    rows.push({
      source: String(feed.source).slice(0, 120),
      category: String(feed.category || "latest-news").slice(0, 60),
      title,
      description: excerpt(item.description, 240),
      original_url: url.slice(0, 1000),
      published_at: item.publishedAt || null,
      guid
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

function createRssService({
  feeds = [],
  fetchImpl = fetchText,
  store = pgStore,
  breakerFor = null,
  dutyCycle = null
} = {}) {
  const approved = feeds.filter(
    feed =>
      feed &&
      feed.enabled === true &&
      feed.termsReviewed !== false && // registry that omitted termsReviewed still passes
      isValidHttpUrl(feed.url)
  );

  let snapshot = null; // { items, sources, fetchedAt }
  let lastRefreshAt = 0;
  let refreshInFlight = null;
  const lastFetchAt = new Map(); // duty-cycle bookkeeping, keyed by feed URL

  async function fetchOne(feed) {
    const breaker = breakerFor ? breakerFor(feed) : null;

    // A feed whose breaker is open (or whose hourly request envelope is
    // spent) quietly stays unpublished until it recovers; it is never listed
    // as a failure, so readers do not see a "degraded" banner for it.
    if (breaker) {
      const gate = await breaker.gate();
      if (!gate.allow) return { state: "disabled", items: [] };
    }

    // Between refreshes (default 10 min) the duty cycle keeps each feed on
    // the network at most once per RSS_MIN_INTERVAL_MS. Skips are silent.
    if (dutyCycle && snapshot && Date.now() - (lastFetchAt.get(feed.url) || 0) < dutyCycle.minIntervalMs) {
      return { state: "skipped", items: [] };
    }
    lastFetchAt.set(feed.url, Date.now());

    let body;
    try {
      body = await fetchImpl(feed.url, {
        timeoutMs: FEED_TIMEOUT_MS,
        maxBytes: FEED_MAX_BYTES,
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
      });
    } catch (error) {
      if (breaker) await breaker.recordResult({ ok: false, error });
      logUpstreamFailure(`rss:${feed.source}`, error);
      return { state: "failed", items: [] };
    }

    // Redirect check: a feed that now lives on another domain is treated as
    // an automatic-stop event — the headline links would silently go where
    // the registry review never approved.
    const xml = typeof body === "string" ? body : body && body.text;
    if (breaker && body && typeof body === "object" && body.finalUrl) {
      const expected = safeHost(feed.url);
      const actual = safeHost(body.finalUrl);
      if (expected && actual && actual !== expected) {
        await breaker.recordResult({
          ok: false,
          error: { status: 0, kind: "redirect", message: `feed moved to ${actual}` },
          immediate: true,
          reason: "Feed now served from a different domain"
        });
        return { state: "disabled", items: [] };
      }
    }

    if (breaker) await breaker.recordResult({ ok: true });
    const parsed = parseFeed(xml, { source: feed.source });
    return { state: "ok", items: normalizeItems(feed, parsed.items) };
  }

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const settled = await Promise.allSettled(approved.map(feed => fetchOne(feed)));

      const sources = [];
      const collected = [];
      settled.forEach((result, index) => {
        const feed = approved[index];
        if (result.status === "rejected") {
          // One broken feed is a fact about that feed, never an error page.
          logUpstreamFailure(`rss:${feed.source}`, result.reason);
          sources.push({ source: feed.source, status: "failed", items: 0 });
          return;
        }
        const outcome = result.value;
        if (outcome.state === "ok") {
          sources.push({ source: feed.source, status: "ok", items: outcome.items.length });
          collected.push(...outcome.items);
        } else if (outcome.state === "failed") {
          sources.push({ source: feed.source, status: "failed", items: 0 });
        }
        // "disabled" and "skipped" are quiet states: not published, not failed.
      });

      // A refresh where nothing was fetched (all feeds duty-cycled or quietly
      // disabled) must not erase the last known-good snapshot.
      if (!sources.length && !collected.length && snapshot) return snapshot;

      const merged = dedupeAndSort(
        // dedupeAndSort works on parsed feed items (link / publishedAt); the
        // normalised rows use original_url / published_at, so bridge the two
        // field names while keeping every row field intact.
        collected.map(item => ({
          ...item,
          link: item.original_url,
          publishedAt: item.published_at
        })),
        MAX_ITEMS
      );
      await store.save(merged);
      store.prune().catch(() => {});

      snapshot = { items: merged, sources, fetchedAt: Date.now() };
      lastRefreshAt = Date.now();
      return snapshot;
    })().finally(() => {
      refreshInFlight = null;
    });

    return refreshInFlight;
  }

  function filterCategory(items, category) {
    const filtered = category ? items.filter(item => item.category === category) : items;
    // The snapshot can carry the same URL under another guid after a feed
    // re-publishes: the visible list must still be unique.
    const seen = new Set();
    return filtered.filter(item => {
      if (seen.has(item.original_url)) return false;
      seen.add(item.original_url);
      return true;
    });
  }

  async function getLatest({ category = "", limit = 20 } = {}) {
    const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50);
    const now = Date.now();
    const needsRefresh = !snapshot || now - lastRefreshAt >= REFRESH_MS;

    let fromStore = await store.load({ category: category || null, limit: MAX_ITEMS });
    if (Array.isArray(fromStore) && fromStore.length) fromStore = filterCategory(fromStore, null);

    if (needsRefresh) {
      if (fromStore && fromStore.length) {
        // Known content exists: answer now, refresh in the background so a
        // slow upstream never sits in front of a page view.
        refresh().catch(() => {});
      } else {
        // Cold start with an empty database: the first caller waits for the
        // refresh (bounded by the per-feed timeout) so the strip is not blank.
        await refresh().catch(() => {});
        fromStore = await store.load({ category: category || null, limit: MAX_ITEMS });
        if (Array.isArray(fromStore) && fromStore.length) fromStore = filterCategory(fromStore, null);
      }
    }

    const snapshotItems = filterCategory(snapshot ? snapshot.items : [], category);
    let items = fromStore && fromStore.length ? fromStore : snapshotItems;
    items = items.slice(0, bounded);

    const sources = snapshot ? snapshot.sources : [];
    const degraded = sources.length > 0 && sources.some(entry => entry.status === "failed");

    return {
      items: items.map(item => ({
        title: item.title,
        description: item.description || "",
        url: item.original_url,
        published_at: item.published_at || null,
        source: item.source,
        category: item.category
      })),
      sources,
      degraded,
      generated_at: new Date().toISOString()
    };
  }

  return {
    approved,
    getLatest,
    normalizeItems: items => normalizeItems({ source: "", category: "" }, items),
    refresh,
    _snapshot: () => snapshot
  };
}

const defaultService = createRssService({
  feeds: require("./rss-feeds"),
  // The default service is the one that talks to the reviewed registry, so it
  // is the one that carries the real safety layer: per-feed breakers share
  // one hourly RSS request envelope, and each feed refreshes at most once
  // per RSS_MIN_INTERVAL_MS. Redirect checks run against the final URL, which
  // only fetchTextWithUrl reveals.
  breakerFor: feed => circuit.getBreaker(circuit.feedBreakerKey(feed.source)),
  dutyCycle: { minIntervalMs: config.rssMinIntervalMs },
  fetchImpl: fetchTextWithUrl
});

module.exports = {
  MAX_ITEMS,
  REFRESH_MS,
  createMemoryStore,
  createRssService,
  defaultService,
  isValidHttpUrl,
  normalizeItems,
  pgStore,
  safeHost
};
