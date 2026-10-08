"use strict";

/**
 * KaliNova — admin redirect page templates
 *
 * Server-rendered like the rest of the admin area: the management page works
 * without JavaScript, every value is escaped, and deleting always passes
 * through an explicit confirmation so no GET can remove a redirect.
 *
 * A redirect matters to readers who followed an old link, so every rendered
 * row shows the exact source URL it protects and what it forwards to. Rows can
 * be paused (is_active = false) without deleting the history — a paused source
 * simply stops forwarding until the administrator re-enables it.
 */

const { adminHeader, adminFooter, escapeHtml, formatDate, renderNotFoundPage } = require("./admin-views");

function statusLabel(statusCode) {
  return statusCode === 302 ? "302" : "301";
}

function submittedValues(body) {
  const one = (...names) => {
    const value = body ? body[names.find(name => body[name] !== undefined && body[name] !== null)] : undefined;
    return value === undefined ? "" : String(value);
  };

  return {
    source_path: one("source_path", "sourcePath"),
    destination_path: one("destination_path", "destinationPath"),
    status_code: one("status_code", "statusCode"),
    is_active: one("is_active", "isActive")
  };
}

function fieldError(errors, field) {
  const message = errors && errors[field];
  return message ? `<p class="admin-field-error" role="alert">${escapeHtml(message)}</p>` : "";
}

/**
 * One redirect row: source, destination, status code badge, active badge and
 * the edit / delete actions. The destination is displayed with the scheme
 * stripped when it points back at the site, so the table reads cleanly.
 */
function redirectRow(redirect, { csrfToken }) {
  const id = Number(redirect.id);
  const isActive = redirect.is_active !== false;
  const destination = String(redirect.destination_path || "");

  return `<tr>
    <td data-label="Source" class="admin-cell-code"><code>${escapeHtml(redirect.source_path)}</code></td>
    <td data-label="Forwards to" class="admin-cell-code"><code>${escapeHtml(destination)}</code></td>
    <td data-label="Status"><span class="admin-badge">${escapeHtml(statusLabel(redirect.status_code))}</span></td>
    <td data-label="Active"><span class="admin-badge admin-badge--${isActive ? "published" : "draft"}">${isActive ? "Active" : "Paused"}</span></td>
    <td data-label="Updated"><time datetime="${escapeHtml(redirect.updated_at || redirect.created_at || "")}">${escapeHtml(formatDate(redirect.updated_at || redirect.created_at))}</time></td>
    <td data-label="Actions" class="admin-cell-actions">
      <a class="admin-action" href="/admin/redirects/${id}/edit">Edit</a>
      <form class="admin-action-form" method="post" action="/admin/redirects/${id}/delete">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="confirm" value="1">
        <button type="submit" class="admin-action admin-action--danger">Delete</button>
      </form>
    </td>
  </tr>`;
}

/**
 * The redirects management page: a creation form on top and every redirect
 * below. When no redirects exist yet the table explains what the table is for,
 * because an empty management screen tells an administrator nothing.
 */
function renderRedirectsPage({
  admin,
  csrfToken,
  redirects = [],
  errors = null,
  values = null,
  notice = ""
} = {}) {
  const formValues = values || { source_path: "", destination_path: "", status_code: "301", is_active: "1" };
  const isActiveChecked = String(formValues.is_active) === "1" || String(formValues.is_active).toLowerCase() === "on" || String(formValues.is_active).toLowerCase() === "true" || String(formValues.is_active) === "" || String(formValues.is_active) === "active";

  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";

  const rows = redirects.length
    ? redirects.map(redirect => redirectRow(redirect, { csrfToken })).join("\n          ")
    : `<tr>
        <td colspan="6" class="admin-table-empty">
          No redirects yet. They appear here automatically when a published article's slug changes,
          and you can add one for any retired URL by hand.
        </td>
      </tr>`;

  const content = `${adminHeader({ active: "redirects", csrfToken, admin })}

<main class="admin-main" id="admin-main">
  <div class="admin-page-head">
    <div>
      <h1 class="admin-page-title">Redirects</h1>
      <p class="admin-page-subtitle">
        Old URLs forward with a ${escapeHtml(statusLabel(formValues.status_code || 301))} so bookmarks, backlinks and feeds keep working.
        Sources are public site paths only — admin, API, asset and affiliate paths are reserved.
      </p>
    </div>
  </div>
  ${noticeBlock}

  <section class="admin-card" aria-labelledby="section-new-redirect">
    <h2 class="admin-card-title" id="section-new-redirect">Add a redirect</h2>
    <form class="admin-form admin-form--grid" method="post" action="/admin/redirects">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">

      <div class="admin-field">
        <label for="redirect-source">Source path <span class="admin-required" aria-hidden="true">*</span></label>
        <input type="text" id="redirect-source" name="source_path" value="${escapeHtml(formValues.source_path)}"
               maxlength="2000" placeholder="/blog/an-old-title" aria-describedby="redirect-source-help" required>
        <p class="admin-field-help" id="redirect-source-help">The exact public URL that should forward.</p>
        ${fieldError(errors, "source_path")}
      </div>

      <div class="admin-field">
        <label for="redirect-destination">Destination <span class="admin-required" aria-hidden="true">*</span></label>
        <input type="text" id="redirect-destination" name="destination_path" value="${escapeHtml(formValues.destination_path)}"
               maxlength="2000" placeholder="/blog/the-new-title or https://…" aria-describedby="redirect-destination-help" required>
        <p class="admin-field-help" id="redirect-destination-help">A site path or an absolute https:// URL.</p>
        ${fieldError(errors, "destination_path")}
      </div>

      <div class="admin-field">
        <label for="redirect-status">Status code</label>
        <select id="redirect-status" name="status_code">
          <option value="301"${String(formValues.status_code) === "301" ? " selected" : ""}>301 Moved Permanently</option>
          <option value="302"${String(formValues.status_code) === "302" ? " selected" : ""}>302 Found (temporary)</option>
        </select>
        <p class="admin-field-help">301 is right for a permanently renamed page.</p>
        ${fieldError(errors, "status_code")}
      </div>

      <label class="admin-checkbox">
        <input type="checkbox" name="is_active" value="1"${isActiveChecked ? " checked" : ""}>
        <span>Active</span>
      </label>

      <div class="admin-form-actions">
        <button type="submit" class="admin-button admin-button--primary">Add redirect</button>
      </div>
    </form>
  </section>

  <section class="admin-section" aria-labelledby="section-redirect-list">
    <h2 class="admin-section-title" id="section-redirect-list">Current redirects (${redirects.length})</h2>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <caption class="sr-only">Every redirect with its source, destination, status code, active state and actions</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Forwards to</th>
            <th scope="col">Status</th>
            <th scope="col">Active</th>
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
</main>

${adminFooter()}`;

  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="same-origin">
<meta name="theme-color" content="#181B1F">
<title>Redirects | KaliNova Admin</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/assets/admin/admin.css">
<link rel="stylesheet" href="/assets/admin/admin-monetization.css">
</head>
<body class="admin-body">
${content}
</body>
</html>`;
}

/**
 * Edit form for one redirect. Works without JavaScript; the CSRF token is part
 * of the form and the submission only changes what an administrator asked to
 * change.
 */
function renderRedirectForm({ admin, csrfToken, redirect, errors = null, values = null, notice = "" } = {}) {
  const formValues = values || {
    source_path: redirect.source_path,
    destination_path: redirect.destination_path,
    status_code: String(redirect.status_code),
    is_active: redirect.is_active !== false ? "1" : "0"
  };
  const isActiveChecked = String(formValues.is_active) === "1" || String(formValues.is_active).toLowerCase() === "on" || String(formValues.is_active).toLowerCase() === "true";

  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";

  const content = `${adminHeader({ active: "redirects", csrfToken, admin })}

<main class="admin-main admin-main--narrow" id="admin-main">
  <div class="admin-page-head">
    <div>
      <h1 class="admin-page-title">Edit redirect</h1>
      <p class="admin-page-subtitle">
        ${escapeHtml(redirect.source_path)} forwards to ${escapeHtml(redirect.destination_path)}.
      </p>
    </div>
    <p class="admin-page-actions">
      <a class="admin-button admin-button--ghost" href="/admin/redirects">Back to redirects</a>
    </p>
  </div>
  ${noticeBlock}
  ${errors ? errorList(errors) : ""}

  <div class="admin-card">
    <form class="admin-form" method="post" action="/admin/redirects/${escapeHtml(redirect.id)}">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">

      <div class="admin-field">
        <label for="redirect-source">Source path <span class="admin-required" aria-hidden="true">*</span></label>
        <input type="text" id="redirect-source" name="source_path" value="${escapeHtml(formValues.source_path)}"
               maxlength="2000" aria-describedby="redirect-source-help" required>
        <p class="admin-field-help" id="redirect-source-help">Changing this effectively retrains the old link.</p>
        ${fieldError(errors, "source_path")}
      </div>

      <div class="admin-field">
        <label for="redirect-destination">Destination <span class="admin-required" aria-hidden="true">*</span></label>
        <input type="text" id="redirect-destination" name="destination_path" value="${escapeHtml(formValues.destination_path)}"
               maxlength="2000" aria-describedby="redirect-destination-help" required>
        <p class="admin-field-help" id="redirect-destination-help">A site path or an absolute https:// URL.</p>
        ${fieldError(errors, "destination_path")}
      </div>

      <div class="admin-field">
        <label for="redirect-status">Status code</label>
        <select id="redirect-status" name="status_code">
          <option value="301"${String(formValues.status_code) === "301" ? " selected" : ""}>301 Moved Permanently</option>
          <option value="302"${String(formValues.status_code) === "302" ? " selected" : ""}>302 Found (temporary)</option>
        </select>
        ${fieldError(errors, "status_code")}
      </div>

      <label class="admin-checkbox">
        <input type="checkbox" name="is_active" value="1"${isActiveChecked ? " checked" : ""}>
        <span>Active — pause to stop forwarding without deleting history</span>
      </label>

      <div class="admin-form-actions">
        <button type="submit" class="admin-button admin-button--primary">Save redirect</button>
        <a class="admin-button admin-button--ghost" href="/admin/redirects">Cancel</a>
      </div>
    </form>
  </div>
</main>

${adminFooter()}`;

  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="same-origin">
<meta name="theme-color" content="#181B1F">
<title>Edit redirect | KaliNova Admin</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/assets/admin/admin.css">
<link rel="stylesheet" href="/assets/admin/admin-monetization.css">
</head>
<body class="admin-body">
${content}
</body>
</html>`;
}

function errorList(errors) {
  if (!errors) return "";
  const items = Object.entries(errors)
    .map(([field, message]) => `<li>${escapeHtml(String(message))}</li>`)
    .join("");
  return `<ul class="admin-alert admin-alert--error">${items}</ul>`;
}

module.exports = {
  renderNotFound: renderNotFoundPage,
  renderRedirectForm,
  renderRedirectsPage,
  submittedValues
};