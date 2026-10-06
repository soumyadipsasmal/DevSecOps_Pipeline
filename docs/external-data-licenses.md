# External data sources and their licences

This document records every third-party data source the site reads at runtime,
what license or terms of use apply, and how we comply. It is updated whenever a
source is added, disabled, or removed.

## Quick reference

| Source | Used for | License / terms | Status |
| ------ | -------- | --------------- | ------ |
| [Wikidata](https://www.wikidata.org) | Facts on article/entity pages (`/api/wikidata/*`) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Enabled |
| [Wikimedia Commons](https://commons.wikimedia.org) | Media search, licence-aware metadata (`/api/media/search`) | Per-file licences (CC, PD); never downloaded | Enabled |
| [OpenStreetMap + Nominatim](https://nominatim.org) | Travel map tiles + geocoding (`/api/geo/*`) | ODbL / [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) | Enabled |
| [Wikimedia Foundation feed](https://wikimediafoundation.org/about/website-terms-of-use/) | "Latest News" headlines (`/api/news/latest`) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | Enabled |
| [Mongabay](https://news.mongabay.com) | Wildlife/consumption news headlines | [CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/) | Enabled |
| [The Guardian](https://www.theguardian.com) | (originally: news headlines) | Personal, non-commercial use only | Disabled |
| The Conversation | (originally: news headlines) | Licence terms ambiguous | Disabled |
| Mainstream Indian news outlets | (originally: news headlines) | Rights not verified | Disabled |

## Wikidata (facts)

- Licence: Wikidata is published under **CC0 1.0** — a public-domain dedication.
  Facts (e.g. "elevation 2115 m") carry no attribution requirement.
- We call the read-only `wbsearchentities` / `wbgetentities` API. No media files
  are copied from Commons via Wikidata.
- Compliance: we store nothing beyond what our own pages render, and we
  attribute the source in the page's "sourced from Wikidata" blurb.

## Wikimedia Commons (media search)

- Individual media files on Commons are each licensed separately (CC BY,
  CC BY-SA, CC0 / PD, and occasionally non-free). We honour per-file terms:
  - Only raster formats used by our pages are surfaced.
  - Files explicitly marked non-free or with no licence metadata are dropped.
  - The API returns *metadata only*; we never download, hot-link, or embed the
    media files.
  - Every result carries the licence short name, the author, the licence page
    URL, and a pointer to the file's regular Commons page — so a human making
    an editorial decision has the full attribution picture before reuse.

## OpenStreetMap tiles and Nominatim geocoding (Travel page)

- Map data and tiles: © **OpenStreetMap** contributors, distributed under the
  [Open Database Licence (ODbL)](https://www.openstreetmap.org/copyright). The
  map view shows the required attribution.
- Geocoding: Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/)
  requires ≤ 1 request/second, a valid `User-Agent` and `Referer`, no bulk
  scraping, and results that carry the OpenStreetMap attribution. We comply:
  a global rate limiter holds geocoding to one request per second, requests
  send `Kalinova/1.0` as the User-Agent, and results are cached in our database
  for 90 days (rendered + CORS headers from the Nominatim API itself).
- We serve the tile layer from `https://tile.openstreetmap.org` with the
  standard OSM attribution; a proper tile key can be set via `OSM_TILE_URL` for
  production.

## RSS news feeds

Both enabled feeds are redistributed as headlines only — title, link, and a
short plain-text excerpt up to ~240 characters. We store **no article bodies**
and no images, and we render a visible attribution line ("via Wikimedia
Foundation", "via Mongabay") under every item.

- **Wikimedia Foundation** — CC BY-SA 4.0. Attribution: the source site is
  credited on each headline. Not used as a general-purpose news wire.
- **Mongabay** — CC BY-ND 4.0. Our excerpt is a strip of the "no derivatives"
  title/inside copy and does not modify the work; each headline links through
  to the original article and the source is credited.

### Why the following are disabled

- **The Guardian** — its terms restrict use to personal, non-commercial,
  non-institutional purposes. A public commercial site cannot rely on that, so
  the feed entry stays in the registry but `enabled: false`, with the reviewer
  note recorded. This is asserted by the test suite so nobody silently re-enables
  it without a licence change.

## Operational rules

- All upstream requests use `Kalinova/1.0 (https://kalinova.in; <contact@>)` as
  the User-Agent, a per-request timeout (default 5000 ms), and a 2 MB response
  cap.
- Failures return generic 503/error JSON to the client and are logged only as
  service name + error kind — never as URLs that leak reader search terms.
- Nothing is retried automatically; stale cached content is served when a
  refresh fails, per the resilience licence (no data pasted from Wikipedia
  articles, no derivative bodies, no bulk downloads).

## Automatic safety (Phase 2)

Since this document was written, a fourth guarantee was added: compliance is
**enforced at run time, not just documented** (see `app/circuit-breaker.js`).

- Every integration (Wikidata, Commons, Nominatim, the map tile host, and each
  reviewed RSS feed) runs behind a circuit breaker whose state is persisted in
  PostgreSQL (`integration_status` / `integration_events`). Repeated failures,
  timeout bursts, 429s and 401/403s trip it; a service that answers 403 three
  times in 24 hours stays off until an administrator re-enables it on
  `/admin/integrations`.
- Request envelopes (hourly/daily) cap how often each service is called; once
  spent, only cached answers are served.
- Wikimedia Commons search now applies a licence **allowlist** (PD, CC0, CC BY,
  CC BY-SA only). Files under `-nc` / `-nd`, marked "fair use", or with unclear
  metadata are never surfaced. Stored `article_images` rows that reference a
  Commons file are re-checked weekly against the live licence; rows whose file
  no longer passes the allowlist are taken off the public gallery (reversibly,
  via a `HIDDEN:` source prefix) and restored if the licence comes back. The
  seed images in `scripts/topic-images.tsv` are all PD / CC0 / CC BY / CC BY-SA.
- RSS feeds that redirect to a different domain are stopped automatically
  before any headline is written, and feeds whose terms review is not recorded
  (`termsReviewed: false`) are never fetched.
- Nothing here is a licence change; it is the same policy, now enforced by the
  machine so a quiet upstream change cannot put the site in breach.