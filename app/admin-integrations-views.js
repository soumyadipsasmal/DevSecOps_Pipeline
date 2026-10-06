"use strict";

/**
 * KaliNova — admin integrations & safety screen
 *
 * /admin/integrations is the human-in-the-loop surface for the automatic
 * safety layer that fronts every open-data integration:
 *
 *   - the feature switch each integration answers to (ENABLE_*; an
 *     environment flag always beats anything shown here)
 *   - the live breaker state for Wikidata, Wikimedia Commons, Nominatim, the
 *     map tile host and every reviewed RSS feed
 *   - the automatic-stop flag when an upstream repeatedly answers 403
 *   - the admin controls to disable a service by hand, or to re-enable one
 *     (which clears a manual stop AND a 403 lock)
 *
 * Nothing on this page can reach a third party: it renders breaker bookkeeping
 * from PostgreSQL and the in-memory registry only.
 */

const {
  BRAND,
  adminHeader,
  escapeHtml,
  formatDate,
  layout
} = require("./admin-views");

function attr(value) {
  return value === null || value === undefined ? "" : escapeHtml(value);
}

function badge(label) {
  const on = label === "ON";
  const retrying = label === "RETRYING";
  const variant = on ? "admin-badge--published" : retrying ? "admin-badge--draft" : "admin-badge--draft";
  const title =
    label === "OFF (LOCKED)"
      ? "Automatic safety stopped this service after repeated 403 answers; re-enable it here."
      : label === "MANUAL OFF"
        ? "An administrator switched this service off."
        : label === "AUTO OFF"
          ? "Automatic safety turned this service off after repeated failures."
          : label === "DISABLED"
            ? "Disabled by the ENABLE_* environment switch; this page cannot override it."
            : "";
  const labelSafe = escapeHtml(label);
  return `<span class="admin-badge ${variant}"${title ? ` title="${title}"` : ""}>${labelSafe}</span>`;
}

function actionForm({ service, csrfToken, enabled }) {
  const action = enabled ? "disable" : "enable";
  const buttonLabel = enabled ? "Disable" : "Enable";
  const hint = enabled
    ? "Freeze this service until an administrator re-enables it."
    : "Resets the breaker (and clears a 403 lock), letting the service be used again.";

  return `<form class="admin-inline-form admin-nav-form" method="post" action="/admin/integrations/${encodeURIComponent(service)}/${action}">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      ${enabled ? `<input type="text" class="admin-input admin-input--inline" name="reason" maxlength="200" placeholder="Reason (optional)" aria-label="Reason">` : ""}
      <button type="submit" class="admin-nav-link admin-nav-button">${buttonLabel}</button>
    </form>
    <p class="admin-field-hint">${escapeHtml(hint)}</p>`;
}

function featureSwitch({ key, label, on }) {
  return `<li class="admin-integration-switch"><span class="${on ? "admin-badge admin-badge--published" : "admin-badge admin-badge--draft"}">${on ? "On" : "Off"}</span> <code>${escapeHtml(key)}</code> &mdash; ${escapeHtml(label)}</li>`;
}

function integrationsTable({ summaries, csrfToken }) {
  const ordered = summaries.slice().sort((a, b) => {
    if (a.envOff !== b.envOff) return a.envOff ? 1 : -1;
    if (a.isEnabled !== b.isEnabled) return a.isEnabled ? 1 : -1;
    return a.service.localeCompare(b.service);
  });

  if (!ordered.length) {
    return `<div class="admin-table-empty">No integration has been used yet. The row appears as soon as the site first calls that service.</div>`;
  }

  const rows = ordered
    .map(entry => {
      const lastFailure = entry.lastFailureAt
        ? `<time datetime="${attr(entry.lastFailureAt)}">${escapeHtml(formatDate(entry.lastFailureAt))}</time>`
        : `<span class="admin-muted">—</span>`;
      const reason =
        entry.manual_reason || entry.reason
          ? `<p class="admin-field-hint">${escapeHtml(entry.manual_reason || entry.reason)}</p>`
          : "";
      const budget = entry.budget
        ? `<p class="admin-field-hint">hour ${escapeHtml(entry.budget.hourly.used)}/${escapeHtml(entry.budget.hourly.limit)} &middot; day ${escapeHtml(entry.budget.daily.used)}/${escapeHtml(entry.budget.daily.limit)}</p>`
        : "";

      return `<tr>
        <td><code>${escapeHtml(entry.service)}</code><p class="admin-field-hint">${escapeHtml(entry.module)}</p></td>
        <td>${badge(entry.label)}${reason}</td>
        <td>${escapeHtml(entry.failureCount)} <p class="admin-field-hint">consecutive ${escapeHtml(entry.consecutiveFailures)}</p></td>
        <td>${lastFailure}</td>
        <td>${actionForm({ service: entry.service, csrfToken, enabled: entry.isEnabled })}${budget}</td>
      </tr>`;
    })
    .join("\n        ");

  return `<div class="admin-table-wrap">
    <table class="admin-table">
      <thead>
        <tr>
          <th>Service</th>
          <th>Status</th>
          <th>Failures</th>
          <th>Last failure</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderIntegrationsPage({ admin, csrfToken, summaries, config, mapsEnabled, notice = "" }) {
  const featureKeys = [
    { key: "ENABLE_WIKIDATA", label: "Wikidata lookups", on: config.enableWikidata },
    { key: "ENABLE_COMMONS", label: "Wikimedia Commons lookups", on: config.enableCommons },
    { key: "ENABLE_MAPS", label: "OpenStreetMap tiles and geocoding", on: config.enableMaps && mapsEnabled },
    { key: "ENABLE_RSS", label: "Reviewed RSS headline strip", on: config.enableRss }
  ];

  const switches = featureKeys.map(featureSwitch).join("\n          ");

  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";

  const content = `
    <main class="admin-main">
      <h1>Integrations &amp; safety</h1>
      <p class="admin-page-intro">
        Every open-data integration (Wikidata, Wikimedia Commons, OpenStreetMap
        tiles + Nominatim, and each reviewed RSS feed) is fronted by an automatic
        circuit breaker. When an upstream fails repeatedly or stops respecting
        the site's licensing rules, the breaker switches that service off without
        an administrator in the loop &mdash; the section hides instead of showing
        broken or unsafe content. Changes are persisted in PostgreSQL and survive
        a restart.
      </p>

      ${noticeBlock}

      <section class="admin-card" aria-label="Feature switches">
        <h2>Feature switches</h2>
        <p class="admin-page-intro">Set in the environment (<code>ENABLE_*</code>). A switch set to off disables a service no matter what the breakers below say.</p>
        <ul class="admin-integration-switches">
          ${switches}
        </ul>
      </section>

      <section class="admin-card" aria-label="Circuit breaker states">
        <h2>Automatic safety state</h2>
        <p class="admin-page-intro">
          <strong>AUTO OFF</strong> means repeated failures tripped the breaker;
          it retries itself after a cooldown. <strong>OFF (LOCKED)</strong> means
          the upstream answered 403 three times in 24 hours &mdash; it stays off
          until you press <em>Enable</em>. <strong>MANUAL OFF</strong> is a stop
          you ordered. <code>Disable</code> freezes a service now;
          <code>Enable</code> restores automatic protection.
        </p>
        ${integrationsTable({ summaries, csrfToken })}
      </section>
    </main>`;

  return layout({ title: `Integrations & safety | ${BRAND}`, content, bodyClass: "admin-body" });
}

module.exports = {
  badge,
  featureSwitch,
  integrationsTable,
  renderIntegrationsPage
};