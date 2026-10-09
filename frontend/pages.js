/**
 * KaliNova — Page Components
 * Each function renders a full page into the #app container.
 */
(() => {
  "use strict";

  // The sidebar's social, newsletter and promo blocks. Kept in their own file
  // so both the homepage and the category pages can drop the same markup in.
  const Sidebar = window.KaliNovaSidebar || { extra: () => "", bind: () => {} };

  // The ad component is optional at runtime: on a site that is not monetised, or
  // before the manifest has loaded, the fallback makes every call below return
  // an empty string, so the templates carry no ad markup and no empty boxes.
  const AdSlot = window.KaliNovaAds || {
    placeholder: () => "",
    inArticle: () => null,
    positionOf: () => null,
    hydrate: () => Promise.resolve(false),
    ready: () => Promise.resolve({ enabled: false, ads: [] })
  };

  // The direct-ad/sponsored/affiliate component is optional at runtime in the
  // same way: until the monetization manifest has loaded, every call below
  // returns empty markup, so no template renders an unmonetised placeholder.
  const Monetization = window.KaliNovaMonetization || {
    placeholder: () => "",
    article: () => Promise.resolve(null),
    hydrate: () => {},
    hydrateAll: () => {},
    onRoute: () => {},
    renderArticleExtras: () => {}
  };

  const DEFAULT_AVATAR = "/assets/article-meta.png";
  // Articles may be published without a cover image. When that happens the
  // media block is dropped entirely rather than filled with a placeholder.
  const DEFAULT_COVER = "";

  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  // The public site has no accounts: the site author owns the profile,
  // dashboard and settings views, so those always render without a signed-in
  // check. Story writing is administrator-only and lives in /admin/dashboard.
  function isLoggedIn() { return true; }

  // Drop cover images that resolved to an empty source, along with the
  // anchor that wraps them, so cards collapse cleanly instead of showing a
  // broken image or an empty grey box.
  function stripEmptyCovers(root) {
    $$("img", root).forEach(img => {
      if (img.getAttribute("src")) return;
      const wrapper = img.closest(".card-media, .story-card-media, .news-card-media");
      if (wrapper) {
        wrapper.remove();
      } else {
        img.remove();
      }
    });
  }

  function renderApp(content) {
    const app = $("#app");
    if (app) {
      app.innerHTML = content;
      stripEmptyCovers(app);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function showLoading(msg = "Loading...") {
    renderApp(`<div class="page-loading"><div class="spinner"></div><p>${msg}</p></div>`);
  }

  function showError(msg = "Something went wrong. Please try again.") {
    renderApp(`<div class="page-error"><p>${msg}</p><button class="btn btn-primary" onclick="history.back()">Go Back</button></div>`);
  }

  function formatDate(d) {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function readMins(content, bodyFormat) {
    // An HTML body would otherwise be counted with its tags as words.
    const text = bodyText(content, bodyFormat);
    return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length / 200));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* Escapes a line, then re-applies the inline "**bold**" markers used by the
     editorial seeds. Escaping happens first, so the only markup that can reach
     the DOM is the <strong> added here. */
  function inlineMarkup(text) {
    return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  /* Renders plain-text article bodies that may use "# " / "## " headings
     and blank lines between paragraphs. All text is escaped first. */
  function formatContent(content) {
    if (!content) return "";
    const blocks = String(content).replace(/\r\n/g, "\n").split(/\n{2,}/);
    return blocks
      .map(block => {
        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
        if (!lines.length) return "";
        const heading = lines[0].match(/^#{1,6}\s+(.*)$/);
        if (heading && lines.length === 1) {
          return `<h2>${inlineMarkup(heading[1].trim())}</h2>`;
        }
        return `<p>${lines.map(l => inlineMarkup(l)).join("<br>")}</p>`;
      })
      .filter(Boolean)
      .join("");
  }

  /* An article written through the admin CMS arrives as body_format "html".
     The server stored it after running it through the same allowlist used by
     the editor (article-html.sanitizeBody), so scripts, iframes, style
     attributes, event handlers and unsafe URL schemes are already gone and the
     markup can be inserted as-is. Rows that predate the CMS keep body_format
     "text" and continue to go through formatContent() above, which escapes
     everything.
     The browser, not this file, is the last line of defence: an element that is
     never allowed can never arrive here. */
  function renderBody(content, bodyFormat) {
    if (!content) return "";
    return bodyFormat === "html" ? String(content) : formatContent(content);
  }

  /** Top-level block count of a body, used to resolve an in-content position. */
  function articleBlockCount(content, bodyFormat) {
    const html = renderBody(content, bodyFormat);
    if (!html) return 0;

    const holder = document.createElement("div");
    holder.innerHTML = html;
    return holder.children.length;
  }

  /**
   * The article body, with optional in-content ads/groups between blocks.
   *
   * Accepts one in-content slot object ({position, markup}) or an array of them,
   * so the Google slot and a direct-ad campaign can share a body without the
   * renderer caring which is which.
   *
   * Each slot is inserted between top-level blocks of the already-rendered
   * body, never inside one: the DOM is built first and the slot is then moved in
   * after the chosen element. Nothing is split, so a paragraph cannot be cut in
   * half by a percentage calculation.
   *
   * Returns the plain body unchanged when there is nothing to place, which is
   * the normal case on a site that is not monetised.
   */
  function renderArticleContent(content, bodyFormat, inContentMarkup) {
    const html = renderBody(content, bodyFormat);
    const slides = Array.isArray(inContentMarkup)
      ? inContentMarkup
      : inContentMarkup
        ? [inContentMarkup]
        : [];
    if (!html || !slides.length) return html;

    const holder = document.createElement("div");
    holder.innerHTML = html;

    // Only top-level blocks count towards the position.
    const blocks = Array.from(holder.children);
    if (blocks.length < 3) return html;

    const resolved = [];
    slides.forEach(slide => {
      if (!slide || typeof slide !== "object") return;

      const position = Number(slide.position);
      if (!Number.isInteger(position)) return;

      const slot = document.createElement("div");
      slot.className = "ad-slot-incontent";
      slot.innerHTML = slide.markup;
      if (!slot.firstElementChild) return;

      let target = Math.round((blocks.length * position) / 100);
      if (target < 1) target = 1;
      if (target > blocks.length - 1) target = blocks.length - 1;
      resolved.push({ target, element: slot.firstElementChild });
    });

    // Insert from the end towards the start, so an earlier slot stays next to
    // the paragraph run it was aimed at rather than drifting when a later one
    // (which could follow it) pushes the blocks along.
    resolved.sort((a, b) => b.target - a.target);
    resolved.forEach(({ target, element }) => {
      if (blocks[target]) blocks[target].after(element);
    });

    return holder.innerHTML;
  }

  /* Body text without markup, for excerpts, word counts and SEO strings. */
  function bodyText(content, bodyFormat) {
    if (!content) return "";
    const raw = String(content);
    if (bodyFormat !== "html") return raw;

    const holder = document.createElement("div");
    holder.innerHTML = raw;
    holder.querySelectorAll("script, style, iframe").forEach(node => node.remove());
    return holder.textContent || "";
  }

  function makeExcerpt(content, max = 200, bodyFormat) {
    // For an HTML body the markup is stripped first; for a plain-text body the
    // editorial "# " and "**" conventions are stripped as before.
    const source = bodyText(content, bodyFormat);

    const text = source
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= max) return escapeHtml(text);
    const clipped = text.slice(0, max);
    const cut = clipped.lastIndexOf(" ");
    return escapeHtml((cut > 0 ? clipped.slice(0, cut) : clipped).replace(/[,;:.]$/, "")) + "…";
  }

  /* ------------------------------------------------------------------ */
  /* SEO helpers                                                         */
  /* ------------------------------------------------------------------ */

  const SEO = window.KaliNovaSEO;

  // Plain-text body text for <title> and meta descriptions. Unlike
  // makeExcerpt this does not escape, because the SEO helpers write the value
  // through setAttribute where the browser handles encoding.
  function plainText(content, max = 200) {
    const text = String(content || "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= max) return text;
    const clipped = text.slice(0, max);
    const cut = clipped.lastIndexOf(" ");
    return (cut > 0 ? clipped.slice(0, cut) : clipped).replace(/[,;:.]$/, "");
  }

  /* The description an administrator typed for this article, falling back to the
     body text for rows that predate the CMS. Kept in one place so the <meta>
     tag, the Open Graph tag and the structured data always agree. */
  function articleDescription(article, max = 158) {
    if (article.meta_description) return String(article.meta_description);
    return plainText(bodyText(article.content, article.body_format), max);
  }

  /* Escaped card/summary text for any article-shaped object from the API. A CMS
     article gets its own meta description; a seeded one keeps the excerpt it has
     always had. */
  function cardExcerpt(article, max = 200) {
    if (article.meta_description) {
      const text = String(article.meta_description).replace(/\s+/g, " ").trim();
      return text.length <= max ? escapeHtml(text) : `${escapeHtml(text.slice(0, max - 1).replace(/\s+\S*$/, ""))}…`;
    }

    return makeExcerpt(article.content, max, article.body_format);
  }

  /**
   * Canonical article path. Every published row carries a slug, so the clean
   * /blog/<slug> form is the default; the numeric id form is kept only as a
   * fallback and is canonicalised away by renderStoryDetail.
   */
  function articlePath(a) {
    if (a && a.slug) return `/blog/${encodeURIComponent(a.slug)}`;
    return a && a.id ? `/stories/${a.id}` : "/stories";
  }

  // Apply a static page's title/description/canonical/schema in one call.
  function seoPage(key, overrides) {
    if (SEO) SEO.applyPage(key, overrides);
  }

  // Tool and account views: real pages for users, but never in an index.
  function seoNoindex(path, title) {
    if (!SEO) return;
    SEO.applyPage("search", { path, title });
  }

  /* ------------------------------------------------------------------ */
  /* Home / For You                                                     */
  /* ------------------------------------------------------------------ */
  async function renderHome() {
    seoPage("home");
    showLoading("Loading stories...");
    try {
      const [artRes, catRes, trendRes] = await Promise.all([
        fetch("/api/articles"),
        fetch("/api/categories"),
        // Trending is a separate query. The main feed is capped at the newest
        // 50 rows, so trending articles sitting outside that window would never
        // reach the sidebar and the list would come back nearly empty.
        fetch("/api/articles?trending=true")
      ]);
      if (!artRes.ok || !catRes.ok) throw new Error("API error");
      const artData = await artRes.json();
      const catData = await catRes.json();
      const trendData = trendRes.ok ? await trendRes.json() : { articles: [] };

      const articles = artData.articles.map(a => ({
        id: a.id, slug: a.slug, title: a.title, excerpt: cardExcerpt(a),
        author: { id: a.author_id, name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        category: a.category_name || "General", categorySlug: a.category_slug,
        image: a.cover_image || DEFAULT_COVER, bannerAlt: a.banner_alt || "",
        featured: Boolean(a.is_featured), trending: Boolean(a.is_trending),
        date: formatDate(a.published_at || a.created_at),
        readTime: readMins(a.content, a.body_format)
      }));

      // is_featured picks the featured row. The API orders by created_at DESC with a
      // LIMIT, so a featured article that is not in the newest page would be
      // invisible here; falling back to the two newest keeps the section useful
      // rather than empty.
      let featured = articles.filter(a => a.featured).slice(0, 2);
      if (featured.length === 0) featured = articles.slice(0, 2);

      const recommended = articles.filter(a => !featured.includes(a)).slice(0, 3);
      // Capped on purpose. The feed is 50 rows, and rendering every one of them
      // pushed "Stay In Touch" and the footer roughly 22,000px down the page on a
      // phone. Ten is enough to fill the fold, and /blog carries the rest behind
      // a Load more button.
      const latest = articles.filter(a => !featured.includes(a)).slice(3, 13);

      // Prefer the dedicated trending query, then whatever the main feed
      // carries, then any article at all. The sidebar should never render
      // fewer than five rows just because flags are sparse.
      const trending = trendData.articles.map(a => ({
        id: a.id, slug: a.slug, title: a.title,
        author: { name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR }
      }));
      for (const a of articles) {
        if (trending.length >= 5) break;
        if (!trending.some(t => t.id === a.id)) trending.push(a);
      }
      // Titles are escaped here, at the point of output, so both the
      // trending-query rows and the fallback rows are safe regardless of
      // which branch supplied them.
      const trendingList = trending.slice(0, 5).map(a => ({
        ...a,
        title: escapeHtml(a.title),
        author: { name: escapeHtml(a.author.name), avatar: escapeHtml(a.author.avatar) }
      }));

      renderApp(`
        <div class="layout">
          <div class="feed">
            ${Monetization.placeholder("homepage_top")}
            ${featured.length ? `
            <section class="feed-section">
              <h2 class="feed-heading">Featured stories</h2>
              <div class="featured-grid">
                ${featured.map(a => `
                  <article class="card card-featured">
                    <a class="card-media" href="${articlePath(a)}" aria-label="${a.title}"><img class="card-img" src="${a.image}" alt="${a.bannerAlt || a.title}" loading="lazy" decoding="async" width="1200" height="675"></a>
                    <div class="card-body">
                      <p class="card-eyebrow">${a.category}</p>
                      <h3 class="card-title"><a href="${articlePath(a)}">${a.title}</a></h3>
                      <p class="card-desc">${a.excerpt}</p>
                      <div class="card-meta">
                        <img class="avatar avatar-xs" src="${a.author.avatar}" alt="${a.author.name}" width="24" height="24" loading="lazy" decoding="async">
                        <span class="meta-author">${a.author.name}</span>
                        <span class="meta-dot">&middot;</span>
                        <span class="meta-read">${a.readTime} min read</span>
                        <span class="meta-dot">&middot;</span>
                        <span class="meta-date">${a.date}</span>
                      </div>
                    </div>
                  </article>
                `).join("")}
              </div>
            </section>` : ""}

            <section class="feed-section">
              <h2 class="feed-heading">Recommended for you</h2>
              <div class="article-list">
                ${recommended.length ? recommended.map(a => articleRow(a)).join("") : `<div class="empty-state"><p class="empty-state-title">Nothing to recommend yet.</p></div>`}
              </div>
            </section>

            ${Monetization.placeholder("homepage_middle")}

            <section class="feed-section">
              <h2 class="feed-heading">Latest stories</h2>
              <div class="article-list">
                ${latest.length ? latest.map(a => articleRow(a)).join("") : `<div class="empty-state"><p class="empty-state-title">No stories have been published yet.</p><p class="empty-state-subtitle">Be the first to write one.</p></div>`}
              </div>
              <div class="feed-more">
                <a class="btn btn-outline" href="/blog">Browse all stories</a>
              </div>
            </section>
          </div>

          <aside class="sidebar">
            ${AdSlot.placeholder("sidebar-top")}
            ${Monetization.placeholder("sidebar")}
            <section class="side-card">
              <h2 class="side-heading">Trending on KaliNova</h2>
              <ol class="trending-list">
                ${trendingList.map((a, i) => `
                  <li class="trending-item">
                    <span class="trending-rank">${String(i + 1).padStart(2, "0")}</span>
                    <div class="trending-content">
                      <div class="trending-author-row">
                        <img class="avatar avatar-xxs" src="${a.author.avatar}" alt="" width="20" height="20" loading="lazy" decoding="async">
                        <span class="meta-author">${a.author.name}</span>
                      </div>
                      <h4 class="trending-title"><a href="${articlePath(a)}">${a.title}</a></h4>
                    </div>
                  </li>
                `).join("")}
              </ol>
            </section>
            ${AdSlot.placeholder("sidebar-middle")}
            ${Sidebar.extra()}
            ${AdSlot.placeholder("sidebar-bottom")}
            <p class="side-footnote">KaliNova &copy; 2026 &middot; Built for developers, by developers.</p>
          </aside>
        </div>
      `);

      Sidebar.bind($("#app"));
      // Pushes any ad placeholders in the freshly rendered page. A no-op while
      // the site is unmonetised, because there is nothing in the DOM to fill.
      AdSlot.hydrate($("#app"));
      // Same for the monetization surfaces (direct ads, newsletter wiring).
      Monetization.hydrate($("#app"));
    } catch (e) {
      console.error(e);
      showError("Failed to load stories.");
    }
  }

  function articleRow(a) {
    return `
      <article class="card card-row">
        <div class="card-body">
          <div class="card-meta card-meta-top">
            <img class="avatar avatar-xs" src="${a.author.avatar}" alt="${a.author.name}" width="24" height="24" loading="lazy" decoding="async">
            <span class="meta-author">${a.author.name}</span>
            <span class="meta-dot">&middot;</span>
            <span class="meta-date">${a.date}</span>
          </div>
          <h3 class="card-title"><a href="${articlePath(a)}">${a.title}</a></h3>
          <p class="card-desc">${a.excerpt}</p>
          <div class="card-footer">
            <p class="card-eyebrow">${a.category}</p>
            <span class="meta-dot">&middot;</span>
            <span class="meta-read">${a.readTime} min read</span>
          </div>
        </div>
        <a class="card-media card-media-side" href="${articlePath(a)}" aria-label="${a.title}"><img class="card-img" src="${a.image}" alt="${a.bannerAlt || a.title}" loading="lazy" decoding="async" width="1200" height="675"></a>
      </article>`;
  }

  /* ------------------------------------------------------------------ */
  /* Stories Page                                                       */
  /* ------------------------------------------------------------------ */

  /* How many story cards the listing shows before the reader has to ask for
     more. The endpoint caps the result set at 50 rows, so this is a display
     batch rather than a server page size: everything is already in memory and
     the button just reveals the next slice. */
  const STORIES_BATCH = 12;

  function storyCard(a) {
    return `
              <article class="story-card">
                <a class="story-card-media" href="${articlePath(a)}" aria-label="${a.title}"><img src="${a.image}" alt="${a.bannerAlt || a.title}" loading="lazy" decoding="async" width="1200" height="750"></a>
                <div class="story-card-body">
                  <span class="story-card-category">${a.category}</span>
                  <h3 class="story-card-title"><a href="${articlePath(a)}">${a.title}</a></h3>
                  <p class="story-card-excerpt">${a.excerpt}</p>
                  <div class="story-card-meta">
                    <img class="avatar avatar-xs" src="${a.author.avatar}" alt="${a.author.name}" width="24" height="24" loading="lazy" decoding="async">
                    <span class="meta-author">${a.author.name}</span>
                    <span class="meta-dot">&middot;</span>
                    <span>${a.readTime} min read</span>
                    <span class="meta-dot">&middot;</span>
                    <span>${a.date}</span>
                  </div>
                </div>
              </article>`;
  }

  /* Appends the next batch and relabels the button. Bound once per render from
     renderStories; the cards carry no listeners of their own, so inserting
     markup is enough. */
  function bindLoadMore(state) {
    const button = document.getElementById("load-more-stories");
    if (!button) return;
    button.addEventListener("click", () => {
      const grid = document.querySelector(".stories-grid");
      if (!grid) return;
      const next = state.articles.slice(state.shown, state.shown + STORIES_BATCH);
      grid.insertAdjacentHTML("beforeend", next.map(storyCard).join(""));
      state.shown += next.length;

      const left = state.articles.length - state.shown;
      if (left <= 0) {
        button.remove();
        return;
      }
      button.textContent = `Load more stories (${left} remaining)`;
    });
  }

  async function renderStories() {
    // Canonicalises to /blog whether the visitor typed /blog or /stories.
    seoPage("blog");
    showLoading("Loading stories...");
    try {
      const res = await fetch("/api/articles");
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const articles = data.articles.map(a => ({
        id: a.id, slug: a.slug, title: a.title, excerpt: cardExcerpt(a),
        author: { id: a.author_id, name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        category: a.category_name || "General", categorySlug: a.category_slug,
        image: a.cover_image || DEFAULT_COVER, bannerAlt: a.banner_alt || "",
        featured: Boolean(a.is_featured), date: formatDate(a.published_at || a.created_at),
        readTime: readMins(a.content, a.body_format)
      }));

      const first = articles.slice(0, STORIES_BATCH);
      const remaining = articles.length - first.length;
      const state = { articles, shown: first.length };

      renderApp(`
        <div class="page-container">
          <div class="page-header">
            <h1 class="page-title">Stories</h1>
            <p class="page-subtitle">Discover stories from developers, engineers, and technologists</p>
          </div>
          <div class="stories-grid">
            ${articles.length ? first.map(storyCard).join("") : `<div class="empty-state"><p class="empty-state-title">No stories published yet.</p><p class="empty-state-subtitle">Be the first to write one!</p></div>`}
          </div>
          ${remaining > 0 ? `
          <div class="load-more-wrap">
            <button class="btn btn-outline" id="load-more-stories" type="button">Load more stories (${remaining} remaining)</button>
          </div>` : ""}
        </div>
      `);

      if (remaining > 0) bindLoadMore(state);
    } catch (e) {
      showError("Failed to load stories.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Article gallery                                                     */
  /* ------------------------------------------------------------------ */
  // Photos embedded in a story body. Every one is a Creative Commons file, so
  // each tile carries its creator and licence back to the source page.
  const LICENSE_NAMES = {
    by: "CC BY",
    "by-sa": "CC BY-SA",
    "by-nd": "CC BY-ND",
    "by-nc": "CC BY-NC",
    "by-nc-sa": "CC BY-NC-SA",
    "by-nc-nd": "CC BY-NC-ND",
    cc0: "CC0",
    pdm: "Public Domain",
  };

  function licenseLabel(license) {
    if (!license) return "";
    return LICENSE_NAMES[license.toLowerCase()] || license.toUpperCase();
  }

  function renderGalleryItem(img, index) {
    const alt = img.alt_text || img.title || "Article photograph";
    const credit = [
      img.creator ? `Photo: ${escapeHtml(img.creator)}` : "",
      img.license ? licenseLabel(img.license) : "",
    ].filter(Boolean).join(" &middot; ");

    const sourceLink = img.source
      ? `<a href="${escapeHtml(img.source)}" target="_blank" rel="noopener noreferrer nofollow">source</a>`
      : "";

    return `
      <figure class="gallery-item">
        <button class="gallery-open" type="button" data-gallery-index="${index}"
                aria-label="View ${escapeHtml(alt)}">
          <img src="${escapeHtml(img.file_path)}" alt="${escapeHtml(alt)}" loading="lazy">
        </button>
        <figcaption>
          <span class="gallery-caption">${escapeHtml(img.title || alt)}</span>
          <span class="gallery-credit">${credit}${sourceLink ? " &middot; " + sourceLink : ""}</span>
        </figcaption>
      </figure>
    `;
  }

  function renderGallery(images) {
    if (!images || !images.length) return "";
    return `
      <section class="article-gallery">
        <h2 class="gallery-heading">From the story</h2>
        <div class="gallery-grid">${images.map(renderGalleryItem).join("")}</div>
      </section>
      <div class="gallery-lightbox" id="gallery-lightbox" hidden>
        <button class="gallery-lightbox-close" type="button" aria-label="Close">&times;</button>
        <button class="gallery-lightbox-nav gallery-lightbox-prev" type="button" aria-label="Previous">&#8249;</button>
        <figure class="gallery-lightbox-figure">
          <img id="gallery-lightbox-img" src="" alt="">
          <figcaption id="gallery-lightbox-caption"></figcaption>
        </figure>
        <button class="gallery-lightbox-nav gallery-lightbox-next" type="button" aria-label="Next">&#8250;</button>
      </div>
    `;
  }

  let galleryLightboxState = null;

  /**
   * "Sources & references" for a published story.
   *
   * Only http(s) links are made clickable — the server validates them on the
   * way in, and this is the last check before one reaches the DOM. A licence
   * or an attribution line that was never set stays absent rather than being
   * filled in with a guess.
   */
  function renderSources(sources) {
    if (!sources || !sources.length) return "";

    const items = sources.map(source => {
      const url = typeof source.source_url === "string" && /^https?:\/\//i.test(source.source_url)
        ? source.source_url
        : "";

      const label = escapeHtml(source.source_name || "Untitled source");
      const link = url
        ? `<a class="article-source-link" href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>`
        : `<span class="article-source-link">${label}</span>`;

      const meta = [
        source.license ? `<span class="article-source-license">${escapeHtml(source.license)}</span>` : "",
        source.attribution_text ? `<span class="article-source-attribution">${escapeHtml(source.attribution_text)}</span>` : ""
      ].filter(Boolean).join("");

      return `<li class="article-source">${link}${meta}</li>`;
    }).join("");

    return `
      <section class="article-sources" aria-labelledby="article-sources-heading">
        <h2 class="article-sources-heading" id="article-sources-heading">Sources &amp; references</h2>
        <ul class="article-sources-list">${items}</ul>
      </section>
    `;
  }

  function bindGallery(root, images) {
    const lightbox = $("#gallery-lightbox", root);
    const tiles = $$("[data-gallery-index]", root);
    if (!lightbox || !tiles.length || !images.length) return;

    const img = $("#gallery-lightbox-img", lightbox);
    const caption = $("#gallery-lightbox-caption", lightbox);

    const state = { images, index: 0, dispose: null };

    const show = index => {
      const total = state.images.length;
      const wrapped = ((index % total) + total) % total;
      const item = state.images[wrapped];
      state.index = wrapped;
      img.src = item.file_path;
      img.alt = item.alt_text || item.title || "Article photograph";
      const bits = [
        item.title || "",
        item.creator ? `Photo: ${item.creator}` : "",
        item.license ? licenseLabel(item.license) : "",
        `${wrapped + 1} of ${total}`,
      ].filter(Boolean);
      caption.textContent = bits.join(" · ");
    };

    state.open = i => {
      lightbox.hidden = false;
      document.body.classList.add("gallery-open");
      show(i);
    };
    state.close = () => {
      lightbox.hidden = true;
      document.body.classList.remove("gallery-open");
      img.src = "";
    };
    state.step = delta => show(state.index + delta);

    galleryLightboxState = state;

    tiles.forEach(tile => {
      tile.addEventListener("click", () => {
        state.open(parseInt(tile.dataset.galleryIndex, 10) || 0);
      });
    });

    $(".gallery-lightbox-close", lightbox).addEventListener("click", state.close);
    $(".gallery-lightbox-prev", lightbox).addEventListener("click", () => state.step(-1));
    $(".gallery-lightbox-next", lightbox).addEventListener("click", () => state.step(1));
    lightbox.addEventListener("click", e => { if (e.target === lightbox) state.close(); });

    const onKey = e => {
      if (lightbox.hidden) return;
      if (e.key === "Escape") state.close();
      if (e.key === "ArrowLeft") state.step(-1);
      if (e.key === "ArrowRight") state.step(1);
    };
    document.addEventListener("keydown", onKey);
    // The page re-renders on every navigation, so drop the stale key handler.
    state.dispose = () => document.removeEventListener("keydown", onKey);
  }

  /* ------------------------------------------------------------------ */
  /* Story Detail Page                                                  */
  /* ------------------------------------------------------------------ */
  async function renderStoryDetail(params, context) {
    if (galleryLightboxState && galleryLightboxState.dispose) {
      galleryLightboxState.dispose();
      galleryLightboxState = null;
    }

    // Canonical form is /blog/<slug>. The numeric /stories/<id> URL still
    // resolves, then upgrades itself in the address bar so only one URL per
    // story is ever indexable.
    const legacyId = params && params.id && !params.slug ? params.id : null;

    let endpoint;
    if (params && params.slug) {
      endpoint = `/api/articles/slug/${encodeURIComponent(params.slug)}`;
    } else if (legacyId) {
      endpoint = `/api/articles/${encodeURIComponent(legacyId)}`;
    } else {
      showError("Story not found.");
      return;
    }

    showLoading("Loading story...");
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error("Not found");
      const a = await res.json();

      if (a.slug && params.slug !== a.slug) {
        window.history.replaceState({}, "", articlePath(a));
      }

      const galleryRes = await fetch(`/api/articles/${a.id}/images`).catch(() => null);
      const galleryImages = galleryRes && galleryRes.ok ? ((await galleryRes.json()).images || []) : [];

      // Citations are optional and never worth blocking the article on: a failed
      // sources request simply renders the page without the section.
      const sourcesRes = await fetch(`/api/articles/${a.id}/sources`).catch(() => null);
      const sourcesList = sourcesRes && sourcesRes.ok ? ((await sourcesRes.json()).sources || []) : [];

      // Monetization extras (sponsored badge, affiliate links, direct-ad opt-out).
      // Optional in the same way: a failure only means no badge, no links and
      // the site-wide ad default.
      const monetPayload = await Monetization.article(a.id, a.slug);
      const articleAdsEnabled = monetPayload ? monetPayload.ads_enabled !== false : true;

      const article = {
        id: a.id, slug: a.slug, title: a.title, content: a.content,
        bodyFormat: a.body_format === "html" ? "html" : "text",
        metaDescription: a.meta_description || "",
        bannerAlt: a.banner_alt || "",
        author: { id: a.author_id, name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR, bio: a.author_bio || "" },
        category: a.category_name || "General", categorySlug: a.category_slug,
        image: a.cover_image || DEFAULT_COVER,
        date: formatDate(a.published_at || a.created_at), readTime: readMins(a.content, a.body_format)
      };

      // Related stories from the same topic, newest first. Fetched after the
      // main render so a slow side request never delays the article itself.
      let related = [];
      if (article.categorySlug) {
        try {
          const relRes = await fetch(`/api/articles?category=${encodeURIComponent(article.categorySlug)}`);
          if (relRes.ok) {
            const relData = await relRes.json();
            related = relData.articles
              .filter(r => r.id !== article.id)
              .slice(0, 3)
              .map(r => ({
                id: r.id, slug: r.slug, title: r.title,
                excerpt: cardExcerpt(r, 120),
                category: r.category_name || "General", categorySlug: r.category_slug,
                image: r.cover_image || DEFAULT_COVER, bannerAlt: r.banner_alt || "",
                date: formatDate(r.published_at || r.created_at)
              }));
          }
        } catch { /* related stories are optional */ }
      }

      const crumbs = [
        { name: "Home", path: "/" },
        { name: "Stories", path: "/stories" },
        { name: article.category, path: article.categorySlug ? `/category/${article.categorySlug}` : "/stories" },
        { name: article.title, path: articlePath(article) }
      ];

      if (SEO) {
        SEO.applyArticle(
          {
            slug: article.slug,
            title: article.title,
            cover_image: article.image,
            banner_alt: article.bannerAlt,
            category_name: article.category,
            category_slug: article.categorySlug,
            published_at: a.published_at || a.created_at,
            updated_at: a.updated_at,
            word_count: bodyText(article.content, article.bodyFormat).trim().split(/\s+/).filter(Boolean).length
          },
          {
            // articleDescription already prefers meta_description; seo.js applies
            // the same preference, so this stays consistent either way.
            excerpt: articleDescription({
              meta_description: article.metaDescription,
              content: article.content,
              body_format: article.bodyFormat
            }),
            breadcrumb: crumbs
          }
        );
      }

      renderApp(`
        <article class="article-detail">
          <nav class="breadcrumbs" aria-label="Breadcrumb">
            <ol class="breadcrumbs-list">
              ${crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return `<li class="breadcrumbs-item">${
                  last
                    ? `<span aria-current="page">${escapeHtml(c.name)}</span>`
                    : `<a href="${c.path}">${escapeHtml(c.name)}</a><span class="breadcrumbs-sep" aria-hidden="true">/</span>`
                }</li>`;
              }).join("")}
            </ol>
          </nav>
          <div class="article-detail-header">
            <span class="article-detail-category">${article.category}</span>
            <h1 class="article-detail-title">${article.title}</h1>
            <div class="article-detail-meta">
              <img class="avatar avatar-sm" src="${article.author.avatar}" alt="${article.author.name}" width="32" height="32" decoding="async">
              <div>
                <span class="meta-author">${article.author.name}</span>
                <span class="article-detail-date">${article.date} &middot; ${article.readTime} min read</span>
              </div>
            </div>
          </div>
          ${AdSlot.placeholder("before-article")}
          ${articleAdsEnabled ? Monetization.placeholder("article_top") : ""}
          ${article.image ? `<img class="article-detail-cover" src="${article.image}" alt="${escapeHtml(article.bannerAlt || article.title)}" width="1200" height="675" fetchpriority="high" decoding="async">` : ""}
          <div class="article-detail-content">${renderArticleContent(
            article.content,
            article.bodyFormat,
            [
              AdSlot.inArticle("in-article", articleBlockCount(article.content, article.bodyFormat), {
                contentPosition: AdSlot.positionOf("in-article")
              }),
              articleAdsEnabled ? { position: 35, markup: Monetization.placeholder("article_middle") } : null
            ].filter(Boolean)
          )}</div>
          ${articleAdsEnabled ? Monetization.placeholder("article_bottom") : ""}
          ${AdSlot.placeholder("after-article")}
          ${renderGallery(galleryImages)}
          ${renderSources(sourcesList)}
          <div class="article-detail-footer">
            <div class="article-actions">
              <button class="btn btn-outline like-btn" data-id="${article.id}">&#9825; Like</button>
              <button class="btn btn-outline">&#9993; Share</button>
            </div>
          </div>
          ${related.length ? `
          <section class="related-section">
            <h2 class="related-heading">More in ${escapeHtml(article.category)}</h2>
            <div class="related-grid">
              ${related.map(r => `
                <article class="related-card">
                  ${r.image ? `<a class="related-media" href="${articlePath(r)}" aria-label="${escapeHtml(r.title)}"><img src="${r.image}" alt="${escapeHtml(r.bannerAlt || r.title)}" loading="lazy" decoding="async" width="400" height="300"></a>` : ""}
                  <div class="related-body">
                    <span class="related-category">${escapeHtml(r.category)}</span>
                    <h3 class="related-title"><a href="${articlePath(r)}">${escapeHtml(r.title)}</a></h3>
                    <p class="related-excerpt">${r.excerpt}</p>
                    <p class="related-date">${r.date}</p>
                  </div>
                </article>
              `).join("")}
            </div>
          </section>` : ""}
          <section class="comments-section">
            <h3 class="comments-heading">Comments</h3>
            <div class="comments-empty"><p>No comments yet.</p><p>Be the first to start the conversation.</p></div>
          </section>
        </article>
      `);

      if (galleryImages.length) {
        bindGallery(document.getElementById("app"), galleryImages);
      }
      AdSlot.hydrate($("#app"));
      // Sponsored badge, affiliate links and any article direct ads.
      Monetization.renderArticleExtras($("#app"), monetPayload);
    } catch (e) {
      showError("Story not found.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Guest Posts Page                                                   */
  /* ------------------------------------------------------------------ */
  async function renderGuestPosts() {
    // A submission explainer rather than a content page: it repeats the newest
    // stories, so it stays out of the index and out of the sitemap.
    seoNoindex("/guest-posts", "Submit a Guest Post | KaliNova");
    showLoading("Loading guest posts...");
    try {
      const res = await fetch("/api/articles");
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const posts = data.articles.slice(0, 6).map(a => ({
        id: a.id, slug: a.slug, title: a.title, excerpt: cardExcerpt(a, 150),
        author: { name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        date: formatDate(a.published_at || a.created_at),
        status: a.status || "published"
      }));

      renderApp(`
        <div class="page-container">
          <div class="page-header">
            <h1 class="page-title">Guest Posts</h1>
            <p class="page-subtitle">Submit your story to be featured on KaliNova</p>
            ${isLoggedIn() ? `<button class="btn btn-primary" onclick="document.dispatchEvent(new CustomEvent('open-guest-post'))">Submit Guest Post</button>` : ""}
          </div>
          <div class="guest-posts-info">
            <div class="info-card">
              <h3>Write</h3>
              <p>Create compelling content for the KaliNova community</p>
            </div>
            <div class="info-card">
              <h3>Submit</h3>
              <p>Your post goes through a review process</p>
            </div>
            <div class="info-card">
              <h3>Publish</h3>
              <p>Once approved, your post goes live</p>
            </div>
          </div>
          <div class="guest-posts-list">
            ${posts.map(p => `
              <article class="guest-post-card">
                <div class="guest-post-status status-${p.status}">${p.status}</div>
                <h3 class="guest-post-title"><a href="${articlePath(p)}">${escapeHtml(p.title)}</a></h3>
                <p class="guest-post-excerpt">${p.excerpt}</p>
                <div class="guest-post-meta">
                  <img class="avatar avatar-xs" src="${p.author.avatar}" alt="${p.author.name}" width="24" height="24" loading="lazy" decoding="async">
                  <span class="meta-author">${p.author.name}</span>
                  <span class="meta-dot">&middot;</span>
                  <span>${p.date}</span>
                </div>
              </article>
            `).join("")}
          </div>
        </div>
      `);
    } catch (e) {
      showError("Failed to load guest posts.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* News Page                                                          */
  /* ------------------------------------------------------------------ */
  async function renderNews() {
    seoPage("news");
    showLoading("Loading news...");
    try {
      const res = await fetch("/api/articles");
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const articles = data.articles.slice(0, 8).map(a => ({
        id: a.id, slug: a.slug, title: a.title, excerpt: cardExcerpt(a),
        author: { name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        category: a.category_name || "General", categorySlug: a.category_slug,
        image: a.cover_image || DEFAULT_COVER, bannerAlt: a.banner_alt || "",
        date: formatDate(a.published_at || a.created_at), readTime: readMins(a.content, a.body_format)
      }));

      renderApp(`
        <div class="page-container">
          <div class="page-header">
            <h1 class="page-title">News</h1>
            <p class="page-subtitle">Stay updated with the latest in tech, devops, and development</p>
          </div>
          <div class="news-grid">
            ${articles.map(a => `
              <article class="news-card">
                <a class="news-card-media" href="${articlePath(a)}" aria-label="${escapeHtml(a.title)}"><img src="${a.image}" alt="${escapeHtml(a.bannerAlt || a.title)}" loading="lazy" decoding="async" width="400" height="300"></a>
                <div class="news-card-body">
                  <span class="news-card-date">${a.date}</span>
                  <h3 class="news-card-title"><a href="${articlePath(a)}">${escapeHtml(a.title)}</a></h3>
                  <p class="news-card-excerpt">${a.excerpt}</p>
                  <div class="news-card-meta">
                    <img class="avatar avatar-xxs" src="${a.author.avatar}" alt="${a.author.name}" width="20" height="20" loading="lazy" decoding="async">
                    <span class="meta-author">${a.author.name}</span>
                    <span class="meta-dot">&middot;</span>
                    <span>${a.readTime} min read</span>
                  </div>
                </div>
              </article>
            `).join("")}
          </div>
        </div>
      `);

      // Reviewed RSS headline strip. Optional decoration: it appends itself
      // below the grid when the endpoint answers, and is never rendered at
      // all when it does not, so this page cannot fail because of it.
      if (window.KaliNovaOpenData) window.KaliNovaOpenData.hydrateNewsHeadlines();
    } catch (e) {
      showError("Failed to load news.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Category Page                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The topic switcher shown on a topic page.
   *
   * Every topic is listed, not just the one being read, so a reader can move
   * sideways between subjects from anywhere on the site. The current topic is
   * marked with is-active and aria-current, and the list is built from
   * /api/categories, so adding a topic in the admin makes it appear here with
   * no frontend change.
   *
   * This replaces the old "← All stories" back link, which only ever pointed at
   * the listing and gave no way to reach a different topic.
   */
  function renderTopicSwitcher(categories, activeSlug) {
    if (!categories || !categories.length) return "";

    const chips = categories
      .map(topic => {
        const isActive = topic.slug === activeSlug;
        return `<li>
            <a class="topic-chip${isActive ? " is-active" : ""}"
               href="/category/${encodeURIComponent(topic.slug)}"${isActive ? ' aria-current="page"' : ""}>${escapeHtml(topic.name)}</a>
          </li>`;
      })
      .join("\n          ");

    return `<nav class="topic-switcher" aria-label="All topics">
        <h2 class="topic-switcher-heading">Browse by topic</h2>
        <ul>
          ${chips}
        </ul>
      </nav>`;
  }

  async function renderCategory(params) {
    const slug = params && params.slug;
    if (!slug) return renderHome();

    showLoading("Loading stories...");
    try {
      const [catRes, artRes] = await Promise.all([
        fetch("/api/categories"),
        fetch(`/api/articles?category=${encodeURIComponent(slug)}`)
      ]);
      if (!artRes.ok) throw new Error("API error");

      const catData = catRes.ok ? await catRes.json() : { categories: [] };
      const cat = catData.categories.find(c => c.slug === slug);
      if (!cat) {
        if (SEO) {
          SEO.applyPage("search", {
            path: `/category/${slug}`,
            title: "Topic not found | KaliNova",
            description: "This topic does not exist on KaliNova.",
            noindex: true
          });
        }
        return renderApp(`
          <div class="page-container">
            <div class="empty-state">
              <p class="empty-state-title">This category doesn't exist.</p>
              <a class="btn btn-primary" href="/">Back to home</a>
            </div>
          </div>
        `);
      }

      const data = await artRes.json();
      const articles = data.articles.map(a => ({
        id: a.id, slug: a.slug, title: a.title, excerpt: cardExcerpt(a),
        author: { name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        category: a.category_name || "General", categorySlug: a.category_slug,
        image: a.cover_image || DEFAULT_COVER, bannerAlt: a.banner_alt || "",
        date: formatDate(a.published_at || a.created_at), readTime: readMins(a.content, a.body_format)
      }));

      if (SEO) SEO.applyCategory(cat, articles.length);

      const crumbs = [
        { name: "Home", path: "/" },
        { name: "Stories", path: "/stories" },
        { name: cat.name, path: `/category/${cat.slug}` }
      ];

      renderApp(`
        <div class="page-container">
          <nav class="breadcrumbs" aria-label="Breadcrumb">
            <ol class="breadcrumbs-list">
              <li class="breadcrumbs-item"><a href="/">Home</a><span class="breadcrumbs-sep" aria-hidden="true">/</span></li>
              <li class="breadcrumbs-item"><a href="/stories">Stories</a><span class="breadcrumbs-sep" aria-hidden="true">/</span></li>
              <li class="breadcrumbs-item"><span aria-current="page">${escapeHtml(cat.name)}</span></li>
            </ol>
          </nav>
          <div class="page-header">
            <h1 class="page-title">${escapeHtml(cat.name)}</h1>
            ${cat.description ? `<p class="page-subtitle">${escapeHtml(cat.description)}</p>` : ""}
          </div>
          ${Monetization.placeholder("category_top")}
          ${renderTopicSwitcher(catData.categories, cat.slug)}
          ${articles.length ? `
            <div class="news-grid">
              ${articles.map(a => `
                <article class="news-card">
                  <a class="news-card-media" href="${articlePath(a)}" aria-label="${escapeHtml(a.title)}"><img src="${a.image}" alt="${escapeHtml(a.bannerAlt || a.title)}" loading="lazy" decoding="async" width="400" height="300"></a>
                  <div class="news-card-body">
                    <span class="news-card-date">${a.date}</span>
                    <h3 class="news-card-title"><a href="${articlePath(a)}">${escapeHtml(a.title)}</a></h3>
                    <p class="news-card-excerpt">${a.excerpt}</p>
                    <div class="news-card-meta">
                      <img class="avatar avatar-xxs" src="${a.author.avatar}" alt="${a.author.name}" width="20" height="20" loading="lazy" decoding="async">
                      <span class="meta-author">${a.author.name}</span>
                      <span class="meta-dot">&middot;</span>
                      <span>${a.readTime} min read</span>
                    </div>
                  </div>
                </article>
              `).join("")}
            </div>
          ` : `
            <div class="empty-state">
              <p class="empty-state-title">Nothing here yet.</p>
              <p>No stories in ${escapeHtml(cat.name)} so far.</p>
            </div>
          `}
        </div>
      `);

      // The destination map is a Travel-only decoration: configured
      // destinations, coordinates geocoded once by the server, and a
      // vendored Leaflet map. Silent when the open-data component or its
      // endpoint is unavailable.
      if (slug === "travel" && window.KaliNovaOpenData) {
        window.KaliNovaOpenData.hydrateTravelMap();
      }
      Monetization.hydrate($("#app"));
    } catch (e) {
      showError("Failed to load this category.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tag & author archives                                              */
  /* ------------------------------------------------------------------ */

  function archiveArticleCard(a) {
    return {
      id: a.id,
      slug: a.slug,
      title: a.title,
      excerpt: cardExcerpt(a),
      author: { name: a.author_username || "KaliNova", avatar: a.author_avatar || DEFAULT_AVATAR },
      category: a.category_name || "General",
      categorySlug: a.category_slug,
      image: a.cover_image || DEFAULT_COVER,
      bannerAlt: a.banner_alt || "",
      date: formatDate(a.published_at || a.created_at),
      readTime: readMins(a.content, a.body_format)
    };
  }

  function renderArchiveGrid(articles, emptyLabel) {
    if (!articles.length) {
      return `<div class="empty-state">
          <p class="empty-state-title">Nothing here yet.</p>
          <p>${escapeHtml(emptyLabel)}</p>
        </div>`;
    }
    return `<div class="news-grid">
      ${articles.map(a => `
        <article class="news-card">
          <a class="news-card-media" href="${articlePath(a)}" aria-label="${escapeHtml(a.title)}"><img src="${a.image}" alt="${escapeHtml(a.bannerAlt || a.title)}" loading="lazy" decoding="async" width="400" height="300"></a>
          <div class="news-card-body">
            <span class="news-card-date">${a.date}</span>
            <h3 class="news-card-title"><a href="${articlePath(a)}">${escapeHtml(a.title)}</a></h3>
            <p class="news-card-excerpt">${a.excerpt}</p>
            <div class="news-card-meta">
              <img class="avatar avatar-xxs" src="${a.author.avatar}" alt="${escapeHtml(a.author.name)}" width="20" height="20" loading="lazy" decoding="async">
              <span class="meta-author">${escapeHtml(a.author.name)}</span>
              <span class="meta-dot">&middot;</span>
              <span>${a.readTime} min read</span>
            </div>
          </div>
        </article>
      `).join("")}
    </div>`;
  }

  function renderArchiveShell({ heading, subtitle, articles, emptyLabel }) {
    renderApp(`
      <div class="page-container">
        <nav class="breadcrumbs" aria-label="Breadcrumb">
          <ol class="breadcrumbs-list">
            <li class="breadcrumbs-item"><a href="/">Home</a><span class="breadcrumbs-sep" aria-hidden="true">/</span></li>
            <li class="breadcrumbs-item"><a href="/stories">Stories</a><span class="breadcrumbs-sep" aria-hidden="true">/</span></li>
            <li class="breadcrumbs-item"><span aria-current="page">${escapeHtml(heading)}</span></li>
          </ol>
        </nav>
        <div class="page-header">
          <h1 class="page-title">${escapeHtml(heading)}</h1>
          ${subtitle ? `<p class="page-subtitle">${escapeHtml(subtitle)}</p>` : ""}
        </div>
        ${Monetization.placeholder("category_top")}
        ${renderArchiveGrid(articles, emptyLabel)}
      </div>
    `);
  }

  async function renderTag(params) {
    const slug = params && params.slug;
    if (!slug) return renderHome();

    showLoading("Loading stories...");
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(slug)}`);
      if (res.status === 404) {
        if (SEO) {
          SEO.applyPage("search", {
            path: `/tag/${slug}`,
            title: "Tag not found | KaliNova",
            description: "This tag does not exist on KaliNova.",
            noindex: true
          });
        }
        return renderApp(`
          <div class="page-container">
            <div class="empty-state">
              <p class="empty-state-title">This tag doesn't exist.</p>
              <a class="btn btn-primary" href="/">Back to home</a>
            </div>
          </div>
        `);
      }
      if (!res.ok) throw new Error("API error");

      const data = await res.json();
      const articles = (data.articles || []).map(archiveArticleCard);
      if (SEO) SEO.applyTag(data.tag, articles.length);

      renderArchiveShell({
        heading: data.tag.name,
        subtitle: data.tag.description || "",
        articles,
        emptyLabel: `No stories tagged ${data.tag.name} so far.`
      });
      Monetization.hydrate($("#app"));
    } catch (e) {
      showError("Failed to load this tag.");
    }
  }

  async function renderAuthor(params) {
    const slug = params && params.slug;
    if (!slug) return renderHome();

    showLoading("Loading stories...");
    try {
      const res = await fetch(`/api/authors/${encodeURIComponent(slug)}`);
      if (res.status === 404) {
        if (SEO) {
          SEO.applyPage("search", {
            path: `/author/${slug}`,
            title: "Author not found | KaliNova",
            description: "This author does not exist on KaliNova.",
            noindex: true
          });
        }
        return renderApp(`
          <div class="page-container">
            <div class="empty-state">
              <p class="empty-state-title">This author doesn't exist.</p>
              <a class="btn btn-primary" href="/">Back to home</a>
            </div>
          </div>
        `);
      }
      if (!res.ok) throw new Error("API error");

      const data = await res.json();
      const articles = (data.articles || []).map(archiveArticleCard);
      if (SEO) SEO.applyAuthor(data.author, articles.length);

      renderArchiveShell({
        heading: data.author.username,
        subtitle: data.author.bio || "",
        articles,
        emptyLabel: `No stories by ${data.author.username} yet.`
      });
      Monetization.hydrate($("#app"));
    } catch (e) {
      showError("Failed to load this author.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Portfolio Page                                                     */
  /* ------------------------------------------------------------------ */
  function renderPortfolio() {
    seoNoindex("/portfolio", "Portfolio | KaliNova");

    renderApp(`
      <div class="page-container">
        <div class="page-header">
          <h1 class="page-title">My Portfolio</h1>
          <p class="page-subtitle">Build and manage your professional portfolio</p>
        </div>
        <div class="portfolio-builder">
          <div class="portfolio-builder-sidebar">
            <h3>Sections</h3>
            <ul class="portfolio-sections-list">
              <li class="active">About</li>
              <li>Skills</li>
              <li>Experience</li>
              <li>Education</li>
              <li>Projects</li>
              <li>Certifications</li>
              <li>Stories</li>
              <li>Guest Posts</li>
              <li>Social Links</li>
              <li>Contact</li>
            </ul>
            <button class="btn btn-primary" style="margin-top:16px;width:100%">Publish Portfolio</button>
          </div>
          <div class="portfolio-builder-main">
            <div class="portfolio-preview-card">
              <img class="portfolio-avatar-lg" src="${DEFAULT_AVATAR}" alt="Profile">
              <h2 class="portfolio-name">Your Name</h2>
              <p class="portfolio-headline">Professional Headline</p>
              <p class="portfolio-about">Write about yourself and your professional journey...</p>
              <div class="portfolio-stats">
                <span><strong>0</strong> Stories</span>
                <span><strong>0</strong> Projects</span>
                <span><strong>0</strong> Followers</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Marketplace Page                                                   */
  /* ------------------------------------------------------------------ */
  function renderMarketplace() {
    seoNoindex("/marketplace", "Marketplace | KaliNova");
    renderApp(`
      <div class="page-container">
        <div class="page-header">
          <h1 class="page-title">Marketplace</h1>
          <p class="page-subtitle">Discover products and services from the KaliNova community</p>
          ${isLoggedIn() ? `<button class="btn btn-primary" onclick="document.dispatchEvent(new CustomEvent('open-create-listing'))">Create Listing</button>` : ""}
        </div>
        <div class="marketplace-filters">
          <button class="btn btn-outline filter-btn active" data-filter="all">All</button>
          <button class="btn btn-outline filter-btn" data-filter="products">Products</button>
          <button class="btn btn-outline filter-btn" data-filter="services">Services</button>
          <button class="btn btn-outline filter-btn" data-filter="digital">Digital</button>
        </div>
        <div class="marketplace-grid">
          <div class="marketplace-empty">
            <div class="empty-state">
              <p class="empty-state-title">No listings yet</p>
              <p class="empty-state-subtitle">Be the first to create a product or service listing</p>
              ${isLoggedIn() ? `<button class="btn btn-primary" style="margin-top:16px">Create Your First Listing</button>` : ""}
            </div>
          </div>
        </div>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* CV Page                                                            */
  /* ------------------------------------------------------------------ */
  function renderCV() {
    seoNoindex("/cv", "CV | KaliNova");

    renderApp(`
      <div class="page-container">
        <div class="page-header">
          <h1 class="page-title">My CV</h1>
          <p class="page-subtitle">Build and manage your professional CV</p>
        </div>
        <div class="cv-builder">
          <div class="cv-section">
            <h3>Summary</h3>
            <textarea class="cv-textarea" placeholder="Write a professional summary..."></textarea>
          </div>
          <div class="cv-section">
            <h3>Skills</h3>
            <div class="cv-skills-input">
              <input type="text" class="cv-input" placeholder="Add a skill...">
              <button class="btn btn-outline">Add</button>
            </div>
            <div class="cv-tags" id="cv-skills-tags"></div>
          </div>
          <div class="cv-section">
            <h3>Experience</h3>
            <div class="cv-entry">
              <input type="text" class="cv-input" placeholder="Job Title">
              <input type="text" class="cv-input" placeholder="Company">
              <input type="text" class="cv-input" placeholder="Duration (e.g., Jan 2020 - Present)">
              <textarea class="cv-textarea" placeholder="Description..."></textarea>
            </div>
            <button class="btn btn-outline" style="margin-top:12px">+ Add Experience</button>
          </div>
          <div class="cv-section">
            <h3>Education</h3>
            <div class="cv-entry">
              <input type="text" class="cv-input" placeholder="Degree">
              <input type="text" class="cv-input" placeholder="Institution">
              <input type="text" class="cv-input" placeholder="Year">
            </div>
            <button class="btn btn-outline" style="margin-top:12px">+ Add Education</button>
          </div>
          <div class="cv-section">
            <h3>Projects</h3>
            <div class="cv-entry">
              <input type="text" class="cv-input" placeholder="Project Name">
              <textarea class="cv-textarea" placeholder="Description..."></textarea>
            </div>
            <button class="btn btn-outline" style="margin-top:12px">+ Add Project</button>
          </div>
          <button class="btn btn-primary" style="margin-top:24px">Save CV</button>
        </div>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Search Page                                                        */
  /* ------------------------------------------------------------------ */
  function renderSearch() {
    // Works for both /search?q= and the legacy #/search?q= form.
    const q = Router.getQuery().get("q") || "";
    seoNoindex("/search", q ? `Search results for "${q}" | KaliNova` : "Search — KaliNova");
    renderApp(`
      <div class="page-container">
        <div class="page-header">
          <h1 class="page-title">Search</h1>
          <form class="search-page-form" id="search-page-form" role="search" action="/search" method="get">
            <input type="search" class="search-page-input" id="search-page-input" name="q" placeholder="Search articles, authors, topics, products..." value="${escapeHtml(q)}" aria-label="Search KaliNova">
            <button type="submit" class="btn btn-primary">Search</button>
          </form>
        </div>
        <div class="search-page-results" id="search-page-results" aria-live="polite">
          ${q ? `<p class="search-page-hint">Searching for "${escapeHtml(q)}"...</p>` : `<p class="search-page-hint">Enter a search term to find stories, authors, and more.</p>`}
        </div>
      </div>
    `);

    if (q) performSearch(q);

    const form = document.getElementById("search-page-form");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const val = document.getElementById("search-page-input").value.trim();
        if (val) {
          // Keep ?q= in the address bar so a search can be shared and reloaded.
          Router.navigate(`/search?q=${encodeURIComponent(val)}`);
          performSearch(val);
        }
      });
    }
  }

  async function performSearch(query) {
    const results = document.getElementById("search-page-results");
    if (!results) return;
    results.innerHTML = `<p class="search-page-hint">Searching for "${escapeHtml(query)}"...</p>`;
    try {
      const res = await fetch(`/api/articles?search=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const articles = data.articles.map(a => ({
id: a.id, slug: a.slug, title: a.title, excerpt: cardExcerpt(a),
        author: { id: a.author_id, name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        category: a.category_name || "General", categorySlug: a.category_slug,
        image: a.cover_image || DEFAULT_COVER, bannerAlt: a.banner_alt || "",
        featured: Boolean(a.is_featured), date: formatDate(a.published_at || a.created_at),
        readTime: readMins(a.content, a.body_format)
      }));

      if (articles.length === 0) {
        results.innerHTML = `<div class="empty-state"><p class="empty-state-title">No results found</p><p class="empty-state-subtitle">Try a different search term</p></div>`;
        return;
      }

      results.innerHTML = `
        <p class="search-page-count">${articles.length} result${articles.length !== 1 ? "s" : ""} found</p>
        <div class="article-list">
          ${articles.map(a => articleRow(a)).join("")}
        </div>
      `;
    } catch (e) {
      results.innerHTML = `<div class="empty-state"><p class="empty-state-title">Search is unavailable right now.</p></div>`;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Dashboard Page (static preview)                                    */
  /* ------------------------------------------------------------------ */
  // The public SPA has no accounts, so this page is a static preview rather
  // than a signed-in view. The real, authenticated dashboard lives at
  // /admin/dashboard and is not linked from here.
  function renderDashboard() {
    seoNoindex("/dashboard", "Dashboard | KaliNova");

    renderApp(`
      <div class="page-container">
        <div class="page-header">
          <h1 class="page-title">Welcome back, Creator!</h1>
          <p class="page-subtitle">Here's an overview of your KaliNova activity</p>
        </div>
        <div class="dashboard-stats">
          <div class="stat-card"><span class="stat-number">0</span><span class="stat-label">Stories</span></div>
          <div class="stat-card"><span class="stat-number">0</span><span class="stat-label">Guest Posts</span></div>
          <div class="stat-card"><span class="stat-number">0</span><span class="stat-label">Followers</span></div>
          <div class="stat-card"><span class="stat-number">0</span><span class="stat-label">Portfolio</span></div>
          <div class="stat-card"><span class="stat-number">0</span><span class="stat-label">Listings</span></div>
        </div>
        <div class="dashboard-actions">
          <h2 class="dashboard-actions-title">Quick Actions</h2>
          <div class="dashboard-actions-grid">
            <button class="dashboard-action-btn" onclick="Router.navigate('/portfolio')">
              <span class="action-icon">&#128196;</span>
              <span>Create Portfolio</span>
            </button>
            <button class="dashboard-action-btn" onclick="Router.navigate('/marketplace')">
              <span class="action-icon">&#128722;</span>
              <span>Add Product</span>
            </button>
            <button class="dashboard-action-btn" onclick="Router.navigate('/marketplace')">
              <span class="action-icon">&#128188;</span>
              <span>Add Service</span>
            </button>
            <button class="dashboard-action-btn" onclick="Router.navigate('/cv')">
              <span class="action-icon">&#128196;</span>
              <span>Edit CV</span>
            </button>
            <button class="dashboard-action-btn" onclick="Router.navigate('/settings')">
              <span class="action-icon">&#9881;</span>
              <span>Settings</span>
            </button>
          </div>
        </div>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Profile Page                                                       */
  /* ------------------------------------------------------------------ */
  function renderProfile(params) {
    seoNoindex(`/profile/${params && params.id ? params.id : ""}`, "Profile | KaliNova");
    renderApp(`
      <div class="page-container">
        <div class="profile-page">
          <div class="profile-header">
            <img class="profile-avatar" src="${DEFAULT_AVATAR}" alt="Profile">
            <div class="profile-info">
              <h1 class="profile-name">User Profile</h1>
              <p class="profile-headline">Developer & Creator</p>
              <p class="profile-about">Building amazing things with code.</p>
              <div class="profile-stats">
                <span><strong>0</strong> Followers</span>
                <span><strong>0</strong> Following</span>
                <span><strong>0</strong> Stories</span>
              </div>
              ${isLoggedIn() ? `<button class="btn btn-primary follow-btn">Follow</button>` : ""}
            </div>
          </div>
          <div class="profile-tabs">
            <button class="profile-tab active">Stories</button>
            <button class="profile-tab">Guest Posts</button>
            <button class="profile-tab">Portfolio</button>
            <button class="profile-tab">Marketplace</button>
          </div>
          <div class="profile-content">
            <div class="empty-state">
              <p class="empty-state-title">No stories yet</p>
              <p class="empty-state-subtitle">This user hasn't published any stories.</p>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Settings Page                                                      */
  /* ------------------------------------------------------------------ */
  function renderSettings() {
    seoNoindex("/settings", "Settings | KaliNova");

    // No accounts exist on the public site, so these fields are always empty:
    // the administrator's real settings belong in /admin.
    const user = {};

    renderApp(`
      <div class="page-container">
        <div class="page-header">
          <h1 class="page-title">Settings</h1>
        </div>
        <div class="settings-form">
          <div class="settings-section">
            <h3>Profile</h3>
            <div class="modal-field">
              <label>Username</label>
              <input type="text" value="${user.username || ""}" class="settings-input">
            </div>
            <div class="modal-field">
              <label>Email</label>
              <input type="email" value="${user.email || ""}" class="settings-input">
            </div>
            <div class="modal-field">
              <label>Professional Headline</label>
              <input type="text" placeholder="e.g., Full-Stack Developer & DevOps Engineer" class="settings-input">
            </div>
            <div class="modal-field">
              <label>Bio</label>
              <textarea class="settings-textarea" placeholder="Tell us about yourself..."></textarea>
            </div>
          </div>
          <button class="btn btn-primary">Save Changes</button>
        </div>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Guest Post Submit Modal                                            */
  /* ------------------------------------------------------------------ */
  function renderGuestPostModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "guest-post-modal";
    overlay.innerHTML = `
      <div class="modal modal-wide" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h2>Submit Guest Post</h2>
          <button type="button" class="icon-btn modal-close" onclick="this.closest('.modal-overlay').remove()" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <form id="guest-post-form" novalidate>
          <div class="modal-field">
            <label for="gp-title">Title</label>
            <input type="text" id="gp-title" required>
          </div>
          <div class="modal-field">
            <label for="gp-category">Category</label>
            <select id="gp-category"></select>
          </div>
          <div class="modal-field">
            <label for="gp-content">Content</label>
            <textarea id="gp-content" rows="12" required></textarea>
          </div>
          <p class="modal-error" id="gp-error" hidden></p>
          <div class="modal-actions">
            <button type="submit" class="btn btn-primary">Submit for Review</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  }

  /* ------------------------------------------------------------------ */
  /* Create Listing Modal                                               */
  /* ------------------------------------------------------------------ */
  function renderCreateListingModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "listing-modal";
    overlay.innerHTML = `
      <div class="modal modal-wide" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h2>Create Marketplace Listing</h2>
          <button type="button" class="icon-btn modal-close" onclick="this.closest('.modal-overlay').remove()" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <form id="listing-form" novalidate>
          <div class="modal-field">
            <label>Type</label>
            <select id="listing-type">
              <option value="product">Product</option>
              <option value="service">Service</option>
            </select>
          </div>
          <div class="modal-field">
            <label for="listing-title">Title</label>
            <input type="text" id="listing-title" required>
          </div>
          <div class="modal-field">
            <label for="listing-desc">Description</label>
            <textarea id="listing-desc" rows="6" required></textarea>
          </div>
          <div class="modal-field">
            <label for="listing-price">Price (INR)</label>
            <input type="number" id="listing-price" min="0" required>
          </div>
          <p class="modal-error" id="listing-error" hidden></p>
          <div class="modal-actions">
            <button type="submit" class="btn btn-primary">Save as Draft</button>
            <button type="button" class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  }

  /* ------------------------------------------------------------------ */
  /* About Us — founder story                                           */
  /* ------------------------------------------------------------------ */

  // Monogram avatar. Inline SVG rather than a photo file, so the page has
  // no external image dependency.
  const FOUNDER_MONOGRAM = `
    <svg class="founder-avatar-svg" viewBox="0 0 96 96" role="img" aria-label="Soumyadip Sasmal">
      <defs>
        <linearGradient id="founderGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#7c3aed"/>
          <stop offset="100%" stop-color="#db2777"/>
        </linearGradient>
      </defs>
      <circle cx="48" cy="48" r="48" fill="url(#founderGrad)"/>
      <text x="48" y="48" text-anchor="middle" dominant-baseline="central"
            font-family="var(--font-display), Georgia, serif" font-size="36"
            font-weight="600" fill="#ffffff" letter-spacing="1">SS</text>
    </svg>`;

  const ABOUT_SECTIONS = [
    {
      heading: "About the Founder",
      body: `Soumyadip Sasmal — Founder & Entrepreneur, KaliNova

Every journey begins somewhere.

Sometimes it begins with a dream. Sometimes with a problem that needs to be solved. And sometimes, it begins with a simple desire to create something of your own.

For Soumyadip Sasmal, the journey toward entrepreneurship began with curiosity, ambition, and a strong desire to build a future on his own terms.

Today, he is the founder of KaliNova, a company created from his vision of building something meaningful, independent, and capable of growing beyond a single idea.

KaliNova is not simply a company for Soumyadip. It represents a journey — a journey of learning, experimentation, persistence, responsibility, and the belief that a small idea can eventually become something much larger.`
    },
    {
      heading: "The Person Behind KaliNova",
      body: `Soumyadip's story is not one of overnight success.

It is a story of gradually discovering what he wanted from life and having the courage to pursue it.

Like many young people beginning their careers, he started by focusing on education and developing himself professionally. Along the way, he realized that having a career was only one part of the future he wanted.

He also wanted to create.

He wanted to build something that belonged to him.

He wanted to make decisions, take responsibility, explore ideas, create opportunities, and eventually build something that could provide value to other people.

That desire became one of the driving forces behind KaliNova.

For Soumyadip, entrepreneurship is not about having a perfect plan from day one. It is about being willing to start with what you have, learn what you don't know, and improve as you move forward.`
    },
    {
      heading: "From Dream to Direction",
      body: `There is a difference between having a dream and turning that dream into a direction.

A dream is something you imagine.

A direction is something you start working toward.

Soumyadip chose to turn his ambition into action.

Instead of waiting until everything was perfect, he began exploring ideas, understanding business, learning from experiences, and thinking about what kind of company he wanted to build.

This process was not always easy.

Starting something of your own comes with uncertainty.

There are questions that do not always have immediate answers.

Will people believe in the idea? Will customers come? Will the business grow? What happens when something goes wrong? How do you compete? How do you build trust? How do you keep going when progress is slower than expected?

Entrepreneurship requires facing these questions without always knowing the answers.

Soumyadip believes that this uncertainty is not something to be afraid of. It is part of the process of building something new.`
    },
    {
      heading: "Why KaliNova?",
      body: `KaliNova was created from the desire to build something with a long-term vision.

The idea behind KaliNova is bigger than a single product or service.

It is about creating a company that can grow, adapt, explore new opportunities, and eventually become something meaningful.

The world is changing quickly. People's needs are changing. Businesses are changing. New opportunities are appearing every day.

Soumyadip wants KaliNova to be capable of growing with those changes.

Rather than defining the company by one narrow idea, he sees KaliNova as a foundation from which new ideas can be developed.

The journey may take different directions over time, but the underlying purpose remains the same:

To create value, explore opportunities, solve meaningful problems, and build something people can trust.`
    },
    {
      heading: "Entrepreneurship as a Journey",
      body: `For Soumyadip, entrepreneurship is not a title.

It is a responsibility.

Calling yourself a founder is easy. Building a company is not.

A founder has to make decisions even when there is uncertainty. A founder has to accept responsibility when things do not go according to plan. A founder has to listen, learn, adapt, and continue moving forward.

There are days when everything feels possible.

There are also days when progress feels difficult.

Both are part of the journey.

Soumyadip believes that successful entrepreneurship is built through consistency rather than temporary motivation.

A person may feel motivated today and discouraged tomorrow.

But a business cannot depend only on motivation.

It needs discipline. It needs patience. It needs continuous effort. It needs the ability to keep working even when results take time.

This is the mindset he wants to bring to KaliNova.`
    },
    {
      heading: "Learning From Every Experience",
      body: `One of the most important lessons Soumyadip has learned is that every experience has something to teach.

Success teaches you what works.

Failure teaches you what needs to change.

Difficult situations teach you patience.

Working with people teaches you communication.

Taking responsibility teaches you maturity.

And starting a business teaches you that there is always more to learn.

Soumyadip does not believe that a person needs to know everything before starting a company.

In fact, he believes the opposite.

You start with what you know. You identify what you don't know. Then you learn.

You ask questions. You make mistakes. You improve.

And you continue.

This philosophy has become an important part of his approach to entrepreneurship.`
    },
    {
      heading: "The Importance of Taking Risks",
      body: `Every meaningful opportunity involves some level of risk.

Choosing to start a company is itself a risk.

There is no guaranteed path. There is no certainty that an idea will immediately succeed.

But there is also a risk in never trying.

Soumyadip believes that calculated risks are an important part of growth.

Taking a risk does not mean acting without thinking.

It means understanding the possibilities, accepting uncertainty, preparing as much as possible, and having the courage to take the next step.

KaliNova is the result of taking that step.`
    },
    {
      heading: "Building Something of His Own",
      body: `One of the strongest motivations behind KaliNova is independence.

Soumyadip wanted to create something where his ideas could become real.

A place where he could experiment.

A company where new ideas could be explored.

An organization that could eventually create opportunities for other people.

Building something of your own creates a different kind of responsibility.

When you work for someone else, the company already has its identity, systems, customers, and direction.

When you build your own company, you have to help create those things.

That challenge is difficult, but it is also what makes entrepreneurship meaningful.

Every decision becomes part of the company's story.

Every customer relationship becomes part of its reputation.

Every mistake becomes a lesson.

Every achievement becomes part of the foundation for the future.`
    },
    {
      heading: "The Values Behind KaliNova",
      body: `Soumyadip believes that a company should be built around more than money.

Business growth is important. Revenue is important. Sustainability is important.

But a company also needs values.

For KaliNova, some of the most important values are honesty, responsibility, learning, creativity, persistence, and respect.

Honesty

Trust takes a long time to build and can be lost quickly.

Soumyadip believes that businesses should communicate honestly with their customers and partners.

Promises should be realistic. Expectations should be clear. And when a problem occurs, it should be addressed rather than ignored.

Responsibility

When you build something, you have to take ownership of it.

Soumyadip believes in accepting responsibility for both successes and mistakes.

If something goes wrong, the goal should not simply be to find someone to blame.

The goal should be to understand what happened and determine how it can be improved.

Learning

No entrepreneur knows everything.

Markets change. Customers change. Business conditions change. New opportunities appear.

Continuous learning is therefore essential.

KaliNova is built with the idea that learning should never stop.

Creativity

New ideas often come from looking at familiar problems differently.

Soumyadip believes in giving ideas room to grow and encouraging creative thinking.

Not every idea will become a successful business.

But every idea can teach you something.

Persistence

Building a company takes time.

There will be setbacks. There will be uncertainty. There will be moments of doubt.

Persistence means continuing to work while learning from those experiences.`
    },
    {
      heading: "A Founder With a Long-Term Vision",
      body: `Soumyadip does not see KaliNova as something that should be built only for today.

He thinks about where the company could be years from now.

The goal is to create a business that can evolve.

A company that can enter new areas. A company that can develop new ideas. A company that can create employment and opportunities. A company that can build strong relationships with customers and partners.

And ultimately, a company that can stand on its own identity.

This long-term perspective is important because entrepreneurship is not only about the first year.

It is about creating a foundation strong enough for the years that follow.`
    },
    {
      heading: "More Than One Idea",
      body: `KaliNova is intentionally open to possibilities.

The company may begin with one direction, but that does not mean its future has to remain limited to it.

Businesses evolve. Ideas change. Markets develop. New opportunities appear.

Soumyadip wants KaliNova to have the flexibility to explore those opportunities.

This does not mean chasing every trend.

It means remaining open-minded while staying focused on creating genuine value.

The company's future will be shaped by experience, customer needs, new opportunities, and the lessons learned along the way.`
    },
    {
      heading: "Creating Opportunities for Others",
      body: `An important part of Soumyadip's long-term vision is that KaliNova should eventually become more than a founder-led business.

He wants to build something where other people can participate in the journey.

As the company grows, there can be opportunities for employees, collaborators, creators, professionals, and future entrepreneurs.

Creating opportunities for others is one of the ways a company can create a lasting impact.

For Soumyadip, building a company is therefore not only about creating a career for himself.

It is about eventually creating a platform where other people can also grow.`
    },
    {
      heading: "What Success Means to Soumyadip",
      body: `Everyone has a different definition of success.

For Soumyadip, success is not simply about becoming wealthy or having a large company.

Those may be outcomes of successful business growth, but they are not the only things that matter.

Success means creating something that people value.

It means earning the trust of customers.

It means being able to create opportunities for others.

It means building a team.

It means overcoming challenges.

It means learning from failure.

And it means being proud of how the company was built.

He believes that the way a company grows is just as important as how much it grows.`
    },
    {
      heading: "The Reality of Building From the Beginning",
      body: `KaliNova is being built from the ground up.

That means the journey is still in its early stages.

There is no illusion that everything is already established.

There is still work to do. There are still ideas to test. There are still customers to reach. There are still processes to build. There are still lessons to learn.

But that is what makes the journey exciting.

Every company that becomes successful starts somewhere.

The important thing is to begin.`
    },
    {
      heading: "Looking Toward the Future",
      body: `Soumyadip's vision for the future is ambitious, but it is also grounded in patience.

He wants KaliNova to grow naturally through strong work, good relationships, useful ideas, and consistent improvement.

He wants to build a company that can adapt to changing times without losing its core identity.

He wants KaliNova to be recognized not only for what it creates, but also for how it treats people.

Customers should feel respected.

Partners should feel valued.

Employees should have opportunities to grow.

And everyone connected with the company should understand that they are contributing to something that is being built for the long term.`
    },
    {
      heading: "The Story Is Still Being Written",
      body: `Perhaps the most important thing about Soumyadip's entrepreneurial journey is that it is still being written.

There is no final chapter yet.

The company is young.

The ideas will continue to evolve.

The challenges will continue.

The opportunities will continue.

And Soumyadip intends to continue learning through all of it.

The journey from having an idea to building a company is rarely straightforward.

It involves uncertainty, patience, mistakes, unexpected opportunities, and countless small decisions.

But every step contributes to the bigger picture.

KaliNova represents that bigger picture for Soumyadip.

It represents the decision to stop only imagining what could be built and start actually building it.`
    },
    {
      heading: "A Message From the Founder",
      quote: `KaliNova is more than a business idea for me. It is the beginning of something I want to build with my own vision, values, and effort. I know that building a company takes time, and I know there will be challenges along the way. I don't expect everything to happen overnight. My goal is to keep learning, keep improving, and keep moving forward. I want KaliNova to become a company that creates real value, builds trust, provides opportunities, and continues to grow with purpose. This is only the beginning, and I am excited about what we can build together.`,
      signature: "Soumyadip Sasmal"
    },
    {
      heading: "The Beginning of KaliNova",
      body: `Every great journey has a beginning.

For KaliNova, that beginning is today.

It started with one person's willingness to dream beyond a traditional career.

It continued with the courage to take the first step.

And it will grow through hard work, learning, relationships, ideas, and the people who become part of the journey.

Soumyadip's goal is not simply to say that he founded a company.

His goal is to build one.

Step by step. Idea by idea. Challenge by challenge. And opportunity by opportunity.

KaliNova is the company he chose to build.

The journey has started.

The future is still being written.`
    }
  ];

  // Renders one block of the founder story. Bodies are written as plain text
  // with blank lines between paragraphs, so they go through escapeHtml.
  function renderAboutBlock(block) {
    let html = `<h2>${escapeHtml(block.heading)}</h2>`;

    if (block.quote) {
      html += `<blockquote class="about-quote"><p>${escapeHtml(block.quote)}</p>`;
      if (block.signature) {
        html += `<cite class="about-signature">${escapeHtml(block.signature)}<br>Founder &amp; Entrepreneur, KaliNova</cite>`;
      }
      html += `</blockquote>`;
    }

    if (block.body) {
      html += String(block.body)
        .split(/\n{2,}/)
        .map(para => `<p>${escapeHtml(para.trim()).replace(/\n/g, "<br>")}</p>`)
        .join("");
    }

    const slug = block.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `<section class="about-block" id="about-block-${slug}">${html}</section>`;
  }

  function renderAbout() {
    // The founder is named and titled on this page, which is what makes a
    // Person node here accurate. No dates or social profiles are added,
    // because the site does not publish any.
    seoPage("about", {
      breadcrumb: [
        { name: "Home", path: "/" },
        { name: "About", path: "/about" }
      ],
      extraSchema: [
        {
          "@type": "Person",
          "@id": "https://kalinova.in/about#founder",
          name: "Soumyadip Sasmal",
          jobTitle: "Founder & Entrepreneur",
          worksFor: { "@id": "https://kalinova.in/#organization" },
          description:
            "Soumyadip Sasmal is the founder of KaliNova, an independent " +
            "publishing platform covering cinema, fashion, news, wildlife and travel."
        }
      ]
    });

    renderApp(`
      <div class="about-page">
        <header class="about-hero">
          <div class="about-hero-avatar">${FOUNDER_MONOGRAM}</div>
          <div class="about-hero-text">
            <span class="page-title-label">Our Story</span>
            <h1 class="about-hero-title">About Us</h1>
            <p class="about-hero-role">Soumyadip Sasmal — Founder &amp; Entrepreneur, KaliNova</p>
            <p class="about-hero-tagline">Every journey begins somewhere.</p>
            <a href="/stories" class="btn btn-primary">Read Our Stories</a>
          </div>
        </header>

        <nav class="about-toc" aria-label="On this page">
          ${ABOUT_SECTIONS.map(s => `<a href="#about-block-${escapeHtml(s.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">${escapeHtml(s.heading)}</a>`).join("")}
        </nav>

        <div class="about-body">
          ${ABOUT_SECTIONS.map(renderAboutBlock).join("")}
        </div>
      </div>
    `);

    // The table-of-contents links are same-page anchors. Rewrite them to plain
    // ids so the hash router does not treat them as routes.
    $$(".about-toc a", $(".about-page")).forEach(link => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const id = link.getAttribute("href").slice(1);
        const target = document.getElementById(id);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Careers                                                            */
  /* ------------------------------------------------------------------ */
  function renderCareers() {
    seoPage("careers", {
      breadcrumb: [
        { name: "Home", path: "/" },
        { name: "Careers", path: "/careers" }
      ]
    });

    renderApp(`
      <div class="page-container">
        <header class="page-header">
          <h1 class="page-title">Careers</h1>
          <p class="page-subtitle">Join us in building something meaningful.</p>
        </header>
        <div class="about-body">
          <section class="about-block">
            <h2>We're just getting started</h2>
            <p>KaliNova is growing. We care about curiosity, ownership, and building things that solve real problems.</p>
            <p>If you're passionate about writing, design, or engineering and want to help shape the future of KaliNova, we'd love to hear from you.</p>
            <p>Send a brief note with your interests to <a href="mailto:soumyadipsasmal88@gmail.com">soumyadipsasmal88@gmail.com</a>.</p>
          </section>
        </div>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Services                                                           */
  /* ------------------------------------------------------------------ */
  // Every item below describes something the site actually does or already
  // offers. Nothing is invented, and no pricing or delivery claims are made.
  const SERVICES = [
    {
      title: "Long-form stories across eight topics",
      body: "KaliNova publishes in-depth writing on Bollywood, Tollywood, Fashion, Latest News, Wildlife, Travel, Lifestyle and Kids. Each story is written to be read rather than skimmed, and stays on the site under a permanent URL."
    },
    {
      title: "Topic pages that collect related writing",
      body: "Every story is filed under a topic, and each topic has its own page. That makes it easy to follow one subject over time instead of hunting through a feed."
    },
    {
      title: "Photo essays inside every story",
      body: "Stories can carry an in-article photo essay alongside the text. Each image is credited to its creator and shown with its licence, so the photography is part of the reading experience rather than an afterthought."
    },
    {
      title: "Publish from the browser",
      body: "Writing is done in the browser and published straight away. There is no account to create and no separate CMS to learn, so a story goes from draft to published without leaving the site."
    },
    {
      title: "Search across everything",
      body: "The search page looks through story titles and bodies at once, so a specific article can be found by a keyword, a name or a phrase from the text."
    },
    {
      title: "Guest posts and contributions",
      body: "Readers and writers can submit a guest post. Submissions go through a review process before they are published, which is how outside writing gets onto KaliNova."
    }
  ];

  function renderServices() {
    seoPage("services", {
      breadcrumb: [
        { name: "Home", path: "/" },
        { name: "Services", path: "/services" }
      ]
    });

    renderApp(`
      <div class="page-container">
        <header class="page-header">
          <h1 class="page-title">What KaliNova Offers</h1>
          <p class="page-subtitle">Read. Write. Share. Everything KaliNova does, in one place.</p>
        </header>
        <div class="services-grid">
          ${SERVICES.map(s => `
            <article class="service-card">
              <h2 class="service-title">${escapeHtml(s.title)}</h2>
              <p class="service-body">${escapeHtml(s.body)}</p>
            </article>
          `).join("")}
        </div>
        <section class="services-cta">
          <h2 class="services-cta-title">Want to write for KaliNova?</h2>
          <p class="services-cta-body">Guest posts are welcome. Send a brief note and it will be reviewed before publication.</p>
          <p class="services-cta-links">
            <a class="btn btn-primary" href="/guest-posts">Submit a Guest Post</a>
            <a class="btn btn-outline" href="/contact">Get in touch</a>
          </p>
        </section>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Contact                                                            */
  /* ------------------------------------------------------------------ */
  function renderContact() {
    seoPage("contact", {
      breadcrumb: [
        { name: "Home", path: "/" },
        { name: "Contact", path: "/contact" }
      ]
    });

    renderApp(`
      <div class="page-container">
        <header class="page-header">
          <h1 class="page-title">Contact KaliNova</h1>
          <p class="page-subtitle">Questions, corrections, guest posts or anything else — these are the best ways to reach us.</p>
        </header>
        <div class="contact-grid">
          <article class="contact-card">
            <h2 class="contact-title">Email</h2>
            <p class="contact-body">For stories, corrections and guest post enquiries, email is the fastest way to reach the editor.</p>
            <p class="contact-value"><a href="mailto:soumyadipsasmal88@gmail.com">soumyadipsasmal88@gmail.com</a></p>
            <p class="contact-value"><a href="mailto:soumyadipsasmal10@gmail.com">soumyadipsasmal10@gmail.com</a></p>
          </article>
          <article class="contact-card">
            <h2 class="contact-title">Phone</h2>
            <p class="contact-body">For anything urgent, or if a message does not get a reply by email.</p>
            <p class="contact-value"><a href="tel:+916290687215">+91 6290687215</a></p>
          </article>
          <article class="contact-card">
            <h2 class="contact-title">Contribute</h2>
            <p class="contact-body">Writers can submit a guest post. Every submission is reviewed before it is published.</p>
            <p class="contact-value"><a href="/guest-posts">Submit a Guest Post</a></p>
          </article>
        </div>
        <p class="contact-note">Corrections are welcome and are handled by the founder, Soumyadip Sasmal. Include the story title and the passage you are querying so it can be checked quickly.</p>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Privacy policy                                                    */
  /* ------------------------------------------------------------------ */
  // Written to describe what the site actually does today, and to say plainly
  // that advertising is not running. When ads are switched on in /admin/ads,
  // this page has to be revisited before going live: the cookie and
  // advertising sections have to describe the network that is actually being
  // used. It deliberately does not name a provider that is not in use.
  function renderPrivacy() {
    seoPage("privacy", {
      breadcrumb: [
        { name: "Home", path: "/" },
        { name: "Privacy Policy", path: "/privacy" }
      ]
    });

    renderApp(`
      <div class="page-container">
        <header class="page-header">
          <h1 class="page-title">Privacy Policy</h1>
          <p class="page-subtitle">Last updated 5 October 2026</p>
        </header>

        <div class="contact-grid">
          <article class="contact-card">
            <h2 class="contact-title">What KaliNova collects today</h2>
            <p class="contact-body">
              This site has no reader accounts and no sign-up. Reading stories, browsing
              topics and using the search box do not require you to identify yourself.
            </p>
            <p class="contact-body">
              If you email us, submit a guest post or get in touch through the contact
              page, we keep what you send us so we can reply. We do not sell it.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">Cookies and advertising</h2>
            <p class="contact-body">
              <strong>KaliNova does not run advertising at present.</strong> No ad network
              script is requested, and no third-party cookies are set for advertising.
            </p>
            <p class="contact-body">
              If advertising is introduced, this section will be updated first to name
              the provider, describe the cookies it uses, and link to its own privacy
              policy. A consent choice will be shown before any ad data is requested,
              and declining will leave advertising switched off.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">Server logs</h2>
            <p class="contact-body">
              The web server keeps standard request logs such as IP address, timestamp
              and the page requested. These are used to keep the site running and to
              detect abuse, and they are not used to build a profile of you.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">Third-party content</h2>
            <p class="contact-body">
              Photographs in stories are Creative Commons files credited to their
              creators, with a link to the source. Opening a credit link takes you to
              another site, which has its own privacy policy.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">Your choices</h2>
            <p class="contact-body">
              You can ask what information we hold about you, ask for it to be
              corrected, or ask for it to be deleted. Email
              <a href="mailto:soumyadipsasmal88@gmail.com">soumyadipsasmal88@gmail.com</a>
              and we will deal with the request.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">Changes</h2>
            <p class="contact-body">
              If this policy changes, the date at the top changes with it. Material
              changes will be noted here rather than made silently.
            </p>
          </article>
        </div>

        <p class="contact-note">
          Questions about this policy can go to
          <a href="mailto:soumyadipsasmal88@gmail.com">soumyadipsasmal88@gmail.com</a>.
        </p>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Terms of use                                                       */
  /* ------------------------------------------------------------------ */
  function renderTerms() {
    seoPage("terms", {
      breadcrumb: [
        { name: "Home", path: "/" },
        { name: "Terms of Use", path: "/terms" }
      ]
    });

    renderApp(`
      <div class="page-container">
        <header class="page-header">
          <h1 class="page-title">Terms of Use</h1>
          <p class="page-subtitle">Last updated 5 October 2026</p>
        </header>

        <div class="contact-grid">
          <article class="contact-card">
            <h2 class="contact-title">The content on this site</h2>
            <p class="contact-body">
              Stories published on KaliNova are written for readers to read. They may be
              quoted with a link back and a clear attribution. Republishing a whole
              article, or passing it off as your own, is not permitted.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">Guest posts</h2>
            <p class="contact-body">
              Submissions are reviewed before publication. Publishing a guest post does
              not transfer copyright: the writer keeps it, and grants permission to
              publish it here.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">Accuracy</h2>
            <p class="contact-body">
              We try to keep stories accurate and will correct errors when they are
              pointed out. Nothing here is professional advice, and nothing here is
              an offer or a recommendation to buy or sell anything.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">External links</h2>
            <p class="contact-body">
              Links to other sites are included because they are useful, not because we
              control them. We are not responsible for what is on another site.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">Advertising</h2>
            <p class="contact-body">
              KaliNova does not run advertising at present. If it does in future, labelled
              ad placements will be shown, they will be kept visually distinct from
              editorial content, and the <a href="/privacy">privacy policy</a> will
              describe the arrangement before it starts.
            </p>
          </article>

          <article class="contact-card">
            <h2 class="contact-title">Liability</h2>
            <p class="contact-body">
              The site is provided as it is. We are not liable for decisions you make on
              the basis of anything published here, or for any loss arising from use of
              the site.
            </p>
          </article>
        </div>

        <p class="contact-note">
          Questions about these terms can go to
          <a href="mailto:soumyadipsasmal88@gmail.com">soumyadipsasmal88@gmail.com</a>.
        </p>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Not found                                                          */
  /* ------------------------------------------------------------------ */
  function render404(path) {
    seoPage("search", {
      path: path || "/404",
      title: "Page not found | KaliNova",
      description: "That page does not exist on KaliNova. Browse the latest stories instead.",
      noindex: true
    });

    renderApp(`
      <div class="page-container">
        <div class="empty-state">
          <p class="empty-state-title">That page could not be found.</p>
          <p class="empty-state-subtitle">The link may be out of date, or the page may have moved.</p>
          <p class="page-not-found-links">
            <a class="btn btn-primary" href="/">Back to home</a>
            <a class="btn btn-outline" href="/stories">Browse all stories</a>
            <a class="btn btn-outline" href="/search">Search</a>
          </p>
        </div>
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Register all routes                                                */
  /* ------------------------------------------------------------------ */
  window.KaliNovaPages = {
    renderHome, renderStories, renderStoryDetail, renderGuestPosts,
    renderNews, renderPortfolio, renderMarketplace, renderCV, renderSearch,
    renderDashboard, renderProfile, renderSettings, renderCategory, renderAbout,
    renderCareers, renderServices, renderContact, renderPrivacy, renderTerms, render404,
    renderGuestPostModal, renderCreateListingModal
  };

  // Canonical, indexable routes.
  Router.register("/", renderHome);
  // /blog is the blog listing. /stories is the older name for the same page and
  // is still linked from older markup, so both render the listing; /blog is the
  // one that gets indexed (see the `stories` entry in seo.js).
  Router.register("/blog", renderStories);
  Router.register("/stories", renderStories);
  Router.register("/news", renderNews);
  Router.register("/category/:slug", renderCategory);
  Router.register("/tag/:slug", renderTag);
  Router.register("/author/:slug", renderAuthor);
  Router.register("/about", renderAbout);
  Router.register("/services", renderServices);
  Router.register("/contact", renderContact);
  Router.register("/careers", renderCareers);
  // Legal pages. Linked from the footer and from the sidebar signup copy, so they
  // have to be real routes rather than 404s.
  Router.register("/privacy", renderPrivacy);
  Router.register("/terms", renderTerms);

  // Article detail. /blog/<slug> is canonical; /stories/<id> is the legacy
  // numeric form and redirects itself to the slug.
  Router.register("/blog/:slug", renderStoryDetail);
  Router.register("/stories/:id", renderStoryDetail);

  // Tool and account views — noindex, not in the sitemap.
  Router.register("/guest-posts", renderGuestPosts);
  Router.register("/search", renderSearch);
  Router.register("/portfolio", renderPortfolio);
  Router.register("/marketplace", renderMarketplace);
  Router.register("/cv", renderCV);
  Router.register("/dashboard", renderDashboard);
  Router.register("/profile/:id", renderProfile);
  Router.register("/settings", renderSettings);

  Router.onNotFound(render404);
})();
