/**
 * DevBlog — Homepage
 *
 * Phase 1: frontend-only. All data below is realistic MOCK DATA standing
 * in for the future backend contract described in the project brief:
 *
 *   GET  /api/articles
 *   GET  /api/articles/:id
 *   GET  /api/users/:id
 *   POST /api/articles/:id/like
 *   POST /api/articles/:id/bookmark
 *
 * Swap `MOCK_ARTICLES` / `MOCK_AUTHORS` for real fetch() calls to
 * http://localhost:3007/api/... once the backend endpoints exist —
 * the render functions below already take arrays of the same shape,
 * so no markup changes should be needed.
 */

(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Mock data                                                          */
  /* ------------------------------------------------------------------ */

  const AUTHORS = {
    soumyadip: {
      id: "soumyadip",
      name: "Soumyadip Sasmal",
      avatar: "https://i.pravatar.cc/64?img=12",
      bio: "Software Engineer · DevOps · Cloud",
      followers: 125,
    },
    priya: {
      id: "priya",
      name: "Priya Raman",
      avatar: "https://i.pravatar.cc/64?img=32",
      bio: "Platform engineer. Kubernetes & SRE.",
      followers: 892,
    },
    marcus: {
      id: "marcus",
      name: "Marcus Ito",
      avatar: "https://i.pravatar.cc/64?img=51",
      bio: "Writes about cloud cost & architecture.",
      followers: 2140,
    },
    lena: {
      id: "lena",
      name: "Lena Volkov",
      avatar: "https://i.pravatar.cc/64?img=47",
      bio: "AppSec engineer. Breaks things for a living.",
      followers: 3310,
    },
    dev: {
      id: "dev",
      name: "Dev Okafor",
      avatar: "https://i.pravatar.cc/64?img=15",
      bio: "Full-stack. AI tooling. Open source.",
      followers: 654,
    },
  };

  let ARTICLES = [];

async function loadArticles() {
  try {
    const response = await fetch("/api/articles");

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();

    ARTICLES = data.articles.map((article, index) => ({
      id: article.id,
      title: article.title,
      description: article.content,
      author: {
        id: article.author_id,
        name: article.author,
        avatar: "https://i.pravatar.cc/64?img=12",
        bio: "Software Engineer · DevOps · Cloud",
        followers: 0,
      },
      category: "devops",
      readMins: Math.max(
        1,
        Math.ceil(article.content.trim().split(/\s+/).length / 200)
      ),
      date: new Date(article.created_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      image:
        article.cover_image ||
        "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=60",
      featured: index < 2,
    }));

    populateFeed();
  } catch (error) {
    console.error("Failed to load articles:", error);
  }
}

  const TRENDING = [];

  const TRENDING_TOPICS = [
    "Platform Engineering",
    "Zero Trust",
    "Rust",
    "FinOps",
    "LLM Ops",
    "GitOps",
  ];

  const POPULAR_AUTHORS = [AUTHORS.lena, AUTHORS.marcus, AUTHORS.priya];

  /* ------------------------------------------------------------------ */
  /* Rendering helpers                                                  */
  /* ------------------------------------------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function categoryLabel(cat) {
    return cat
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }

  function fillMeta(card, article) {
    const authorImg = $(".card-meta img.avatar, .card-meta-top img.avatar", card);
    if (authorImg) {
      authorImg.src = article.author.avatar;
      authorImg.alt = article.author.name;
    }
    const authorSpan = $(".meta-author", card);
    if (authorSpan) authorSpan.textContent = article.author.name;
    const readSpan = $(".meta-read", card);
    if (readSpan) readSpan.textContent = `${article.readMins} min read`;
    const dateSpan = $(".meta-date", card);
    if (dateSpan) dateSpan.textContent = article.date;
    const eyebrow = $(".card-eyebrow", card);
    if (eyebrow) eyebrow.textContent = categoryLabel(article.category);
  }

  function renderFeaturedCard(article) {
    const tpl = $("#tpl-featured-card");
    const node = tpl.content.cloneNode(true);
    const card = $(".card-featured", node);
    card.dataset.articleId = article.id;

    $(".card-img", node).src = article.image;
    $(".card-img", node).alt = article.title;
    $(".card-title a", node).textContent = article.title;
    $(".card-desc", node).textContent = article.description;
    fillMeta(node, article);

    return node;
  }

  function renderArticleRow(article) {
    const tpl = $("#tpl-article-row");
    const node = tpl.content.cloneNode(true);
    const card = $(".card-row", node);
    card.dataset.articleId = article.id;

    $(".card-title a", node).textContent = article.title;
    $(".card-desc", node).textContent = article.description;
    $(".card-img", node).src = article.image;
    $(".card-img", node).alt = article.title;
    fillMeta(node, article);

    const bookmarkBtn = $(".bookmark-btn", node);
    bookmarkBtn.addEventListener("click", () => toggleBookmark(bookmarkBtn, article));

    const moreBtn = $(".more-btn", node);
    moreBtn.addEventListener("click", () => {
      // Placeholder for a future options menu (mute author, report, etc.)
      moreBtn.setAttribute("aria-expanded", moreBtn.getAttribute("aria-expanded") === "true" ? "false" : "true");
    });

    return node;
  }

  function renderTrendingItem(article, index) {
    const tpl = $("#tpl-trending-item");
    const node = tpl.content.cloneNode(true);
    $(".trending-rank", node).textContent = String(index + 1).padStart(2, "0");
    $(".trending-author-row img", node).src = article.author.avatar;
    $(".trending-author-row img", node).alt = article.author.name;
    $(".meta-author", node).textContent = article.author.name;
    $(".trending-title a", node).textContent = article.title;
    return node;
  }

  function renderAuthorItem(author) {
    const tpl = $("#tpl-author-item");
    const node = tpl.content.cloneNode(true);
    $("img.avatar", node).src = author.avatar;
    $("img.avatar", node).alt = author.name;
    $(".author-name", node).textContent = author.name;
    $(".author-bio", node).textContent = author.bio;

    const followBtn = $(".follow-btn", node);
    followBtn.addEventListener("click", () => toggleFollow(followBtn));

    return node;
  }

  function toggleBookmark(btn, article) {
    const isPressed = btn.getAttribute("aria-pressed") === "true";
    btn.setAttribute("aria-pressed", String(!isPressed));
    btn.setAttribute(
      "aria-label",
      !isPressed ? `Remove "${article.title}" from bookmarks` : `Bookmark "${article.title}"`
    );
    // Future: POST /api/articles/:id/bookmark
  }

  function toggleFollow(btn) {
    const following = btn.dataset.following === "true";
    btn.dataset.following = String(!following);
    btn.textContent = following ? "Follow" : "Following";
  }

  /* ------------------------------------------------------------------ */
  /* Feed population                                                    */
  /* ------------------------------------------------------------------ */

  const PAGE_SIZE = 4;
  let latestShown = 0;

  function populateFeed() {
    const featuredGrid = $("#featured-grid");
    ARTICLES.filter((a) => a.featured).forEach((a) => featuredGrid.appendChild(renderFeaturedCard(a)));

    const recommended = $("#recommended-list");
    ARTICLES.filter((a) => !a.featured)
      .slice(0, 2)
      .forEach((a) => recommended.appendChild(renderArticleRow(a)));

    renderMoreLatest();

    const trendingList = $("#trending-list");
    TRENDING.forEach((a, i) => trendingList.appendChild(renderTrendingItem(a, i)));

    const topicCloud = $("#topic-cloud");
    TRENDING_TOPICS.forEach((t) => {
      const btn = document.createElement("button");
      btn.className = "topic-chip";
      btn.type = "button";
      btn.textContent = t;
      topicCloud.appendChild(btn);
    });

    const authorList = $("#author-list");
    POPULAR_AUTHORS.forEach((a) => authorList.appendChild(renderAuthorItem(a)));
  }

  function renderMoreLatest() {
    const latestList = $("#latest-list");
    const rest = ARTICLES.filter((a) => !a.featured).slice(2);
    const nextBatch = rest.slice(latestShown, latestShown + PAGE_SIZE);
    nextBatch.forEach((a) => latestList.appendChild(renderArticleRow(a)));
    latestShown += nextBatch.length;

    const loadMoreBtn = $("#load-more-btn");
    if (latestShown >= rest.length) {
      loadMoreBtn.hidden = true;
    }
  }

  $("#load-more-btn").addEventListener("click", renderMoreLatest);

  /* ------------------------------------------------------------------ */
  /* Topic nav filtering (client-side, against mock data)               */
  /* ------------------------------------------------------------------ */

  $("#topic-list").addEventListener("click", (e) => {
    const chip = e.target.closest(".topic-chip");
    if (!chip) return;
    $$(".topic-chip", $("#topic-list")).forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
    // Future: filter ARTICLES by chip.dataset.topic and re-render feed.
  });

  /* ------------------------------------------------------------------ */
  /* Search (client-side against mock data)                              */
  /* ------------------------------------------------------------------ */

  const searchInput = $("#site-search");
  const searchResults = $("#search-results");

  function runSearch(query) {
    const q = query.trim().toLowerCase();
    searchResults.innerHTML = "";

    if (!q) {
      searchResults.hidden = true;
      return;
    }

    const matches = ARTICLES.filter((a) => {
      return (
        a.title.toLowerCase().includes(q) ||
        a.author.name.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
      );
    }).slice(0, 6);

    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.className = "search-empty";
      empty.textContent = `No results for "${query}"`;
      searchResults.appendChild(empty);
    } else {
      matches.forEach((a) => {
        const link = document.createElement("a");
        link.href = "#article";
        const title = document.createElement("span");
        title.className = "search-result-title";
        title.textContent = a.title;
        const meta = document.createElement("span");
        meta.className = "search-result-meta";
        meta.style.display = "block";
        meta.textContent = `${a.author.name} · ${categoryLabel(a.category)} · ${a.readMins} min`;
        link.appendChild(title);
        link.appendChild(meta);
        searchResults.appendChild(link);
      });
    }
    searchResults.hidden = false;
  }

  searchInput.addEventListener("input", (e) => runSearch(e.target.value));
  $("#search-form").addEventListener("submit", (e) => e.preventDefault());

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".header-search")) {
      searchResults.hidden = true;
    }
  });

  /* ------------------------------------------------------------------ */
  /* User menu dropdown                                                  */
  /* ------------------------------------------------------------------ */

  const userMenuBtn = $("#user-menu-btn");
  const userMenuPanel = $("#user-menu-panel");

  if (userMenuBtn) {
    userMenuBtn.addEventListener("click", () => {
      const expanded = userMenuBtn.getAttribute("aria-expanded") === "true";
      userMenuBtn.setAttribute("aria-expanded", String(!expanded));
      userMenuPanel.hidden = expanded;
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#user-menu") && !userMenuPanel.hidden) {
        userMenuPanel.hidden = true;
        userMenuBtn.setAttribute("aria-expanded", "false");
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !userMenuPanel.hidden) {
        userMenuPanel.hidden = true;
        userMenuBtn.setAttribute("aria-expanded", "false");
        userMenuBtn.focus();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Mobile drawer                                                       */
  /* ------------------------------------------------------------------ */

  const mobileToggle = $("#mobile-toggle");
  const mobileDrawer = $("#mobile-drawer");

  mobileToggle.addEventListener("click", () => {
    const expanded = mobileToggle.getAttribute("aria-expanded") === "true";
    mobileToggle.setAttribute("aria-expanded", String(!expanded));
    mobileDrawer.hidden = expanded;
    mobileDrawer.style.display = expanded ? "none" : "flex";
  });

  /* ------------------------------------------------------------------ */
  /* Auth buttons (UI-only placeholders — Phase 8 wires these up)        */
  /* ------------------------------------------------------------------ */

  ["signin-btn", "getstarted-btn", "write-btn", "mobile-signin-btn", "mobile-getstarted-btn", "mobile-write-btn"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("click", () => {
          // Phase 1 scope: no auth pages/editor yet. This is a hook point
          // for Phase 7/8/3 to attach real navigation.
          console.info(`[DevBlog] "${el.textContent.trim()}" clicked — not yet wired (later phase).`);
        });
      }
    }
  );

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */

  document.addEventListener("DOMContentLoaded", loadArticles);
})();
