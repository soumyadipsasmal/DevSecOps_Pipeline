"use strict";

/**
 * KaliNova — admin monetization screens
 *
 * Two server-rendered pages that work without JavaScript:
 *
 *   /admin/ads            the site-wide switches, the AdSense identifiers and
 *                         the list of placements
 *   /admin/ads/:id/edit   one placement: on/off, type, slot, publisher
 *                         override, custom code, device visibility, reserved
 *                         height, and the in-article position
 *
 * Nothing here renders an ad. Every field is escaped on the way out, custom
 * markup is shown inside a <pre> rather than executed, and the page states
 * plainly that the site is not serving ads until an administrator supplies a
 * real publisher id.
 *
 * The page deliberately does not present a "test ad" or an example slot id,
 * because a placeholder id in the admin makes it easy to believe ads are live
 * when they are not.
 */

const {
  BRAND,
  adminHeader,
  escapeHtml,
  formatDate,
  layout
} = require("./admin-views");

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

/**
 * A short explanation of why the whole page is inert.
 *
 * This is the honest state of the product: the machinery exists, the site is not
 * monetised, and no third-party script is requested.
 */
function statusBanner(settings, placementCount, enabledCount) {
  if (!settings.ads_enabled) {
    return `<div class="admin-alert admin-alert--info" role="status">
        <p><strong>Ads are switched off site-wide.</strong> Nothing is rendered on the public site and no third-party script is requested.</p>
        <p>${escapeHtml(settings.adsense_client ? "A publisher ID is saved" : "No publisher ID is saved yet")} &middot; ${escapeHtml(enabledCount)} of ${escapeHtml(placementCount)} placements enabled.</p>
      </div>`;
  }

  if (!settings.adsense_client) {
    return `<div class="admin-alert admin-alert--error" role="alert">
        <p><strong>Ads are switched on but no publisher ID is saved.</strong> No ad can be served until a <code>ca-pub-…</code> ID is entered below.</p>
      </div>`;
  }

  return `<div class="admin-alert admin-alert--info" role="status">
      <p><strong>Ads are switched on.</strong> ${escapeHtml(enabledCount)} of ${escapeHtml(placementCount)} placements are enabled. Only placements with a slot ID and a usable publisher ID are served.</p>
    </div>`;
}

/* ==================================================================== */
/* Settings + list: /admin/ads                                          */
/* ==================================================================== */

function renderAdsPage({ admin, csrfToken, settings, placements, notice = "", errors = {} } = {}) {
  const enabledCount = placements.filter(placement => placement.is_enabled).length;
  const saved = Boolean(settings.adsense_client);

  const rows = placements.length
    ? placements
        .map(placement => {
          const id = Number(placement.id);
          const on = placement.is_enabled;
          const ready = placement.is_enabled && placement.ad_type !== "none" && placement.ad_slot;

          const badge = on
            ? `<span class="admin-badge admin-badge--published">On</span>`
            : `<span class="admin-badge admin-badge--draft">Off</span>`;

          const readiness = !on
            ? "Switched off"
            : placement.ad_type === "none"
              ? "No ad type selected"
              : placement.ad_slot
                ? `Slot ${placement.ad_slot}`
                : "No slot ID yet";

          const devices = [
            placement.show_desktop ? "Desktop" : "",
            placement.show_mobile ? "Mobile" : ""
          ]
            .filter(Boolean)
            .join(" + ");

          return `<tr>
            <td data-label="Placement">
              <strong>${escapeHtml(placement.placement_name)}</strong>
              <br><code>${escapeHtml(placement.placement_key)}</code>
            </td>
            <td data-label="Zone">${escapeHtml(placement.placement_zone)}</td>
            <td data-label="Status">${badge}</td>
            <td data-label="Type">${escapeHtml(placement.ad_type)}${ready ? "" : " <span class=\"admin-muted\">(" + escapeHtml(readiness) + ")</span>"}</td>
            <td data-label="Devices">${escapeHtml(devices || "None")}</td>
            <td data-label="Updated"><time datetime="${attr(placement.updated_at)}">${escapeHtml(formatDate(placement.updated_at))}</time></td>
            <td data-label="Actions" class="admin-cell-actions">
              <a class="admin-action" href="/admin/ads/${id}/edit">Edit</a>
            </td>
          </tr>`;
        })
        .join("\n          ")
    : `<tr>
            <td colspan="7" class="admin-table-empty">No placements yet. Run the ads migration to seed them.</td>
          </tr>`;

  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";

  const content = `${adminHeader({ active: "ads", csrfToken, admin })}

<main class="admin-main" id="admin-main">
  <div class="admin-page-head">
    <div>
      <h1 class="admin-page-title">Ads &amp; Monetization</h1>
      <p class="admin-page-subtitle">Ad placements, identifiers and consent</p>
    </div>
  </div>

  ${noticeBlock}
  ${statusBanner(settings, placements.length, enabledCount)}
  ${errorList(errors)}

  <section class="admin-section" aria-labelledby="admin-ads-switches-heading">
    <h2 class="admin-section-title" id="admin-ads-switches-heading">Site-wide switches</h2>

    <form class="admin-form" method="post" action="/admin/ads/settings">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">

      <h3 class="admin-form-section">Google AdSense</h3>

      <div class="admin-field">
        <label for="adsense_client">Publisher ID</label>
        <input
          id="adsense_client"
          name="adsense_client"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          maxlength="40"
          placeholder="ca-pub-XXXXXXXXXXXXXXX"
          value="${attr(settings.adsense_client)}"
          ${errors.adsense_client ? 'aria-invalid="true" aria-describedby="adsense_client-error"' : ""}>
        <p class="admin-field-hint">
          From your AdSense account. Leave empty until you have one &mdash; the site serves no ads without it.
          ${saved ? "" : "Not configured yet."}
        </p>
        ${fieldError(errors, "adsense_client")}
      </div>

      ${checkbox({
        id: "adsense_enabled",
        name: "adsense_enabled",
        checked: settings.adsense_enabled,
        label: "Enable the AdSense network",
        hint: "Only has an effect while site-wide ads are on and a publisher ID is saved."
      })}

      ${checkbox({
        id: "adsense_script_enabled",
        name: "adsense_script_enabled",
        checked: settings.adsense_script_enabled,
        label: "Load adsbygoogle.js",
        hint: "Loads Google&rsquo;s script once per page. Still requires a saved publisher ID."
      })}

      <h3 class="admin-form-section">Master switch</h3>

      ${checkbox({
        id: "ads_enabled",
        name: "ads_enabled",
        checked: settings.ads_enabled,
        label: "Serve ads site-wide",
        hint: "The only switch that can make an ad appear. While this is off, no placement is served."
      })}

      <h3 class="admin-form-section">Consent</h3>

      ${checkbox({
        id: "consent_required",
        name: "consent_required",
        checked: settings.consent_required,
        label: "Require consent before requesting ad data",
        hint: "While this is on, the public site withholds ad requests until the reader has agreed."
      })}

      <div class="admin-field">
        <label for="consent_script_url">Consent provider script URL</label>
        <input
          id="consent_script_url"
          name="consent_script_url"
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          maxlength="500"
          placeholder="https://&hellip;"
          value="${attr(settings.consent_script_url)}"
          ${errors.consent_script_url ? 'aria-invalid="true" aria-describedby="consent_script_url-error"' : ""}>
        <p class="admin-field-hint">Optional, absolute https URL. Leave empty until you have chosen a provider.</p>
        ${fieldError(errors, "consent_script_url")}
      </div>

      <button type="submit" class="admin-button admin-button--primary">Save settings</button>
    </form>
  </section>

  <section class="admin-section" aria-labelledby="admin-placements-heading">
    <h2 class="admin-section-title" id="admin-placements-heading">Placements</h2>
    <p class="admin-note">
      Each placement is independent and off by default. A placement only renders when it is
      enabled, has an ad type, has a slot ID, and resolves a publisher ID.
    </p>

    <div class="admin-table-wrap">
      <table class="admin-table">
        <caption class="sr-only">Every ad placement with its zone, status, ad type, devices and last change</caption>
        <thead>
          <tr>
            <th scope="col">Placement</th>
            <th scope="col">Zone</th>
            <th scope="col">Status</th>
            <th scope="col">Type</th>
            <th scope="col">Devices</th>
            <th scope="col">Updated</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </section>
</main>`;

  return layout({ title: `Ads & Monetization | ${BRAND}`, content, bodyClass: "admin-body" });
}

/* ==================================================================== */
/* One placement: /admin/ads/:id/edit                                  */
/* ==================================================================== */

/** Echo the values from a rejected submission so nothing has to be retyped. */
function submittedValues(body) {
  const one = (...names) => {
    for (const name of names) {
      const value = body ? body[name] : undefined;
      if (value !== undefined && value !== null) return String(value);
    }
    return "";
  };

  // An unticked checkbox is simply absent from the POST body, so "1" or "".
  const flag = (...names) => (one(...names) === "1" ? "1" : "");

  return {
    placement_name: one("placement_name"),
    placement_zone: one("placement_zone") || "content",
    ad_type: one("ad_type") || "none",
    ad_slot: one("ad_slot"),
    publisher_id: one("publisher_id"),
    custom_html: one("custom_html"),
    min_height: one("min_height"),
    content_position: one("content_position"),
    sort_order: one("sort_order"),
    is_enabled: flag("is_enabled"),
    show_desktop: flag("show_desktop"),
    show_mobile: flag("show_mobile")
  };
}

function selectOptions(values, selected) {
  return values
    .map(
      value =>
        `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`
    )
    .join("\n          ");
}

function renderPlacementForm({ admin, csrfToken, placement, values = null, errors = {}, notice = "" } = {}) {
  // A rejected submission wins over the stored row so the administrator keeps
  // what they typed.
  const shown = values || {
    placement_name: placement.placement_name,
    placement_zone: placement.placement_zone,
    ad_type: placement.ad_type,
    ad_slot: placement.ad_slot,
    publisher_id: placement.publisher_id,
    custom_html: placement.custom_html,
    min_height: String(placement.min_height ?? 0),
    content_position: placement.content_position === null ? "" : String(placement.content_position),
    sort_order: String(placement.sort_order ?? 0)
  };

  const id = Number(placement.id);

  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";

  // Custom markup is shown, never executed. This is the only place it is ever
  // rendered, and rendering it as text is the whole reason it is safe to store.
  const customBlock = shown.custom_html
    ? `<pre class="admin-code-preview"><code>${escapeHtml(shown.custom_html)}</code></pre>`
    : `<p class="admin-field-hint">Empty. Nothing is stored for this placement.</p>`;

  const content = `${adminHeader({ active: "ads", csrfToken, admin })}

<main class="admin-main admin-main--narrow" id="admin-main">
  <div class="admin-page-head">
    <div>
      <h1 class="admin-page-title">${escapeHtml(placement.placement_name)}</h1>
      <p class="admin-page-subtitle"><code>${escapeHtml(placement.placement_key)}</code></p>
    </div>
    <p class="admin-page-actions">
      <a class="admin-button" href="/admin/ads">Back to Ads</a>
    </p>
  </div>

  ${noticeBlock}
  ${errorList(errors)}

  <form class="admin-form" method="post" action="/admin/ads/${id}">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">

    <div class="admin-field">
      <label for="placement_name">Display name</label>
      <input
        id="placement_name"
        name="placement_name"
        type="text"
        required
        maxlength="80"
        value="${attr(shown.placement_name)}"
        ${errors.placement_name ? 'aria-invalid="true" aria-describedby="placement_name-error"' : ""}>
      <p class="admin-field-hint">Shown in this admin list only. Changing it does not move the slot.</p>
      ${fieldError(errors, "placement_name")}
    </div>

    <div class="admin-field">
      <label for="placement_zone">Zone</label>
      <select id="placement_zone" name="placement_zone">
        ${selectOptions(["header", "sidebar", "content", "footer"], shown.placement_zone)}
      </select>
      <p class="admin-field-hint">Groups this placement in the admin table.</p>
    </div>

    <div class="admin-field">
      <label for="ad_type">Ad type</label>
      <select id="ad_type" name="ad_type">
        ${selectOptions(["none", "adsense", "custom"], shown.ad_type)}
      </select>
      <p class="admin-field-hint">
        <code>none</code> means this position is deliberately empty. <code>custom</code> stores markup for an
        admin preview only &mdash; raw third-party code is never injected into public pages.
      </p>
    </div>

    <div class="admin-field">
      <label for="ad_slot">Slot ID</label>
      <input
        id="ad_slot"
        name="ad_slot"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        spellcheck="false"
        maxlength="40"
        placeholder="XXXXXXXXXX"
        value="${attr(shown.ad_slot)}"
        ${errors.ad_slot ? 'aria-invalid="true" aria-describedby="ad_slot-error"' : ""}>
      <p class="admin-field-hint">Digits only, from the ad network. No ad is served while this is empty.</p>
      ${fieldError(errors, "ad_slot")}
    </div>

    <div class="admin-field">
      <label for="publisher_id">Publisher ID override</label>
      <input
        id="publisher_id"
        name="publisher_id"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        spellcheck="false"
        maxlength="40"
        placeholder="ca-pub-XXXXXXXXXXXXXXX"
        value="${attr(shown.publisher_id)}"
        ${errors.publisher_id ? 'aria-invalid="true" aria-describedby="publisher_id-error"' : ""}>
      <p class="admin-field-hint">Leave empty to use the site-wide publisher ID.</p>
      ${fieldError(errors, "publisher_id")}
    </div>

    <h3 class="admin-form-section">Devices</h3>

    ${checkbox({
      id: "show_desktop",
      name: "show_desktop",
      checked: values ? "1" === shown.show_desktop : placement.show_desktop,
      label: "Show on desktop"
    })}

    ${checkbox({
      id: "show_mobile",
      name: "show_mobile",
      checked: values ? "1" === shown.show_mobile : placement.show_mobile,
      label: "Show on mobile"
    })}

    <h3 class="admin-form-section">Layout</h3>

    <div class="admin-field">
      <label for="min_height">Reserved height (px)</label>
      <input
        id="min_height"
        name="min_height"
        type="number"
        min="0"
        max="1200"
        step="1"
        value="${attr(shown.min_height || "0")}"
        ${errors.min_height ? 'aria-invalid="true" aria-describedby="min_height-error"' : ""}>
      <p class="admin-field-hint">Space held before the ad loads, so text does not jump around it. 0 reserves nothing.</p>
      ${fieldError(errors, "min_height")}
    </div>

    <div class="admin-field">
      <label for="content_position">In-article position (%)</label>
      <input
        id="content_position"
        name="content_position"
        type="number"
        min="0"
        max="100"
        step="1"
        value="${attr(shown.content_position)}"
        ${errors.content_position ? 'aria-invalid="true" aria-describedby="content_position-error"' : ""}>
      <p class="admin-field-hint">
        Optional. A whole-block position as a percentage of the article body; empty means no in-content ad.
        Ads are never inserted inside a paragraph.
      </p>
      ${fieldError(errors, "content_position")}
    </div>

    <div class="admin-field">
      <label for="sort_order">Sort order</label>
      <input
        id="sort_order"
        name="sort_order"
        type="number"
        min="0"
        max="32767"
        step="1"
        value="${attr(shown.sort_order || "0")}"
        ${errors.sort_order ? 'aria-invalid="true" aria-describedby="sort_order-error"' : ""}>
      <p class="admin-field-hint">Lower values come first in the admin table.</p>
      ${fieldError(errors, "sort_order")}
    </div>

    <h3 class="admin-form-section">Custom code</h3>

    <div class="admin-field">
      <label for="custom_html">Custom HTML / JS</label>
      <textarea
        id="custom_html"
        name="custom_html"
        rows="8"
        maxlength="8000"
        spellcheck="false">${escapeHtml(shown.custom_html)}</textarea>
      <p class="admin-field-hint">
        Stored verbatim and shown below as text. Never executed on a public page.
      </p>
      ${fieldError(errors, "custom_html")}
    </div>

    ${customBlock}

    <h3 class="admin-form-section">Status</h3>

    ${checkbox({
      id: "is_enabled",
      name: "is_enabled",
      checked: values ? "1" === shown.is_enabled : placement.is_enabled,
      label: "Enable this placement",
      hint: "Off by default. Even on, it renders nothing without an ad type and a slot ID."
    })}

    <button type="submit" class="admin-button admin-button--primary">Save placement</button>
  </form>
</main>`;

  return layout({
    title: `${placement.placement_name} | ${BRAND}`,
    content,
    bodyClass: "admin-body"
  });
}

module.exports = { renderAdsPage, renderPlacementForm, submittedValues };