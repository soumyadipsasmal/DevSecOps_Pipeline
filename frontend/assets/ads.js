/*
 * KaliNova — Ad slots
 *
 * A reusable, no-op-by-default ad component. Exposed as window.KaliNovaAds.
 *
 * The site is not monetised. This file ships with no publisher ID, no slot ID
 * and no third-party script URL. Every one of those comes from GET /api/ads at
 * runtime, and that endpoint returns an empty manifest until an administrator
 * has saved a real publisher ID and switched ads on. So on a fresh deployment:
 *
 *   - no request is made to any Google host
 *   - AdSlot(...).markup() returns an empty string
 *   - nothing is added to the DOM
 *
 * Two rules matter more than the rendering itself:
 *
 *   1. Nothing renders unless the manifest says so. AdSlot is not given an ID;
 *      it is given a placement key, and the server decides what that means.
 *   2. A Google failure is invisible. If the script never loads, the reserved
 *      height collapses to nothing and the article reads normally. No error UI,
 *      no broken box, no retry loop.
 *
 * Usage:
 *   KaliNovaAds.placeholder("sidebar-top", { minHeight: 250 })   // returns HTML
 *   KaliNovaAds.hydrate(root)                                    // after render
 *
 * hydrate() is what actually pushes to adsbygoogle, and only after the script
 * is confirmed loaded. Nothing runs on page load by itself.
 */
(function () {
  "use strict";

  var MANIFEST_URL = "/api/ads";
  var GOOGLE_SCRIPT_SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";

  /* ------------------------------------------------------------------ */
  /* Manifest                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Fetch the manifest once per page load.
   *
   * The promise is cached, including the failure case: if the request fails we
   * remember that and never retry, because a site whose database is down should
   * not keep asking. The site simply has no ads.
   */
  var manifestPromise = null;
  var manifest = { enabled: false, consent_required: true, publisher_id: "", ads: [] };

  function loadManifest() {
    if (manifestPromise) return manifestPromise;

    manifestPromise = fetch(MANIFEST_URL, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (response) {
        if (!response.ok) throw new Error("ads manifest: " + response.status);
        return response.json();
      })
      .then(function (data) {
        manifest = normaliseManifest(data);
        return manifest;
      })
      .catch(function () {
        // All-off, permanently for this page load. See the note above.
        manifest = { enabled: false, consent_required: true, publisher_id: "", ads: [] };
        return manifest;
      });

    return manifestPromise;
  }

  /** Trust nothing from the network: rebuild the shape we are willing to use. */
  function normaliseManifest(data) {
    var empty = { enabled: false, consent_required: true, publisher_id: "", ads: [] };
    if (!data || typeof data !== "object") return empty;

    var slots = [];
    if (Array.isArray(data.ads)) {
      for (var i = 0; i < data.ads.length; i += 1) {
        var ad = data.ads[i];
        if (!ad || typeof ad !== "object") continue;

        var key = typeof ad.placement === "string" ? ad.placement : "";
        // A slot id becomes an attribute value, so only digits are accepted.
        var slot = typeof ad.slot === "string" ? ad.slot.replace(/[^0-9]/g, "") : "";
        if (!key || !slot) continue;

        slots.push({
          placement: key,
          slot: slot,
          client: typeof ad.client === "string" ? ad.client : "",
          show_desktop: ad.show_desktop !== false,
          show_mobile: ad.show_mobile !== false,
          min_height: Number(ad.min_height) > 0 ? Number(ad.min_height) : 0,
          content_position:
            typeof ad.content_position === "number" ? ad.content_position : null
        });
      }
    }

    return {
      // enabled only if the server said so *and* there is something to show.
      enabled: data.enabled === true && slots.length > 0,
      consent_required: data.consent_required !== false,
      publisher_id: typeof data.publisher_id === "string" ? data.publisher_id : "",
      ads: slots
    };
  }

  /**
   * The configured in-content position for a placement key, as a percentage, or
   * null when that placement has no content position set.
   *
   * Returned separately from slotFor() because callers need the position to
   * resolve where the slot lands, which is a decision the server does not make.
   */
  function positionOf(key) {
    var slot = slotFor(key);
    if (!slot) return null;
    return typeof slot.content_position === "number" ? slot.content_position : null;
  }

  /** The configured slot for a placement key, or null. */
  function slotFor(key) {
    if (!manifest.enabled) return null;
    if (manifest.consent_required && !consentGiven()) return null;

    for (var i = 0; i < manifest.ads.length; i += 1) {
      if (manifest.ads[i].placement === key) return manifest.ads[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Consent                                                             */
  /* ------------------------------------------------------------------ */

  var CONSENT_KEY = "kalinova:ads-consent";

  function readConsent() {
    try {
      var raw = window.localStorage.getItem(CONSENT_KEY);
      if (raw === "granted") return true;
      if (raw === "denied") return false;
    } catch (err) {
      /* Private browsing or storage disabled: treat as not granted. */
    }
    return null;
  }

  function writeConsent(value) {
    try {
      window.localStorage.setItem(CONSENT_KEY, value);
    } catch (err) {
      /* Storage unavailable: the banner will ask again next page. */
    }
  }

  function consentGiven() {
    return readConsent() === true;
  }

  function grantConsent() {
    writeConsent("granted");
    hideBanner();
    hydrateAll();
    /* A single, decryptable signal lets the optional analytics loader begin
       only after the reader has actually agreed (see assets/analytics.js). */
    document.dispatchEvent(new CustomEvent("kal:consent", { detail: { granted: true } }));
  }

  function denyConsent() {
    writeConsent("denied");
    hideBanner();
    document.dispatchEvent(new CustomEvent("kal:consent", { detail: { granted: false } }));
  }

  /* ------------------------------------------------------------------ */
  /* Markup                                                              */
  /* ------------------------------------------------------------------ */

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  /**
   * Placeholder markup for one placement.
   *
   * Returns "" when there is no ad, which is the expected result on a site that
   * has not been monetised. Call sites interpolate it directly, so an empty
   * string leaves no trace in the document.
   *
   * minHeight comes from the placement config. Reserving it up front is what
   * stops the article reflowing once the ad arrives.
   */
  function placeholder(key, options) {
    var opts = options || {};
    var slot = slotFor(key);

    if (!slot) return "";

    var reserved = slot.min_height || Number(opts.minHeight) || 0;
    var zoneClass = opts.className ? " " + opts.className.replace(/[^a-zA-Z0-9 _-]/g, "") : "";

    return (
      '<aside class="ad-slot ad-slot--' + esc(key) + zoneClass + '"' +
      ' data-ad-placement="' + esc(key) + '"' +
      ' data-ad-slot="' + esc(slot.slot) + '"' +
      ' data-ad-client="' + esc(slot.client) + '"' +
      ' data-ad-desktop="' + (slot.show_desktop ? "1" : "0") + '"' +
      ' data-ad-mobile="' + (slot.show_mobile ? "1" : "0") + '"' +
      (reserved > 0 ? ' style="min-height:' + reserved + 'px"' : "") +
      ' aria-label="Advertisement">' +
      '<ins class="adsbygoogle" style="display:block"' +
      ' data-ad-client="' + esc(slot.client) + '"' +
      ' data-ad-slot="' + esc(slot.slot) + '"' +
      ' data-ad-format="auto" data-full-width-responsive="true"></ins>' +
      "</aside>"
    );
  }

  /**
   * Placement for an in-content slot, given a whole number of blocks already
   * rendered.
   *
   * The position is a percentage of the article body, resolved against block
   * boundaries. A paragraph is never split: if the percentage lands mid-paragraph
   * the ad simply goes after that block.
   */
  function inArticle(key, blockCount, options) {
    var opts = options || {};
    var slot = slotFor(key);
    if (!slot) return "";

    if (typeof opts.contentPosition !== "number") return "";
    if (blockCount < 3) return ""; // Too short to interrupt sensibly.

    var target = Math.round((blockCount * opts.contentPosition) / 100);
    if (target < 1) target = 1;
    if (target > blockCount - 1) target = blockCount - 1;

    return {
      afterBlock: target,
      markup: placeholder(key, options)
    };
  }

  /* ------------------------------------------------------------------ */
  /* Delivery                                                            */
  /* ------------------------------------------------------------------ */

  var scriptPromise = null;

  /**
   * Load adsbygoogle.js once, if it is allowed.
   *
   * The source URL is a constant here but the script is only ever requested when
   * the manifest has a real publisher id and the reader has consented, so a
   * default installation never contacts Google.
   */
  function loadScript() {
    if (scriptPromise) return scriptPromise;

    if (!manifest.enabled || !manifest.publisher_id || !consentGiven()) {
      return Promise.resolve(false);
    }

    scriptPromise = new Promise(function (resolve) {
      var existing = document.querySelector(
        'script[src="' + GOOGLE_SCRIPT_SRC + '"]'
      );
      if (existing) {
        if (existing.getAttribute("data-loaded") === "1") return resolve(true);
        existing.addEventListener("load", function () {
          existing.setAttribute("data-loaded", "1");
          resolve(true);
        });
        existing.addEventListener("error", function () {
          resolve(false);
        });
        return undefined;
      }

      var script = document.createElement("script");
      script.async = true;
      script.crossOrigin = "anonymous";
      script.src = GOOGLE_SCRIPT_SRC;
      script.setAttribute("data-loaded", "0");

      script.addEventListener("load", function () {
        script.setAttribute("data-loaded", "1");
        resolve(true);
      });
      script.addEventListener("error", function () {
        // Blocked by an extension, an ad blocker or the CSP: give up quietly.
        resolve(false);
      });

      document.head.appendChild(script);
      return undefined;
    });

    return scriptPromise;
  }

  function viewportIsMobile() {
    return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
  }

  /**
   * Push the slots inside root to the network.
   *
   * Each <ins> is pushed in its own try/catch, so one slot that the network
   * dislikes cannot stop the others from filling. A slot that never fills keeps
   * its reserved height: holding the space is less jarring than the article
   * jumping once the ad fails.
   */
  function hydrate(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll(".ad-slot");

    if (!nodes.length) return Promise.resolve(false);

    loadScript().then(function (loaded) {
      if (!loaded || !window.adsbygoogle) return;

      Array.prototype.forEach.call(nodes, function (node) {
        var desktopOk = node.getAttribute("data-ad-desktop") === "1";
        var mobileOk = node.getAttribute("data-ad-mobile") === "1";

        var wanted = viewportIsMobile() ? mobileOk : desktopOk;
        if (!wanted) {
          node.style.display = "none";
          return;
        }

        var ins = node.querySelector("ins.adsbygoogle");
        if (!ins || ins.getAttribute("data-pushed") === "1") return;

        try {
          ins.setAttribute("data-pushed", "1");
          (window.adsbygoogle = window.adsbygoogle || []).push({});
        } catch (err) {
          /* One bad slot must not affect the others. */
          ins.removeAttribute("data-pushed");
        }
      });
    });

    return Promise.resolve(true);
  }

  /**
   * Rework the placeholders inside root once a route renders.
   *
   * AdSlot renders its markup synchronously, which means the manifest has to be
   * in hand first. Call sites therefore await ready() during startup rather than
   * paying for a second pass over the DOM.
   */
  var observers = [];

  function hydrateAll() {
    for (var i = 0; i < observers.length; i += 1) {
      try {
        observers[i]();
      } catch (err) {
        /* A broken observer must not stop the others. */
      }
    }
    return hydrate(document);
  }

  /* ------------------------------------------------------------------ */
  /* Consent banner                                                      */
  /* ------------------------------------------------------------------ */

  var banner = null;

  function consentDecided() {
    return readConsent() !== null;
  }

  function buildBanner() {
    if (banner || !manifest.enabled) return;
    if (consentDecided()) return;

    var el = document.createElement("div");
    el.className = "ad-consent";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-label", "Advertising consent");

    // Copy is built with textContent, not innerHTML: nothing is injected.
    var text = document.createElement("p");
    text.className = "ad-consent-text";
    text.textContent =
      "KaliNova does not run advertising today. When it does, this site will use cookies and similar " +
      "technologies to personalise ads and measure them. Choose accept to allow ad data, or continue " +
      "without to keep ads switched off.";

    var actions = document.createElement("div");
    actions.className = "ad-consent-actions";

    var accept = document.createElement("button");
    accept.type = "button";
    accept.className = "ad-consent-button ad-consent-button--accept";
    accept.textContent = "Accept ad data";

    var decline = document.createElement("button");
    decline.type = "button";
    decline.className = "ad-consent-button";
    decline.textContent = "Continue without";

    var policy = document.createElement("a");
    policy.className = "ad-consent-link";
    policy.href = "/privacy";
    policy.textContent = "Privacy policy";

    accept.addEventListener("click", grantConsent);
    decline.addEventListener("click", denyConsent);

    actions.appendChild(policy);
    actions.appendChild(decline);
    actions.appendChild(accept);

    el.appendChild(text);
    el.appendChild(actions);
    document.body.appendChild(el);
    banner = el;
  }

  function hideBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  /**
   * Load the manifest and build the consent banner if it is needed.
   *
   * Called once from startup. Because the manifest is empty on an unmonetised
   * site, this resolves quickly and does nothing visible.
   */
  /**
   * The footer is static markup in index.html rather than something a route
   * renders, so it is filled once after the manifest arrives.
   *
   * An empty placeholder() result leaves the container untouched, so the footer
   * gains no empty box on an unmonetised site.
   */
  function fillStaticPlacements() {
    var host = document.getElementById("footer-ad-slot");
    if (!host || host.dataset.adFilled === "1") return;

    var markup = placeholder("footer");
    if (!markup) return;

    host.innerHTML = markup;
    host.dataset.adFilled = "1";
  }

  function ready() {
    return loadManifest().then(function () {
      fillStaticPlacements();
      buildBanner();
      return manifest;
    });
  }

  /** Register a callback that re-renders placeholders after a route change. */
  function onRoute(fn) {
    if (typeof fn === "function") observers.push(fn);
  }

  window.KaliNovaAds = {
    // Ready for a caller to read. Never rejects.
    ready: ready,
    // HTML for one placement, or "" when there is no ad there.
    placeholder: placeholder,
    // In-content slot resolved against whole blocks, or "" / null.
    inArticle: inArticle,
    // Push placeholders in a root to the network.
    hydrate: hydrate,
    hydrateAll: hydrateAll,
    onRoute: onRoute,
    positionOf: positionOf,
    // Consent, exposed so a settings screen can change its mind.
    grant: grantConsent,
    deny: denyConsent,
    consentGiven: consentGiven,
    // The loaded manifest, for tests and for debugging.
    get manifest() {
      return manifest;
    }
  };
})();