"use strict";

/**
 * KaliNova — curated travel destinations for the map on /category/travel
 *
 * Configuration, not database rows: destinations change a few times a year
 * and an entry here is editorial (which places the site wants on the map),
 * so a deploy-time file matches how this project already handles feed lists
 * (see rss-feeds.js).
 *
 * How it works
 *   - `query` is what gets geocoded. Geocoding happens once per query, is
 *     persisted in PostgreSQL (external_data_cache) and is never done in a
 *     browser or on every page load. Nominatim's public service allows one
 *     request per second, so keep the list small.
 *   - `wikidataId` is optional. When present the destination card can show
 *     the entity's structured description (Wikidata is CC0).
 *   - `places` are the markers shown around the destination, in the order
 *     listed. Each one is geocoded independently, exactly once.
 *
 * To add a destination: append an entry, deploy, and load /category/travel
 * once so the coordinates are fetched and stored.
 */

module.exports = [
  {
    id: "darjeeling",
    name: "Darjeeling",
    region: "West Bengal, India",
    query: "Darjeeling, West Bengal, India",
    wikidataId: "Q169997",
    places: [
      { name: "Tiger Hill", query: "Tiger Hill, Darjeeling, India" },
      { name: "Batasia Loop", query: "Batasia Loop, Darjeeling, India" },
      { name: "Mall Road", query: "Mall Road, Darjeeling, India" },
      { name: "Peace Pagoda", query: "Peace Pagoda, Darjeeling, India" }
    ]
  }
];
