/**
 * KaliNova — Main SPA Controller
 * Handles auth, navigation, search, modals, and routing initialization.
 */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------------------------------------------ */
  /* Session (JWT) storage                                              */
  /* ------------------------------------------------------------------ */
  const SESSION_KEY = "kalinova_session";

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function setSession(token, user) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user }));
    } catch (e) {
      console.error("Failed to store session:", e);
    }
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  }

  /* ------------------------------------------------------------------ */
  /* Navigation UI updates                                              */
  /* ------------------------------------------------------------------ */
  function updateNav() {
    const session = getSession();
    const signedIn = Boolean(session && session.token);
    const guestEls = $$("#signin-btn, #getstarted-btn, .mobile-auth-btn:not(.mobile-logout-btn)");
    const authEls = $$(".mobile-auth-link, .mobile-logout-btn");

    guestEls.forEach(el => { el.hidden = signedIn; });
    authEls.forEach(el => { el.hidden = !signedIn; });

    const userMenu = $("#user-menu");
    if (userMenu) userMenu.hidden = !signedIn;
  }

  function highlightActiveNav() {
    const hash = window.location.hash;
    $$(".nav-link", $(".header-right")).forEach(link => {
      link.classList.toggle("is-active", link.getAttribute("href") === hash);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Auth modal                                                         */
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
    setAuthMode(mode || "signin");
    authForm.reset();
    authError.hidden = true;
    authModal.hidden = false;
  }

  function closeAuthModal() { authModal.hidden = true; }

  $("#auth-modal-close").addEventListener("click", closeAuthModal);
  authSwitchBtn.addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
  authModal.addEventListener("click", (e) => { if (e.target === authModal) closeAuthModal(); });

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
      updateNav();
      closeAuthModal();
    } catch (error) {
      authError.textContent = error.message;
      authError.hidden = false;
    } finally {
      authSubmitBtn.disabled = false;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Write modal                                                        */
  /* ------------------------------------------------------------------ */
  const writeModal = $("#write-modal");
  const writeForm = $("#write-form");
  const writeError = $("#write-error");
  const writeSubmitBtn = $(".btn-primary", writeForm);

  async function openWriteModal() {
    const session = getSession();
    if (!session || !session.token) { openAuthModal("signin"); return; }

    const select = $("#write-category");
    select.innerHTML = '<option value="">No category</option>';
    try {
      const res = await fetch("/api/categories");
      if (res.ok) {
        const data = await res.json();
        data.categories.forEach(c => {
          const opt = document.createElement("option");
          opt.value = c.id;
          opt.textContent = c.name;
          select.appendChild(opt);
        });
      }
    } catch {}

    writeForm.reset();
    writeError.hidden = true;
    writeModal.hidden = false;
  }

  function closeWriteModal() { writeModal.hidden = true; }

  $("#write-modal-close").addEventListener("click", closeWriteModal);
  writeModal.addEventListener("click", (e) => { if (e.target === writeModal) closeWriteModal(); });

  writeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    writeError.hidden = true;
    const session = getSession();
    if (!session || !session.token) { closeWriteModal(); openAuthModal("signin"); return; }
    const title = $("#write-title").value.trim();
    const content = $("#write-content").value.trim();
    const categoryId = $("#write-category").value;
    writeSubmitBtn.disabled = true;
    try {
      const response = await fetch("/api/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ title, content, category_id: categoryId || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the article");
      closeWriteModal();
      alert("Draft saved. It will appear publicly once an admin reviews and publishes it.");
    } catch (error) {
      writeError.textContent = error.message;
      writeError.hidden = false;
    } finally {
      writeSubmitBtn.disabled = false;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Header search                                                      */
  /* ------------------------------------------------------------------ */
  const searchInput = $("#header-search");
  const searchResults = $("#search-results");
  let searchDebounce = null;

  async function runSearch(query) {
    const q = query.trim();
    if (!q) { searchResults.hidden = true; searchResults.innerHTML = ""; return; }
    try {
      const res = await fetch(`/api/articles?search=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      searchResults.innerHTML = "";
      const matches = data.articles.slice(0, 6);
      if (matches.length === 0) {
        searchResults.innerHTML = `<p class="search-empty">No results for "${query}"</p>`;
      } else {
        matches.forEach(a => {
          const link = document.createElement("a");
          link.href = `#/stories/${a.id}`;
          link.innerHTML = `
            <span class="search-result-title">${a.title}</span>
            <span class="search-result-meta" style="display:block">${a.author_username} &middot; ${a.category_name || "General"}</span>`;
          searchResults.appendChild(link);
        });
        const viewAll = document.createElement("a");
        viewAll.href = `#/search?q=${encodeURIComponent(q)}`;
        viewAll.className = "search-result-viewall";
        viewAll.textContent = "View all results";
        searchResults.appendChild(viewAll);
      }
      searchResults.hidden = false;
    } catch {
      searchResults.innerHTML = `<p class="search-empty">Search unavailable</p>`;
      searchResults.hidden = false;
    }
  }

  searchInput.addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(e.target.value), 250);
  });
  $("#header-search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q) {
      searchResults.hidden = true;
      Router.navigate(`#/search?q=${encodeURIComponent(q)}`);
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".header-search")) searchResults.hidden = true;
  });

  /* ------------------------------------------------------------------ */
  /* User menu dropdown                                                 */
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
  /* Mobile drawer                                                      */
  /* ------------------------------------------------------------------ */
  const mobileToggle = $("#mobile-toggle");
  const mobileDrawer = $("#mobile-drawer");

  mobileToggle.addEventListener("click", () => {
    const expanded = mobileToggle.getAttribute("aria-expanded") === "true";
    mobileToggle.setAttribute("aria-expanded", String(!expanded));
    mobileDrawer.hidden = expanded;
    mobileDrawer.style.display = expanded ? "none" : "flex";
  });

  // Close mobile drawer on nav link click
  $$(".mobile-nav-link", mobileDrawer).forEach(link => {
    link.addEventListener("click", () => {
      mobileDrawer.hidden = true;
      mobileToggle.setAttribute("aria-expanded", "false");
      mobileDrawer.style.display = "none";
    });
  });

  /* ------------------------------------------------------------------ */
  /* Logout                                                             */
  /* ------------------------------------------------------------------ */
  function handleLogout() {
    clearSession();
    updateNav();
    if (userMenuPanel) {
      userMenuPanel.hidden = true;
      userMenuBtn.setAttribute("aria-expanded", "false");
    }
    Router.navigate("#/");
  }

  const logoutBtn = $("#logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);

  const mobileLogoutBtn = $("#mobile-logout-btn");
  if (mobileLogoutBtn) mobileLogoutBtn.addEventListener("click", handleLogout);

  /* ------------------------------------------------------------------ */
  /* Custom event listeners (for page components)                       */
  /* ------------------------------------------------------------------ */
  document.addEventListener("open-write", () => openWriteModal());
  document.addEventListener("open-auth", (e) => openAuthModal(e.detail || "signin"));
  document.addEventListener("open-guest-post", () => {
    if (KaliNovaPages.renderGuestPostModal) KaliNovaPages.renderGuestPostModal();
  });
  document.addEventListener("open-create-listing", () => {
    if (KaliNovaPages.renderCreateListingModal) KaliNovaPages.renderCreateListingModal();
  });

  /* ------------------------------------------------------------------ */
  /* Init                                                               */
  /* ------------------------------------------------------------------ */
  document.addEventListener("DOMContentLoaded", () => {
    updateNav();
    Router.init();
    highlightActiveNav();
    window.addEventListener("hashchange", highlightActiveNav);
  });
})();
