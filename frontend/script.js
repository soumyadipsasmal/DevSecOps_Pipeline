/**
 * KaliNova — Main SPA Controller
 * Handles navigation, topic menus, modals, and routing initialization.
 *
 * There are no user accounts: every article is published as the site author,
 * so there is no session, sign-in or sign-out to manage.
 */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function highlightActiveNav() {
    // The header-right nav was removed when the topics moved into the single
    // header row, so there are no .nav-link elements left to highlight.
  }

  /* ------------------------------------------------------------------ */
  /* Topic nav (rendered from GET /api/categories)                       */
  /* ------------------------------------------------------------------ */
  async function renderTopicNav() {
    const list = $("#topic-list");
    if (!list) return;

    try {
      const res = await fetch("/api/categories");
      if (!res.ok) return;
      const { categories } = await res.json();

      list.querySelectorAll("li:not(:first-child)").forEach(li => li.remove());

      // The drawer carries the same topics on narrow screens, where the
      // header row is hidden in favour of the hamburger.
      const mobileList = $("#mobile-topic-list");

      categories.forEach(c => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.className = "topic-chip";
        a.href = `#/category/${c.slug}`;
        a.textContent = c.name;
        li.appendChild(a);
        list.appendChild(li);

        if (mobileList) {
          const mli = document.createElement("li");
          const ma = document.createElement("a");
          ma.className = "mobile-nav-link";
          ma.href = `#/category/${c.slug}`;
          ma.textContent = c.name;
          mli.appendChild(ma);
          mobileList.appendChild(mli);
        }
      });

      const footerList = $("#footer-topic-list");
      if (footerList) {
        footerList.querySelectorAll("li:not(:first-child)").forEach(li => li.remove());
        categories.forEach(c => {
          const li = document.createElement("li");
          const a = document.createElement("a");
          a.href = `#/category/${c.slug}`;
          a.textContent = c.name;
          li.appendChild(a);
          footerList.appendChild(li);
        });
      }
    } catch (e) {
      console.error("Failed to load topics:", e);
    }
  }

  function highlightActiveTopic() {
    const hash = window.location.hash;

    const list = $("#topic-list");
    if (list) {
      $$(".topic-chip", list).forEach(chip => {
        chip.classList.toggle("is-active", chip.getAttribute("href") === hash);
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Write modal                                                        */
  /* ------------------------------------------------------------------ */
  const writeModal = $("#write-modal");
  const writeForm = $("#write-form");
  const writeError = $("#write-error");
  const writeSubmitBtn = $(".btn-primary", writeForm);

  async function openWriteModal() {
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
    const title = $("#write-title").value.trim();
    const content = $("#write-content").value.trim();
    const categoryId = $("#write-category").value;
    if (!title || !content) {
      writeError.textContent = "Title and content are required";
      writeError.hidden = false;
      return;
    }
    writeSubmitBtn.disabled = true;
    try {
      const response = await fetch("/api/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, category_id: categoryId || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the article");
      closeWriteModal();
      alert("Published as KaliNova.");
      Router.navigate("#/");
    } catch (error) {
      writeError.textContent = error.message;
      writeError.hidden = false;
    } finally {
      writeSubmitBtn.disabled = false;
    }
  });

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
  /* Custom event listeners (for page components)                       */
  /* ------------------------------------------------------------------ */
  document.addEventListener("open-write", () => openWriteModal());
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
    renderTopicNav();
    Router.init();
    highlightActiveNav();
    highlightActiveTopic();
    window.addEventListener("hashchange", () => {
      highlightActiveNav();
      highlightActiveTopic();
    });
  });
})();
