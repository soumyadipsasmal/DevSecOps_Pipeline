/* KaliNova — open-data sections (optional, fail-silent)
 *
 * Two page decorations that depend on endpoints the backend may or may not be
 * able to answer right now:
 *
 *   hydrateTravelMap()    destination cards + Leaflet map on /category/travel
 *   hydrateNewsHeadlines() reviewed RSS headline strip on /news
 *
 * Contract for everything in this file:
 *   - the page is complete and readable before this code runs; each section
 *     appends itself only after its data arrives, and simply does not exist
 *     when the data does not (no error states, no spinners left behind)
 *   - Leaflet is vendored at /vendor/leaflet and injected lazily, because the
 *     public CSP is script-src 'self' — there is no CDN to fall back to
 *   - every dynamic string goes through esc() before it touches innerHTML
 *   - external links open with rel="noopener noreferrer" and carry the
 *     attribution the source licence asks for
 *   - coordinates come from the server (Nominatim, rate-limited and cached
 *     there); the browser never queries a geocoder itself
 */
(function () {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("request failed: " + res.status);
    return res.json();
  }

  function pageContainer() {
    return document.querySelector("#app .page-container");
  }

  function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  /* ---------------------------------------------------------------- */
  /* Leaflet (vendored, lazy)                                          */
  /* ---------------------------------------------------------------- */

  let leafletPromise = null;

  function loadLeaflet() {
    if (window.L) return Promise.resolve(true);
    if (leafletPromise) return leafletPromise;

    leafletPromise = new Promise(resolve => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/vendor/leaflet/leaflet.css";
      document.head.appendChild(link);

      const script = document.createElement("script");
      script.src = "/vendor/leaflet/leaflet.js";
      script.onload = () => resolve(true);
      script.onerror = () => {
        // Let a later navigation try again instead of caching the failure.
        leafletPromise = null;
        resolve(false);
      };
      document.head.appendChild(script);
    });

    return leafletPromise;
  }

  /* ---------------------------------------------------------------- */
  /* Travel map (/category/travel)                                     */
  /* ---------------------------------------------------------------- */

  /* Session cache: geocoding is expensive (server-side Nominatim, one request
     per second), so a reader moving between pages must not repeat it. */
  const placeCache = new Map();

  async function resolvePoint(query) {
    if (placeCache.has(query)) return placeCache.get(query);
    try {
      const data = await getJson("/api/geo/place?q=" + encodeURIComponent(query));
      const point = data && data.results && data.results[0] ? data.results[0] : null;
      placeCache.set(query, point);
      return point;
    } catch (error) {
      // A failed lookup is cached as null too, for this session only: the
      // server keeps its own 90-day entry when it did get an answer.
      placeCache.set(query, null);
      return null;
    }
  }

  function travelSectionMarkup(destinations) {
    const cards = destinations
      .map(dest => {
        const chips = (dest.places || [])
          .map(place => `<li class="destination-chip">${esc(place.name)}</li>`)
          .join("");
        const source = dest.wikidataId
          ? `<a class="destination-source" href="https://www.wikidata.org/wiki/${encodeURIComponent(dest.wikidataId)}" target="_blank" rel="noopener noreferrer">View on Wikidata</a>`
          : "";
        return `
          <article class="destination-card" data-destination="${esc(dest.id)}">
            <h3 class="destination-name">${esc(dest.name)}</h3>
            ${dest.region ? `<p class="destination-region">${esc(dest.region)}</p>` : ""}
            <p class="destination-blurb" data-blurb hidden></p>
            ${chips ? `<ul class="destination-chips">${chips}</ul>` : ""}
            ${source}
          </article>`;
      })
      .join("");

    return `
      <section class="open-data-section" id="travel-map-section" aria-label="Destination map">
        <div class="open-data-header">
          <h2 class="open-data-title">Destinations on the map</h2>
          <p class="open-data-note">Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a> &middot; destination facts from <a href="https://www.wikidata.org/" target="_blank" rel="noopener noreferrer">Wikidata</a> (CC0)</p>
        </div>
        <div class="destination-cards">${cards}</div>
        <div class="travel-map-wrap" id="travel-map-wrap">
          <div id="travel-map" class="travel-map" aria-label="Map of travel destinations" hidden></div>
          <p class="travel-map-status" id="travel-map-status" hidden>Loading map&hellip;</p>
        </div>
      </section>`;
  }

  async function fetchWikidataBlurb(dest) {
    if (!dest.wikidataId) return null;
    try {
      const entity = await getJson("/api/wikidata/entity/" + encodeURIComponent(dest.wikidataId));
      return entity && entity.description ? entity.description : null;
    } catch (error) {
      return null;
    }
  }

  /* Text-destination fallback. Literate, zero-network and always available:
     it exists so the travel section is never a blank canvas when map tiles are
     down or the maps feature is switched off. */
  function locationIndexMarkup(destinations) {
    const entries = destinations
      .map(dest => {
        const chips = (dest.places || [])
          .map(place => `<li class="destination-chip">${esc(place.name)}</li>`)
          .join("");
        const source = dest.wikidataId
          ? `<a class="destination-source" href="https://www.wikidata.org/wiki/${encodeURIComponent(dest.wikidataId)}" target="_blank" rel="noopener noreferrer">View on Wikidata</a>`
          : "";
        return `
          <li class="travel-index-entry">
            <h3 class="destination-name">${esc(dest.name)}</h3>
            ${dest.region ? `<p class="destination-region">${esc(dest.region)}</p>` : ""}
            ${chips ? `<ul class="destination-chips">${chips}</ul>` : ""}
            ${source}
          </li>`;
      })
      .join("");

    return `<p class="open-data-note" role="status">The map cannot be shown right now (the tile service is unavailable or switched off); here are the destinations as plain text instead.</p>
      <ul class="travel-index">${entries}</ul>`;
  }

  function renderLocationIndex(destinations) {
    const wrap = document.getElementById("travel-map-wrap");
    const status = document.getElementById("travel-map-status");
    if (status) status.remove();
    if (!wrap) return;
    wrap.innerHTML = locationIndexMarkup(destinations);
  }

  function renderMap(mapConfig, destinations, points) {
    const container = document.getElementById("travel-map");
    const status = document.getElementById("travel-map-status");
    if (status) status.remove();

    if (!container || !window.L || !points.length) {
      if (container) container.remove();
      return;
    }

    // Tiles are fetched by the browser, so the server's breaker cannot be the
    // only guard: if the first tiles never arrive (or error out), the section
    // quietly degrades to the text index instead of a blank map frame.
    let tileLoads = 0;
    let tileFails = 0;
    let degraded = false;

    const degrade = () => {
      if (degraded) return;
      degraded = true;
      const wrap = document.getElementById("travel-map-wrap");
      if (wrap) wrap.innerHTML = locationIndexMarkup(destinations);
      try {
        map.remove();
      } catch (error) {
        /* already removed */
      }
    };

    const tileFailTimer = window.setTimeout(() => {
      if (tileLoads === 0) degrade();
    }, 5000);

    container.hidden = false;

    const map = window.L.map(container, {
      scrollWheelZoom: false,
      attributionControl: true
    });

    const attribution =
      mapConfig.attributionUrl && /^https:\/\//.test(mapConfig.attributionUrl)
        ? `<a href="${esc(mapConfig.attributionUrl)}" target="_blank" rel="noopener noreferrer">${esc(mapConfig.attribution)}</a>`
        : esc(mapConfig.attribution);

    const layer = window.L.tileLayer(mapConfig.tileUrl, {
      maxZoom: Number(mapConfig.maxZoom) || 19,
      attribution
    });
    layer.on("tileload", () => {
      tileLoads += 1;
      window.clearTimeout(tileFailTimer);
    });
    layer.on("tileerror", () => {
      tileFails += 1;
      if (tileLoads === 0) window.setTimeout(degrade, 300);
    });
    layer.addTo(map);

    const group = [];
    points.forEach(point => {
      const marker = window.L.marker([point.lat, point.lon]).addTo(map);
      marker.bindPopup(point.html);
      group.push([point.lat, point.lon]);
    });

    if (group.length === 1) {
      map.setView(group[0], 13);
    } else {
      map.fitBounds(group, { padding: [28, 28], maxZoom: 14 });
    }
  }

  async function hydrateTravelMap() {
    const host = pageContainer();
    if (!host || document.getElementById("travel-map-section")) return;

    let data;
    try {
      data = await getJson("/api/geo/destinations");
    } catch (error) {
      return; // No section at all: the category page stands on its own.
    }

    const destinations = (data && data.destinations) || [];
    if (!destinations.length || !document.body.contains(host)) return;

    host.insertAdjacentHTML("beforeend", travelSectionMarkup(destinations));

    // The server reports whether the map host is healthy (its own probe runs
    // through a circuit breaker). When it is not, skip geocoding and map
    // loading entirely and show the destinations as a text index.
    const mapsEnabled = !data.map || data.map.mapsEnabled !== false;
    if (!mapsEnabled) {
      renderLocationIndex(destinations);
      return;
    }

    // 1. Wikidata blurbs — cosmetic, never blocks the map.
    destinations.forEach(async dest => {
      const blurb = await fetchWikidataBlurb(dest);
      if (!blurb) return;
      const card = host.querySelector(`[data-destination="${CSS.escape(dest.id)}"] .destination-blurb`);
      if (card) {
        card.textContent = blurb;
        card.hidden = false;
      }
    });

    // 2. Coordinates (server-side geocoding, one throttled request each).
    const status = document.getElementById("travel-map-status");
    if (status) status.hidden = false;

    const points = [];
    await Promise.all(
      destinations.map(async dest => {
        const center = await resolvePoint(dest.query);
        if (center) {
          points.push({
            lat: center.lat,
            lon: center.lon,
            html: `<strong>${esc(dest.name)}</strong>${dest.region ? `<br>${esc(dest.region)}` : ""}`
          });
        }
        await Promise.all(
          (dest.places || []).map(async place => {
            const point = await resolvePoint(place.query);
            if (point) points.push({ lat: point.lat, lon: point.lon, html: esc(place.name) });
          })
        );
      })
    );

    if (!document.getElementById("travel-map-section")) return; // navigated away

    const ok = await loadLeaflet();
    if (!ok || !window.L) {
      if (status) status.remove();
      const container = document.getElementById("travel-map");
      if (container) container.remove();
      return;
    }

    // Cards and chips are already visible; only the map frame depends on this.
    renderMap(data.map || {}, destinations, points);
  }

  /* ---------------------------------------------------------------- */
  /* Headline strip (/news)                                            */
  /* ---------------------------------------------------------------- */

  function headlinesMarkup(result) {
    const items = result.items
      .map(item => {
        const when = item.published_at
          ? `<time class="headline-date" datetime="${esc(item.published_at)}">${esc(formatDate(item.published_at))}</time>`
          : "";
        const excerpt = item.description
          ? `<p class="headline-excerpt">${esc(item.description)}</p>`
          : "";
        return `
          <li class="headline-item">
            <a class="headline-title" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
            <span class="headline-meta">
              <span class="headline-source">${esc(item.source)}</span>
              ${when}
            </span>
            ${excerpt}
          </li>`;
      })
      .join("");

    const someFailed = (result.sources || []).some(entry => entry.status !== "ok");
    const footer = someFailed
      ? `<p class="open-data-note">Some sources did not respond just now; the headlines above are the most recent available.</p>`
      : `<p class="open-data-note">Headlines and short excerpts, credited to their publishers. Full articles open on the publisher&rsquo;s site.</p>`;

    return `
      <section class="open-data-section" id="news-headlines-section" aria-label="Latest headlines from the web">
        <div class="open-data-header">
          <h2 class="open-data-title">Latest headlines from the web</h2>
        </div>
        <ul class="headline-list">${items}</ul>
        ${footer}
      </section>`;
  }

  async function hydrateNewsHeadlines() {
    const host = pageContainer();
    if (!host || document.getElementById("news-headlines-section")) return;

    let result;
    try {
      result = await getJson("/api/news/latest?limit=6");
    } catch (error) {
      return;
    }

    if (!result || !Array.isArray(result.items) || !result.items.length) return;
    if (!document.body.contains(host)) return; // navigated away mid-fetch

    host.insertAdjacentHTML("beforeend", headlinesMarkup(result));
  }

  window.KaliNovaOpenData = {
    hydrateNewsHeadlines,
    hydrateTravelMap
  };
})();
