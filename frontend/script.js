/**
 * KaliNova — Main SPA Controller
 * Handles navigation, topic menus, modals, and routing initialization.
 *
 * The public site has no accounts: nobody can sign in, and articles are written
 * by administrators from /admin/dashboard rather than from this page.
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

  // The topics shown in the footer's "Discover" column (rendered statically in
  // index.html). They are filtered out of the dynamic "Explore" list so a topic
  // is never listed twice in the footer.
  const DISCOVER_SLUGS = new Set([
    "food-recipes", "sports", "education",
    "digital-technology", "cars-bikes", "history-facts"
  ]);

  async function renderTopicNav() {
    const list = $("#topic-list");
    if (!list) return;

    try {
      const res = await fetch("/api/categories");
      if (!res.ok) return;
      const { categories } = await res.json();

      list.querySelectorAll("li:not(:first-child)").forEach(li => li.remove());

      categories.forEach(c => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.className = "topic-chip";
        a.href = `/category/${c.slug}`;
        a.textContent = c.name;
        li.appendChild(a);
        list.appendChild(li);
      });

      const footerList = $("#footer-topic-list");
      if (footerList) {
        footerList.querySelectorAll("li:not(:first-child)").forEach(li => li.remove());
        categories.filter(c => !DISCOVER_SLUGS.has(c.slug)).forEach(c => {
          const li = document.createElement("li");
          const a = document.createElement("a");
          a.href = `/category/${c.slug}`;
          a.textContent = c.name;
          li.appendChild(a);
          footerList.appendChild(li);
        });
      }

      highlightActiveTopic();
      syncTopicStrip();
    } catch (e) {
      console.error("Failed to load topics:", e);
    }
  }

  /* Edge fade hints for the topic strip on narrow screens. Each side only fades
     when there is more content that way, so the first chip is never dimmed
     while the strip is already scrolled to the start. */
  function syncTopicStrip() {
    const nav = $(".topic-nav");
    const list = nav && $("#topic-list", nav);
    if (!list) return;

    const overflows = list.scrollWidth - list.clientWidth > 1;
    nav.classList.toggle("is-scroll-start", overflows && list.scrollLeft > 1);
    nav.classList.toggle("is-scroll-end", overflows && list.scrollLeft < list.scrollWidth - list.clientWidth - 1);
  }

  function highlightActiveTopic() {
    // Compare against the resolved route rather than location.hash, so the chip
    // still highlights now that navigation uses clean paths.
    const current = Router.getCurrentPath().split("?")[0].replace(/\/+$/, "") || "/";

    // The visible strip chips mark the current topic, so the active state is
    // unambiguous wherever the reader found the link.
    const links = $$("#topic-list .topic-chip");
    links.forEach(link => {
      const href = (link.getAttribute("href") || "").split("?")[0].replace(/\/+$/, "") || "/";
      link.classList.toggle("is-active", href === current);
      if (href === current) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
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
    link.addEventListener("click", closeMobileDrawer);
  });
  $$(".mobile-drawer-contact", mobileDrawer).forEach(link => {
    link.addEventListener("click", closeMobileDrawer);
  });

  function closeMobileDrawer() {
    mobileDrawer.hidden = true;
    mobileToggle.setAttribute("aria-expanded", "false");
    mobileDrawer.style.display = "none";
  }

  // Keep the edge fades honest as the strip scrolls, and as the viewport or the
  // chip count changes. Bound at init because #topic-list is empty until
  // renderTopicNav() resolves.
  const topicList = $("#topic-list");
  if (topicList) {
    topicList.addEventListener("scroll", syncTopicStrip, { passive: true });
    window.addEventListener("resize", syncTopicStrip);
  }

  /* ------------------------------------------------------------------ */
  /* Custom event listeners (for page components)                       */
  /* ------------------------------------------------------------------ */
  // Story writing is administrator-only and lives in /admin/dashboard, so no
  // public page dispatches an open-write event.
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
    highlightActiveNav();
    highlightActiveTopic();

    // The ad manifest is fetched before the first route renders.
    //
    // AdSlot.placeholder() is synchronous, so the manifest has to be in hand
    // before any page builds its HTML, otherwise a page would render without its
    // slots and only pick them up on the next navigation. On a site that is not
    // monetised the request returns an empty manifest immediately and the
    // renderer is unchanged; if the request fails, ads.js treats it as "no ads"
    // and the site still renders.
    const adsReady =
      window.KaliNovaAds && typeof window.KaliNovaAds.ready === "function"
        ? window.KaliNovaAds.ready()
        : Promise.resolve(null);

    // Same contract for the monetization manifest: fetched before the first
    // route, cached for the page load, all-off on failure. It also points the
    // sidebar newsletter card at the live subscribe endpoint, which is safe to
    // do even when there are no campaigns configured.
    const monetReady =
      window.KaliNovaMonetization && typeof window.KaliNovaMonetization.ready === "function"
        ? window.KaliNovaMonetization.ready()
        : Promise.resolve(null);

    Promise.all([adsReady, monetReady])
      .catch(() => null)
      .then(() => {
        Router.init();

        // Opt-in, consent-gated analytics. A silent no-op unless an operator
        // configured a GA4 id and the reader has granted consent (see
        // assets/analytics.js). It never blocks rendering.
        if (window.KaliNovaAnalytics) window.KaliNovaAnalytics.init();

        // After any navigation, push whatever placeholders the new page rendered.
        // pages.js also calls hydrate directly for the routes it owns, so this is
        // only a safety net for pages that do not.
        if (window.KaliNovaAds) window.KaliNovaAds.onRoute(() => window.KaliNovaAds.hydrateAll());
        if (window.KaliNovaMonetization) window.KaliNovaMonetization.onRoute(() => window.KaliNovaMonetization.hydrateAll());
      });

    // The router fires this for clean-path navigation too, so a hashchange
    // listener alone would miss most page changes.
    document.addEventListener("kal:route", () => {
      highlightActiveNav();
      highlightActiveTopic();
      syncTopicStrip();
      // The topic strip now sits directly below the hamburger, so navigating
      // must not leave the drawer hanging open over it.
      closeMobileDrawer();
    });
  });
})();
