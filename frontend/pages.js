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

  function getSession() {
    try {
      const raw = localStorage.getItem("kalinova_session");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function isLoggedIn() {
    const s = getSession();
    return Boolean(s && s.token);
  }

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
        id: a.id, title: a.title, excerpt: a.excerpt || a.content,
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
        id: a.id, title: a.title, excerpt: a.excerpt || a.content,
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
          <div class="article-detail-content">${article.content.split("\n").map(p => `<p>${p}</p>`).join("")}</div>
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
        id: a.id, title: a.title, excerpt: a.excerpt || a.content.substring(0, 150),
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
        id: a.id, title: a.title, excerpt: a.excerpt || a.content.substring(0, 200),
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
  /* Portfolio Page                                                     */
  /* ------------------------------------------------------------------ */
  function renderPortfolio() {
    if (!isLoggedIn()) {
      renderApp(`
        <div class="page-container">
          <div class="page-header">
            <h1 class="page-title">Portfolio Builder</h1>
            <p class="page-subtitle">Create your professional portfolio and share it with the world</p>
            <button class="btn btn-primary" onclick="document.dispatchEvent(new CustomEvent('open-auth', {detail:'signup'}))">Get Started</button>
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
            <button class="btn btn-primary" onclick="document.dispatchEvent(new CustomEvent('open-auth', {detail:'signup'}))">Get Started</button>
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
        id: a.id, title: a.title, excerpt: a.excerpt || a.content.substring(0, 200),
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
    if (!isLoggedIn()) {
      renderApp(`
        <div class="page-container">
          <div class="page-header">
            <h1 class="page-title">Dashboard</h1>
            <p class="page-subtitle">Sign in to access your dashboard</p>
            <button class="btn btn-primary" onclick="document.dispatchEvent(new CustomEvent('open-auth', {detail:'signin'}))">Sign In</button>
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
  /* Register all routes                                                */
  /* ------------------------------------------------------------------ */
  window.KaliNovaPages = {
    renderHome, renderStories, renderStoryDetail, renderGuestPosts,
    renderNews, renderPortfolio, renderMarketplace, renderCV, renderSearch,
    renderDashboard, renderProfile, renderSettings,
    renderGuestPostModal, renderCreateListingModal
  };

  Router.register("/", renderHome);
  Router.register("/stories", renderStories);
  Router.register("/stories/:id", renderStoryDetail);
  Router.register("/guest-posts", renderGuestPosts);
  Router.register("/news", renderNews);
  Router.register("/portfolio", renderPortfolio);
  Router.register("/marketplace", renderMarketplace);
  Router.register("/cv", renderCV);
  Router.register("/search", renderSearch);
  Router.register("/dashboard", renderDashboard);
  Router.register("/profile/:id", renderProfile);
  Router.register("/settings", renderSettings);
})();
