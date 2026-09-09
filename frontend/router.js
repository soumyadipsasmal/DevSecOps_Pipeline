/**
 * KaliNova — Hash-based SPA Router
 * Routes: #/ , #/stories, #/guest-posts, #/cv, #/news, #/portfolio,
 *         #/marketplace, #/search, #/dashboard, #/profile/:id, #/settings
 */
(() => {
  "use strict";

  const routes = {};
  let currentRoute = null;

  window.Router = {
    register(path, handler) {
      routes[path] = handler;
    },

    navigate(path) {
      window.location.hash = path;
    },

    getParam(name) {
      const hash = window.location.hash.slice(1);
      const segments = hash.split("/").filter(Boolean);
      if (name === "slug" && segments.length >= 2) return segments[1];
      if (name === "id" && segments.length >= 2) return segments[1];
      return null;
    },

    getCurrentPath() {
      return window.location.hash.slice(1) || "/";
    },

    matchRoute(path) {
      if (routes[path]) return { handler: routes[path], params: {} };
      const segments = path.split("/").filter(Boolean);
      for (const pattern of Object.keys(routes)) {
        const patternSegments = pattern.split("/").filter(Boolean);
        if (patternSegments.length !== segments.length) continue;
        const params = {};
        let match = true;
        for (let i = 0; i < patternSegments.length; i++) {
          if (patternSegments[i].startsWith(":")) {
            params[patternSegments[i].slice(1)] = segments[i];
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
      const path = window.location.hash.slice(1) || "/";
      const matched = Router.matchRoute(path);
      if (matched) {
        currentRoute = path;
        matched.handler(matched.params);
      }
    },

    init() {
      window.addEventListener("hashchange", () => Router.handleRoute());
      Router.handleRoute();
    }
  };
})();
