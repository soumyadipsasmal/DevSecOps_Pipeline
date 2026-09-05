/**
 * KaliNova — Homepage
 *
 * All data is loaded from the real backend (GET /api/categories,
 * GET /api/articles). Sections with no backend support yet (trending
 * topics, popular authors, follow) render an honest empty state instead
 * of invented data -- see renderPendingSidebarSections().
 */

(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Mock data                                                          */
  /* ------------------------------------------------------------------ */

  // Generic placeholder avatar used only when a real author has no avatar_url
  // on file -- never a stand-in for a fictional author.
  const DEFAULT_AVATAR = "https://i.pravatar.cc/64?img=12";

  let ARTICLES = [];
  let CATEGORIES = [];

  // The 10 categories KaliNova wants featured first in the topic nav. This is
  // purely a *display order* preference -- the categories themselves (names,
  // slugs, the full set of 19) always come from GET /api/categories, never
  // hardcoded here. Anything not in this list renders afterward in whatever
  // order the API already returned it in (its display_order).
  const PRIORITY_CATEGORY_SLUGS = [
    "ai-technology", "travel", "fashion-beauty", "design-creativity",
    "food-and-lifestyle", "business-career", "finance-money",
    "education", "health-and-wellness", "entertainment-gaming"
  ];

async function loadCategories() {
  try {
    const response = await fetch("/api/categories");
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();

    const prioritySet = new Set(PRIORITY_CATEGORY_SLUGS);
    const priority = PRIORITY_CATEGORY_SLUGS
      .map((slug) => data.categories.find((c) => c.slug === slug))
      .filter(Boolean);
    const rest = data.categories.filter((c) => !prioritySet.has(c.slug));

    CATEGORIES = [...priority, ...rest];
    renderCategoryChips(CATEGORIES);
    return CATEGORIES;
  } catch (error) {
    console.error("Failed to load categories:", error);
    return [];
  }
}

// Each chip is a real link to its own page (/category/<slug>, or / for "For
// You") so every category is a genuine, navigable, bookmarkable page.
function renderCategoryChips(categories) {
  const list = $("#topic-list");
  $$(".topic-chip[data-category-slug]", list).forEach((chip) => chip.closest("li").remove());

  categories.forEach((category) => {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.className = "topic-chip";
    link.dataset.categorySlug = category.slug;
    link.href = `/category/${encodeURIComponent(category.slug)}`;
    link.textContent = category.name;
    li.appendChild(link);
    list.appendChild(li);
  });

  markActiveChip(getCategorySlugFromPath());
}

function markActiveChip(activeSlug) {
  $$(".topic-chip", $("#topic-list")).forEach((chip) => {
    chip.classList.toggle("is-active", (chip.dataset.categorySlug || null) === activeSlug);
  });
}

function getCategorySlugFromPath() {
  const match = window.location.pathname.match(/^\/category\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function mapArticle(article) {
  return {
    id: article.id,
    title: article.title,
    description: article.excerpt || article.content,
    author: {
      id: article.author_id,
      name: article.author_username,
      avatar: article.author_avatar || DEFAULT_AVATAR,
      bio: article.author_bio || "",
    },
    category: article.category_name || "",
    readMins: Math.max(
      1,
      Math.ceil(article.content.trim().split(/\s+/).length / 200)
    ),
    date: new Date(article.published_at || article.created_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    image:
      article.cover_image ||
      "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=60",
    featured: Boolean(article.is_featured),
    trending: Boolean(article.is_trending),
  };
}

async function loadArticles(categorySlug) {
  try {
    const url = categorySlug ? `/api/articles?category=${encodeURIComponent(categorySlug)}` : "/api/articles";
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();

    ARTICLES = data.articles.map(mapArticle);

    renderArticleSections();
  } catch (error) {
    console.error("Failed to load articles:", error);
    ARTICLES = [];
    renderArticleSections();
  }
}

async function loadTrending() {
  try {
    const response = await fetch("/api/articles?trending=true");
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    renderTrendingSidebar(data.articles.map(mapArticle));
  } catch (error) {
    console.error("Failed to load trending stories:", error);
    renderTrendingSidebar([]);
  }
}

  /* ------------------------------------------------------------------ */
  /* Rendering helpers                                                  */
  /* ------------------------------------------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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
    if (eyebrow) eyebrow.textContent = article.category || "General";
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

  function renderEmptyState(container, title, subtitle) {
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "empty-state";
    const heading = document.createElement("p");
    heading.className = "empty-state-title";
    heading.textContent = title;
    wrap.appendChild(heading);
    if (subtitle) {
      const sub = document.createElement("p");
      sub.className = "empty-state-subtitle";
      sub.textContent = subtitle;
      wrap.appendChild(sub);
    }
    container.appendChild(wrap);
  }

  // Re-run every time ARTICLES changes (initial load or a category filter),
  // so the feed sections are cleared first to avoid duplicating cards.
  function renderArticleSections() {
    latestShown = 0;

    const featuredGrid = $("#featured-grid");
    featuredGrid.innerHTML = "";
    const featured = ARTICLES.filter((a) => a.featured);
    if (featured.length === 0) {
      renderEmptyState(featuredGrid, "No featured stories yet.", "Check back soon.");
    } else {
      featured.forEach((a) => featuredGrid.appendChild(renderFeaturedCard(a)));
    }

    const rest = ARTICLES.filter((a) => !a.featured);

    const recommended = $("#recommended-list");
    recommended.innerHTML = "";
    if (rest.length === 0) {
      renderEmptyState(recommended, "Nothing to recommend yet.", "New stories will show up here once they're published.");
    } else {
      rest.slice(0, 2).forEach((a) => recommended.appendChild(renderArticleRow(a)));
    }

    const latestList = $("#latest-list");
    latestList.innerHTML = "";
    const loadMoreBtn = $("#load-more-btn");
    if (rest.length <= 2) {
      loadMoreBtn.hidden = true;
      if (rest.length === 0) {
        renderEmptyState(latestList, "No stories have been published yet.", "Be the first to write one.");
      }
    } else {
      loadMoreBtn.hidden = false;
      renderMoreLatest();
    }
  }

  // "Trending topics" and "Popular authors" have no public backend endpoint
  // yet (no tag-popularity API; GET /api/authors only fetches a single author
  // by id, and there is no follow API wired to the existing `follows` table).
  // Rather than showing invented names, both sections render an honest empty
  // state until those endpoints exist.
  function renderPendingSidebarSections() {
    renderEmptyState($("#topic-cloud"), "No trending topics yet.");
    renderEmptyState($("#author-list"), "No popular authors yet.");
  }

  function renderTrendingSidebar(articles) {
    const trendingList = $("#trending-list");
    trendingList.innerHTML = "";
    if (articles.length === 0) {
      renderEmptyState(trendingList, "Nothing trending yet.");
      return;
    }
    articles.forEach((a, i) => trendingList.appendChild(renderTrendingItem(a, i)));
  }

  function renderMoreLatest() {
    const latestList = $("#latest-list");
    const rest = ARTICLES.filter((a) => !a.featured).slice(2);
    const nextBatch = rest.slice(latestShown, latestShown + PAGE_SIZE);
    nextBatch.forEach((a) => latestList.appendChild(renderArticleRow(a)));
    latestShown += nextBatch.length;

    const loadMoreBtn = $("#load-more-btn");
    loadMoreBtn.hidden = latestShown >= rest.length;
  }

  $("#load-more-btn").addEventListener("click", renderMoreLatest);

  /* ------------------------------------------------------------------ */
  /* Search -- calls the existing GET /api/articles?search= backend       */
  /* filter (Phase 4); debounced so we don't fire a request per keystroke.*/
  /* ------------------------------------------------------------------ */

  const searchInput = $("#site-search");
  const searchResults = $("#search-results");
  let searchDebounce = null;
  let searchRequestId = 0;

  async function runSearch(query) {
    const q = query.trim();

    if (!q) {
      searchResults.hidden = true;
      searchResults.innerHTML = "";
      return;
    }

    const requestId = ++searchRequestId;
    try {
      const response = await fetch(`/api/articles?search=${encodeURIComponent(q)}`);
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const data = await response.json();
      if (requestId !== searchRequestId) return; // a newer search superseded this one

      searchResults.innerHTML = "";
      const matches = data.articles.slice(0, 6);

      if (matches.length === 0) {
        const empty = document.createElement("p");
        empty.className = "search-empty";
        empty.textContent = `No results for "${query}"`;
        searchResults.appendChild(empty);
      } else {
        matches.forEach((article) => {
          const a = mapArticle(article);
          const link = document.createElement("a");
          link.href = "#article";
          const title = document.createElement("span");
          title.className = "search-result-title";
          title.textContent = a.title;
          const meta = document.createElement("span");
          meta.className = "search-result-meta";
          meta.style.display = "block";
          meta.textContent = `${a.author.name} · ${a.category || "General"} · ${a.readMins} min`;
          link.appendChild(title);
          link.appendChild(meta);
          searchResults.appendChild(link);
        });
      }
      searchResults.hidden = false;
    } catch (error) {
      if (requestId !== searchRequestId) return;
      console.error("Search failed:", error);
      searchResults.innerHTML = "";
      const empty = document.createElement("p");
      empty.className = "search-empty";
      empty.textContent = "Search is unavailable right now.";
      searchResults.appendChild(empty);
      searchResults.hidden = false;
    }
  }

  searchInput.addEventListener("input", (e) => {
    const value = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(value), 250);
  });
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
  /* Session (JWT) storage                                              */
  /* ------------------------------------------------------------------ */

  const SESSION_KEY = "kalinova_session";

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function setSession(token, user) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user }));
    } catch (error) {
      console.error("Failed to store session:", error);
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (error) {
      /* ignore -- nothing to clear */
    }
  }

  function updateAuthUI() {
    const session = getSession();
    const signedIn = Boolean(session && session.token);
    $$("#signin-btn, #getstarted-btn, #mobile-signin-btn, #mobile-getstarted-btn").forEach((el) => {
      el.hidden = signedIn;
    });
    const userMenu = $("#user-menu");
    if (userMenu) userMenu.hidden = !signedIn;
  }

  /* ------------------------------------------------------------------ */
  /* Auth modal (Sign Up / Sign In) -- calls the existing               */
  /* /api/auth/register and /api/auth/login endpoints directly.         */
  /* ------------------------------------------------------------------ */

  const authModal = $("#auth-modal");
  const authForm = $("#auth-form");
  const authError = $("#auth-error");
  const authUsernameField = $("#auth-username-field");
  const authUsernameInput = $("#auth-username");
  const authSubmitBtn = $("#auth-submit-btn");
  const authSwitchBtn = $("#auth-switch-btn");
  const authSwitchText = $("#auth-switch-text");
  const authModalTitle = $("#auth-modal-title");

  let authMode = "signin";

  function setAuthMode(mode) {
    authMode = mode;
    authError.hidden = true;
    if (mode === "signup") {
      authModalTitle.textContent = "Create your account";
      authUsernameField.hidden = false;
      authUsernameInput.required = true;
      authSubmitBtn.textContent = "Sign Up";
      authSwitchText.textContent = "Already have an account?";
      authSwitchBtn.textContent = "Sign in";
    } else {
      authModalTitle.textContent = "Sign In";
      authUsernameField.hidden = true;
      authUsernameInput.required = false;
      authSubmitBtn.textContent = "Sign In";
      authSwitchText.textContent = "New to KaliNova?";
      authSwitchBtn.textContent = "Create an account";
    }
  }

  function openAuthModal(mode) {
    setAuthMode(mode);
    authForm.reset();
    authError.hidden = true;
    authModal.hidden = false;
  }

  function closeAuthModal() {
    authModal.hidden = true;
  }

  $("#auth-modal-close").addEventListener("click", closeAuthModal);
  authSwitchBtn.addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
  authModal.addEventListener("click", (e) => {
    if (e.target === authModal) closeAuthModal();
  });

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.hidden = true;
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    authSubmitBtn.disabled = true;
    try {
      if (authMode === "signup") {
        const username = authUsernameInput.value.trim();
        const registerRes = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, email, password }),
        });
        const registerData = await registerRes.json();
        if (!registerRes.ok) throw new Error(registerData.error || "Registration failed");
      }
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const loginData = await loginRes.json();
      if (!loginRes.ok) throw new Error(loginData.error || "Sign in failed");
      setSession(loginData.token, loginData.user);
      updateAuthUI();
      closeAuthModal();
    } catch (error) {
      authError.textContent = error.message;
      authError.hidden = false;
    } finally {
      authSubmitBtn.disabled = false;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Write modal -- calls the existing authenticated POST /api/articles */
  /* ------------------------------------------------------------------ */

  const writeModal = $("#write-modal");
  const writeForm = $("#write-form");
  const writeError = $("#write-error");
  const writeSubmitBtn = $(".btn-primary", writeForm);

  function populateCategorySelect() {
    const select = $("#write-category");
    select.innerHTML = '<option value="">No category</option>';
    CATEGORIES.forEach((category) => {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      select.appendChild(option);
    });
  }

  function openWriteModal() {
    const session = getSession();
    if (!session || !session.token) {
      openAuthModal("signin");
      return;
    }
    writeForm.reset();
    writeError.hidden = true;
    populateCategorySelect();
    writeModal.hidden = false;
  }

  function closeWriteModal() {
    writeModal.hidden = true;
  }

  $("#write-modal-close").addEventListener("click", closeWriteModal);
  writeModal.addEventListener("click", (e) => {
    if (e.target === writeModal) closeWriteModal();
  });

  writeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    writeError.hidden = true;
    const session = getSession();
    if (!session || !session.token) {
      closeWriteModal();
      openAuthModal("signin");
      return;
    }
    const title = $("#write-title").value.trim();
    const content = $("#write-content").value.trim();
    const categoryId = $("#write-category").value;
    writeSubmitBtn.disabled = true;
    try {
      const response = await fetch("/api/articles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({
          title,
          content,
          category_id: categoryId || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the article");
      closeWriteModal();
      window.alert("Draft saved. It will appear publicly once an admin reviews and publishes it.");
    } catch (error) {
      writeError.textContent = error.message;
      writeError.hidden = false;
    } finally {
      writeSubmitBtn.disabled = false;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Auth / write triggers (header + mobile drawer) and sign-out         */
  /* ------------------------------------------------------------------ */

  function bindTrigger(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", handler);
  }

  bindTrigger("signin-btn", () => openAuthModal("signin"));
  bindTrigger("mobile-signin-btn", () => openAuthModal("signin"));
  bindTrigger("getstarted-btn", () => openAuthModal("signup"));
  bindTrigger("mobile-getstarted-btn", () => openAuthModal("signup"));
  bindTrigger("write-btn", openWriteModal);
  bindTrigger("mobile-write-btn", openWriteModal);

  const logoutBtn = $("#logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      clearSession();
      updateAuthUI();
      if (userMenuPanel) {
        userMenuPanel.hidden = true;
        userMenuBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Category page (frontend/category.html, served at /category/:slug)  */
  /* ------------------------------------------------------------------ */

  async function initCategoryPage(slug) {
    const body = $("#category-page-body");
    const notFound = $("#category-not-found");
    const title = $("#category-page-title");
    const categories = await loadCategories();
    const category = categories.find((c) => c.slug === slug);

    if (!category) {
      title.textContent = "Category not found";
      body.hidden = true;
      notFound.hidden = false;
      return;
    }

    document.title = `${category.name} — KaliNova`;
    title.textContent = category.name;
    body.hidden = false;
    notFound.hidden = true;
    loadArticles(slug);
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */

  document.addEventListener("DOMContentLoaded", () => {
    updateAuthUI();
    renderPendingSidebarSections();
    loadTrending();

    const categorySlug = getCategorySlugFromPath();
    if (categorySlug) {
      initCategoryPage(categorySlug);
    } else {
      loadCategories();
      loadArticles();
    }
  });
})();
