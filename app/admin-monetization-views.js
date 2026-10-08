"use strict";

/**
 * KaliNova — admin monetization screens
 *
 * One overview screen and one screen per monetization surface, all rendered
 * server-side so they work without JavaScript and all inheriting the existing
 * admin design tokens:
 *
 *   /admin/monetization             overview numbers + honest status
 *   /admin/monetization/affiliate   affiliate links (list + form)
 *   /admin/monetization/sponsored   sponsored campaigns (list + form)
 *   /admin/monetization/direct-ads  direct banner campaigns (list + form)
 *   /admin/monetization/newsletter  subscribers + delivery status
 *   /admin/monetization/disclosures site-wide disclosure texts
 *   /admin/monetization/settings    category monetization defaults
 *   /admin/monetization/audit       the admin action log
 *
 * The Google AdSense screen already exists at /admin/ads; the sub-navigation
 * links there rather than duplicating the form.
 *
 * Nothing here fabricates numbers: the overview reports that revenue reporting
 * is not connected, and the newsletter screen states plainly when no delivery
 * provider is configured.
 */

const {
  BRAND,
  adminHeader,
  escapeHtml,
  formatDate,
  layout,
  pluralise
} = require("./admin-views");
const { DIRECT_ADS_PLACEMENTS, SPONSORED_LABELS } = require("./monetization-service");

const MONETIZATION_CSS = "/assets/admin/admin-monetization.css";

/* ==================================================================== */
/* Shared pieces                                                        */
/* ==================================================================== */

function errorList(errors) {
  const entries = Object.entries(errors || {});
  if (!entries.length) return "";

  return `<div class="admin-alert admin-alert--error" role="alert" id="form-errors">
      <p><strong>Nothing was saved.</strong> Fix the following:</p>
      <ul class="admin-error-list">
        ${entries
          .map(([field, message]) => `<li><code>${escapeHtml(field)}</code> ${escapeHtml(message)}</li>`)
          .join("\n        ")}
      </ul>
    </div>`;
}

function fieldError(errors, field) {
  const message = errors && errors[field];
  if (!message) return "";
  return `<p class="admin-field-error" id="${escapeHtml(field)}-error">${escapeHtml(message)}</p>`;
}

function attr(value) {
  return value === null || value === undefined ? "" : escapeHtml(value);
}

/** A checkbox that round-trips through a form POST without JavaScript. */
function checkbox({ id, name, checked, label, hint = "" }) {
  const hintBlock = hint ? `<p class="admin-field-hint">${escapeHtml(hint)}</p>` : "";
  return `<div class="admin-field admin-field--check">
      <input class="admin-checkbox" type="checkbox" id="${escapeHtml(id)}" name="${escapeHtml(name)}" value="1"${checked ? " checked" : ""}>
      <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
      ${hintBlock}
    </div>`;
}

function selectOptions(values, selected, labels) {
  return values
    .map(value => {
      const label = labels && labels[value] ? labels[value] : value;
      return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("\n          ");
}

/** The monetization sub-navigation, shown on every screen below. */
function monetNav(active) {
  const items = [
    ["overview", "Overview", "/admin/monetization"],
    ["affiliate", "Affiliate", "/admin/monetization/affiliate"],
    ["sponsored", "Sponsored", "/admin/monetization/sponsored"],
    ["direct", "Direct Ads", "/admin/monetization/direct-ads"],
    ["newsletter", "Newsletter", "/admin/monetization/newsletter"],
    ["disclosures", "Disclosures", "/admin/monetization/disclosures"],
    ["settings", "Settings", "/admin/monetization/settings"],
    ["audit", "Audit", "/admin/monetization/audit"]
  ];

  const tabs = items
    .map(([key, label, href]) => {
      const current = key === active ? " monet-tab--active" : "";
      const aria = key === active ? ' aria-current="page"' : "";
      return `<a class="monet-tab${current}" href="${escapeHtml(href)}"${aria}>${escapeHtml(label)}</a>`;
    })
    .join("\n    ");

  // The AdSense screen lives at /admin/ads; it is linked but never duplicated.
  const adsense = active === "adsense" ? " monet-tab--active" : "";
  const adsenseAria = active === "adsense" ? ' aria-current="page"' : "";

  return `<nav class="monet-tabs" aria-label="Monetization sections">
    ${tabs}
    <a class="monet-tab monet-tab--flush${adsense}" href="/admin/ads"${adsenseAria}>AdSense</a>
  </nav>`;
}

function pageHead({ title, subtitle = "", actions = "", notice = "", errors = {} }) {
  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";
  return `<div class="admin-page-head">
    <div>
      <h1 class="admin-page-title">${escapeHtml(title)}</h1>
      ${subtitle ? `<p class="admin-page-subtitle">${escapeHtml(subtitle)}</p>` : ""}
    </div>
    ${actions ? `<p class="admin-page-actions">${actions}</p>` : ""}
    ${noticeBlock}
    ${errorList(errors)}
  </div>`;
}

/** Submit-field echo helpers, matching the pattern of admin-ads-views. */
function submittedValues(body) {
  return {
    name: String(body?.name ?? ""),
    network: String(body?.network ?? ""),
    destination_url: String(body?.destination_url ?? ""),
    tracking_url: String(body?.tracking_url ?? ""),
    disclosure_text: String(body?.disclosure_text ?? ""),
    slug: String(body?.slug ?? ""),
    article_id: String(body?.article_id ?? ""),
    category_id: String(body?.category_id ?? ""),
    status: String(body?.status ?? "active"),
    position: String(body?.position ?? "0")
  };
}

function sponsoredSubmitted(body) {
  return {
    article_id: String(body?.article_id ?? ""),
    sponsor_name: String(body?.sponsor_name ?? ""),
    sponsor_url: String(body?.sponsor_url ?? ""),
    label: String(body?.label ?? "Sponsored"),
    disclosure: String(body?.disclosure ?? ""),
    start_at: String(body?.start_at ?? ""),
    end_at: String(body?.end_at ?? ""),
    status: String(body?.status ?? "draft")
  };
}

function directSubmitted(body) {
  return {
    name: String(body?.name ?? ""),
    advertiser_name: String(body?.advertiser_name ?? ""),
    image_url: String(body?.image_url ?? ""),
    image_alt: String(body?.image_alt ?? ""),
    destination_url: String(body?.destination_url ?? ""),
    placement: String(body?.placement ?? ""),
    start_date: String(body?.start_date ?? ""),
    end_date: String(body?.end_date ?? ""),
    status: String(body?.status ?? "draft"),
    priority: String(body?.priority ?? "100"),
    campaign_notes: String(body?.campaign_notes ?? "")
  };
}

/* ==================================================================== */
/* Overview                                                             */
/* ==================================================================== */

function statCard(label, value, hint = "") {
  return `<div class="admin-stat">
      <p class="admin-stat-value">${escapeHtml(value)}</p>
      <p class="admin-stat-label">${escapeHtml(label)}</p>
      ${hint ? `<p class="admin-stat-hint">${escapeHtml(hint)}</p>` : ""}
    </div>`;
}

function renderOverview({ admin, csrfToken, overview }) {
  const sponsoredTotal = Object.values(overview.sponsored).reduce((a, b) => a + b, 0);

  const sections = `
  <section class="admin-section" aria-labelledby="monet-overview-heading">
    <h2 class="admin-section-title" id="monet-overview-heading">Status</h2>
    <div class="admin-alert ${overview.ad_sense.configured ? "admin-alert--info" : "admin-alert--notice"}" role="status">
      <p><strong>${escapeHtml(overview.ad_sense.note)}</strong></p>
      <p>${escapeHtml(overview.revenue.message)} There is no ad-network or analytics integration wired in, so the dashboard shows activity, never invented revenue.</p>
    </div>
    <div class="admin-stats">
      ${statCard("Affiliate links", String(overview.affiliate.total), `${overview.affiliate.active} active`)}
      ${statCard("Affiliate clicks (30d)", String(overview.affiliate.clicks_30d), `${overview.affiliate.total_clicks} all-time`)}
      ${statCard("Sponsored campaigns", String(sponsoredTotal), `${overview.sponsored.active} active`)}
      ${statCard("Direct-ads campaigns", String(overview.direct_ads.total), `${overview.direct_ads.active} active`)}
      ${statCard("Direct-ad events (30d)", String(overview.direct_ads.impressions_30d + overview.direct_ads.clicks_30d), `${overview.direct_ads.impressions_30d} impressions · ${overview.direct_ads.clicks_30d} clicks`)}
      ${statCard("Newsletter subscribers", String(overview.newsletter.subscribed), `${overview.newsletter.pending} pending · ${overview.newsletter.unsubscribed} unsubscribed`)}
    </div>
  </section>

  <section class="admin-section" aria-labelledby="monet-surfaces-heading">
    <h2 class="admin-section-title" id="monet-surfaces-heading">Manage</h2>
    <p class="admin-note">Every surface below starts empty and switched off. The AdSense network is configured on its own screen.</p>
    <ul class="monet-links">
      <li><a href="/admin/monetization/affiliate">Affiliate links</a> — destinations editors attach to articles.</li>
      <li><a href="/admin/monetization/sponsored">Sponsored campaigns</a> — one commercial label per article.</li>
      <li><a href="/admin/monetization/direct-ads">Direct ads</a> — banner campaigns sold to advertisers.</li>
      <li><a href="/admin/monetization/newsletter">Newsletter</a> — one row per subscriber; no email is sent without a provider.</li>
      <li><a href="/admin/monetization/disclosures">Disclosures</a> — the site-wide disclosure texts.</li>
      <li><a href="/admin/monetization/settings">Settings</a> — category defaults for advertising.</li>
      <li><a href="/admin/ads">Google AdSense</a> — publisher ID, placements and consent.</li>
    </ul>
  </section>`;

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main" id="admin-main">
  ${monetNav("overview")}
  ${pageHead({ title: "Monetization", subtitle: "Overview" })}
  ${sections}
</main>
${adminFooter()}`;

  return layout({
    title: `Monetization | ${BRAND}`,
    content,
    bodyClass: "admin-body",
    extraStyles: [MONETIZATION_CSS]
  });
}

/* ==================================================================== */
/* Affiliate                                                            */
/* ==================================================================== */

function affiliateForm({ csrfToken, action, method = "post", values, errors, articleOptions, categoryOptions }) {
  return `<form class="admin-form admin-card" method="${method}" action="${escapeHtml(action)}">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">

    <div class="admin-field">
      <label for="name">Link name</label>
      <input id="name" name="name" type="text" required maxlength="120" value="${attr(values.name)}" ${errors.name ? "aria-invalid=\"true\" aria-describedby=\"name-error\"" : ""}>
      <p class="admin-field-hint">Shown to readers next to the link.</p>
      ${fieldError(errors, "name")}
    </div>

    <div class="admin-field">
      <label for="network">Network</label>
      <input id="network" name="network" type="text" maxlength="80" value="${attr(values.network)}">
      <p class="admin-field-hint">Optional programme label, e.g. &ldquo;Amazon Associates&rdquo;.</p>
    </div>

    <div class="admin-field">
      <label for="destination_url">Destination URL</label>
      <input id="destination_url" name="destination_url" type="url" inputmode="url" required maxlength="1000" value="${attr(values.destination_url)}" ${errors.destination_url ? "aria-invalid=\"true\" aria-describedby=\"destination_url-error\"" : ""}>
      <p class="admin-field-hint">Absolute http(s) URL the reader reaches through <code>/go/&hellip;</code>.</p>
      ${fieldError(errors, "destination_url")}
    </div>

    <div class="admin-field">
      <label for="tracking_url">Tracking URL (optional)</label>
      <input id="tracking_url" name="tracking_url" type="url" inputmode="url" maxlength="1000" value="${attr(values.tracking_url)}">
      <p class="admin-field-hint">When set, the redirect sends visitors here instead. Usually a network&rsquo;s tracked variant.</p>
    </div>

    <div class="admin-field">
      <label for="disclosure_text">Disclosure text (optional)</label>
      <textarea id="disclosure_text" name="disclosure_text" rows="3" maxlength="4000">${escapeHtml(values.disclosure_text)}</textarea>
      <p class="admin-field-hint">Shown under the link. Empty uses the site-wide affiliate disclosure.</p>
    </div>

    <div class="admin-field">
      <label for="slug">Redirect slug</label>
      <input id="slug" name="slug" type="text" maxlength="80" value="${attr(values.slug)}" ${errors.slug ? "aria-invalid=\"true\" aria-describedby=\"slug-error\"" : ""}>
      <p class="admin-field-hint">The <code>/go/&hellip;</code> suffix. Lowercase letters, numbers and hyphens; left blank it is generated from the name.</p>
      ${fieldError(errors, "slug")}
    </div>

    <div class="admin-field">
      <label for="article_id">Attached article</label>
      <select id="article_id" name="article_id">
        <option value="">— None (site-wide) —</option>
        ${selectOptions(articleOptions, values.article_id, articleLabels(articleOptions))}
      </select>
      <p class="admin-field-hint">Shows this link on one article. Choose none for a site-wide link.</p>
    </div>

    <div class="admin-field">
      <label for="category_id">Attached category</label>
      <select id="category_id" name="category_id">
        <option value="">— None —</option>
        ${selectOptions(categoryOptions, values.category_id, categoryLabels(categoryOptions))}
      </select>
      <p class="admin-field-hint">Shows this link on every article in one category.</p>
    </div>

    <div class="admin-field">
      <label for="status">Status</label>
      <select id="status" name="status">
        ${selectOptions(["active", "paused"], values.status)}
      </select>
      <p class="admin-field-hint">Paused links answer <code>410 Gone</code> on the redirect instead of forwarding.</p>
    </div>

    <div class="admin-field">
      <label for="position">Sort order</label>
      <input id="position" name="position" type="number" min="0" max="32767" step="1" value="${attr(values.position)}">
    </div>

    <button type="submit" class="admin-button admin-button--primary">Save link</button>
  </form>`;
}

function articleLabels(options) {
  return Object.fromEntries(options.map(item => [String(item.value), item.title]));
}

function categoryLabels(options) {
  return Object.fromEntries(options.map(item => [String(item.value), item.name]));
}

function renderAffiliatePage({ admin, csrfToken, links, articleOptions, categoryOptions, values = null, errors = {}, notice = "" }) {
  const shown = values || {
    name: "", network: "", destination_url: "", tracking_url: "",
    disclosure_text: "", slug: "", article_id: "", category_id: "",
    status: "active", position: "0"
  };

  const rows = links.length
    ? links.map(link => {
        const id = Number(link.id);
        const badge = link.status === "active"
          ? `<span class="admin-badge admin-badge--published">Active</span>`
          : `<span class="admin-badge admin-badge--draft">Paused</span>`;
        const attached = link.article_title
          ? `Article: ${escapeHtml(link.article_title)}`
          : link.category_name
            ? `Category: ${escapeHtml(link.category_name)}`
            : "Site-wide";
        return `<tr>
          <td data-label="Link"><strong>${escapeHtml(link.name)}</strong><br><code>/go/${escapeHtml(link.slug)}</code></td>
          <td data-label="Attached to">${attached}</td>
          <td data-label="Destination">${escapeHtml(link.destination_url)}</td>
          <td data-label="Clicks">${escapeHtml(String(link.click_count))}</td>
          <td data-label="Status">${badge}</td>
          <td data-label="Actions" class="admin-cell-actions">
            <a class="admin-action" href="/admin/monetization/affiliate/${id}/edit">Edit</a>
            <form class="admin-action-form" method="post" action="/admin/monetization/affiliate/${id}/delete">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
              <input type="hidden" name="confirm" value="1">
              <button type="submit" class="admin-action admin-action--danger">Delete</button>
            </form>
          </td>
        </tr>`;
      }).join("\n        ")
    : `<tr><td colspan="6" class="admin-table-empty">No affiliate links yet. Add the first one below.</td></tr>`;

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main" id="admin-main">
  ${monetNav("affiliate")}
  ${pageHead({ title: "Monetization", subtitle: "Affiliate links", notice })}

  <section class="admin-section" aria-labelledby="monet-affiliate-list-heading">
    <h2 class="admin-section-title" id="monet-affiliate-list-heading">Links</h2>
    ${errorList(errors)}
    <div class="admin-table-wrap">
      <table class="admin-table">
        <caption class="sr-only">Affiliate links with their destination, attachment, click count and status</caption>
        <thead>
          <tr><th scope="col">Link</th><th scope="col">Attached to</th><th scope="col">Destination</th><th scope="col">Clicks</th><th scope="col">Status</th><th scope="col">Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>

  <section class="admin-section" aria-labelledby="monet-affiliate-new-heading">
    <h2 class="admin-section-title" id="monet-affiliate-new-heading">Add a link</h2>
    ${affiliateForm({
      csrfToken,
      action: "/admin/monetization/affiliate",
      values: shown,
      errors,
      articleOptions,
      categoryOptions
    })}
  </section>
</main>`;

  return layout({ title: `Affiliate links | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

function renderAffiliateForm({ admin, csrfToken, link, articleOptions, categoryOptions, values = null, errors = {}, notice = "" }) {
  const shown = values || {
    name: link.name, network: link.network, destination_url: link.destination_url,
    tracking_url: link.tracking_url, disclosure_text: link.disclosure_text,
    slug: link.slug, article_id: String(link.article_id ?? ""),
    category_id: String(link.category_id ?? ""), status: link.status,
    position: String(link.position ?? 0)
  };

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main admin-main--narrow" id="admin-main">
  ${monetNav("affiliate")}
  ${pageHead({
    title: "Edit affiliate link",
    subtitle: link.slug,
    notice,
    actions: `<a class="admin-button" href="/admin/monetization/affiliate">Back to links</a>`
  })}
  ${errorList(errors)}
  ${affiliateForm({
    csrfToken,
    action: `/admin/monetization/affiliate/${link.id}`,
    values: shown,
    errors,
    articleOptions,
    categoryOptions
  })}
</main>`;

  return layout({ title: `Edit link | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

/* ==================================================================== */
/* Sponsored                                                            */
/* ==================================================================== */

function sponsoredForm({ csrfToken, action, values, errors, articleOptions, readOnlyArticle = false }) {
  const articleField = readOnlyArticle
    ? `<div class="admin-field"><label>Article</label><p class="admin-form-static">${escapeHtml(searchArticleTitle(articleOptions, values.article_id))}</p></div>`
    : `<div class="admin-field">
        <label for="article_id">Article</label>
        <select id="article_id" name="article_id" ${errors.article_id ? "aria-invalid=\"true\" aria-describedby=\"article_id-error\"" : ""}>
          <option value="">— Select an article —</option>
          ${selectOptions(articleOptions, values.article_id, articleLabels(articleOptions))}
        </select>
        ${fieldError(errors, "article_id")}
        <p class="admin-field-hint">One campaign per article. Assigning this screen again replaces the previous campaign.</p>
      </div>`;

  return `<form class="admin-form admin-card" method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
    ${articleField}

    <div class="admin-field">
      <label for="sponsor_name">Sponsor name</label>
      <input id="sponsor_name" name="sponsor_name" type="text" required maxlength="160" value="${attr(values.sponsor_name)}" ${errors.sponsor_name ? "aria-invalid=\"true\" aria-describedby=\"sponsor_name-error\"" : ""}>
      ${fieldError(errors, "sponsor_name")}
    </div>

    <div class="admin-field">
      <label for="sponsor_url">Sponsor URL (optional)</label>
      <input id="sponsor_url" name="sponsor_url" type="url" inputmode="url" maxlength="1000" value="${attr(values.sponsor_url)}">
    </div>

    <div class="admin-field">
      <label for="label">Label</label>
      <select id="label" name="label">
        ${selectOptions(SPONSORED_LABELS, values.label)}
      </select>
      <p class="admin-field-hint">The badge readers see on the article.</p>
    </div>

    <div class="admin-field">
      <label for="disclosure">Disclosure (optional)</label>
      <textarea id="disclosure" name="disclosure" rows="3" maxlength="4000">${escapeHtml(values.disclosure)}</textarea>
      <p class="admin-field-hint">Empty uses the site-wide sponsored disclosure.</p>
    </div>

    <div class="admin-field">
      <label for="start_at">Starts at</label>
      <input id="start_at" name="start_at" type="datetime-local" value="${attr(splitLocalDateTime(values.start_at))}">
    </div>

    <div class="admin-field">
      <label for="end_at">Ends at</label>
      <input id="end_at" name="end_at" type="datetime-local" value="${attr(splitLocalDateTime(values.end_at))}" ${errors.end_at ? "aria-invalid=\"true\" aria-describedby=\"end_at-error\"" : ""}>
      ${fieldError(errors, "end_at")}
    </div>

    <div class="admin-field">
      <label for="status">Status</label>
      <select id="status" name="status">
        ${selectOptions(["draft", "active", "paused", "ended"], values.status)}
      </select>
      <p class="admin-field-hint">Only <code>active</code> campaigns are shown to readers.</p>
    </div>

    <button type="submit" class="admin-button admin-button--primary">Save campaign</button>
  </form>`;
}

function searchArticleTitle(options, value) {
  const match = options.find(item => String(item.value) === String(value ?? ""));
  return match ? match.title : "—";
}

function splitLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderSponsoredPage({ admin, csrfToken, campaigns, articleOptions, values = null, errors = {}, notice = "" }) {
  const shown = values || sponsoredSubmitted({});

  const rows = campaigns.length
    ? campaigns.map(campaign => {
        const badgeMap = {
          draft: ["admin-badge--draft", "Draft"],
          active: ["admin-badge--published", "Active"],
          paused: ["admin-badge--draft", "Paused"],
          ended: ["admin-badge--draft", "Ended"]
        };
        const [badgeClass, badgeLabel] = badgeMap[campaign.status] || badgeMap.draft;
        return `<tr>
          <td data-label="Article"><strong>${escapeHtml(campaign.article_title || "Deleted article")}</strong><br><code>${escapeHtml(campaign.article_slug || "")}</code></td>
          <td data-label="Sponsor">${escapeHtml(campaign.sponsor_name)}</td>
          <td data-label="Label">${escapeHtml(campaign.label)}</td>
          <td data-label="Status"><span class="admin-badge ${badgeClass}">${badgeLabel}</span></td>
          <td data-label="Updated"><time datetime="${attr(campaign.updated_at)}">${escapeHtml(formatDate(campaign.updated_at))}</time></td>
          <td data-label="Actions" class="admin-cell-actions">
            <a class="admin-action" href="/admin/monetization/sponsored/${campaign.article_id}/edit">Edit</a>
            <form class="admin-action-form" method="post" action="/admin/monetization/sponsored/${campaign.article_id}/delete">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
              <input type="hidden" name="confirm" value="1">
              <button type="submit" class="admin-action admin-action--danger">Delete</button>
            </form>
          </td>
        </tr>`;
      }).join("\n        ")
    : `<tr><td colspan="6" class="admin-table-empty">No sponsored campaigns. Assign the first one below.</td></tr>`;

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main" id="admin-main">
  ${monetNav("sponsored")}
  ${pageHead({ title: "Monetization", subtitle: "Sponsored campaigns", notice })}

  <section class="admin-section" aria-labelledby="monet-sponsored-list-heading">
    <h2 class="admin-section-title" id="monet-sponsored-list-heading">Campaigns</h2>
    ${errorList(errors)}
    <div class="admin-table-wrap">
      <table class="admin-table">
        <caption class="sr-only">Sponsored campaigns with their article, sponsor, label and status</caption>
        <thead>
          <tr><th scope="col">Article</th><th scope="col">Sponsor</th><th scope="col">Label</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col">Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>

  <section class="admin-section" aria-labelledby="monet-sponsored-new-heading">
    <h2 class="admin-section-title" id="monet-sponsored-new-heading">Add a campaign</h2>
    ${sponsoredForm({ csrfToken, action: "/admin/monetization/sponsored", values: shown, errors, articleOptions })}
  </section>
</main>`;

  return layout({ title: `Sponsored | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

function renderSponsoredForm({ admin, csrfToken, campaign, articleOptions, values = null, errors = {}, notice = "" }) {
  const shown = values || sponsoredSubmitted({
    article_id: String(campaign.article_id),
    sponsor_name: campaign.sponsor_name,
    sponsor_url: campaign.sponsor_url,
    label: campaign.label,
    disclosure: campaign.disclosure,
    start_at: campaign.start_at,
    end_at: campaign.end_at,
    status: campaign.status
  });

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main admin-main--narrow" id="admin-main">
  ${monetNav("sponsored")}
  ${pageHead({
    title: "Edit sponsored campaign",
    subtitle: campaign.article_title || "Article",
    notice,
    actions: `<a class="admin-button" href="/admin/monetization/sponsored">Back to campaigns</a>`
  })}
  ${errorList(errors)}
  ${sponsoredForm({
    csrfToken,
    action: `/admin/monetization/sponsored/${campaign.article_id}`,
    values: shown,
    errors,
    articleOptions,
    readOnlyArticle: true
  })}
</main>`;

  return layout({ title: `Edit campaign | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

/* ==================================================================== */
/* Direct ads                                                           */
/* ==================================================================== */

function directForm({ csrfToken, action, values, errors }) {
  return `<form class="admin-form admin-card" method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">

    <div class="admin-field">
      <label for="name">Campaign name</label>
      <input id="name" name="name" type="text" required maxlength="120" value="${attr(values.name)}" ${errors.name ? "aria-invalid=\"true\" aria-describedby=\"name-error\"" : ""}>
      ${fieldError(errors, "name")}
      <p class="admin-field-hint">Internal name, e.g. &ldquo;Summer travel banner&rdquo;.</p>
    </div>

    <div class="admin-field">
      <label for="advertiser_name">Advertiser</label>
      <input id="advertiser_name" name="advertiser_name" type="text" maxlength="120" value="${attr(values.advertiser_name)}">
    </div>

    <div class="admin-field">
      <label for="image_url">Banner image URL</label>
      <input id="image_url" name="image_url" type="url" inputmode="url" required maxlength="1000" value="${attr(values.image_url)}" ${errors.image_url ? "aria-invalid=\"true\" aria-describedby=\"image_url-error\"" : ""}>
      <p class="admin-field-hint">Absolute http(s) URL served to readers. Host it on the site or on a CDN you control.</p>
      ${fieldError(errors, "image_url")}
    </div>

    <div class="admin-field">
      <label for="image_alt">Alt text</label>
      <input id="image_alt" name="image_alt" type="text" maxlength="300" value="${attr(values.image_alt)}">
    </div>

    <div class="admin-field">
      <label for="destination_url">Destination URL</label>
      <input id="destination_url" name="destination_url" type="url" inputmode="url" required maxlength="1000" value="${attr(values.destination_url)}" ${errors.destination_url ? "aria-invalid=\"true\" aria-describedby=\"destination_url-error\"" : ""}>
      ${fieldError(errors, "destination_url")}
    </div>

    <div class="admin-field">
      <label for="placement">Placement</label>
      <select id="placement" name="placement">
        ${selectOptions(DIRECT_ADS_PLACEMENTS, values.placement)}
      </select>
      ${errors.placement ? fieldError(errors, "placement") : ""}
    </div>

    <div class="admin-field">
      <label for="start_date">Start date</label>
      <input id="start_date" name="start_date" type="date" value="${attr(values.start_date)}">
    </div>

    <div class="admin-field">
      <label for="end_date">End date</label>
      <input id="end_date" name="end_date" type="date" value="${attr(values.end_date)}" ${errors.end_date ? "aria-invalid=\"true\" aria-describedby=\"end_date-error\"" : ""}>
      ${fieldError(errors, "end_date")}
      <p class="admin-field-hint">Blank means no date window; the status alone decides.</p>
    </div>

    <div class="admin-field">
      <label for="status">Status</label>
      <select id="status" name="status">
        ${selectOptions(["draft", "scheduled", "active", "paused", "expired"], values.status)}
      </select>
      <p class="admin-field-hint">Only <code>active</code> campaigns inside their date window are served.</p>
    </div>

    <div class="admin-field">
      <label for="priority">Priority</label>
      <input id="priority" name="priority" type="number" min="1" max="1000" step="1" value="${attr(values.priority)}" ${errors.priority ? "aria-invalid=\"true\" aria-describedby=\"priority-error\"" : ""}>
      ${fieldError(errors, "priority")}
      <p class="admin-field-hint">Lower numbers take precedence in the same placement.</p>
    </div>

    <div class="admin-field">
      <label for="campaign_notes">Campaign notes</label>
      <textarea id="campaign_notes" name="campaign_notes" rows="3" maxlength="2000">${escapeHtml(values.campaign_notes)}</textarea>
      <p class="admin-field-hint">Internal only; never rendered publicly.</p>
    </div>

    <button type="submit" class="admin-button admin-button--primary">Save campaign</button>
  </form>`;
}

function adServerNote(ad) {
  if (ad.status === "active") {
    const windowOk = (!ad.start_date || ad.start_date <= new Date().toISOString().slice(0, 10)) &&
      (!ad.end_date || ad.end_date >= new Date().toISOString().slice(0, 10));
    return windowOk ? "Serving now." : "Active status, but outside the date window.";
  }
  if (ad.status === "scheduled") return "Scheduled; will serve once the window opens.";
  return `Not serving (${ad.status}).`;
}

function renderDirectAdsPage({ admin, csrfToken, ads, values = null, errors = {}, notice = "" }) {
  const shown = values || directSubmitted({});

  const rows = ads.length
    ? ads.map(ad => {
        const id = Number(ad.id);
        const badge = ad.status === "active"
          ? `<span class="admin-badge admin-badge--published">Active</span>`
          : `<span class="admin-badge admin-badge--draft">${escapeHtml(ad.status)}</span>`;
        return `<tr>
          <td data-label="Campaign"><strong>${escapeHtml(ad.name)}</strong>${ad.advertiser_name ? `<br>${escapeHtml(ad.advertiser_name)}` : ""}</td>
          <td data-label="Placement"><code>${escapeHtml(ad.placement)}</code></td>
          <td data-label="Dates">${escapeHtml(ad.start_date || "—")} → ${escapeHtml(ad.end_date || "—")}</td>
          <td data-label="Events">${escapeHtml(String(ad.impression_count))} / ${escapeHtml(String(ad.click_count))}</td>
          <td data-label="Status">${badge}</td>
          <td data-label="Notes">${escapeHtml(adServerNote(ad))}</td>
          <td data-label="Actions" class="admin-cell-actions">
            <a class="admin-action" href="/admin/monetization/direct-ads/${id}/edit">Edit</a>
            <form class="admin-action-form" method="post" action="/admin/monetization/direct-ads/${id}/delete">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
              <input type="hidden" name="confirm" value="1">
              <button type="submit" class="admin-action admin-action--danger">Delete</button>
            </form>
          </td>
        </tr>`;
      }).join("\n        ")
    : `<tr><td colspan="7" class="admin-table-empty">No direct-ads campaigns yet. Add the first one below.</td></tr>`;

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main" id="admin-main">
  ${monetNav("direct")}
  ${pageHead({ title: "Monetization", subtitle: "Direct ads", notice })}

  <section class="admin-section" aria-labelledby="monet-direct-list-heading">
    <h2 class="admin-section-title" id="monet-direct-list-heading">Campaigns</h2>
    <p class="admin-note">Banner campaigns sold directly to advertisers. Impressions and clicks are recorded with anonymised metadata only.</p>
    ${errorList(errors)}
    <div class="admin-table-wrap">
      <table class="admin-table">
        <caption class="sr-only">Direct-ad campaigns with their placement, dates, events, status and notes</caption>
        <thead>
          <tr><th scope="col">Campaign</th><th scope="col">Placement</th><th scope="col">Dates</th><th scope="col">Impr / Clicks</th><th scope="col">Status</th><th scope="col">Notes</th><th scope="col">Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>

  <section class="admin-section" aria-labelledby="monet-direct-new-heading">
    <h2 class="admin-section-title" id="monet-direct-new-heading">Add a campaign</h2>
    ${directForm({ csrfToken, action: "/admin/monetization/direct-ads", values: shown, errors })}
  </section>
</main>`;

  return layout({ title: `Direct ads | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

function renderDirectAdForm({ admin, csrfToken, ad, values = null, errors = {}, notice = "" }) {
  const shown = values || directSubmitted({
    name: ad.name,
    advertiser_name: ad.advertiser_name,
    image_url: ad.image_url,
    image_alt: ad.image_alt,
    destination_url: ad.destination_url,
    placement: ad.placement,
    start_date: ad.start_date ? ad.start_date.toISOString?.().slice(0, 10) : (ad.start_date || ""),
    end_date: ad.end_date ? ad.end_date.toISOString?.().slice(0, 10) : (ad.end_date || ""),
    status: ad.status,
    priority: String(ad.priority),
    campaign_notes: ad.campaign_notes
  });

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main admin-main--narrow" id="admin-main">
  ${monetNav("direct")}
  ${pageHead({
    title: "Edit direct-ads campaign",
    subtitle: ad.name,
    notice,
    actions: `<a class="admin-button" href="/admin/monetization/direct-ads">Back to campaigns</a>`
  })}
  ${errorList(errors)}
  ${directForm({ csrfToken, action: `/admin/monetization/direct-ads/${ad.id}`, values: shown, errors })}
</main>`;

  return layout({ title: `Edit campaign | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

/* ==================================================================== */
/* Newsletter                                                           */
/* ==================================================================== */

function renderNewsletterPage({ admin, csrfToken, subscribers, counts, mailing, notice = "" }) {
  const rows = subscribers.length
    ? subscribers.map(sub => {
        const id = Number(sub.id);
        const badge = sub.status === "subscribed"
          ? `<span class="admin-badge admin-badge--published">Subscribed</span>`
          : `<span class="admin-badge admin-badge--draft">${escapeHtml(sub.status)}</span>`;
        const action = sub.status === "subscribed"
          ? `<form class="admin-action-form" method="post" action="/admin/monetization/newsletter/${id}/unsubscribe">
               <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
               <button type="submit" class="admin-action admin-action--danger">Unsubscribe</button>
             </form>`
          : "";
        return `<tr>
          <td data-label="Email">${escapeHtml(sub.email)}</td>
          <td data-label="Name">${escapeHtml(sub.name || "—")}</td>
          <td data-label="Status">${badge}</td>
          <td data-label="Since"><time datetime="${attr(sub.subscribed_at)}">${escapeHtml(formatDate(sub.subscribed_at))}</time></td>
          <td data-label="Actions" class="admin-cell-actions">${action}</td>
        </tr>`;
      }).join("\n        ")
    : `<tr><td colspan="5" class="admin-table-empty">No subscribers yet. The public form stores a row when someone subscribes.</td></tr>`;

  const providerBlock = mailing.can_send || mailing.provider
    ? `<p class="admin-note">Configured provider: <code>${escapeHtml(mailing.provider || "—")}</code>, from <code>${escapeHtml(mailing.from_email || "—")}</code>. Delivery is not enabled by this build.</p>`
    : `<div class="admin-alert admin-alert--info" role="status">
         <p><strong>Email delivery provider not configured.</strong> Subscriptions are stored so the list is never lost, but no email is sent yet.</p>
       </div>`;

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main" id="admin-main">
  ${monetNav("newsletter")}
  ${pageHead({ title: "Monetization", subtitle: "Newsletter subscribers", notice })}

  <div class="admin-stats">
    ${statCard("Subscribed", String(counts.subscribed))}
    ${statCard("Pending", String(counts.pending))}
    ${statCard("Unsubscribed", String(counts.unsubscribed))}
  </div>

  <section class="admin-section" aria-labelledby="monet-newsletter-delivery-heading">
    <h2 class="admin-section-title" id="monet-newsletter-delivery-heading">Delivery</h2>
    ${providerBlock}
  </section>

  <section class="admin-section" aria-labelledby="monet-newsletter-list-heading">
    <h2 class="admin-section-title" id="monet-newsletter-list-heading">Subscribers (${escapeHtml(String(subscribers.length))} shown)</h2>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <caption class="sr-only">Newsletter subscribers with email, name, status and subscription date</caption>
        <thead>
          <tr><th scope="col">Email</th><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Since</th><th scope="col">Actions</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>
</main>`;

  return layout({ title: `Newsletter | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

/* ==================================================================== */
/* Disclosures                                                          */
/* ==================================================================== */

function renderDisclosuresPage({ admin, csrfToken, disclosures, values = null, errors = {}, notice = "" }) {
  const shown = values || disclosures;

  const field = (name, label, hint) => `<div class="admin-field">
      <label for="${name}">${escapeHtml(label)}</label>
      <textarea id="${name}" name="${name}" rows="4" maxlength="4000">${escapeHtml(shown[name] || "")}</textarea>
      <p class="admin-field-hint">${escapeHtml(hint)}</p>
    </div>`;

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main admin-main--narrow" id="admin-main">
  ${monetNav("disclosures")}
  ${pageHead({ title: "Monetization", subtitle: "Site-wide disclosures", notice })}
  ${errorList(errors)}

  <form class="admin-form admin-card" method="post" action="/admin/monetization/disclosures">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
    <p class="admin-note">These plain-language texts are rendered wherever the matching monetisation appears. They are editorial copy, not legal guarantees.</p>
    ${field("affiliate_disclosure", "Affiliate disclosure", "Shown next to affiliate links that have no disclosure of their own.")}
    ${field("sponsored_disclosure", "Sponsored disclosure", "Shown on articles with an active sponsored campaign.")}
    ${field("advertising_disclosure", "Advertising disclosure", "Shown alongside advertisements and in the site footer.")}
    ${field("privacy_notice", "Privacy notice", "The short notice about how advertising data is handled.")}
    <button type="submit" class="admin-button admin-button--primary">Save disclosures</button>
  </form>
</main>`;

  return layout({ title: `Disclosures | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

/* ==================================================================== */
/* Settings                                                             */
/* ==================================================================== */

function renderSettingsPage({ admin, csrfToken, categories, notice = "", errors = {} }) {
  const rows = categories.length
    ? categories.map(category => {
        const id = Number(category.id);
        const box = (name, checked) => `<input class="admin-checkbox" type="checkbox" id="${name}" name="${name}" value="1"${checked ? " checked" : ""}>`;
        return `<tr>
          <td data-label="Category"><strong>${escapeHtml(category.name)}</strong></td>
          <td data-label="Ads">
            <div class="admin-field admin-field--check">
              ${box(`def_ads_${id}`, category.default_ads_enabled)}
              <label for="def_ads_${id}" class="sr-only">Ads enabled for ${escapeHtml(category.name)}</label>
            </div>
          </td>
          <td data-label="Affiliates">
            <div class="admin-field admin-field--check">
              ${box(`def_aff_${id}`, category.default_affiliate_enabled)}
              <label for="def_aff_${id}" class="sr-only">Affiliates enabled for ${escapeHtml(category.name)}</label>
            </div>
          </td>
          <td data-label="Direct ads">
            <div class="admin-field admin-field--check">
              ${box(`def_direct_${id}`, category.default_direct_ads_enabled)}
              <label for="def_direct_${id}" class="sr-only">Direct ads enabled for ${escapeHtml(category.name)}</label>
            </div>
          </td>
        </tr>`;
      }).join("\n        ")
    : `<tr><td colspan="4" class="admin-table-empty">No categories yet.</td></tr>`;

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main" id="admin-main">
  ${monetNav("settings")}
  ${pageHead({ title: "Monetization", subtitle: "Settings", notice })}
  ${errorList(errors)}

  <section class="admin-section" aria-labelledby="monet-settings-categories-heading">
    <h2 class="admin-section-title" id="monet-settings-categories-heading">Category defaults</h2>
    <p class="admin-note">
      Every new article inherits these defaults. A category may also toggle how
      the public pages render the three monetisation surfaces.
    </p>
    <form class="admin-form" method="post" action="/admin/monetization/settings">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <div class="admin-table-wrap">
        <table class="admin-table">
          <caption class="sr-only">Per-category monetisation defaults: ads, affiliates and direct ads</caption>
          <thead>
            <tr><th scope="col">Category</th><th scope="col">Ads</th><th scope="col">Affiliates</th><th scope="col">Direct ads</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <button type="submit" class="admin-button admin-button--primary">Save defaults</button>
    </form>
  </section>

  <section class="admin-section" aria-labelledby="monet-settings-notes-heading">
    <h2 class="admin-section-title" id="monet-settings-notes-heading">Notes</h2>
    <ul class="admin-note">
      <li>Google AdSense (publisher ID, placements, consent) is managed on the <a href="/admin/ads">Ads screen</a>.</li>
      <li><code>ANALYTICS_SALT</code> and <code>NEWSLETTER_*</code> are read from the environment; see <code>.env.example</code>.</li>
    </ul>
  </section>
</main>`;

  return layout({ title: `Settings | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

/* ==================================================================== */
/* Audit                                                                */
/* ==================================================================== */

function renderAuditPage({ admin, csrfToken, entries, notice = "" }) {
  const rows = entries.length
    ? entries.map(entry => {
        const detail = entry.details && Object.keys(entry.details).length
          ? `<code>${escapeHtml(JSON.stringify(entry.details))}</code>`
          : "—";
        return `<tr>
          <td data-label="When"><time datetime="${attr(entry.created_at)}">${escapeHtml(formatDate(entry.created_at))}</time></td>
          <td data-label="Admin">${escapeHtml(entry.admin_email || "—")}</td>
          <td data-label="Action"><code>${escapeHtml(entry.action)}</code></td>
          <td data-label="Entity"><code>${escapeHtml(entry.entity_type || "")}</code>${entry.entity_id ? ` #${escapeHtml(String(entry.entity_id))}` : ""}</td>
          <td data-label="Details">${detail}</td>
        </tr>`;
      }).join("\n        ")
    : `<tr><td colspan="5" class="admin-table-empty">No monetization actions recorded yet.</td></tr>`;

  const content = `${adminHeader({ active: "monetization", csrfToken, admin })}
<main class="admin-main" id="admin-main">
  ${monetNav("audit")}
  ${pageHead({ title: "Monetization", subtitle: "Audit log", notice })}

  <section class="admin-section" aria-labelledby="monet-audit-heading">
    <h2 class="admin-section-title" id="monet-audit-heading">Recent actions</h2>
    <p class="admin-note">${escapeHtml(pluralise(entries.length, "entry"))} shown, most recent first.</p>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <caption class="sr-only">Recent monetization administrator actions</caption>
        <thead>
          <tr><th scope="col">When</th><th scope="col">Admin</th><th scope="col">Action</th><th scope="col">Entity</th><th scope="col">Details</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>
</main>`;

  return layout({ title: `Audit | ${BRAND}`, content, bodyClass: "admin-body", extraStyles: [MONETIZATION_CSS] });
}

function adminFooter() {
  return `<footer class="admin-footer">
      <p>&copy; ${new Date().getFullYear()} ${escapeHtml(BRAND)}. Authorised administrators only.</p>
      <p><a href="/">Back to ${escapeHtml("kalinova.in")}</a></p>
    </footer>`;
}

module.exports = {
  directSubmitted,
  renderAffiliateForm,
  renderAffiliatePage,
  renderAuditPage,
  renderDirectAdForm,
  renderDirectAdsPage,
  renderDisclosuresPage,
  renderNewsletterPage,
  renderOverview,
  renderSettingsPage,
  renderSponsoredForm,
  renderSponsoredPage,
  sponsoredSubmitted,
  submittedValues
};