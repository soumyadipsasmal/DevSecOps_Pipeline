/**
 * KaliNova — SPA Router
 *
 * Canonical routes are real paths (/about, /blog/my-slug). Hash routes
 * (#/about) are still accepted so existing links keep working, but they are
 * upgraded to the clean path as soon as the app boots, so there is only ever
 * one indexable URL per page.
 *
 * Routes: / , /blog, /stories, /blog/:slug, /guest-posts, /news, /category/:slug,
 *         /portfolio, /marketplace, /cv, /search, /dashboard,
 *         /profile/:id, /settings, /about, /services, /contact, /careers
 */
(() => {
  "use strict";

  const routes = {};
  let currentRoute = null;
  let notFoundHandler = null;

  /* If the app is mounted in a subdirectory, strip it before matching so the
     route table stays written in clean, root-relative terms. */
  const basePath = (() => {
    const script = document.currentScript;
    if (!script || !script.src) return "";
    try {
      const dir = new URL(".", script.src).pathname;
      return dir === "/" ? "" : dir.replace(/\/$/, "");
    } catch {
      return "";
    }
  })();

  /** Strip a leading "#" and "/" so both "#/about" and "/about" are accepted. */
  function normalize(input) {
    let path = String(input || "");
    if (path.startsWith("#")) path = path.slice(1);
    if (!path.startsWith("/")) path = `/${path}`;
    return path.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  }

  function stripBase(pathname) {
    if (!basePath) return pathname;
    if (pathname === basePath) return "/";
    if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
    return pathname;
  }

  /**
   * Resolve the active route.
   *
   * A hash wins when present, which is what keeps legacy #/ links alive. The
   * query string is tracked separately so /search?q= works on clean paths.
   */
  function resolveLocation() {
    const hash = window.location.hash;
    const search = window.location.search || "";

    // Only "#/..." is a legacy route. A plain "#anchor" is an in-page link and
    // must never be resolved against the route table.
    if (hash.startsWith("#/")) {
      const [rawPath, rawQuery = ""] = hash.slice(1).split("?");
      const query = rawQuery || search.replace(/^\?/, "");
      return {
        path: normalize(rawPath),
        search: query ? `?${query}` : "",
        query: new URLSearchParams(query),
        legacy: true,
      };
    }

    return {
      path: normalize(stripBase(window.location.pathname)),
      search,
      query: new URLSearchParams(search),
      legacy: false,
    };
  }

  function toHref(path, search) {
    const clean = normalize(path);
    return `${basePath}${clean}${search || ""}`;
  }

  const Router = {
    register(path, handler) {
      routes[normalize(path)] = handler;
    },

    onNotFound(handler) {
      notFoundHandler = handler;
    },

    /**
     * Client-side navigation. Accepts "/about" or the legacy "#/about".
     * `replace` swaps the current history entry, which is what legacy-URL
     * upgrades want.
     */
    navigate(path, options = {}) {
      const raw = String(path || "");
      const queryIndex = raw.indexOf("?");
      const clean = normalize(queryIndex === -1 ? raw : raw.slice(0, queryIndex));
      const search = queryIndex === -1 ? "" : `?${raw.slice(queryIndex + 1)}`;
      const href = toHref(clean, search);

      // Nothing to do if we are already there — but still re-run the handler so
      // a fresh click behaves like a reload.
      if (window.location.pathname + window.location.search === href) {
        Router.handleRoute();
        return;
      }

      if (options.replace) {
        window.history.replaceState({}, "", href);
      } else {
        window.history.pushState({}, "", href);
      }
      Router.handleRoute();
    },

    getCurrentPath() {
      const { path, search } = resolveLocation();
      return `${path}${search}`;
    },

    /** Query string parameters of the active route. */
    getQuery() {
      return resolveLocation().query;
    },

    getParam(name) {
      const { path } = resolveLocation();
      const segments = path.split("/").filter(Boolean);
      return segments.length >= 2 ? decodeURIComponent(segments[1]) : null;
    },

    matchRoute(path) {
      const clean = normalize(path);
      if (routes[clean]) return { handler: routes[clean], params: {} };

      const segments = clean.split("/").filter(Boolean);
      for (const pattern of Object.keys(routes)) {
        const patternSegments = pattern.split("/").filter(Boolean);
        if (patternSegments.length !== segments.length) continue;

        const params = {};
        let match = true;
        for (let i = 0; i < patternSegments.length; i++) {
          if (patternSegments[i].startsWith(":")) {
            params[patternSegments[i].slice(1)] = decodeURIComponent(segments[i]);
          } else if (patternSegments[i] !== segments[i]) {
            match = false;
            break;
          }
        }
        if (match) return { handler: routes[pattern], params };
      }
      return null;
    },

    handleRoute() {
      const { path, search, query, legacy } = resolveLocation();
      const matched = Router.matchRoute(path);

      if (!matched) {
        currentRoute = path;
        if (notFoundHandler) notFoundHandler(path);
        return;
      }

      currentRoute = path;

      // A legacy #/ URL that maps 1:1 onto a clean path gets upgraded in place,
      // so the address bar, the canonical tag and the sitemap all agree.
      if (legacy && !path.includes(":")) {
        const known = Object.keys(routes).some(r => r === path);
        if (known) {
          window.history.replaceState({}, "", toHref(path, search));
        }
      }

      matched.handler(matched.params, { path, search, query });

      document.dispatchEvent(
        new CustomEvent("kal:route", { detail: { path, search, query } })
      );
    },

    /**
     * Intercept same-origin links so navigation stays client-side. Modified
     * clicks, downloads, external hosts and in-page anchors are left alone so
     * "open in new tab" and permalink copying keep working.
     */
    interceptLinks() {
      document.addEventListener("click", event => {
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const link = event.target.closest && event.target.closest("a[href]");
        if (!link) return;
        if (link.target && link.target !== "_self") return;
        if (link.hasAttribute("download")) return;
        if (link.getAttribute("rel") === "external") return;

        const raw = link.getAttribute("href");
        if (!raw || raw === "#") return;

        const isHashRoute = raw.startsWith("#/");
        const isPathRoute = raw.startsWith("/") && !raw.startsWith("//");

        if (!isHashRoute && !isPathRoute) return;

        event.preventDefault();
        Router.navigate(raw);
      });
    },

    init() {
      window.addEventListener("popstate", () => Router.handleRoute());
      window.addEventListener("hashchange", () => Router.handleRoute());
      Router.interceptLinks();
      Router.handleRoute();
    },
  };

  window.Router = Router;
})();