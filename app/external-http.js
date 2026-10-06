"use strict";

/**
 * KaliNova — outbound HTTP for open-data services
 *
 * One bounded, identifiable client for every request KaliNova makes to
 * Wikidata, Wikimedia Commons, OpenStreetMap's Nominatim and the approved RSS
 * feeds:
 *
 *   timeout      every request carries an AbortSignal.timeout, so a slow or
 *                hung upstream can never pin a request handler open
 *   size cap     responses are read through a byte budget; a 2 GB "JSON"
 *                body is refused instead of buffered
 *   User-Agent   Wikimedia asks API clients to send a descriptive UA with a
 *                contact address (see config.wikimediaUserAgent)
 *   errors       failures become ExternalServiceError with a machine-readable
 *                kind. Routes turn that into a generic 5xx — no upstream URL,
 *                stack trace or library message ever reaches a visitor
 *
 * There are no retries. The callers keep cached (and, for geocoding, persisted)
 * copies of what they fetched, so a retry would add latency and hammer an
 * upstream that is already struggling. A failed fetch falls back to cache at
 * the service layer instead.
 */

const config = require("./config");

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB is generous for every API here.

class ExternalServiceError extends Error {
  /**
   * @param {string} kind  "timeout" | "network" | "http" | "too-large" | "bad-response"
   * @param {string} message internal message (logged, never sent to clients)
   * @param {{status?: number, cause?: Error}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "ExternalServiceError";
    this.kind = kind;
    this.status = extra.status || null;
    if (extra.cause) this.cause = extra.cause;
  }
}

/**
 * Validate an absolute http(s) URL before it is handed to fetch.
 *
 * KaliNova builds every upstream URL itself from a fixed base plus an
 * encoded query parameter, so this is defence in depth rather than the only
 * line of defence: no caller can smuggle a credentials-bearing or
 * non-http scheme into the client.
 */
function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ExternalServiceError("bad-response", "requested URL is not absolute");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ExternalServiceError("bad-response", "unsupported URL scheme");
  }
  if (parsed.username || parsed.password) {
    throw new ExternalServiceError("bad-response", "credentials in URL are not allowed");
  }
  return parsed;
}

async function readBodyCapped(response, maxBytes) {
  // Content-Length is advisory; the streaming read below is the real guard.
  const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isInteger(declared) && declared > maxBytes) {
    throw new ExternalServiceError("too-large", "response exceeds the size budget", {
      status: response.status
    });
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    // Extremely defensive fallback: fetch() in supported Node versions always
    // exposes a streaming body, but buffering with a hard cap keeps the
    // guarantee if that ever changes.
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new ExternalServiceError("too-large", "response exceeds the size budget");
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ExternalServiceError("too-large", "response exceeds the size budget");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof ExternalServiceError) throw error;
    throw new ExternalServiceError("network", "response stream aborted", { cause: error });
  }

  return Buffer.concat(chunks, total);
}

/**
 * GET a URL and return the body as text.
 *
 * @param {string} rawUrl
 * @param {{timeoutMs?: number, maxBytes?: number, headers?: object, accept?: string}} [options]
 * @returns {Promise<string>}
 */
async function fetchText(rawUrl, options = {}) {
  const url = assertSafeUrl(rawUrl);
  const timeoutMs = options.timeoutMs || config.externalFetchTimeoutMs;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;

  const headers = {
    "User-Agent": config.wikimediaUserAgent,
    Accept: options.accept || "application/json, text/plain, */*",
    "Accept-Language": "en",
    ...(options.headers || {})
  };

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const name = error && error.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ExternalServiceError("timeout", `upstream timed out after ${timeoutMs}ms`, {
        cause: error
      });
    }
    throw new ExternalServiceError("network", "upstream connection failed", { cause: error });
  }

  if (!response.ok) {
    // Drain a few bytes so the socket can be reused, then surface the status.
    await response.body?.cancel?.().catch(() => {});
    const error = new ExternalServiceError("http", `upstream answered ${response.status}`, {
      status: response.status
    });
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    if (retryAfter !== null) error.retryAfterSeconds = retryAfter;
    throw error;
  }

  const buffer = await readBodyCapped(response, maxBytes);
  const text = buffer.toString("utf8");
  if (options.includeFinalUrl) {
    // response.url is the URL AFTER redirects, which the caller (the RSS layer)
    // uses to detect a feed that silently stopped serving on its own domain.
    return { text, finalUrl: response.url || url.href };
  }
  return text;
}

/**
 * RFC 7231 Retry-After: either seconds or an HTTP-date.
 * Returns whole seconds, or null when the header is absent/unusable.
 */
function parseRetryAfter(header) {
  const raw = String(header || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.max(0, Math.round((parsed - Date.now()) / 1000));
  return null;
}

/**
 * GET a URL, returning the body and the final URL after redirects.
 * Fetched with the exact same policy as fetchText; the extra field exists
 * only for the RSS layer's redirect check.
 */
async function fetchTextWithUrl(rawUrl, options = {}) {
  return fetchText(rawUrl, { ...options, includeFinalUrl: true });
}

/** GET a URL and parse the body as JSON. */
async function fetchJson(rawUrl, options = {}) {
  const text = await fetchText(rawUrl, {
    ...options,
    accept: options.accept || "application/json"
  });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ExternalServiceError("bad-response", "upstream returned invalid JSON", {
      cause: error
    });
  }
}

/**
 * A quiet logger for upstream failures: the kind and a short internal message,
 * never the full URL with query parameters (search terms are reader input).
 */
function logUpstreamFailure(service, error) {
  const kind = (error && error.kind) || "error";
  const message = error && error.message ? error.message : String(error);
  console.warn(`[external] ${service}: ${kind} — ${message}`);
}

module.exports = {
  ExternalServiceError,
  assertSafeUrl,
  fetchJson,
  fetchText,
  logUpstreamFailure
};
