"use strict";

/**
 * KaliNova — small in-process cache for open-data lookups
 *
 * Every external lookup in the app (Wikidata search, entity payloads, Commons
 * media search, feed snapshots) runs through this cache so a page view never
 * becomes a passthrough to somebody else's API.
 *
 * Freshness model, per entry:
 *
 *   now < freshUntil                     fresh  → served directly
 *   freshUntil <= now < hardUntil        stale  → served immediately while a
 *                                          single background refresh runs
 *   loader failed while stale exists     stale  → served as the fallback
 *   now >= hardUntil or never loaded     gone   → loader must succeed or the
 *                                          caller sees an error
 *
 * "single-flight": concurrent misses on the same key share one loader
 * promise, so ten simultaneous searches for the same term produce one
 * upstream request, not ten.
 *
 * The cache is deliberately bounded (maxEntries, oldest evicted first) — an
 * unbounded search-keyed map is a memory leak with a public input at the
 * front of it.
 */

const DEFAULT_MAX_ENTRIES = 500;

function createCache({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  /** @type {Map<string, {value: *, freshUntil: number, hardUntil: number, inflight: Promise<*>|null}>} */
  const store = new Map();

  function evictIfNeeded() {
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value;
      store.delete(oldestKey);
    }
  }

  function set(key, value, { ttlMs, staleMs = 0 } = {}) {
    const now = Date.now();
    store.set(key, {
      value,
      freshUntil: now + ttlMs,
      hardUntil: now + ttlMs + staleMs,
      inflight: null
    });
    evictIfNeeded();
  }

  function entryFor(key) {
    return store.get(key) || null;
  }

  /**
   * Read a value without running the loader.
   * Returns { value, stale } for anything inside its hard window, else null.
   */
  function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now >= entry.hardUntil) {
      store.delete(key);
      return null;
    }
    return { value: entry.value, stale: now >= entry.freshUntil };
  }

  /**
   * Start a refresh for `key` unless one is already running.
   * Returns the shared promise. Never rejects here: failures are handled by
   * the caller (it decides whether stale data covers the miss).
   */
  function refresh(key, loader, { ttlMs, staleMs = 0 }) {
    let entry = store.get(key);
    if (entry && entry.inflight) return entry.inflight;

    if (!entry) {
      entry = { value: undefined, freshUntil: 0, hardUntil: 0, inflight: null };
      store.set(key, entry);
      evictIfNeeded();
    }

    const promise = Promise.resolve()
      .then(loader)
      .then(value => {
        entry.value = value;
        entry.freshUntil = Date.now() + ttlMs;
        entry.hardUntil = entry.freshUntil + staleMs;
        entry.inflight = null;
        return value;
      })
      .catch(error => {
        // Keep whatever the entry held before: a failed refresh must not
        // erase the stale copy the next request can fall back to.
        entry.inflight = null;
        throw error;
      });

    entry.inflight = promise;
    return promise;
  }

  /**
   * The main entry point.
   *
   * Fresh hit            → value.
   * Stale hit            → value now, refresh kicked off in the background.
   * Miss                 → loader awaited; on failure, a still-stale copy of
   *                          an older value is served if one exists.
   *
   * @param {string} key
   * @param {() => Promise<*>} loader
   * @param {{ttlMs: number, staleMs?: number}} options
   * @returns {Promise<{value: *, stale: boolean}>}
   */
  async function getOrLoad(key, loader, { ttlMs, staleMs = 0 }) {
    const entry = store.get(key);
    const now = Date.now();

    if (entry && now < entry.hardUntil) {
      if (now < entry.freshUntil) {
        return { value: entry.value, stale: false };
      }
      // Stale but usable: hand it back instantly and refresh once, quietly.
      refresh(key, loader, { ttlMs, staleMs }).catch(() => {});
      return { value: entry.value, stale: true };
    }

    try {
      const value = await refresh(key, loader, { ttlMs, staleMs });
      return { value, stale: false };
    } catch (error) {
      const fallback = store.get(key);
      if (fallback && now < fallback.hardUntil && fallback.value !== undefined) {
        return { value: fallback.value, stale: true };
      }
      throw error;
    }
  }

  function reset() {
    store.clear();
  }

  function size() {
    return store.size;
  }

  return { entryFor, get, getOrLoad, refresh, reset, set, size };
}

module.exports = { createCache };
