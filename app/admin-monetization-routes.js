"use strict";

/**
 * KaliNova — admin monetization routes
 *
 * Registered onto the two routers admin-routes.js already builds, so every
 * screen inherits the same chain as the dashboard and article pages:
 *
 *   /admin/monetization*        adminPages — HTML, no-store + admin CSP + CSRF +
 *                               authenticated session, then the page guard
 *   /api/admin/monetization*    adminApi   — JSON for the same operations
 *
 * Policy notes shared by every handler:
 *   - every mutation is written only after the matching service validated the
 *     input; nothing here trusts the browser
 *   - every mutation is written to monetization_audit_logs through the shared
 *     logAudit helper, with sanitised details only
 *   - deletions require an explicit "confirm" field from the form
 *   - the pages never fabricate numbers, and nothing here can turn ads on by
 *     itself (AdSense remains a separate screen, and the services start off)
 */

const express = require("express");

const affiliate = require("./affiliate-service");
const directAds = require("./direct-ads-service");
const monetization = require("./monetization-service");
const pool = require("./db");
const security = require("./security");
const sponsored = require("./sponsored-service");
const views = require("./admin-monetization-views");
const { renderNotFoundPage } = require("./admin-views");

const MAX_SELECT_ARTICLES = 300;

function parseId(value) {
  const id = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function noticeFrom(query) {
  return typeof query.notice === "string" ? query.notice.slice(0, 200) : "";
}

function notFoundPage(req, res) {
  return res.status(404).type("html").send(renderNotFoundPage({ csrfToken: req.csrfToken }));
}

/** Article + category options for the single-select fields. */
async function selectOptions() {
  const [articles, categories] = await Promise.all([
    pool.query(
      `SELECT id, title FROM articles
        ORDER BY
          CASE status WHEN 'published' THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT ${MAX_SELECT_ARTICLES}`
    ),
    pool.query("SELECT id, name FROM categories ORDER BY display_order ASC, name ASC")
  ]);

  return {
    articleOptions: articles.rows.map(row => ({ value: row.id, title: row.title })),
    categoryOptions: categories.rows.map(row => ({ value: row.id, name: row.name }))
  };
}

async function recordAdmin(req, action, entityType = "", entityId = null, details = {}) {
  return monetization.logAudit({
    adminId: req.admin ? req.admin.id : null,
    action,
    entityType,
    entityId,
    details
  });
}

/** Apply the three per-category defaults from a page form or a JSON body. */
async function setCategoryDefaults(client, body) {
  const { rows } = await client.query("SELECT id FROM categories ORDER BY id");
  for (const row of rows) {
    const set = (column, name) =>
      client.query(
        `UPDATE categories SET ${column} = $1 WHERE id = $2`,
        [Boolean(body?.[`def_${name}_${row.id}`]), row.id]
      );
    await set("default_ads_enabled", "ads");
    await set("default_affiliate_enabled", "aff");
    await set("default_direct_ads_enabled", "direct");
  }
}

/* ==================================================================== */
/* HTML pages                                                           */
/* ==================================================================== */

function registerPages(pages) {
  const guard = security.requireAdminPage;

  /* ---- overview ---------------------------------------------------- */

  pages.get("/monetization", guard, async (req, res, next) => {
    try {
      const overview = await monetization.getOverview();
      res.type("html").send(
        views.renderOverview({
          admin: req.admin,
          csrfToken: req.csrfToken,
          overview
        })
      );
    } catch (error) {
      next(error);
    }
  });

  /* ---- affiliate ---------------------------------------------------- */

  pages.get("/monetization/affiliate", guard, async (req, res, next) => {
    try {
      const [links, { articleOptions, categoryOptions }] = await Promise.all([
        affiliate.listLinks(),
        selectOptions()
      ]);

      res.type("html").send(
        views.renderAffiliatePage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          links,
          articleOptions,
          categoryOptions,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/affiliate", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const result = affiliate.validateLink(req.body, { isNew: true });
      if (!result.ok) return renderAffiliatePageWith(req, res, { errors: result.errors });

      const link = await affiliate.createLink(result.values);
      await recordAdmin(req, "affiliate.create", "affiliate_link", link.id, {
        name: link.name,
        slug: link.slug
      });

      return res.redirect(303, `/admin/monetization/affiliate?notice=${encodeURIComponent(`“${link.name}” was added.`)}`);
    } catch (error) {
      next(error);
    }
  });

  pages.get("/monetization/affiliate/:id/edit", guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const link = await affiliate.getLink(id);
      if (!link) return notFoundPage(req, res);

      const { articleOptions, categoryOptions } = await selectOptions();
      res.type("html").send(
        views.renderAffiliateForm({
          admin: req.admin,
          csrfToken: req.csrfToken,
          link,
          articleOptions,
          categoryOptions
        })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/affiliate/:id", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const link = await affiliate.getLink(id);
      if (!link) return notFoundPage(req, res);

      const result = affiliate.validateLink(req.body, { isNew: false });
      if (!result.ok) {
        const { articleOptions, categoryOptions } = await selectOptions();
        return res.status(422).type("html").send(
          views.renderAffiliateForm({
            admin: req.admin,
            csrfToken: req.csrfToken,
            link,
            articleOptions,
            categoryOptions,
            values: views.submittedValues(req.body),
            errors: result.errors
          })
        );
      }

      const updated = await affiliate.updateLink(id, result.values);
      await recordAdmin(req, "affiliate.update", "affiliate_link", id, {
        name: updated ? updated.name : link.name,
        slug: updated ? updated.slug : link.slug
      });

      return res.redirect(303, `/admin/monetization/affiliate?notice=${encodeURIComponent("The link was saved.")}`);
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/affiliate/:id/delete", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id || String(req.body?.confirm) !== "1") return notFoundPage(req, res);

      const deleted = await affiliate.deleteLink(id);
      if (!deleted) return notFoundPage(req, res);

      await recordAdmin(req, "affiliate.delete", "affiliate_link", id, {
        name: deleted.name,
        slug: deleted.slug
      });

      return res.redirect(303, `/admin/monetization/affiliate?notice=${encodeURIComponent("The link was deleted.")}`);
    } catch (error) {
      next(error);
    }
  });

  /* ---- sponsored ---------------------------------------------------- */

  pages.get("/monetization/sponsored", guard, async (req, res, next) => {
    try {
      const [campaigns, { articleOptions }] = await Promise.all([
        sponsored.listCampaigns(),
        selectOptions()
      ]);

      res.type("html").send(
        views.renderSponsoredPage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          campaigns,
          articleOptions,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/sponsored", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const result = sponsored.validateCampaign(req.body);
      if (!result.ok) return renderSponsoredPageWith(req, res, { errors: result.errors });

      const saved = await sponsored.upsertCampaign(result.values);
      if (!saved.ok) return renderSponsoredPageWith(req, res, { errors: { article_id: saved.error } });

      await recordAdmin(req, "sponsored.upsert", "sponsored_campaign", result.values.article_id, {
        sponsor_name: result.values.sponsor_name,
        status: result.values.status
      });

      return res.redirect(303, `/admin/monetization/sponsored?notice=${encodeURIComponent("The sponsored campaign was saved.")}`);
    } catch (error) {
      next(error);
    }
  });

  pages.get("/monetization/sponsored/:articleId/edit", guard, async (req, res, next) => {
    try {
      const articleId = parseId(req.params.articleId);
      if (!articleId) return notFoundPage(req, res);

      const campaign = await sponsored.getCampaignByArticle(articleId);
      if (!campaign) return notFoundPage(req, res);

      const { articleOptions } = await selectOptions();
      res.type("html").send(
        views.renderSponsoredForm({
          admin: req.admin,
          csrfToken: req.csrfToken,
          campaign,
          articleOptions
        })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/sponsored/:articleId", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const articleId = parseId(req.params.articleId);
      if (!articleId) return notFoundPage(req, res);

      const campaign = await sponsored.getCampaignByArticle(articleId);
      if (!campaign) return notFoundPage(req, res);

      const result = sponsored.validateCampaign({ ...req.body, article_id: articleId });
      if (!result.ok) {
        const { articleOptions } = await selectOptions();
        return res.status(422).type("html").send(
          views.renderSponsoredForm({
            admin: req.admin,
            csrfToken: req.csrfToken,
            campaign,
            articleOptions,
            values: views.sponsoredSubmitted(req.body),
            errors: result.errors
          })
        );
      }

      await sponsored.upsertCampaign(result.values);
      await recordAdmin(req, "sponsored.upsert", "sponsored_campaign", articleId, {
        sponsor_name: result.values.sponsor_name,
        status: result.values.status
      });

      return res.redirect(303, `/admin/monetization/sponsored?notice=${encodeURIComponent("The campaign was saved.")}`);
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/sponsored/:articleId/delete", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const articleId = parseId(req.params.articleId);
      if (!articleId || String(req.body?.confirm) !== "1") return notFoundPage(req, res);

      const deleted = await sponsored.deleteCampaign(articleId);
      if (!deleted) return notFoundPage(req, res);

      await recordAdmin(req, "sponsored.delete", "sponsored_campaign", articleId);

      return res.redirect(303, `/admin/monetization/sponsored?notice=${encodeURIComponent("The campaign was deleted.")}`);
    } catch (error) {
      next(error);
    }
  });

  /* ---- direct ads --------------------------------------------------- */

  pages.get("/monetization/direct-ads", guard, async (req, res, next) => {
    try {
      const ads = await directAds.listAds();
      res.type("html").send(
        views.renderDirectAdsPage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          ads,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/direct-ads", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const result = directAds.validateAd(req.body, { isNew: true });
      if (!result.ok) return renderDirectAdsPageWith(req, res, { errors: result.errors });

      const ad = await directAds.createAd(result.values);
      await recordAdmin(req, "direct_ads.create", "direct_ad", ad.id, { name: ad.name, placement: ad.placement });

      return res.redirect(303, `/admin/monetization/direct-ads?notice=${encodeURIComponent(`“${ad.name}” was added.`)}`);
    } catch (error) {
      next(error);
    }
  });

  pages.get("/monetization/direct-ads/:id/edit", guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const ad = await directAds.getAd(id);
      if (!ad) return notFoundPage(req, res);

      res.type("html").send(
        views.renderDirectAdForm({ admin: req.admin, csrfToken: req.csrfToken, ad })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/direct-ads/:id", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const ad = await directAds.getAd(id);
      if (!ad) return notFoundPage(req, res);

      const result = directAds.validateAd(req.body, { isNew: false });
      if (!result.ok) {
        return res.status(422).type("html").send(
          views.renderDirectAdForm({
            admin: req.admin,
            csrfToken: req.csrfToken,
            ad,
            values: views.directSubmitted(req.body),
            errors: result.errors
          })
        );
      }

      const updated = await directAds.updateAd(id, result.values);
      await recordAdmin(req, "direct_ads.update", "direct_ad", id, {
        name: result.values.name,
        placement: result.values.placement,
        status: result.values.status
      });

      return res.redirect(303, `/admin/monetization/direct-ads?notice=${encodeURIComponent("The campaign was saved.")}`);
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/direct-ads/:id/delete", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id || String(req.body?.confirm) !== "1") return notFoundPage(req, res);

      const deleted = await directAds.deleteAd(id);
      if (!deleted) return notFoundPage(req, res);

      await recordAdmin(req, "direct_ads.delete", "direct_ad", id, { name: deleted.name });

      return res.redirect(303, `/admin/monetization/direct-ads?notice=${encodeURIComponent("The campaign was deleted.")}`);
    } catch (error) {
      next(error);
    }
  });

  /* ---- newsletter --------------------------------------------------- */

  pages.get("/monetization/newsletter", guard, async (req, res, next) => {
    try {
      const [subscribers, counts, mailing] = await Promise.all([
        monetization.listSubscribers({}),
        monetization.subscriberCounts(),
        monetization.mailingConfig()
      ]);

      res.type("html").send(
        views.renderNewsletterPage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          subscribers,
          counts,
          mailing,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/newsletter/:id/unsubscribe", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return notFoundPage(req, res);

      const affected = await monetization.adminUnsubscribe(id);
      await recordAdmin(req, "newsletter.unsubscribe", "newsletter_subscriber", id);

      return res.redirect(303, `/admin/monetization/newsletter?notice=${encodeURIComponent(affected ? "Subscriber unsubscribed." : "Subscriber was not subscribed.")}`);
    } catch (error) {
      next(error);
    }
  });

  /* ---- disclosures -------------------------------------------------- */

  pages.get("/monetization/disclosures", guard, async (req, res, next) => {
    try {
      const disclosures = await monetization.getDisclosures();
      res.type("html").send(
        views.renderDisclosuresPage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          disclosures,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/disclosures", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const disclosures = await monetization.updateDisclosures(req.body || {});
      await recordAdmin(req, "disclosures.update", "monetization_disclosures", 1);

      return res.redirect(303, `/admin/monetization/disclosures?notice=${encodeURIComponent("Disclosures saved.")}`);
    } catch (error) {
      next(error);
    }
  });

  /* ---- settings ----------------------------------------------------- */

  pages.get("/monetization/settings", guard, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, name, default_ads_enabled, default_affiliate_enabled, default_direct_ads_enabled
          FROM categories
         ORDER BY display_order ASC, name ASC`);
      res.type("html").send(
        views.renderSettingsPage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          categories: rows,
          notice: noticeFrom(req.query)
        })
      );
    } catch (error) {
      next(error);
    }
  });

  pages.post("/monetization/settings", security.requireCsrf, guard, async (req, res, next) => {
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setCategoryDefaults(client, req.body || {});
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await recordAdmin(req, "settings.update", "categories");

      return res.redirect(303, `/admin/monetization/settings?notice=${encodeURIComponent("Defaults saved.")}`);
    } catch (error) {
      next(error);
    }
  });

  /* ---- audit -------------------------------------------------------- */

  pages.get("/monetization/audit", guard, async (req, res, next) => {
    try {
      const entries = await monetization.listAudit({ limit: 100 });
      res.type("html").send(
        views.renderAuditPage({
          admin: req.admin,
          csrfToken: req.csrfToken,
          entries
        })
      );
    } catch (error) {
      next(error);
    }
  });

  return pages;
}

/* 422 re-renders (kept next to the pages they belong to) */

async function renderAffiliatePageWith(req, res, { errors }) {
  const [links, { articleOptions, categoryOptions }] = await Promise.all([
    affiliate.listLinks(),
    selectOptions()
  ]);
  return res.status(422).type("html").send(
    views.renderAffiliatePage({
      admin: req.admin,
      csrfToken: req.csrfToken,
      links,
      articleOptions,
      categoryOptions,
      values: views.submittedValues(req.body),
      errors
    })
  );
}

async function renderSponsoredPageWith(req, res, { errors }) {
  const [campaigns, { articleOptions }] = await Promise.all([
    sponsored.listCampaigns(),
    selectOptions()
  ]);
  return res.status(422).type("html").send(
    views.renderSponsoredPage({
      admin: req.admin,
      csrfToken: req.csrfToken,
      campaigns,
      articleOptions,
      values: views.sponsoredSubmitted(req.body),
      errors
    })
  );
}

async function renderDirectAdsPageWith(req, res, { errors }) {
  const ads = await directAds.listAds();
  return res.status(422).type("html").send(
    views.renderDirectAdsPage({
      admin: req.admin,
      csrfToken: req.csrfToken,
      ads,
      values: views.directSubmitted(req.body),
      errors
    })
  );
}

/* ==================================================================== */
/* JSON API                                                             */
/* ==================================================================== */

function registerApi(api) {
  const guard = [security.attachAdmin, security.requireAdmin];

  api.get("/monetization/overview", ...guard, async (req, res, next) => {
    try {
      res.json(await monetization.getOverview());
    } catch (error) {
      next(error);
    }
  });

  /* ---- affiliate ---------------------------------------------------- */

  api.get("/monetization/affiliate", ...guard, async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "";
      res.json({ links: await affiliate.listLinks({ status }) });
    } catch (error) {
      next(error);
    }
  });

  api.post("/monetization/affiliate", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const result = affiliate.validateLink(req.body || {}, { isNew: true });
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const link = await affiliate.createLink(result.values);
      await recordAdmin(req, "affiliate.create", "affiliate_link", link.id, { name: link.name, slug: link.slug });

      return res.status(201).json({ link });
    } catch (error) {
      next(error);
    }
  });

  api.get("/monetization/affiliate/:id", ...guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const link = id ? await affiliate.getLink(id) : null;
      if (!link) return res.status(404).json({ error: "Link not found" });
      return res.json({ link });
    } catch (error) {
      next(error);
    }
  });

  const updateAffiliate = async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(404).json({ error: "Link not found" });

      const result = affiliate.validateLink(req.body || {}, { isNew: false });
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const link = await affiliate.updateLink(id, result.values);
      if (!link) return res.status(404).json({ error: "Link not found" });

      await recordAdmin(req, "affiliate.update", "affiliate_link", id, { name: link.name, slug: link.slug });
      return res.json({ link });
    } catch (error) {
      next(error);
    }
  };

  api.put("/monetization/affiliate/:id", ...guard, security.requireCsrf, updateAffiliate);
  api.patch("/monetization/affiliate/:id", ...guard, security.requireCsrf, updateAffiliate);

  api.delete("/monetization/affiliate/:id", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const deleted = id ? await affiliate.deleteLink(id) : null;
      if (!deleted) return res.status(404).json({ error: "Link not found" });

      await recordAdmin(req, "affiliate.delete", "affiliate_link", id, { name: deleted.name });
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  /* ---- sponsored ---------------------------------------------------- */

  api.get("/monetization/sponsored", ...guard, async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "";
      res.json({ campaigns: await sponsored.listCampaigns({ status }) });
    } catch (error) {
      next(error);
    }
  });

  api.post("/monetization/sponsored", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const result = sponsored.validateCampaign(req.body || {});
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const saved = await sponsored.upsertCampaign(result.values);
      if (!saved.ok) return res.status(404).json({ error: saved.error });

      await recordAdmin(req, "sponsored.upsert", "sponsored_campaign", result.values.article_id, {
        sponsor_name: result.values.sponsor_name,
        status: result.values.status
      });
      return res.json({ campaign: saved.campaign });
    } catch (error) {
      next(error);
    }
  });

  api.delete("/monetization/sponsored/:articleId", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const articleId = parseId(req.params.articleId);
      const deleted = articleId ? await sponsored.deleteCampaign(articleId) : null;
      if (!deleted) return res.status(404).json({ error: "Campaign not found" });

      await recordAdmin(req, "sponsored.delete", "sponsored_campaign", articleId);
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  /* ---- direct ads --------------------------------------------------- */

  api.get("/monetization/direct-ads", ...guard, async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "";
      res.json({ ads: await directAds.listAds({ status }) });
    } catch (error) {
      next(error);
    }
  });

  api.post("/monetization/direct-ads", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const result = directAds.validateAd(req.body || {}, { isNew: true });
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const ad = await directAds.createAd(result.values);
      await recordAdmin(req, "direct_ads.create", "direct_ad", ad.id, { name: ad.name, placement: ad.placement });
      return res.status(201).json({ ad });
    } catch (error) {
      next(error);
    }
  });

  api.get("/monetization/direct-ads/:id", ...guard, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const ad = id ? await directAds.getAd(id) : null;
      if (!ad) return res.status(404).json({ error: "Campaign not found" });
      return res.json({ ad });
    } catch (error) {
      next(error);
    }
  });

  const updateDirect = async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(404).json({ error: "Campaign not found" });

      const result = directAds.validateAd(req.body || {}, { isNew: false });
      if (!result.ok) return res.status(422).json({ error: "Validation failed", errors: result.errors });

      const ad = await directAds.updateAd(id, result.values);
      if (!ad) return res.status(404).json({ error: "Campaign not found" });

      await recordAdmin(req, "direct_ads.update", "direct_ad", id, {
        name: ad.name,
        placement: ad.placement,
        status: ad.status
      });
      return res.json({ ad });
    } catch (error) {
      next(error);
    }
  };

  api.put("/monetization/direct-ads/:id", ...guard, security.requireCsrf, updateDirect);
  api.patch("/monetization/direct-ads/:id", ...guard, security.requireCsrf, updateDirect);

  api.delete("/monetization/direct-ads/:id", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const deleted = id ? await directAds.deleteAd(id) : null;
      if (!deleted) return res.status(404).json({ error: "Campaign not found" });

      await recordAdmin(req, "direct_ads.delete", "direct_ad", id, { name: deleted.name });
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  /* ---- newsletter --------------------------------------------------- */

  api.get("/monetization/newsletter", ...guard, async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "";
      const [subscribers, counts] = await Promise.all([
        monetization.listSubscribers({ status }),
        monetization.subscriberCounts()
      ]);
      res.json({ subscribers, counts });
    } catch (error) {
      next(error);
    }
  });

  api.post("/monetization/newsletter/:id/unsubscribe", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const affected = id ? await monetization.adminUnsubscribe(id) : null;
      await recordAdmin(req, "newsletter.unsubscribe", "newsletter_subscriber", id);
      if (affected === null) return res.status(404).json({ error: "Subscriber not found or not subscribed" });
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  /* ---- disclosures -------------------------------------------------- */

  api.get("/monetization/disclosures", ...guard, async (req, res, next) => {
    try {
      res.json({ disclosures: await monetization.getDisclosures() });
    } catch (error) {
      next(error);
    }
  });

  api.put("/monetization/disclosures", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      await monetization.updateDisclosures(req.body || {});
      await recordAdmin(req, "disclosures.update", "monetization_disclosures", 1);
      res.json({ disclosures: await monetization.getDisclosures() });
    } catch (error) {
      next(error);
    }
  });

  /* ---- settings ----------------------------------------------------- */

  api.get("/monetization/settings", ...guard, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, name, default_ads_enabled, default_affiliate_enabled, default_direct_ads_enabled
          FROM categories ORDER BY display_order ASC, name ASC`);
      res.json({ categories: rows });
    } catch (error) {
      next(error);
    }
  });

  api.put("/monetization/settings", ...guard, security.requireCsrf, async (req, res, next) => {
    try {
      const body = req.body || {};
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setCategoryDefaults(client, body);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await recordAdmin(req, "settings.update", "categories");
      const { rows } = await pool.query(`
        SELECT id, name, default_ads_enabled, default_affiliate_enabled, default_direct_ads_enabled
          FROM categories ORDER BY display_order ASC, name ASC`);
      res.json({ ok: true, categories: rows });
    } catch (error) {
      next(error);
    }
  });

  /* ---- audit -------------------------------------------------------- */

  api.get("/monetization/audit", ...guard, async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || "50"), 10) || 50, 1), 200);
      res.json({ entries: await monetization.listAudit({ limit }) });
    } catch (error) {
      next(error);
    }
  });

  return api;
}

module.exports = { registerApi, registerPages };