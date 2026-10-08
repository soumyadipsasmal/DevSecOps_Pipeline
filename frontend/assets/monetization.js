/*
 * KaliNova — Monetization surfaces (frontend)
 *
 * The public counterpart of the admin Monetization dashboard. Exposed as
 * window.KaliNovaMonetization. Loaded on every page but a no-op by default:
 *
 *   - GET /api/monetization is fetched once per page load, cached, and treated
 *     as "all off" if it fails, so a broken database never blocks rendering.
 *   - Direct banner campaigns render into explicit placement slots and record
 *     anonymised impressions/clicks against the /api/ads/direct/* endpoints.
 *   - Article pages additionally read /api/articles/:id/monetization for a
 *     sponsored badge, the affiliate link list and the article's ad opt-out.
 *   - The sidebar newsletter form is pointed at the real subscribe endpoint.
 *
 * Nothing here renders Google marketing or any third-party script, and no ad
 * is ever shown unless the server said it is servable.
 */
(function () {
  "use strict";

  var MANIFEST_URL = "/api/monetization";
  var IMPRESSION_URL = "/api/ads/direct/impression";
  var CLICK_URL = "/api/ads/direct/click";

  var manifestPromise = null;
  var manifest = allOff();

  function allOff() {
    return {
      ads_active: false,
      consent_required: true,
      disclosures: {},
      newsletter: { enabled: false, can_send: false, provider: "", from_email: "" },
      direct_ads: {}
    };
  }

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /* A destination attribute may only be an allowed URL shape. */
  function safeHref(value) {
    var raw = String(value || "").trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^\//.test(raw)) return raw;
    return "#";
  }

  function safeImage(value) {
    var raw = String(value || "").trim();
    if (/^(?:https?:\/\/|\/)/i.test(raw)) return raw;
    return "";
  }

  function directAdsFor(placement) {
    var group = manifest.direct_ads && manifest.direct_ads[placement];
    if (!Array.isArray(group) || !group.length) return [];
    return group;
  }

  /* The first, highest-priority ad for a placement, or null. */
  function leadingAd(placement) {
    var ads = directAdsFor(placement);
    return ads.length ? ads[0] : null;
  }

  function adMarkup(ad) {
    var image = safeImage(ad.image_url);
    if (!image) return "";
    return (
      '<a class="monet-ad" href="' + esc(safeHref(ad.destination_url)) +
      '" data-monet-ad="' + esc(ad.id) + '" ' +
      'data-monet-ad-impression="' + esc(ad.id) + '" ' +
      'rel="sponsored noopener noreferrer" target="_blank" aria-label="' + esc(ad.image_alt || ad.name) + '">' +
      '<img src="' + esc(image) + '" alt="' + esc(ad.image_alt || ad.name) +
      '" loading="lazy" decoding="async">' +
      "</a>"
    );
  }

  /** The HTML for the leading direct ad of a placement, or "" when none. */
  function placeholder(placement) {
    var ad = leadingAd(placement);
    if (!ad) return "";
    var markup = adMarkup(ad);
    if (!markup) return "";
    return (
      '<aside class="monet-ad-slot monet-ad-slot--' + esc(String(placement).replace(/[^a-z0-9_-]/g, "")) + '"' +
      ' data-monet-placement="' + esc(placement) + '">' + markup + "</aside>"
    );
  }

  /* ------------------------------------------------------------------ */
  /* Tracking                                                           */
  /* ------------------------------------------------------------------ */

  function post(url, body) {
    // keepalive lets the click event finish recording even as the browser
    // follows the advertiser link.
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true
    }).catch(function () {
      /* Tracking must never block navigation or rendering. */
    });
  }

  function recordImpression(adId) {
    if (!adId) return;
    post(IMPRESSION_URL, { ad_id: adId });
  }

  function trackClick(adId, event) {
    post(CLICK_URL, { ad_id: adId });
    // Let the browser continue to the destination; tracking is fire-and-forget.
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  function fillContainers(root) {
    var scope = root || document;
    var containers = scope.querySelectorAll("[data-monet-placement]");
    Array.prototype.forEach.call(containers, function (container) {
      if (container.dataset.monetFilled === "1") return;
      var placement = container.getAttribute("data-monet-placement") || "";
      var ad = leadingAd(placement);
      var markup = ad ? adMarkup(ad) : "";
      container.dataset.monetFilled = "1";
      if (markup) container.innerHTML = markup;
    });
  }

  function bindClickTracking(root) {
    var scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll("[data-monet-ad]"), function (anchor) {
      if (anchor.dataset.monetClickBound === "1") return;
      anchor.dataset.monetClickBound = "1";
      anchor.addEventListener("click", function (event) {
        trackClick(anchor.getAttribute("data-monet-ad"), event);
      });
    });
  }

  function recordImpressions(root) {
    var scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll("[data-monet-ad-impression]"), function (node) {
      if (node.dataset.monetImpressionSent === "1") return;
      node.dataset.monetImpressionSent = "1";
      recordImpression(node.getAttribute("data-monet-ad-impression"));
    });
  }

  /** Fill containers, bind clicks and fire impressions inside root. */
  function hydrate(root) {
    fillContainers(root);
    bindClickTracking(root);
    recordImpressions(root);
  }

  function fillStatic() {
    var host = document.getElementById("monet-footer-ad");
    if (host && host.dataset.monetFilled !== "1") hydrate(host);
  }

  /* ------------------------------------------------------------------ */
  /* Article extras                                                     */
  /* ------------------------------------------------------------------ */

  function articleEndpoint(articleId, slug) {
    if (slug) return "/api/articles/slug/" + encodeURIComponent(slug) + "/monetization";
    if (articleId) return "/api/articles/" + encodeURIComponent(articleId) + "/monetization";
    return "";
  }

  /** The article's monetization payload, or null when unavailable. */
  function article(articleId, slug) {
    var url = articleEndpoint(articleId, slug);
    if (!url) return Promise.resolve(null);
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .catch(function () {
        return null;
      });
  }

  function sponsoredMarkup(payload) {
    if (!payload || !payload.sponsored) return "";
    var sp = payload.sponsored;
    var label = String(sp.label || "Sponsored");
    var name = String(sp.sponsor_name || "");
    var sponsor = sp.sponsor_url ? '<a href="' + esc(safeHref(sp.sponsor_url)) + '" rel="sponsored noopener noreferrer" target="_blank">' + esc(name) + "</a>" : esc(name);
    var disclosure = String(sp.disclosure || "");

    return (
      '<div class="monet-sponsored">' +
      '<span class="monet-sponsored-label">' + esc(label) + '</span>' +
      '<p class="monet-sponsored-body">' +
      (name ? "This story was produced in partnership with " + sponsor + "." : "This story was produced in partnership with a sponsor.") +
      (disclosure ? '<span class="monet-sponsored-disclosure">' + esc(disclosure) + "</span>" : "") +
      "</p>" +
      "</div>"
    );
  }

  function affiliateMarkup(payload) {
    if (!payload || !payload.affiliate_links || !payload.affiliate_links.length) return "";

    var items = payload.affiliate_links
      .map(function (link) {
        return (
          '<li class="monet-affiliate-link">' +
          '<a class="monet-affiliate-href" href="' + esc(safeHref(link.url)) + '" rel="sponsored noopener noreferrer">' +
          esc(link.name) + "</a>" +
          (link.network ? '<span class="monet-affiliate-network">' + esc(link.network) + "</span>" : "") +
          "</li>"
        );
      })
      .join("");

    var note = payload.disclosures && payload.disclosures.affiliate
      ? '<p class="monet-affiliate-note">' + esc(payload.disclosures.affiliate) + "</p>"
      : "";
    var perLink = payload.affiliate_links
      .map(function (link) {
        return link.disclosure_text ? '<p class="monet-affiliate-note">' + esc(link.disclosure_text) + "</p>" : "";
      })
      .join("");

    return (
      '<section class="monet-affiliate" aria-labelledby="monet-affiliate-heading">' +
      '<h2 class="monet-affiliate-heading" id="monet-affiliate-heading">Resources</h2>' +
      '<ul class="monet-affiliate-list">' + items + "</ul>" +
      (note || perLink ? '<div class="monet-affiliate-disclosures">' + note + perLink + "</div>" : "") +
      "</section>"
    );
  }

  /**
   * Fill a rendered article page with its monetization extras.
   *
   * Sponsored badge and affiliate links come from the payload; article direct
   * ads only fill when ads_enabled is true on the article. Everything is
   * optional and fails silently.
   */
  function renderArticleExtras(root, payload) {
    if (!payload) return;

    var adsEnabled = payload.ads_enabled !== false;

    if (adsEnabled) hydrate(root);

    var sponsored = sponsoredMarkup(payload);
    if (sponsored) {
      var contentBlock = root.querySelector(".article-detail-content");
      if (contentBlock) {
        contentBlock.insertAdjacentHTML("beforebegin", sponsored);
      }
    }

    var affiliate = affiliateMarkup(payload);
    if (affiliate) {
      var after = root.querySelector(".article-detail-content");
      if (after) {
        after.insertAdjacentHTML("afterend", affiliate);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Startup                                                            */
  /* ------------------------------------------------------------------ */

  function loadManifest() {
    if (manifestPromise) return manifestPromise;

    manifestPromise = fetch(MANIFEST_URL, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (response) {
        if (!response.ok) throw new Error("monetization manifest: " + response.status);
        return response.json();
      })
      .then(function (data) {
        manifest = normalise(data);
        return manifest;
      })
      .catch(function () {
        manifest = allOff();
        return manifest;
      });

    return manifestPromise;
  }

  /** Rebuild only the fields this file is willing to use. */
  function normalise(data) {
    if (!data || typeof data !== "object") return allOff();

    var direct = {};
    if (data.direct_ads && typeof data.direct_ads === "object") {
      Object.keys(data.direct_ads).forEach(function (placement) {
        var list = data.direct_ads[placement];
        if (!Array.isArray(list)) return;
        var safe = [];
        list.forEach(function (ad) {
          if (!ad || typeof ad !== "object") return;
          var id = Number(ad.id);
          var image = safeImage(ad.image_url);
          if (!Number.isInteger(id) || id <= 0 || !image) return;
          safe.push({
            id: id,
            name: String(ad.name || ""),
            advertiser_name: String(ad.advertiser_name || ""),
            image_url: image,
            image_alt: String(ad.image_alt || ""),
            destination_url: String(ad.destination_url || ""),
            priority: Number(ad.priority) || 100
          });
        });
        if (safe.length) direct[placement] = safe;
      });
    }

    var disclosures = {};
    if (data.disclosures && typeof data.disclosures === "object") {
      ["affiliate", "sponsored", "advertising", "privacy"].forEach(function (key) {
        if (typeof data.disclosures[key] === "string") disclosures[key] = data.disclosures[key];
      });
    }

    var newsletter = { enabled: false, can_send: false, provider: "", from_email: "" };
    if (data.newsletter && typeof data.newsletter === "object") {
      newsletter.enabled = data.newsletter.enabled === true;
      newsletter.can_send = data.newsletter.can_send === true;
      newsletter.provider = String(data.newsletter.provider || "");
      newsletter.from_email = String(data.newsletter.from_email || "");
    }

    return {
      ads_active: data.ads_active === true,
      consent_required: data.consent_required !== false,
      disclosures: disclosures,
      newsletter: newsletter,
      direct_ads: direct
    };
  }

  /** Called once at startup, before the first route renders. */
  function ready() {
    return loadManifest().then(function (m) {
      // The sidebar newsletter card can now reach the real endpoint. Subscribe
      // stores a row server-side; a configured provider is a separate concern.
      if (window.KaliNovaSidebar && window.KaliNovaSidebar.setEndpoint) {
        window.KaliNovaSidebar.setEndpoint("/api/newsletter/subscribe");
      }
      fillStatic();
      return m;
    });
  }

  /* Observers re-run on every route so new pages pick up their slots. */
  var observers = [];

  function onRoute(fn) {
    if (typeof fn === "function") observers.push(fn);
  }

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

  window.KaliNovaMonetization = {
    ready: ready,
    placeholder: placeholder,
    article: article,
    hydrate: hydrate,
    hydrateAll: hydrateAll,
    onRoute: onRoute,
    renderArticleExtras: renderArticleExtras,
    get manifest() {
      return manifest;
    }
  };
})();