/**
 * KaliNova — optional, consent-gated Google Analytics 4 loader
 *
 * The site ships with analytics OFF: no measurement id is configured by
 * default, so this module loads the config, sees `enabled: false` and stops.
 * When an operator sets GA_MEASUREMENT_ID (and leaves ENABLE_ANALYTICS on), the
 * loader still refuses to reach Google until
 *
 *   * the reader is not sending Do Not Track or Global Privacy Control, and
 *   * the reader has granted advertising consent through the existing banner
 *     (frontend/assets/ads.js), which stores the choice under
 *     `kalinova:ads-consent`.
 *
 * Nothing here is a hard dependency: every failure is swallowed so a blocked
 * request or a missing endpoint never disturbs a reader. The public CSP in
 * frontend/_headers has to allow the Google Analytics origins in the same
 * deploy, or the injected script is refused (see that file).
 */
(() => {
  "use strict";

  const CONFIG_URL = "/api/analytics/config";
  const GA_SCRIPT_URL = "https://www.googletagmanager.com/gtag/js";

  const state = {
    loaded: false,
    measurementId: "",
    consentRequired: true,
    seenPaths: new Set()
  };

  /** Do Not Track / GPC is a reader decision that overrides everything. */
  function privacySignalSet() {
    const dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
    if (dnt === "1" || dnt === "yes") return true;
    return navigator.globalPrivacyControl === true;
  }

  /** Reuse the ad-consent choice rather than asking the reader twice. */
  function consentGiven() {
    const ads = window.KaliNovaAds;
    return !!(ads && typeof ads.consentGiven === "function" && ads.consentGiven());
  }

  /** Inject gtag once. `send_page_view: false` so the SPA owns pageviews. */
  function inject(measurementId) {
    if (state.loaded) return;

    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      // The real gtag pushes the arguments object, not an array.
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());
    window.gtag("config", measurementId, {
      anonymize_ip: true,
      send_page_view: false
    });

    const script = document.createElement("script");
    script.async = true;
    script.src = `${GA_SCRIPT_URL}?id=${encodeURIComponent(measurementId)}`;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    document.head.appendChild(script);

    state.loaded = true;
    state.measurementId = measurementId;
  }

  /** One page_view per path, driven by the router's kal:route event. */
  function trackPageView(location) {
    if (!state.loaded || typeof window.gtag !== "function") return;

    const detail = location || {};
    const path = detail.path || window.location.pathname;
    const search = detail.search || window.location.search || "";
    const pagePath = `${path}${search}`;

    if (state.seenPaths.has(pagePath)) return;
    state.seenPaths.add(pagePath);

    window.gtag("event", "page_view", {
      page_path: pagePath,
      page_location: `${window.location.origin}${pagePath}`,
      page_title: document.title
    });
  }

  let starting = false;

  /** Load config once and, if everything allows it, start measuring. */
  function init() {
    if (state.loaded || starting || privacySignalSet()) return Promise.resolve(false);
    starting = true;

    return fetch(CONFIG_URL, { headers: { Accept: "application/json" } })
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        starting = false;
        if (!data || !data.enabled || !data.measurement_id) return false;
        if (data.consent_required !== false && !consentGiven()) return false;

        state.consentRequired = data.consent_required !== false;
        inject(data.measurement_id);
        trackPageView({ path: window.location.pathname, search: window.location.search });
        document.addEventListener("kal:route", event => trackPageView(event.detail));
        return true;
      })
      .catch(() => {
        starting = false;
        return false;
      });
  }

  // A reader who accepts the ad banner after the first attempt still starts
  // measuring without a reload. Nobody is measured before they agree.
  document.addEventListener("kal:consent", event => {
    if (event && event.detail && event.detail.granted) init();
  });

  window.KaliNovaAnalytics = {
    init,
    trackPageView,
    isEnabled: () => state.loaded
  };
})();
