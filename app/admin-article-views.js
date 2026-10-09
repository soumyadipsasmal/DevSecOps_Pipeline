"use strict";

/**
 * KaliNova — admin article screens
 *
 * Server-rendered pages for the article CMS: the list with its filters, the
 * new/edit form, the delete confirmation and the draft preview.
 *
 * Everything interpolated goes through escapeHtml from admin-views. The only
 * value inserted without escaping is the article body, and that value is the
 * output of article-html.sanitizeBody, which is stored sanitised — the same
 * column the public renderer trusts.
 */

const {
  BRAND,
  adminHeader,
  articleRow,
  escapeHtml,
  formatDate,
  layout
} = require("./admin-views");

const {
  BANNER_ALT_MAX,
  EXCERPT_MAX,
  FOCUS_KEYWORD_MAX,
  META_DESCRIPTION_MAX,
  META_DESCRIPTION_MIN,
  META_TITLE_MAX,
  OG_DESCRIPTION_MAX,
  ROBOTS_FOLLOW_VALUES,
  ROBOTS_INDEX_VALUES,
  SCHEMA_TYPES,
  STATUSES,
  STATUS_ARCHIVED,
  STATUS_DRAFT,
  STATUS_PUBLISHED,
  STATUS_SCHEDULED,
  TITLE_MAX
} = require("./article-validation");

const { countWords, stripTags } = require("./article-html");

const { MAX_SOURCES } = require("./article-sources");

/**
 * The editorial rule the CMS repeats on every article screen.
 *
 * Kept verbatim so the wording in the interface and the wording in the docs are
 * the same sentence rather than two paraphrases of each other.
 */
const EDITORIAL_POLICY_NOTICE =
  "Use external APIs for research, facts, images, locations, RSS and source discovery. " +
  "Do not copy third-party articles, reviews or long passages into the CMS.";

/* ==================================================================== */
/* Shared pieces                                                        */
/* ==================================================================== */

/** Turn a raw input value into an escaped value="..." attribute. */
function fieldValue(value) {
  return value === null || value === undefined ? "" : escapeHtml(value);
}

/**
 * Format a timestamp for an <input type="datetime-local">. The browser reads
 * local wall-clock time, so the stored UTC value is converted to local before
 * it is shown; an unparseable value renders empty rather than "Invalid Date".
 */
function dateTimeLocalValue(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function errorList(errors) {
  const entries = Object.entries(errors || {});
  if (!entries.length) return "";

  return `<div class="admin-alert admin-alert--error" role="alert" id="form-errors">
      <p><strong>Validation failed.</strong> Fix the following:</p>
      <ul class="admin-error-list">
        ${entries.map(([field, message]) => `<li><code>${escapeHtml(field)}</code> ${escapeHtml(message)}</li>`).join("\n        ")}
      </ul>
    </div>`;
}

function fieldError(errors, field) {
  const message = errors && errors[field];
  if (!message) return "";

  return `<p class="admin-field-error" id="${escapeHtml(field)}-error">${escapeHtml(message)}</p>`;
}

/** Preserve the submitted query string so filters survive a save round trip. */
function listHref(query, overrides = {}) {
  const params = new URLSearchParams();

  const merged = { search: "", status: "", category: "", sort: "updated", page: "1", ...query, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value !== "" && value !== null && value !== undefined) params.set(key, String(value));
  }

  const search = params.toString();
  return `/admin/articles${search ? `?${search}` : ""}`;
}

function queryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== "" && value !== null && value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}

/* ==================================================================== */
/* Article list: /admin/articles                                        */
/* ==================================================================== */

/**
 * The main article-management screen.
 *
 * Search, status and category are a GET form, so a filtered list is a real
 * bookmarkable URL and works without JavaScript. Sorting and paging are links
 * built from the same query string.
 */
function renderArticleList({ admin, csrfToken, result, filters, categories, notice = "" } = {}) {
  const { rows, total, page, pages, perPage, counts } = result;

  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";

  const activeFilter = String(filters.status || "");
  const activeCategory = String(filters.category || "");
  const activeSort = String(filters.sort || "updated");

  const tab = (label, status) => {
    const target = listHref(filters, { status, page: 1 });
    const count = status === "" ? counts.all : counts[status];
    const isActive = activeFilter === status;
    return `<a class="admin-tab${isActive ? " is-active" : ""}" href="${escapeHtml(target)}"${isActive ? ' aria-current="page"' : ""}>${escapeHtml(label)} <span class="admin-tab-count">${escapeHtml(count)}</span></a>`;
  };

  const sortLink = (key, label) => {
    const isActive = activeSort === key;
    return `<a class="admin-sort${isActive ? " is-active" : ""}" href="${escapeHtml(listHref(filters, { sort: key, page: 1 }))}">${escapeHtml(label)}${isActive ? " <span aria-hidden=\"true\">↓</span>" : ""}</a>`;
  };

  const tableRows = rows.length
    ? rows.map(article => articleRow({ ...article, csrfToken })).join("\n            ")
    : `<tr>
            <td colspan="5" class="admin-table-empty">${
              filters.search || filters.status || filters.category
                ? "No articles match these filters."
                : "No articles yet."
            }</td>
          </tr>`;

  const perPageOptions = [10, 25, 50, 100]
    .map(
      size =>
        `<option value="${size}"${size === perPage ? " selected" : ""}>${size} per page</option>`
    )
    .join("");

  const content = `${adminHeader({ active: "articles", csrfToken, admin })}

<main class="admin-main" id="admin-main">
  <div class="admin-page-head">
    <div>
      <h1 class="admin-page-title">Articles</h1>
      <p class="admin-page-subtitle">${escapeHtml(total)} ${escapeHtml(total === 1 ? "article" : "articles")} match this view</p>
    </div>
    <p class="admin-page-actions">
      <a class="admin-button admin-button--primary" href="/admin/articles/new">+ New Article</a>
    </p>
  </div>

  ${noticeBlock}

  <nav class="admin-tabs" aria-label="Filter by status">
    ${tab("All", "")}
    ${tab("Published", STATUS_PUBLISHED)}
    ${tab("Scheduled", STATUS_SCHEDULED)}
    ${tab("Drafts", STATUS_DRAFT)}
    ${tab("Archived", STATUS_ARCHIVED)}
  </nav>

  <form class="admin-filters" method="get" action="/admin/articles" role="search">
    <div class="admin-filter-field admin-filter-search">
      <label for="filter-search">Search titles</label>
      <input type="search" id="filter-search" name="search" value="${fieldValue(filters.search)}" placeholder="Search articles…" maxlength="120">
    </div>

    <div class="admin-filter-field">
      <label for="filter-category">Category</label>
      <select id="filter-category" name="category">
        <option value="">All categories</option>
        ${categories
          .map(
            category =>
              `<option value="${escapeHtml(category.id)}"${String(category.id) === activeCategory ? " selected" : ""}>${escapeHtml(category.name)} (${escapeHtml(category.article_count)})</option>`
          )
          .join("\n        ")}
      </select>
    </div>

    <div class="admin-filter-field">
      <label for="filter-sort">Sort</label>
      <select id="filter-sort" name="sort">
        <option value="updated"${activeSort === "updated" ? " selected" : ""}>Recently updated</option>
        <option value="newest"${activeSort === "newest" ? " selected" : ""}>Newest first</option>
        <option value="oldest"${activeSort === "oldest" ? " selected" : ""}>Oldest first</option>
        <option value="title"${activeSort === "title" ? " selected" : ""}>Title A–Z</option>
        <option value="status"${activeSort === "status" ? " selected" : ""}>Status</option>
      </select>
    </div>

    <div class="admin-filter-field">
      <label for="filter-per-page">Per page</label>
      <select id="filter-per-page" name="perPage">${perPageOptions}</select>
    </div>

    <input type="hidden" name="status" value="${fieldValue(activeFilter)}">

    <div class="admin-filter-actions">
      <button type="submit" class="admin-button">Apply filters</button>
      <a class="admin-button admin-button--ghost" href="/admin/articles">Reset</a>
    </div>
  </form>

  <p class="admin-sort-links">
    Sort by
    ${sortLink("updated", "Last updated")}
    ${sortLink("newest", "Created")}
    ${sortLink("title", "Title")}
  </p>

  <div class="admin-table-wrap">
    <table class="admin-table admin-table--articles">
      <caption class="sr-only">Articles with their category, status, last change and available actions</caption>
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
            ${tableRows}
      </tbody>
    </table>
  </div>

  ${renderPagination({ page, pages, total, perPage, filters })}
</main>

${adminFooter()}`;

  return layout({
    title: `Articles | ${BRAND}`,
    content,
    bodyClass: "admin-body",
    extraStyles: ["/assets/admin/admin-cms.css"]
  });
}

function renderPagination({ page, pages, total, perPage, filters }) {
  if (pages <= 1) {
    return `<p class="admin-note">Showing ${escapeHtml(Math.min(total, perPage))} of ${escapeHtml(total)}.</p>`;
  }

  const link = (targetPage, label, current) =>
    current
      ? `<span class="admin-page-link is-current" aria-current="page">${escapeHtml(label)}</span>`
      : `<a class="admin-page-link" href="${escapeHtml(listHref(filters, { page: targetPage }))}">${escapeHtml(label)}</a>`;

  const first = Math.max(1, page - 2);
  const last = Math.min(pages, first + 4);
  const start = Math.max(1, Math.min(first, last - 4));

  const numbers = [];
  for (let index = start; index <= last; index += 1) {
    numbers.push(link(index, String(index), index === page));
  }

  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);

  return `<nav class="admin-pagination" aria-label="Article pages">
    ${page > 1 ? link(page - 1, "Previous", false) : `<span class="admin-page-link is-disabled">Previous</span>`}
    ${numbers.join("\n    ")}
    ${page < pages ? link(page + 1, "Next", false) : `<span class="admin-page-link is-disabled">Next</span>`}
  </nav>
  <p class="admin-note">Showing ${escapeHtml(from)}–${escapeHtml(to)} of ${escapeHtml(total)}.</p>`;
}

function adminFooter() {
  return `<footer class="admin-footer">
    <p>&copy; ${new Date().getFullYear()} ${escapeHtml(BRAND)}. Authorised administrators only.</p>
    <p><a href="/">Back to kalinova.in</a></p>
  </footer>`;
}

/* ==================================================================== */
/* New / edit: /admin/articles/new, /admin/articles/:id/edit            */
/* ==================================================================== */

/**
 * The article form, used for both creating and editing.
 *
 * The same markup serves /new and /:id/edit; only the action, the heading and
 * the button labels differ. Submitted values are echoed back (escaped) so a
 * validation failure never loses an author's work.
 */
function renderArticleForm({
  admin,
  csrfToken,
  article = null,
  values = {},
  categories = [],
  uploads = [],
  sources = [],
  researchRefs = [],
  similarity = null,
  errors = null,
  uploadError = "",
  notice = ""
} = {}) {
  const isEdit = Boolean(article);
  const action = isEdit ? `/admin/articles/${escapeHtml(article.id)}` : "/admin/articles";
  const submittedStatus = String(values.status ?? (article ? article.status : STATUS_DRAFT) ?? STATUS_DRAFT)
    .trim()
    .toLowerCase();
  const mode = STATUSES.includes(submittedStatus) ? submittedStatus : STATUS_DRAFT;

  // Advertising choice echoed back from a validation re-render, else from the
  // stored row. The row stores a nullable boolean; the form stores a 3-way
  // string ("default" | "1" | "0") so the author's choice survives an error.
  const submittedAdsChoice = ["default", "1", "0"].includes(values.ads_enabled)
    ? values.ads_enabled
    : null;
  const adsEnabledRaw = submittedAdsChoice
    ?? (article && typeof article.ads_enabled === "boolean"
      ? article.ads_enabled ? "1" : "0"
      : "default");
  const adsChoiceDefault = adsEnabledRaw === "default" ? " checked" : "";
  const adsChoiceYes = adsEnabledRaw === "1" ? " checked" : "";
  const adsChoiceNo = adsEnabledRaw === "0" ? " checked" : "";

  const title = fieldValue(values.title ?? article?.title ?? "");
  const slug = fieldValue(values.slug ?? article?.slug ?? "");
  const metaDescription = fieldValue(values.meta_description ?? article?.meta_description ?? "");
  const coverImage = fieldValue(values.cover_image ?? article?.cover_image ?? "");
  const bannerAlt = fieldValue(values.banner_alt ?? article?.banner_alt ?? "");
  const categoryId = String(values.category_id ?? article?.category_id ?? "");
  // The textarea is the real form field, so the form still works with JavaScript
  // disabled; the rich surface is created from it by admin-article-form.js.
  const body = String(values.content ?? article?.content ?? "");
  const words = countWords(body);

  /* ---- SEO / social / scheduling values ----------------------------- */
  const excerpt = fieldValue(values.excerpt ?? article?.excerpt ?? "");
  const metaTitle = fieldValue(values.meta_title ?? article?.meta_title ?? "");
  const canonicalUrl = fieldValue(values.canonical_url ?? article?.canonical_url ?? "");
  const robotsIndex = String(values.robots_index ?? article?.robots_index ?? "index");
  const robotsFollow = String(values.robots_follow ?? article?.robots_follow ?? "follow");
  const schemaType = String(values.schema_type ?? article?.schema_type ?? "BlogPosting");
  const focusKeyword = fieldValue(values.focus_keyword ?? article?.focus_keyword ?? "");
  const tagList = fieldValue(values.tags ?? "");
  const ogTitle = fieldValue(values.og_title ?? article?.og_title ?? "");
  const ogDescription = fieldValue(values.og_description ?? article?.og_description ?? "");
  const ogImage = fieldValue(values.og_image ?? article?.og_image ?? "");
  const twitterTitle = fieldValue(values.twitter_title ?? article?.twitter_title ?? "");
  const twitterDescription = fieldValue(values.twitter_description ?? article?.twitter_description ?? "");
  const twitterImage = fieldValue(values.twitter_image ?? article?.twitter_image ?? "");
  const scheduledAt =
    values.scheduled_at !== undefined && values.scheduled_at !== null
      ? fieldValue(values.scheduled_at)
      : fieldValue(dateTimeLocalValue(article?.scheduled_at));

  const robotsIndexOptions = ROBOTS_INDEX_VALUES
    .map(value => `<option value="${escapeHtml(value)}"${robotsIndex === value ? " selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
  const robotsFollowOptions = ROBOTS_FOLLOW_VALUES
    .map(value => `<option value="${escapeHtml(value)}"${robotsFollow === value ? " selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
  const schemaTypeOptions = SCHEMA_TYPES
    .map(value => `<option value="${escapeHtml(value)}"${schemaType === value ? " selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");

  const noticeBlock = notice
    ? `<p class="admin-alert admin-alert--info" role="status">${escapeHtml(notice)}</p>`
    : "";

  const policyNotice = `<p class="admin-alert admin-alert--info admin-notice--policy" role="note">${escapeHtml(EDITORIAL_POLICY_NOTICE)}</p>`;

  /* ---- citations repeater ------------------------------------------- */
  // One blank row is always rendered past the end, so an editor without
  // JavaScript can still add a citation by filling it in and saving.
  const citationRows = [];
  for (let i = 0; i <= Math.min(sources.length, MAX_SOURCES - 1); i += 1) {
    const row = sources[i] || {};
    citationRows.push(`
      <fieldset class="admin-source-row" data-source-row>
        <legend class="sr-only">Source ${i + 1}</legend>
        <div class="admin-field">
          <label for="source-name-${i}">Source name</label>
          <input type="text" id="source-name-${i}" name="source_name_${i}" maxlength="200"
                 value="${fieldValue(row.name ?? "")}" placeholder="Wikidata, OSM, an interview…">
        </div>
        <div class="admin-field">
          <label for="source-url-${i}">URL</label>
          <input type="url" id="source-url-${i}" name="source_url_${i}" maxlength="500"
                 value="${fieldValue(row.url ?? "")}" placeholder="https://…">
        </div>
        <div class="admin-field">
          <label for="source-license-${i}">Licence</label>
          <input type="text" id="source-license-${i}" name="source_license_${i}" maxlength="120"
                 value="${fieldValue(row.license ?? "")}" placeholder="Leave blank if the source states none">
        </div>
        <div class="admin-field">
          <label for="source-attribution-${i}">Attribution</label>
          <input type="text" id="source-attribution-${i}" name="source_attribution_${i}" maxlength="600"
                 value="${fieldValue(row.attribution ?? "")}" placeholder="Leave blank when no credit is required">
        </div>
        <button type="button" class="admin-button admin-button--tiny" data-remove-source>Remove</button>
      </fieldset>`);
  }

  const citationBlock = `
    <div class="admin-sources" data-sources>
      <input type="hidden" name="source_count" value="${citationRows.length}" data-source-count>
      ${citationRows.join("\n")}
      <p class="admin-field-help">
        These appear under the article as <strong>Sources &amp; references</strong>. A licence or an
        attribution line is left blank when the source does not state one — nothing is invented for you.
      </p>
      ${fieldError(errors, "sources")}
      <button type="button" class="admin-button admin-button--tiny" data-add-source>Add a source</button>
    </div>`;

  /* ---- attached research -------------------------------------------- */
  const researchJson = escapeHtml(JSON.stringify(researchRefs));
  const attachedList = researchRefs.length
    ? researchRefs
        .map(
          ref => `<li data-ref-key="${escapeHtml(`${ref.source_key}:${ref.source_url || ref.source_name}`)}">
            <strong>${escapeHtml(ref.source_name)}</strong>
            <span class="admin-field-help">${escapeHtml(ref.source_key)}${ref.source_url ? ` · <a href="${escapeHtml(ref.source_url)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(ref.source_url)}</a>` : ""}</span>
            <button type="button" class="admin-button admin-button--tiny" data-remove-ref>Remove</button>
          </li>`
        )
        .join("\n")
    : `<li class="admin-field-help">Nothing attached yet.</li>`;

  const researchBlock = `
    <details class="admin-research" data-research-panel>
      <summary>Research panel — look up open data while you draft</summary>
      <p class="admin-field-help">
        Wikidata, Wikimedia Commons, OpenStreetMap and the reviewed RSS feeds. Results are read-only:
        you can attach one as a <em>reference</em>, which stores its name, URL, licence and a short
        excerpt for provenance. Nothing here is written into the article body.
      </p>
      <div class="admin-research-controls">
        <label for="research-source">Source
          <select id="research-source" data-research-source>
            <option value="wikidata">Wikidata (CC0 1.0)</option>
            <option value="commons">Wikimedia Commons (per file)</option>
            <option value="news">Reviewed RSS feeds</option>
            <option value="geo">OpenStreetMap / Nominatim (ODbL)</option>
          </select>
        </label>
        <label for="research-query">Search
          <input type="search" id="research-query" data-research-query maxlength="120" placeholder="Topic, file, place or headline">
        </label>
        <button type="button" class="admin-button" data-research-search>Search</button>
        <span class="admin-research-status" data-research-status role="status"></span>
      </div>
      <p class="admin-field-help" data-research-disclaimer hidden></p>
      <div class="admin-research-results" data-research-results></div>
      <input type="hidden" name="research_refs" value="${researchJson}" data-research-refs>
      <h3 class="admin-research-subhead">Attached references (<span data-ref-count>${researchRefs.length}</span>)</h3>
      <ul class="admin-research-attached" data-research-attached>${attachedList}</ul>
    </details>`;

  /* ---- copy similarity ------------------------------------------------ */
  const flagged = Boolean(similarity && similarity.flagged);
  const similarityWarning = flagged
    ? `<div class="admin-alert admin-alert--error admin-similarity" role="alert" data-similarity-warning>
        <strong>Copy-similarity warning — about ${escapeHtml(similarity.percent)}% of this article matches reference material you attached.</strong>
        <span>Threshold ${escapeHtml(Math.round(similarity.threshold * 100))}%, checked against ${escapeHtml(similarity.checked)} reference${similarity.checked === 1 ? "" : "s"}. This is an editorial nudge, not a plagiarism detector, and it blocks nothing on its own.</span>
        <label class="admin-checkbox admin-checkbox--ack">
          <input type="checkbox" name="acknowledge_similarity" value="1" data-similarity-ack>
          <span>I have reviewed this and still want to publish.</span>
        </label>
      </div>`
    : "";

  const similarityHint =
    !flagged && similarity
      ? `<p class="admin-field-help" data-similarity-hint>Copy similarity: ${escapeHtml(similarity.percent)}% (threshold ${escapeHtml(Math.round(similarity.threshold * 100))}%). Only a match at or above the threshold asks for an acknowledgement.</p>`
      : "";

  const categoryOptions = categories
    .map(
      category =>
        `<option value="${escapeHtml(category.id)}"${String(category.id) === String(categoryId) ? " selected" : ""}>${escapeHtml(category.name)}</option>`
    )
    .join("\n            ");

  const uploadedImages = uploads
    .map(
      upload =>
        `<button type="button" class="admin-media-item" data-insert-image="${escapeHtml(upload.path)}" title="${escapeHtml(upload.fileName)}">
          <img src="${escapeHtml(upload.path)}" alt="" width="120" height="80" loading="lazy">
          <span class="admin-media-name">${escapeHtml(upload.fileName)}</span>
        </button>`
    )
    .join("\n          ");

  const uploadErrorBlock = uploadError
    ? `<p class="admin-alert admin-alert--error" role="alert">${escapeHtml(uploadError)}</p>`
    : "";

  const previewUrl = isEdit ? `/admin/articles/${escapeHtml(article.id)}/preview` : "";

  const content = `${adminHeader({ active: isEdit ? "articles" : "new-article", csrfToken, admin })}

<main class="admin-main" id="admin-main">
  <div class="admin-page-head">
    <div>
      <h1 class="admin-page-title">${isEdit ? "Edit article" : "New article"}</h1>
      <p class="admin-page-subtitle">${
        isEdit
          ? `Editing <strong>${escapeHtml(article.title)}</strong> — saving updates this article, it never creates a copy.`
          : "Drafts stay private until you publish them."
      }</p>
    </div>
    <p class="admin-page-actions">
      ${previewUrl ? `<a class="admin-button admin-button--ghost" href="${escapeHtml(previewUrl)}">Preview</a>` : ""}
      ${isEdit ? `<a class="admin-button admin-button--ghost" href="/admin/articles/${escapeHtml(article.id)}/delete">Delete</a>` : ""}
      <a class="admin-button admin-button--ghost" href="/admin/articles">Back to articles</a>
    </p>
  </div>

  ${errorList(errors)}
  ${noticeBlock}
  ${policyNotice}
  ${uploadErrorBlock}

  <form class="admin-form admin-article-form" method="post" action="${escapeHtml(action)}" data-article-form>
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">

    <section class="admin-card" aria-labelledby="section-basics">
      <h2 class="admin-card-title" id="section-basics">Article</h2>

      <div class="admin-field">
        <label for="article-title">Title <span class="admin-required" aria-hidden="true">*</span></label>
        <input type="text" id="article-title" name="title" value="${title}" maxlength="${TITLE_MAX}" required
               placeholder="Top 10 Bollywood Movies to Watch in 2026" data-slug-source>
        ${fieldError(errors, "title")}
      </div>

      <div class="admin-field">
        <label for="article-slug">Slug</label>
        <input type="text" id="article-slug" name="slug" value="${slug}" maxlength="180"
               placeholder="top-10-bollywood-movies-to-watch-in-2026" data-slug-target
               aria-describedby="slug-help">
        <p class="admin-field-help" id="slug-help">
          Lowercase letters, numbers and hyphens. Generated from the title while you type; a clash becomes
          <code>-2</code>, <code>-3</code> and so on.
          <button type="button" class="admin-button admin-button--tiny" data-regenerate-slug>Regenerate from title</button>
        </p>
        ${fieldError(errors, "slug")}
      </div>

      <div class="admin-field">
        <label for="article-category">Category <span class="admin-required" aria-hidden="true">*</span></label>
        <select id="article-category" name="category_id" required>
          <option value="">Select a category</option>
            ${categoryOptions}
        </select>
        <p class="admin-field-help">Loaded from the <code>categories</code> table. One category per article.</p>
        ${fieldError(errors, "category_id")}
      </div>

      <div class="admin-field">
        <label for="article-meta">Meta description <span class="admin-required" aria-hidden="true">*</span></label>
        <textarea id="article-meta" name="meta_description" rows="3" maxlength="${META_DESCRIPTION_MAX}"
                  data-counter-for="article-meta-count" aria-describedby="article-meta-count"
                  placeholder="One sentence used in search results and link previews.">${metaDescription}</textarea>
        <p class="admin-field-help"><span id="article-meta-count" data-counter>${escapeHtml(metaDescription.length)}</span> / ${META_DESCRIPTION_MAX} characters. Search engines show roughly the first ${META_DESCRIPTION_MIN}; nothing is truncated for you.</p>
        ${fieldError(errors, "meta_description")}
      </div>
    </section>

    <section class="admin-card" aria-labelledby="section-banner">
      <h2 class="admin-card-title" id="section-banner">Banner image</h2>

      <div class="admin-field">
        <label for="article-banner">Upload image</label>
        <input type="file" id="article-banner" accept="image/jpeg,image/png,image/webp,image/avif" data-banner-input>
        <p class="admin-field-help">
          JPEG, PNG, WebP or AVIF, up to the server limit. The file type is checked from its contents and the
          stored name is generated, so the original filename is never used. The upload is sent on selection and
          its public path is written into the field below.
        </p>
      </div>

      <div class="admin-field">
        <label for="article-cover">Banner path</label>
        <input type="text" id="article-cover" name="cover_image" value="${coverImage}" maxlength="1000"
               data-banner-path placeholder="/assets/uploads/… or https://…">
        <p class="admin-field-help">Uploading a file fills this in. Existing <code>/assets/topics/…</code> covers work too.</p>
        ${fieldError(errors, "cover_image")}
      </div>

      <div class="admin-field">
        <label for="article-banner-alt">Banner alt text</label>
        <input type="text" id="article-banner-alt" name="banner_alt" value="${bannerAlt}" maxlength="${BANNER_ALT_MAX}"
               placeholder="Describe the image for screen readers" aria-describedby="banner-alt-help">
        <p class="admin-field-help" id="banner-alt-help">Required whenever a banner image is set.</p>
        ${fieldError(errors, "banner_alt")}
      </div>

      <div class="admin-banner-preview" data-banner-preview${coverImage ? "" : " hidden"}>
        <img src="${coverImage}" alt="" data-banner-preview-image>
      </div>

      ${
        uploads.length
          ? `<details class="admin-media">
              <summary>Recently uploaded images (${escapeHtml(uploads.length)})</summary>
              <div class="admin-media-grid">
          ${uploadedImages}
              </div>
              <p class="admin-field-help">Click an image to insert it into the body.</p>
            </details>`
          : ""
      }
    </section>

    <section class="admin-card" aria-labelledby="section-sources">
      <h2 class="admin-card-title" id="section-sources">Sources &amp; research</h2>
      ${citationBlock}
      ${researchBlock}
    </section>

    <section class="admin-card" aria-labelledby="section-body">
      <h2 class="admin-card-title" id="section-body">Article body</h2>
      <p class="admin-field-help">
        HTML is sanitised on the server against a fixed allowlist before it is stored:
        headings, paragraphs, lists, links, blockquotes and images survive; scripts, iframes, inline styles and
        every <code>on*</code> handler are removed.
      </p>
      <div class="admin-editor" data-editor>
        <div class="admin-editor-toolbar" role="toolbar" aria-label="Formatting" data-editor-toolbar hidden>
          <button type="button" class="admin-editor-button" data-command="formatBlock" data-value="p" title="Paragraph">P</button>
          <button type="button" class="admin-editor-button" data-command="formatBlock" data-value="h1" title="Heading 1">H1</button>
          <button type="button" class="admin-editor-button" data-command="formatBlock" data-value="h2" title="Heading 2">H2</button>
          <button type="button" class="admin-editor-button" data-command="formatBlock" data-value="h3" title="Heading 3">H3</button>
          <button type="button" class="admin-editor-button" data-command="formatBlock" data-value="h4" title="Heading 4">H4</button>
          <button type="button" class="admin-editor-button" data-command="formatBlock" data-value="h5" title="Heading 5">H5</button>
          <button type="button" class="admin-editor-button" data-command="formatBlock" data-value="h6" title="Heading 6">H6</button>
          <span class="admin-editor-divider" aria-hidden="true"></span>
          <button type="button" class="admin-editor-button" data-command="bold" title="Bold (Ctrl+B)"><strong>B</strong></button>
          <button type="button" class="admin-editor-button" data-command="italic" title="Italic (Ctrl+I)"><em>I</em></button>
          <button type="button" class="admin-editor-button" data-command="insertUnorderedList" title="Bulleted list">&bull; List</button>
          <button type="button" class="admin-editor-button" data-command="insertOrderedList" title="Numbered list">1. List</button>
          <button type="button" class="admin-editor-button" data-command="formatBlock" data-value="blockquote" title="Quote">&ldquo;</button>
          <span class="admin-editor-divider" aria-hidden="true"></span>
          <button type="button" class="admin-editor-button" data-command="link" title="Insert link">Link</button>
          <button type="button" class="admin-editor-button" data-command="unlink" title="Remove link">Unlink</button>
          <button type="button" class="admin-editor-button" data-command="image" title="Insert image">Image</button>
          <span class="admin-editor-divider" aria-hidden="true"></span>
          <button type="button" class="admin-editor-button" data-command="removeFormat" title="Clear formatting">Clear</button>
          <button type="button" class="admin-editor-button" data-command="source" title="Edit HTML source">&lt;/&gt;</button>
        </div>
        <div class="admin-editor-surface" contenteditable="true" role="textbox" aria-multiline="true"
             aria-label="Article body" data-editor-surface spellcheck="true" hidden></div>
        <textarea class="admin-editor-source" name="content" rows="20" data-editor-source spellcheck="false"
                  aria-label="Article body">${escapeHtml(body)}</textarea>
        <p class="admin-field-help">
          <span data-word-count>${escapeHtml(words)}</span> words. Blank lines become paragraphs. Nothing is saved
          automatically — use one of the buttons below.
        </p>
        ${fieldError(errors, "content")}
      </div>
    </section>

    <section class="admin-card admin-seo-panel" aria-labelledby="section-metadata">
      <h2 class="admin-card-title" id="section-metadata">Search &amp; social metadata</h2>
      <p class="admin-field-help">
        Every field here is optional: a blank value falls back to the article's own title, excerpt,
        meta description and banner. Fill one in only when the search result or the social card should
        read differently from the article itself.
      </p>

      <div class="admin-field">
        <label for="article-excerpt">Excerpt / standfirst</label>
        <textarea id="article-excerpt" name="excerpt" rows="2" maxlength="${EXCERPT_MAX}"
                  placeholder="One or two sentences shown under the headline.">${excerpt}</textarea>
        <p class="admin-field-help">Used beneath the headline and as the fallback social description.</p>
        ${fieldError(errors, "excerpt")}
      </div>

      <div class="admin-field">
        <label for="article-meta-title">Meta title</label>
        <input type="text" id="article-meta-title" name="meta_title" value="${metaTitle}" maxlength="${META_TITLE_MAX}"
               placeholder="Leave blank to use the article title">
        <p class="admin-field-help">The <code>&lt;title&gt;</code> and the blue link in search results. Roughly ${META_TITLE_MAX} characters is the practical ceiling.</p>
        ${fieldError(errors, "meta_title")}
      </div>

      <div class="admin-field">
        <label for="article-canonical">Canonical URL override</label>
        <input type="url" id="article-canonical" name="canonical_url" value="${canonicalUrl}" maxlength="2000"
               placeholder="https://… or /blog/…">
        <p class="admin-field-help">Set this only when the article was first published elsewhere and points here as the original.</p>
        ${fieldError(errors, "canonical_url")}
      </div>

      <div class="admin-field">
        <label for="article-focus-keyword">Focus keyword</label>
        <input type="text" id="article-focus-keyword" name="focus_keyword" value="${focusKeyword}" maxlength="${FOCUS_KEYWORD_MAX}"
               placeholder="The one phrase this article should rank for">
        <p class="admin-field-help">Used by the SEO check above. Optional: without it the checker picks the most frequent term.</p>
        ${fieldError(errors, "focus_keyword")}
      </div>

      <div class="admin-field">
        <label for="article-tags">Tags</label>
        <input type="text" id="article-tags" name="tags" value="${tagList}"
               placeholder="cinema, wildlife, travel">
        <p class="admin-field-help">Comma-separated keywords. Each one gets a /tag/&lt;slug&gt; page and feeds the search facets.</p>
        ${fieldError(errors, "tags")}
      </div>

      <div class="admin-field">
        <label for="article-schema-type">Structured data type</label>
        <select id="article-schema-type" name="schema_type">${schemaTypeOptions}</select>
        <p class="admin-field-help">The Schema.org type emitted in the article's JSON-LD. BlogPosting is the right default.</p>
        ${fieldError(errors, "schema_type")}
      </div>

      <h3 class="admin-card-title admin-card-title--sub">Indexing</h3>
      <div class="admin-seo-inline">
        <div class="admin-field">
          <label for="article-robots-index">Search engines</label>
          <select id="article-robots-index" name="robots_index">${robotsIndexOptions}</select>
          ${fieldError(errors, "robots_index")}
        </div>
        <div class="admin-field">
          <label for="article-robots-follow">Follow links</label>
          <select id="article-robots-follow" name="robots_follow">${robotsFollowOptions}</select>
          ${fieldError(errors, "robots_follow")}
        </div>
      </div>
      <p class="admin-field-help"><code>noindex</code> keeps the article off search results; <code>nofollow</code> asks crawlers not to follow its outbound links.</p>

      <details class="admin-seo-social">
        <summary>Open Graph and Twitter / X overrides</summary>
        <p class="admin-field-help">Each field falls back to the article's title, excerpt and banner when left blank.</p>

        <div class="admin-field">
          <label for="article-og-title">Open Graph title</label>
          <input type="text" id="article-og-title" name="og_title" value="${ogTitle}" maxlength="${META_TITLE_MAX}">
          ${fieldError(errors, "og_title")}
        </div>
        <div class="admin-field">
          <label for="article-og-description">Open Graph description</label>
          <textarea id="article-og-description" name="og_description" rows="2" maxlength="${OG_DESCRIPTION_MAX}">${ogDescription}</textarea>
          ${fieldError(errors, "og_description")}
        </div>
        <div class="admin-field">
          <label for="article-og-image">Open Graph image</label>
          <input type="text" id="article-og-image" name="og_image" value="${ogImage}" maxlength="1000" placeholder="/assets/uploads/… or https://…">
          ${fieldError(errors, "og_image")}
        </div>
        <div class="admin-field">
          <label for="article-twitter-title">Twitter title</label>
          <input type="text" id="article-twitter-title" name="twitter_title" value="${twitterTitle}" maxlength="${META_TITLE_MAX}">
          ${fieldError(errors, "twitter_title")}
        </div>
        <div class="admin-field">
          <label for="article-twitter-description">Twitter description</label>
          <textarea id="article-twitter-description" name="twitter_description" rows="2" maxlength="${OG_DESCRIPTION_MAX}">${twitterDescription}</textarea>
          ${fieldError(errors, "twitter_description")}
        </div>
        <div class="admin-field">
          <label for="article-twitter-image">Twitter image</label>
          <input type="text" id="article-twitter-image" name="twitter_image" value="${twitterImage}" maxlength="1000" placeholder="/assets/uploads/… or https://…">
          ${fieldError(errors, "twitter_image")}
        </div>
      </details>
    </section>

    <section class="admin-card admin-seo-panel" aria-labelledby="section-seo">
      <h2 class="admin-card-title" id="section-seo">SEO check</h2>
      <p class="admin-field-help">
        A deterministic, internal content-quality report computed on the server (docs/seo-engine.md). It is
        not a Google ranking metric, calls no third-party service and stores nothing. Check the published days'
        worth of articles, then decide what to improve here before it lands.
      </p>
      <div class="admin-seo" data-seo-panel data-article-id="${isEdit ? escapeHtml(article.id) : ""}">
        <div class="admin-seo-controls">
          <button type="button" class="admin-button" data-seo-run>Run SEO check</button>
          <span class="admin-seo-status" data-seo-status role="status"></span>
        </div>
        <div class="admin-seo-report" data-seo-report hidden></div>
      </div>
    </section>

    <section class="admin-card" aria-labelledby="section-status">
      <h2 class="admin-card-title" id="section-status">Status</h2>

      <fieldset class="admin-radio-group">
        <legend class="sr-only">Article status</legend>
        <label class="admin-radio">
          <input type="radio" name="status" value="draft"${mode === STATUS_DRAFT ? " checked" : ""}>
          <span><strong>Draft</strong><br><span class="admin-field-help">Private. Not on the site, in the API or the sitemap.</span></span>
        </label>
        <label class="admin-radio">
          <input type="radio" name="status" value="scheduled"${mode === STATUS_SCHEDULED ? " checked" : ""}>
          <span><strong>Scheduled</strong><br><span class="admin-field-help">Goes live automatically at the date and time below.</span></span>
        </label>
        <label class="admin-radio">
          <input type="radio" name="status" value="published"${mode === STATUS_PUBLISHED ? " checked" : ""}>
          <span><strong>Published</strong><br><span class="admin-field-help">Visible on the site and in the dynamic sitemap.</span></span>
        </label>
        <label class="admin-radio">
          <input type="radio" name="status" value="archived"${mode === STATUS_ARCHIVED ? " checked" : ""}>
          <span><strong>Archived</strong><br><span class="admin-field-help">Kept for the record but off the site and out of the sitemap.</span></span>
        </label>
      </fieldset>
      ${fieldError(errors, "status")}

      <div class="admin-field">
        <label for="article-scheduled-at">Publish at <span class="admin-field-help">(used when the status is Scheduled)</span></label>
        <input type="datetime-local" id="article-scheduled-at" name="scheduled_at" value="${scheduledAt}">
        <p class="admin-field-help">The article is promoted to Published once this moment passes; nothing needs to be clicked.</p>
        ${fieldError(errors, "scheduled_at")}
      </div>
      ${similarityWarning}
      ${similarityHint}

      <div class="admin-form-actions">
        <button type="submit" name="intent" value="publish" class="admin-button admin-button--primary">${isEdit ? "Save &amp; publish" : "Publish"}</button>
        <button type="submit" name="intent" value="schedule" class="admin-button">Schedule</button>
        <button type="submit" name="intent" value="draft" class="admin-button">${isEdit ? "Save as draft" : "Save draft"}</button>
        <button type="submit" name="intent" value="archive" class="admin-button admin-button--ghost">Archive</button>
        <button type="submit" name="intent" value="preview" class="admin-button admin-button--ghost">Preview</button>
        <a class="admin-button admin-button--ghost" href="/admin/articles">Cancel</a>
      </div>
    </section>

    <section class="admin-card" aria-labelledby="section-ads">
      <h2 class="admin-card-title" id="section-ads">Advertising</h2>
      <p class="admin-field-help">
        The site-wide advertising units are shown on the public layout unless this article opts out.
        A category can set a default for its articles; this article-level setting wins when both exist.
      </p>

      <fieldset class="admin-radio-group">
        <legend class="sr-only">Advertising on this article</legend>
        <label class="admin-radio">
          <input type="radio" name="ads_enabled" value="default"${adsChoiceDefault}>
          <span><strong>Follow the category default</strong><br><span class="admin-field-help">Usually advertising is on; check the category defaults under Monetization.</span></span>
        </label>
        <label class="admin-radio">
          <input type="radio" name="ads_enabled" value="1"${adsChoiceYes}>
          <span><strong>Show ads</strong><br><span class="admin-field-help">Explicitly allow the advertising units on this article.</span></span>
        </label>
        <label class="admin-radio">
          <input type="radio" name="ads_enabled" value="0"${adsChoiceNo}>
          <span><strong>No ads</strong><br><span class="admin-field-help">Suppress the advertising units on this article, for example when a source or a topic demands it.</span></span>
        </label>
      </fieldset>
      ${fieldError(errors, "ads_enabled")}
    </section>
  </form>
</main>

<script src="/assets/admin/admin-article-form.js" defer></script>
<script src="/assets/admin/admin-research.js" defer></script>
<script src="/assets/admin/admin-seo.js" defer></script>

${adminFooter()}`;

  return layout({
    title: `${isEdit ? "Edit article" : "New article"} | ${BRAND}`,
    content,
    bodyClass: "admin-body",
    extraStyles: ["/assets/admin/admin-cms.css"]
  });
}

/* ==================================================================== */
/* Delete confirmation: /admin/articles/:id/delete                      */
/* ==================================================================== */

/**
 * Deleting always passes through this screen. Nothing is removed by a GET, and
 * the POST carries the CSRF token, so an <img> tag or a prefetch cannot delete
 * an article.
 */
function renderDeleteConfirm({ admin, csrfToken, article }) {
  const content = `${adminHeader({ active: "articles", csrfToken, admin })}

<main class="admin-main admin-main--narrow" id="admin-main">
  <div class="admin-card">
    <h1 class="admin-card-title">Delete this article?</h1>
    <p class="admin-card-subtitle">This cannot be undone.</p>

    <dl class="admin-summary">
      <div><dt>Title</dt><dd>${escapeHtml(article.title)}</dd></div>
      <div><dt>Slug</dt><dd><code>${escapeHtml(article.slug)}</code></dd></div>
      <div><dt>Category</dt><dd>${escapeHtml(article.category_name || "Uncategorised")}</dd></div>
      <div><dt>Status</dt><dd>${escapeHtml(article.status)}</dd></div>
      <div><dt>Last updated</dt><dd>${escapeHtml(formatDate(article.updated_at || article.created_at))}</dd></div>
    </dl>

    <p class="admin-note">Images stored in <code>article_images</code> for this article are removed with it. A banner uploaded through this admin area is deleted from disk as well.</p>

    <form class="admin-form admin-form-actions" method="post" action="/admin/articles/${escapeHtml(article.id)}/delete">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <button type="submit" class="admin-button admin-button--danger">Delete permanently</button>
      <a class="admin-button admin-button--ghost" href="/admin/articles/${escapeHtml(article.id)}/edit">Cancel</a>
    </form>
  </div>
</main>

${adminFooter()}`;

  return layout({
    title: `Delete article | ${BRAND}`,
    content,
    bodyClass: "admin-body",
    extraStyles: ["/assets/admin/admin-cms.css"]
  });
}

/* ==================================================================== */
/* Preview: /admin/articles/:id/preview and POST /admin/articles/preview */
/* ==================================================================== */

/**
 * Admin-only preview of an article, published or not.
 *
 * The page sits behind the admin page guard and carries noindex, so a draft can
 * be reviewed without ever becoming reachable by a public URL. The body is the
 * same sanitised HTML that was stored (or, for the unsaved preview, sanitised
 * on the way in).
 */
function renderPreview({ admin, csrfToken, article, isUnsaved = false, bodyHtml = "", values = {} } = {}) {
  const status = String(article ? article.status : values.status || STATUS_DRAFT).toLowerCase();
  const published = status === STATUS_PUBLISHED;
  const bannerAlt = (article ? article.banner_alt : values.banner_alt) || "";
  const banner = (article ? article.cover_image : values.cover_image) || "";
  const body = isUnsaved ? bodyHtml : article ? article.content : "";
  const metaDescription = (article ? article.meta_description : values.meta_description) || "";

  const content = `${adminHeader({ active: "articles", csrfToken, admin })}

<main class="admin-main" id="admin-main">
  <div class="admin-page-head">
    <div>
      <h1 class="admin-page-title">Preview</h1>
      <p class="admin-page-subtitle">
        <span class="admin-badge admin-badge--${published ? "published" : "draft"}">${published ? "Published" : "Draft"}</span>
        ${isUnsaved ? " Unsaved changes — nothing was written to the database." : ""}
      </p>
    </div>
    <p class="admin-page-actions">
      ${
        article
          ? `<a class="admin-button admin-button--ghost" href="/admin/articles/${escapeHtml(article.id)}/edit">Back to editor</a>
             ${published ? `<a class="admin-action" href="/blog/${encodeURIComponent(article.slug)}" rel="external">View live</a>` : ""}`
          : `<a class="admin-button admin-button--ghost" href="/admin/articles/new">Back to the form</a>`
      }
    </p>
  </div>

  <p class="admin-alert admin-alert--info" role="status">This page is reachable only with an administrator session and is never indexed.</p>

  <article class="article-detail admin-preview">
    <div class="article-detail-header">
      ${values.category_name ? `<span class="article-detail-category">${escapeHtml(values.category_name)}</span>` : ""}
      <h1 class="article-detail-title">${escapeHtml(values.title || "Untitled article")}</h1>
      <div class="article-detail-meta">
        <span class="article-detail-date">${escapeHtml(formatDate(article ? article.published_at || article.created_at : new Date()))}</span>
      </div>
    </div>
    ${banner ? `<img class="article-detail-cover" src="${escapeHtml(banner)}" alt="${escapeHtml(bannerAlt)}" width="1200" height="675" decoding="async">` : ""}
    ${metaDescription ? `<p class="admin-preview-meta"><strong>Meta description:</strong> ${escapeHtml(metaDescription)} <em>(${escapeHtml(metaDescription.length)} characters)</em></p>` : ""}
    <div class="article-detail-content">${body}</div>
  </article>
</main>

${adminFooter()}`;

  return layout({
    title: `Preview | ${BRAND}`,
    content,
    bodyClass: "admin-body",
    extraStyles: ["/assets/admin/admin-cms.css"]
  });
}

module.exports = {
  listHref,
  queryString,
  renderArticleForm,
  renderArticleList,
  renderDeleteConfirm,
  renderPreview
};