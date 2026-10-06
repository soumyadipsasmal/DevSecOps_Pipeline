"use strict";

/**
 * KaliNova — admin page templates
 *
 * Server-rendered on purpose: the admin area is a handful of pages that must
 * work without JavaScript and must never be indexed. Every value that reaches
 * the document goes through escapeHtml, so article titles or category names
 * containing markup cannot break out of their element.
 */

const SITE_ORIGIN = "https://kalinova.in";
const BRAND = "KaliNova Admin";

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

function formatDate(value) {
  if (!value) return "—";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toISOString().slice(0, 10);
}

function pluralise(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural || `${singular}s`}`;
}

/* ==================================================================== */
/* Shell                                                                */
/* ==================================================================== */

/**
 * Shared admin chrome. Loads the public stylesheet first so the dashboard
 * inherits the existing design tokens, fonts and focus states, then the small
 * admin-only stylesheets. No third-party font CDN is loaded here (unlike the
 * public shell), which is why the Content-Security-Policy allows local origins
 * only; the CSS font stacks fall back to Georgia and the system UI font.
 */
function layout({ title, content, bodyClass = "", extraStyles = [] } = {}) {
  const styles = ["/assets/admin/admin.css", ...extraStyles]
    .map(href => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="same-origin">
<meta name="theme-color" content="#181B1F">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
${styles}
</head>
<body class="${escapeHtml(bodyClass)}">
<a class="skip-link" href="#admin-main">Skip to main content</a>
${content}
</body>
</html>`;
}

/**
 * Admin navigation. Articles and New Article are real pages now; Categories
 * still has no screen, so it stays visibly disabled rather than linking to a
 * route that does not exist.
 */
function adminNav({ active, csrfToken, includeLogout }) {
  const item = (label, href, key) => {
    if (key === active) {
      return `<li><a class="admin-nav-link is-active" href="${escapeHtml(href)}" aria-current="page">${escapeHtml(label)}</a></li>`;
    }
    return `<li><a class="admin-nav-link" href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`;
  };

  const pending = label =>
    `<li><span class="admin-nav-link is-pending" aria-disabled="true" title="Available with the category screens">${escapeHtml(label)}</span></li>`;

  const logout = includeLogout
    ? `<li>
        <form class="admin-nav-form" method="post" action="/admin/logout">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
          <button type="submit" class="admin-nav-link admin-nav-button">Logout</button>
        </form>
      </li>`
    : "";

  return `<nav class="admin-nav" aria-label="Admin sections">
      <ul>
        ${item("Dashboard", "/admin/dashboard", "dashboard")}
        ${item("Articles", "/admin/articles", "articles")}
        ${item("New Article", "/admin/articles/new", "new-article")}
        ${item("Ads & Monetization", "/admin/ads", "ads")}
        ${pending("Categories")}
        ${logout}
      </ul>
    </nav>`;
}

function adminHeader({ active, csrfToken, admin }) {
  return `<header class="admin-header">
      <div class="admin-header-inner">
        <a class="admin-brand" href="/admin/dashboard">
          <span class="admin-brand-mark" aria-hidden="true">KN</span>
          <span class="admin-brand-text">Kalinova Admin</span>
        </a>
        ${adminNav({ active, csrfToken, includeLogout: Boolean(admin) })}
        ${
          admin
            ? `<p class="admin-identity">
                 <span class="admin-identity-role">${escapeHtml(admin.role)}</span>
                 <span class="admin-identity-email">${escapeHtml(admin.email)}</span>
               </p>`
            : ""
        }
      </div>
    </header>`;
}

function adminFooter() {
  return `<footer class="admin-footer">
      <p>&copy; ${new Date().getFullYear()} ${escapeHtml(BRAND)}. Authorised administrators only.</p>
      <p><a href="/">Back to ${escapeHtml(SITE_ORIGIN.replace("https://", ""))}</a></p>
    </footer>`;
}

/* ==================================================================== */
/* Login                                                                */
/* ==================================================================== */

const GENERIC_LOGIN_ERROR = "Invalid email or password.";

/**
 * Login form.
 *
 * The error copy never distinguishes a missing account, a wrong password, a
 * disabled account and a non-admin role. The submitted email address is echoed
 * back so a typo can be corrected; the password never is.
 */
function renderLoginPage({ error, notice, email = "", csrfToken, next = "" } = {}) {
  const errorBlock = error
    ? `<p class="admin-alert admin-alert--error" role="alert" id="login-error">${escapeHtml(error)}</p>`
    : "";

  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";

  const emailField = email ? escapeHtml(email) : "";
  const nextField = next ? escapeHtml(next) : "";

  const content = `${adminHeader({ active: "login", csrfToken })}

<main class="admin-main admin-main--narrow" id="admin-main">
  <div class="admin-card">
    <h1 class="admin-card-title">Administrator sign in</h1>
    <p class="admin-card-subtitle">This area is restricted to KaliNova administrators.</p>
    ${noticeBlock}
    ${errorBlock}

    <form class="admin-form" method="post" action="/admin/login" novalidate>
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      ${nextField ? `<input type="hidden" name="next" value="${nextField}">` : ""}

      <div class="admin-field">
        <label for="admin-email">Email</label>
        <input
          id="admin-email"
          name="email"
          type="email"
          autocomplete="username"
          inputmode="email"
          maxlength="255"
          required
          autofocus
          value="${emailField}"
          ${error ? 'aria-invalid="true" aria-describedby="login-error"' : ""}>
      </div>

      <div class="admin-field">
        <label for="admin-password">Password</label>
        <input
          id="admin-password"
          name="password"
          type="password"
          autocomplete="current-password"
          maxlength="200"
          required
          ${error ? 'aria-invalid="true" aria-describedby="login-error"' : ""}>
      </div>

      <button type="submit" class="admin-button admin-button--primary">Sign in</button>
    </form>
  </div>

  <p class="admin-note">Public readers do not have accounts. Stories are written from the admin dashboard.</p>
</main>

${adminFooter()}`;

  return layout({
    title: `Sign in | ${BRAND}`,
    content,
    bodyClass: "admin-body admin-body--centered"
  });
}

/* ==================================================================== */
/* Dashboard                                                            */
/* ==================================================================== */

function renderDashboardPage({ admin, summary, csrfToken, notice = "" } = {}) {
  const { stats, recentArticles } = summary;

  const statCards = [
    { label: "Total articles", value: stats.totalArticles },
    { label: "Published", value: stats.publishedArticles },
    { label: "Drafts", value: stats.draftArticles },
    { label: "Categories", value: stats.categories }
  ]
    .map(
      card => `<div class="admin-stat">
          <p class="admin-stat-value">${escapeHtml(card.value)}</p>
          <p class="admin-stat-label">${escapeHtml(card.label)}</p>
        </div>`
    )
    .join("\n        ");

  // The article row and its actions are shared with the article list screen, so
  // both tables stay identical.
  const rows = recentArticles.length
    ? recentArticles.map(article => articleRow({ ...article, csrfToken })).join("\n          ")
    : `<tr>
            <td colspan="5" class="admin-table-empty">No articles yet. Create the first one from New Article.</td>
          </tr>`;

  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";

  const content = `${adminHeader({ active: "dashboard", csrfToken, admin })}

<main class="admin-main" id="admin-main">
  <div class="admin-page-head">
    <div>
      <h1 class="admin-page-title">Dashboard</h1>
      <p class="admin-page-subtitle">Signed in as ${escapeHtml(admin.email)}</p>
    </div>
    <p class="admin-page-actions">
      <a class="admin-button admin-button--primary" href="/admin/articles/new">+ New Article</a>
    </p>
    ${noticeBlock}
  </div>

  <section class="admin-section" aria-labelledby="admin-overview-heading">
    <h2 class="admin-section-title" id="admin-overview-heading">Statistics</h2>
    <div class="admin-stats">
      ${statCards}
    </div>
  </section>

  <section class="admin-section" aria-labelledby="admin-recent-heading">
    <h2 class="admin-section-title" id="admin-recent-heading">Recent articles</h2>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <caption class="sr-only">The ten most recently changed articles with their category, status, date and actions</caption>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Category</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    <p class="admin-note">
      ${escapeHtml(pluralise(recentArticles.length, "article"))} shown.
      <a class="admin-link" href="/admin/articles">Manage all articles</a>
    </p>
  </section>
</main>

${adminFooter()}`;

  return layout({ title: `Dashboard | ${BRAND}`, content, bodyClass: "admin-body" });
}

/**
 * One article row: title, category, status badge, last change and the actions
 * for that row. Used by both the dashboard and /admin/articles.
 *
 * Every action is a link to a server-rendered confirmation or form, so the page
 * needs no JavaScript to be safe: deleting always goes through an explicit
 * confirmation screen and the CSRF token is part of the form.
 */
function articleRow(article) {
  const status = String(article.status || "").toLowerCase();
  const published = status === "published";
  const id = Number(article.id);

  const updated = formatDate(article.updated_at || article.published_at || article.created_at);

  const actions = [
    `<a class="admin-action" href="/admin/articles/${id}/edit">Edit</a>`,
    published
      ? `<a class="admin-action" href="/blog/${encodeURIComponent(article.slug)}" rel="external">View</a>`
      : `<a class="admin-action" href="/admin/articles/${id}/preview">Preview</a>`,
    published
      ? `<form class="admin-action-form" method="post" action="/admin/articles/${id}/status">
           <input type="hidden" name="_csrf" value="${escapeHtml(article.csrfToken || "")}">
           <input type="hidden" name="status" value="draft">
           <button type="submit" class="admin-action">Unpublish</button>
         </form>`
      : `<form class="admin-action-form" method="post" action="/admin/articles/${id}/status">
           <input type="hidden" name="_csrf" value="${escapeHtml(article.csrfToken || "")}">
           <input type="hidden" name="status" value="published">
           <button type="submit" class="admin-action">Publish</button>
         </form>`,
    `<a class="admin-action admin-action--danger" href="/admin/articles/${id}/delete">Delete</a>`
  ].join("\n            ");

  return `<tr>
            <td data-label="Title" class="admin-cell-title">${escapeHtml(article.title)}</td>
            <td data-label="Category">${escapeHtml(article.category_name || "Uncategorised")}</td>
            <td data-label="Status"><span class="admin-badge admin-badge--${published ? "published" : "draft"}">${published ? "Published" : "Draft"}</span></td>
            <td data-label="Updated"><time datetime="${escapeHtml(article.updated_at || article.published_at || article.created_at || "")}">${escapeHtml(updated)}</time></td>
            <td data-label="Actions" class="admin-cell-actions">
            ${actions}
            </td>
          </tr>`;
}

/* ==================================================================== */
/* Errors                                                               */
/* ==================================================================== */

function renderNotFoundPage({ csrfToken, title = "Page not found", message = "That admin page does not exist." } = {}) {
  const content = `${adminHeader({ active: "none", csrfToken })}

<main class="admin-main admin-main--narrow" id="admin-main">
  <div class="admin-card">
    <h1 class="admin-card-title">${escapeHtml(title)}</h1>
    <p class="admin-card-subtitle">${escapeHtml(message)}</p>
    <p><a class="admin-button admin-button--primary" href="/admin/dashboard">Go to the dashboard</a></p>
  </div>
</main>

${adminFooter()}`;

  return layout({
    title: `Not found | ${BRAND}`,
    content,
    bodyClass: "admin-body admin-body--centered"
  });
}

module.exports = {
  BRAND,
  GENERIC_LOGIN_ERROR,
  adminHeader,
  adminNav,
  articleRow,
  escapeHtml,
  formatDate,
  layout,
  pluralise,
  renderDashboardPage,
  renderLoginPage,
  renderNotFoundPage
};