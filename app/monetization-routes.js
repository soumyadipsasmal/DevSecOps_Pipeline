"use strict";

/**
 * KaliNova — public monetization surface
 *
 * Everything a reader can touch, deliberately read-mostly and rate limited:
 *
 *   GET  /api/monetization                       site-wide config + disclosures +
 *                                                currently servable direct ads
 *   GET  /api/articles/:id/monetization          sponsored label + affiliate
 *   GET  /api/articles/slug/:slug/monetization   links + ad eligibility for one
 *                                                published article
 *   POST /api/newsletter/subscribe               store a subscriber (no sending)
 *   POST /api/newsletter/unsubscribe             token-based opt-out
 *   POST /api/ads/direct/impression              record one direct-ad impression
 *   POST /api/ads/direct/click                   record one direct-ad click
 *   GET  /go/:slug                               affiliate redirect (302 / 410)
 *
 * Rules that apply to every handler here:
 *   - nothing is ever written that a browser could not have sent; there is no
 *     admin mutation from the public surface
 *   - anonymised event metadata comes from monetization-service (no raw IPs)
 *   - affiliate destinations are validated twice (here by service, in the
 *     database by CHECK) and only ever reached through /go/:slug
 *   - the redirect answers 302 for active links, 410 Gone for paused ones and
 *     404 for unknown slugs, so a dead programme cannot silently strand a
 *     reader on a changed address
 *   - every response is either JSON or a bare redirect; nothing rendered here
 *     can inject markup
 */

const express = require("express");

const adsService = require("./ads-service");
const affiliate = require("./affiliate-service");
const config = require("./config");
const directAds = require("./direct-ads-service");
const monetization = require("./monetization-service");
const sponsored = require("./sponsored-service");
const security = require("./security");

const monetizationApi = express.Router();
const goRouter = express.Router();

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * Per-IP sliding window on the project's own limiter, matching the pattern in
 * external-routes.js. State-changing public endpoints stay throttled so a loop
 * cannot inflate subscription or event tables.
 */
function createRequestLimiter({ windowMs, maxAttempts, message, header = false }) {
  const limiter = security.createLoginLimiter({
    windowMs,
    maxAttempts,
    keyFor: req => String(req.ip || "unknown")
  });

  return (req, res, next) => {
    const key = limiter.keyFor(req);
    const retry = limiter.check(key);
    if (retry !== null) {
      res.set("Retry-After", String(retry));
      if (header) {
        res.set("Content-Type", "text/plain; charset=utf-8");
        return res.status(429).send(message);
      }
      return res.status(429).json({ error: message });
    }
    limiter.record(key);
    return next();
  };
}

const subscribeLimiter = createRequestLimiter({
  windowMs: 60 * 1000,
  maxAttempts: 10,
  message: "Too many subscription attempts. Try again shortly."
});

const eventLimiter = createRequestLimiter({
  windowMs: 60 * 1000,
  maxAttempts: 60,
  message: "Too many requests. Try again shortly."
});

const goLimiter = createRequestLimiter({
  windowMs: 60 * 1000,
  maxAttempts: 180,
  message: "Too many redirect requests. Try again shortly.",
  header: true
});

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function setSharedCache(res, seconds = 60) {
  res.set("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=300`);
}

function setNoStore(res) {
  res.set("Cache-Control", "no-store");
}

/* ------------------------------------------------------------------ */
/* GET /api/monetization                                               */
/* ------------------------------------------------------------------ */

monetizationApi.get("/monetization", async (req, res) => {
  try {
    const [disclosures, mailing, manifest, ads] = await Promise.all([
      monetization.getDisclosures(),
      monetization.mailingConfig(),
      adsService.getPublicManifest(),
      Promise.all(
        monetization.DIRECT_ADS_PLACEMENTS.map(placement =>
          directAds.activeAdsForPlacement(placement).then(adsFor => ({ placement, ads: adsFor }))
        )
      )
    ]);

    const directAdsByPlacement = {};
    for (const entry of ads) directAdsByPlacement[entry.placement] = entry.ads;

    setSharedCache(res, 60);
    return res.json({
      ads_active: manifest.enabled,
      consent_required: manifest.consent_required,
      disclosures: {
        affiliate: disclosures.affiliate_disclosure,
        sponsored: disclosures.sponsored_disclosure,
        advertising: disclosures.advertising_disclosure,
        privacy: disclosures.privacy_notice
      },
      newsletter: {
        enabled: true,
        can_send: mailing.can_send,
        provider: mailing.provider,
        from_email: mailing.from_email
      },
      direct_ads: directAdsByPlacement
    });
  } catch (error) {
    console.error("Get monetization config error:", error.message);
    setNoStore(res);
    return res.json({
      ads_active: false,
      consent_required: true,
      disclosures: {},
      newsletter: { enabled: false, can_send: false, provider: "", from_email: "" },
      direct_ads: {}
    });
  }
});

/* ------------------------------------------------------------------ */
/* Optional analytics                                                   */
/* ------------------------------------------------------------------ */

/**
 * GET /api/analytics/config
 *
 * The opt-in GA4 loader reads this once. It is same-origin and cacheable, so a
 * page load never reaches Google unless the operator configured a measurement
 * id (see monetization-service.getAnalyticsConfig). No secret is returned.
 */
monetizationApi.get("/analytics/config", (req, res) => {
  setSharedCache(res, 300);
  return res.json(monetization.getAnalyticsConfig());
});

/* ------------------------------------------------------------------ */
/* Article-level monetization                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve one published article's monetization projection. A draft answers
 * exactly like a missing slug: the endpoint is joined to articles.status so an
 * unpublished story's relationships cannot be probed.
 */
async function articleMonetization(column, key) {
  const SOURCE_COLUMNS = { id: "articles.id", slug: "articles.slug" };
  const qualified = SOURCE_COLUMNS[column];
  if (!qualified) return null;

  const { rows } = await poolQueryArticle(qualified, key);
  if (rows.length === 0) return null;
  const row = rows[0];

  const ads_enabled =
    row.ads_enabled === null || row.ads_enabled === undefined
      ? row.default_ads_enabled !== false
      : row.ads_enabled === true;

  const [sponsoredInfo, affiliateLinks, disclosures] = await Promise.all([
    sponsored.getPublicCampaign(row.id),
    affiliate.linksForArticle(row.id, row.category_id),
    monetization.getDisclosures()
  ]);

  return {
    article: { id: row.id },
    ads_enabled,
    sponsored: sponsoredInfo,
    affiliate_links: affiliateLinks,
    disclosures: {
      affiliate: disclosures.affiliate_disclosure,
      sponsored: disclosures.sponsored_disclosure,
      advertising: disclosures.advertising_disclosure
    }
  };
}

function poolQueryArticle(qualified, key) {
  return require("./db").query(
    `SELECT articles.id, articles.ads_enabled, articles.category_id,
            categories.default_ads_enabled
       FROM articles
       LEFT JOIN categories ON categories.id = articles.category_id
      WHERE ${qualified} = $1 AND articles.status = 'published'
      LIMIT 1`,
    [key]
  );
}

monetizationApi.get("/articles/:id/monetization", async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(404).json({ error: "Article not found" });
  }

  try {
    const payload = await articleMonetization("id", req.params.id);
    if (!payload) return res.status(404).json({ error: "Article not found" });
    setSharedCache(res, 60);
    return res.json(payload);
  } catch (error) {
    console.error("Get article monetization error:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

monetizationApi.get("/articles/slug/:slug/monetization", async (req, res) => {
  try {
    const payload = await articleMonetization("slug", req.params.slug);
    if (!payload) return res.status(404).json({ error: "Article not found" });
    setSharedCache(res, 60);
    return res.json(payload);
  } catch (error) {
    console.error("Get article monetization error:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ------------------------------------------------------------------ */
/* Newsletter                                                          */
/* ------------------------------------------------------------------ */

monetizationApi.post("/newsletter/subscribe", subscribeLimiter, async (req, res) => {
  // source is forced server-side: a visitor can never claim to be a widget.
  const result = await monetization.subscribe({
    email: typeof req.body?.email === "string" ? req.body.email : "",
    name: typeof req.body?.name === "string" ? req.body.name : "",
    source: "site"
  });

  if (!result.ok) return res.status(400).json({ error: result.error });

  setNoStore(res);
  return res.json({
    ok: true,
    status: result.subscriber.status,
    mailing: monetization.mailingConfig()
  });
});

monetizationApi.post("/newsletter/unsubscribe", subscribeLimiter, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const result = await monetization.unsubscribeByToken(token);

  setNoStore(res);
  if (!result.ok) return res.status(404).json({ error: result.error });
  return res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Direct-ad event tracking                                            */
/* ------------------------------------------------------------------ */

function trackEvent(type) {
  return async (req, res) => {
    try {
      const adId = req.body?.ad_id ?? req.body?.adId;
      const meta = monetization.metaFromRequest(req);
      const result = await directAds.recordEvent({ adId, type, meta });

      setNoStore(res);
      // A non-servable ad is a caller error, not a server error; answer 404 so
      // a stale page stops counting without retrying.
      return result.recorded
        ? res.json({ ok: true })
        : res.status(404).json({ error: "Ad is not currently active." });
    } catch (error) {
      console.error(`Record direct-ad ${type} error:`, error.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

monetizationApi.post("/ads/direct/impression", eventLimiter, trackEvent("impression"));
monetizationApi.post("/ads/direct/click", eventLimiter, trackEvent("click"));

/* ------------------------------------------------------------------ */
/* Affiliate redirect: /go/:slug                                       */
/* ------------------------------------------------------------------ */

goRouter.get("/:slug", goLimiter, async (req, res) => {
  try {
    const link = await affiliate.getLinkBySlug(req.params.slug);
    if (!link) {
      setNoStore(res);
      return res.status(404).type("text/plain").send("Not found");
    }

    if (link.status !== "active") {
      setNoStore(res);
      return res
        .status(410)
        .type("text/plain")
        .send("This link is no longer active.");
    }

    // Log the click with anonymised metadata before following: the redirect is
    // one round-trip, so the insert's timing is imperceptible to the reader.
    const meta = monetization.metaFromRequest(req);
    await affiliate.recordClick({
      linkId: link.id,
      articleId: link.article_id,
      meta
    });

    setNoStore(res);
    return res.redirect(302, affiliate.redirectTarget(link));
  } catch (error) {
    console.error("Affiliate redirect error:", error.message);
    return res.status(500).type("text/plain").send("Redirect temporarily unavailable.");
  }
});

module.exports = { goRouter, monetizationApi };