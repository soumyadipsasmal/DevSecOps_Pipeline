/**
 * KaliNova — Page Components
 * Each function renders a full page into the #app container.
 */
(() => {
  "use strict";

  const DEFAULT_AVATAR = "https://i.pravatar.cc/64?img=12";
  const DEFAULT_COVER = "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=60";

  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  // There are no user accounts. The site author owns the profile, dashboard
  // and settings views, so those always render without a signed-in check.
  function isLoggedIn() { return true; }

  function renderApp(content) {
    const app = $("#app");
    if (app) {
      app.innerHTML = content;
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

  function readMins(content) {
    return Math.max(1, Math.ceil(content.trim().split(/\s+/).length / 200));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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
          return `<h2>${escapeHtml(heading[1].trim())}</h2>`;
        }
        return `<p>${lines.map(l => escapeHtml(l)).join("<br>")}</p>`;
      })
      .filter(Boolean)
      .join("");
  }

  function makeExcerpt(content, max = 200) {
    const text = String(content || "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= max) return escapeHtml(text);
    const clipped = text.slice(0, max);
    const cut = clipped.lastIndexOf(" ");
    return escapeHtml((cut > 0 ? clipped.slice(0, cut) : clipped).replace(/[,;:.]$/, "")) + "…";
  }

  /* ------------------------------------------------------------------ */
  /* Home / For You                                                     */
  /* ------------------------------------------------------------------ */
  async function renderHome() {
    showLoading("Loading stories...");
    try {
      const [artRes, catRes] = await Promise.all([
        fetch("/api/articles"),
        fetch("/api/categories")
      ]);
      if (!artRes.ok || !catRes.ok) throw new Error("API error");
      const artData = await artRes.json();
      const catData = await catRes.json();

      const articles = artData.articles.map(a => ({
        id: a.id, title: a.title, excerpt: makeExcerpt(a.content),
        author: { id: a.author_id, name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        category: a.category_name || "General", image: a.cover_image || DEFAULT_COVER,
        featured: Boolean(a.is_featured), date: formatDate(a.published_at || a.created_at),
        readTime: readMins(a.content)
      }));

      const featured = articles.filter(a => a.featured).slice(0, 2);
      const recommended = articles.filter(a => !a.featured).slice(0, 3);
      const latest = articles.filter(a => !a.featured).slice(3);

      const trending = articles.filter(a => a.featured).slice(0, 5);

      renderApp(`
        <div class="layout">
          <div class="feed">
            <section class="feed-section">
              <h2 class="feed-heading">Featured stories</h2>
              <div class="featured-grid">
                ${featured.length ? featured.map(a => `
                  <article class="card card-featured">
                    <a class="card-media" href="#/stories/${a.id}"><img class="card-img" src="${a.image}" alt="${a.title}"></a>
                    <div class="card-body">
                      <p class="card-eyebrow">${a.category}</p>
                      <h3 class="card-title"><a href="#/stories/${a.id}">${a.title}</a></h3>
                      <p class="card-desc">${a.excerpt}</p>
                      <div class="card-meta">
                        <img class="avatar avatar-xs" src="${a.author.avatar}" alt="${a.author.name}">
                        <span class="meta-author">${a.author.name}</span>
                        <span class="meta-dot">&middot;</span>
                        <span class="meta-read">${a.readTime} min read</span>
                        <span class="meta-dot">&middot;</span>
                        <span class="meta-date">${a.date}</span>
                      </div>
                    </div>
                  </article>
                `).join("") : `<div class="empty-state"><p class="empty-state-title">No featured stories yet.</p><p class="empty-state-subtitle">Check back soon.</p></div>`}
              </div>
            </section>

            <section class="feed-section">
              <h2 class="feed-heading">Recommended for you</h2>
              <div class="article-list">
                ${recommended.length ? recommended.map(a => articleRow(a)).join("") : `<div class="empty-state"><p class="empty-state-title">Nothing to recommend yet.</p></div>`}
              </div>
            </section>

            <section class="feed-section">
              <h2 class="feed-heading">Latest stories</h2>
              <div class="article-list">
                ${latest.length ? latest.map(a => articleRow(a)).join("") : `<div class="empty-state"><p class="empty-state-title">No stories have been published yet.</p><p class="empty-state-subtitle">Be the first to write one.</p></div>`}
              </div>
            </section>
          </div>

          <aside class="sidebar">
            <section class="side-card">
              <h2 class="side-heading">Trending on KaliNova</h2>
              <ol class="trending-list">
                ${trending.map((a, i) => `
                  <li class="trending-item">
                    <span class="trending-rank">${String(i + 1).padStart(2, "0")}</span>
                    <div class="trending-content">
                      <div class="trending-author-row">
                        <img class="avatar avatar-xxs" src="${a.author.avatar}" alt="${a.author.name}">
                        <span class="meta-author">${a.author.name}</span>
                      </div>
                      <h4 class="trending-title"><a href="#/stories/${a.id}">${a.title}</a></h4>
                    </div>
                  </li>
                `).join("")}
              </ol>
            </section>
            <p class="side-footnote">KaliNova &copy; 2026 &middot; Built for developers, by developers.</p>
          </aside>
        </div>
      `);
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
            <img class="avatar avatar-xs" src="${a.author.avatar}" alt="${a.author.name}">
            <span class="meta-author">${a.author.name}</span>
            <span class="meta-dot">&middot;</span>
            <span class="meta-date">${a.date}</span>
          </div>
          <h3 class="card-title"><a href="#/stories/${a.id}">${a.title}</a></h3>
          <p class="card-desc">${a.excerpt}</p>
          <div class="card-footer">
            <p class="card-eyebrow">${a.category}</p>
            <span class="meta-dot">&middot;</span>
            <span class="meta-read">${a.readTime} min read</span>
          </div>
        </div>
        <a class="card-media card-media-side" href="#/stories/${a.id}"><img class="card-img" src="${a.image}" alt="${a.title}"></a>
      </article>`;
  }

  /* ------------------------------------------------------------------ */
  /* Stories Page                                                       */
  /* ------------------------------------------------------------------ */
  async function renderStories() {
    showLoading("Loading stories...");
    try {
      const res = await fetch("/api/articles");
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const articles = data.articles.map(a => ({
        id: a.id, title: a.title, excerpt: makeExcerpt(a.content),
        author: { id: a.author_id, name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        category: a.category_name || "General", image: a.cover_image || DEFAULT_COVER,
        featured: Boolean(a.is_featured), date: formatDate(a.published_at || a.created_at),
        readTime: readMins(a.content)
      }));

      renderApp(`
        <div class="page-container">
          <div class="page-header">
            <h1 class="page-title">Stories</h1>
            <p class="page-subtitle">Discover stories from developers, engineers, and technologists</p>
            ${isLoggedIn() ? `<button class="btn btn-primary" onclick="document.dispatchEvent(new CustomEvent('open-write'))">Write a Story</button>` : ""}
          </div>
          <div class="stories-grid">
            ${articles.length ? articles.map(a => `
              <article class="story-card">
                <a class="story-card-media" href="#/stories/${a.id}"><img src="${a.image}" alt="${a.title}"></a>
                <div class="story-card-body">
                  <span class="story-card-category">${a.category}</span>
                  <h3 class="story-card-title"><a href="#/stories/${a.id}">${a.title}</a></h3>
                  <p class="story-card-excerpt">${a.excerpt}</p>
                  <div class="story-card-meta">
                    <img class="avatar avatar-xs" src="${a.author.avatar}" alt="${a.author.name}">
                    <span class="meta-author">${a.author.name}</span>
                    <span class="meta-dot">&middot;</span>
                    <span>${a.readTime} min read</span>
                    <span class="meta-dot">&middot;</span>
                    <span>${a.date}</span>
                  </div>
                </div>
              </article>
            `).join("") : `<div class="empty-state"><p class="empty-state-title">No stories published yet.</p><p class="empty-state-subtitle">Be the first to write one!</p></div>`}
          </div>
        </div>
      `);
    } catch (e) {
      showError("Failed to load stories.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Story Detail Page                                                  */
  /* ------------------------------------------------------------------ */
  async function renderStoryDetail(params) {
    showLoading("Loading story...");
    try {
      const res = await fetch(`/api/articles/${params.id}`);
      if (!res.ok) throw new Error("Not found");
      const a = await res.json();
      const article = {
        id: a.id, title: a.title, content: a.content,
        author: { id: a.author_id, name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR, bio: a.author_bio || "" },
        category: a.category_name || "General", image: a.cover_image || DEFAULT_COVER,
        date: formatDate(a.published_at || a.created_at), readTime: readMins(a.content)
      };

      renderApp(`
        <article class="article-detail">
          <div class="article-detail-header">
            <span class="article-detail-category">${article.category}</span>
            <h1 class="article-detail-title">${article.title}</h1>
            <div class="article-detail-meta">
              <img class="avatar avatar-sm" src="${article.author.avatar}" alt="${article.author.name}">
              <div>
                <span class="meta-author">${article.author.name}</span>
                <span class="article-detail-date">${article.date} &middot; ${article.readTime} min read</span>
              </div>
            </div>
          </div>
          <img class="article-detail-cover" src="${article.image}" alt="${article.title}">
          <div class="article-detail-content">${formatContent(article.content)}</div>
          <div class="article-detail-footer">
            <div class="article-actions">
              <button class="btn btn-outline like-btn" data-id="${article.id}">&#9825; Like</button>
              <button class="btn btn-outline">&#9993; Share</button>
            </div>
          </div>
          <section class="comments-section">
            <h3 class="comments-heading">Comments</h3>
            <div class="comments-empty"><p>No comments yet.</p><p>Be the first to start the conversation.</p></div>
          </section>
        </article>
      `);
    } catch (e) {
      showError("Story not found.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Guest Posts Page                                                   */
  /* ------------------------------------------------------------------ */
  async function renderGuestPosts() {
    showLoading("Loading guest posts...");
    try {
      const res = await fetch("/api/articles");
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const posts = data.articles.slice(0, 6).map(a => ({
        id: a.id, title: a.title, excerpt: makeExcerpt(a.content, 150),
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
                <h3 class="guest-post-title">${p.title}</h3>
                <p class="guest-post-excerpt">${p.excerpt}</p>
                <div class="guest-post-meta">
                  <img class="avatar avatar-xs" src="${p.author.avatar}" alt="${p.author.name}">
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
    showLoading("Loading news...");
    try {
      const res = await fetch("/api/articles");
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const articles = data.articles.slice(0, 8).map(a => ({
        id: a.id, title: a.title, excerpt: makeExcerpt(a.content),
        author: { name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        image: a.cover_image || DEFAULT_COVER,
        date: formatDate(a.published_at || a.created_at), readTime: readMins(a.content)
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
                <a class="news-card-media" href="#/stories/${a.id}"><img src="${a.image}" alt="${a.title}"></a>
                <div class="news-card-body">
                  <span class="news-card-date">${a.date}</span>
                  <h3 class="news-card-title"><a href="#/stories/${a.id}">${a.title}</a></h3>
                  <p class="news-card-excerpt">${a.excerpt}</p>
                  <div class="news-card-meta">
                    <img class="avatar avatar-xxs" src="${a.author.avatar}" alt="${a.author.name}">
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
    } catch (e) {
      showError("Failed to load news.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Category Page                                                       */
  /* ------------------------------------------------------------------ */
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
        return renderApp(`
          <div class="page-container">
            <div class="empty-state">
              <p class="empty-state-title">This category doesn't exist.</p>
              <a class="btn btn-primary" href="#/">Back to home</a>
            </div>
          </div>
        `);
      }

      const data = await artRes.json();
      const articles = data.articles.map(a => ({
        id: a.id, title: a.title, excerpt: makeExcerpt(a.content),
        author: { name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        image: a.cover_image || DEFAULT_COVER,
        date: formatDate(a.published_at || a.created_at), readTime: readMins(a.content)
      }));

      renderApp(`
        <div class="page-container">
          <a class="category-back-link" href="#/">&larr; All stories</a>
          <div class="page-header">
            <h1 class="page-title">${cat.name}</h1>
            ${cat.description ? `<p class="page-subtitle">${cat.description}</p>` : ""}
          </div>
          ${articles.length ? `
            <div class="news-grid">
              ${articles.map(a => `
                <article class="news-card">
                  <a class="news-card-media" href="#/stories/${a.id}"><img src="${a.image}" alt="${a.title}"></a>
                  <div class="news-card-body">
                    <span class="news-card-date">${a.date}</span>
                    <h3 class="news-card-title"><a href="#/stories/${a.id}">${a.title}</a></h3>
                    <p class="news-card-excerpt">${a.excerpt}</p>
                    <div class="news-card-meta">
                      <img class="avatar avatar-xxs" src="${a.author.avatar}" alt="${a.author.name}">
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
              <p>No stories in ${cat.name} so far.</p>
            </div>
          `}
        </div>
      `);
    } catch (e) {
      showError("Failed to load this category.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Portfolio Page                                                     */
  /* ------------------------------------------------------------------ */
  function renderPortfolio() {
    if (!isLoggedIn()) {
      renderApp(`
        <div class="page-container">
          <div class="page-header">
            <h1 class="page-title">Portfolio Builder</h1>
            <p class="page-subtitle">Create your professional portfolio and share it with the world</p>
            <button class="btn btn-primary" onclick="document.dispatchEvent(new CustomEvent('open-write'))">Write a Story</button>
          </div>
          <div class="portfolio-features">
            <div class="portfolio-feature">
              <div class="portfolio-feature-icon">&#128196;</div>
              <h3>Professional Profile</h3>
              <p>Showcase your skills, experience, and education</p>
            </div>
            <div class="portfolio-feature">
              <div class="portfolio-feature-icon">&#128188;</div>
              <h3>Projects & Work</h3>
              <p>Display your best projects and case studies</p>
            </div>
            <div class="portfolio-feature">
              <div class="portfolio-feature-icon">&#128241;</div>
              <h3>Public URL</h3>
              <p>Get a shareable link like kalinova.com/portfolio/yourname</p>
            </div>
            <div class="portfolio-feature">
              <div class="portfolio-feature-icon">&#128176;</div>
              <h3>Marketplace Integration</h3>
              <p>Connect your products and services</p>
            </div>
          </div>
        </div>
      `);
      return;
    }

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
    if (!isLoggedIn()) {
      renderApp(`
        <div class="page-container">
          <div class="page-header">
            <h1 class="page-title">CV / Resume</h1>
            <p class="page-subtitle">Create a professional CV and share it with employers</p>
            <button class="btn btn-primary" onclick="document.dispatchEvent(new CustomEvent('open-write'))">Write a Story</button>
          </div>
        </div>
      `);
      return;
    }

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
    const q = new URLSearchParams(window.location.hash.split("?")[1]).get("q") || "";
    renderApp(`
      <div class="page-container">
        <div class="page-header">
          <h1 class="page-title">Search</h1>
          <form class="search-page-form" id="search-page-form">
            <input type="search" class="search-page-input" id="search-page-input" placeholder="Search articles, authors, topics, products..." value="${q}">
            <button type="submit" class="btn btn-primary">Search</button>
          </form>
        </div>
        <div class="search-page-results" id="search-page-results">
          ${q ? `<p class="search-page-hint">Searching for "${q}"...</p>` : `<p class="search-page-hint">Enter a search term to find stories, authors, and more.</p>`}
        </div>
      </div>
    `);

    if (q) performSearch(q);

    const form = document.getElementById("search-page-form");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const val = document.getElementById("search-page-input").value.trim();
        if (val) performSearch(val);
      });
    }
  }

  async function performSearch(query) {
    const results = document.getElementById("search-page-results");
    if (!results) return;
    results.innerHTML = `<p class="search-page-hint">Searching for "${query}"...</p>`;
    try {
      const res = await fetch(`/api/articles?search=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const articles = data.articles.map(a => ({
        id: a.id, title: a.title, excerpt: makeExcerpt(a.content),
        author: { name: a.author_username, avatar: a.author_avatar || DEFAULT_AVATAR },
        category: a.category_name || "General", date: formatDate(a.published_at || a.created_at),
        readTime: readMins(a.content)
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
  /* Dashboard Page (authenticated)                                     */
  /* ------------------------------------------------------------------ */
  function renderDashboard() {

    const session = getSession();
    const user = session.user || {};

    renderApp(`
      <div class="page-container">
        <div class="page-header">
          <h1 class="page-title">Welcome back, ${user.username || "Creator"}!</h1>
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
            <button class="dashboard-action-btn" onclick="document.dispatchEvent(new CustomEvent('open-write'))">
              <span class="action-icon">&#9997;</span>
              <span>Create Story</span>
            </button>
            <button class="dashboard-action-btn" onclick="Router.navigate('#/portfolio')">
              <span class="action-icon">&#128196;</span>
              <span>Create Portfolio</span>
            </button>
            <button class="dashboard-action-btn" onclick="Router.navigate('#/marketplace')">
              <span class="action-icon">&#128722;</span>
              <span>Add Product</span>
            </button>
            <button class="dashboard-action-btn" onclick="Router.navigate('#/marketplace')">
              <span class="action-icon">&#128188;</span>
              <span>Add Service</span>
            </button>
            <button class="dashboard-action-btn" onclick="Router.navigate('#/cv')">
              <span class="action-icon">&#128196;</span>
              <span>Edit CV</span>
            </button>
            <button class="dashboard-action-btn" onclick="Router.navigate('#/settings')">
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
    if (!isLoggedIn()) {
      renderApp(`
        <div class="page-container">
          <div class="page-header">
            <h1 class="page-title">Settings</h1>
            <p class="page-subtitle">Sign in to manage your account settings</p>
          </div>
        </div>
      `);
      return;
    }

    const session = getSession();
    const user = session.user || {};

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
    renderApp(`
      <div class="about-page">
        <header class="about-hero">
          <div class="about-hero-avatar">${FOUNDER_MONOGRAM}</div>
          <div class="about-hero-text">
            <span class="page-title-label">Our Story</span>
            <h1 class="about-hero-title">About Us</h1>
            <p class="about-hero-role">Soumyadip Sasmal — Founder &amp; Entrepreneur, KaliNova</p>
            <p class="about-hero-tagline">Every journey begins somewhere.</p>
            <a href="#/category/latest-news" class="btn btn-primary">Read Our Stories</a>
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
  /* Register all routes                                                */
  /* ------------------------------------------------------------------ */
  window.KaliNovaPages = {
    renderHome, renderStories, renderStoryDetail, renderGuestPosts,
    renderNews, renderPortfolio, renderMarketplace, renderCV, renderSearch,
    renderDashboard, renderProfile, renderSettings, renderCategory, renderAbout, renderCareers,
    renderGuestPostModal, renderCreateListingModal
  };

  Router.register("/", renderHome);
  Router.register("/stories", renderStories);
  Router.register("/stories/:id", renderStoryDetail);
  Router.register("/guest-posts", renderGuestPosts);
  Router.register("/news", renderNews);
  Router.register("/category/:slug", renderCategory);
  Router.register("/portfolio", renderPortfolio);
  Router.register("/marketplace", renderMarketplace);
  Router.register("/cv", renderCV);
  Router.register("/search", renderSearch);
  Router.register("/dashboard", renderDashboard);
  Router.register("/profile/:id", renderProfile);
  Router.register("/settings", renderSettings);
  Router.register("/about", renderAbout);
  Router.register("/careers", renderCareers);
})();
