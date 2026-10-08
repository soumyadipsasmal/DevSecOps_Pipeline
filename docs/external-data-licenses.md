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

## Endpoint inventory

Every public read the site performs, what it returns, and where that lands in
the product. This table is the inventory of record: a source may not appear in
the CMS unless it has a row here.

| Source | Endpoint | Data used | Where it is used | Shown publicly or stored | Attribution / licence |
| ------ | -------- | --------- | ---------------- | ------------------------ | --------------------- |
| Wikidata | `GET /api/wikidata/search` | Entity id, label, description, canonical URL | Admin research panel on the article editor | Displayed publicly only when the editor attaches a citation; the lookup itself is admin-only | CC0 1.0 — no attribution required, credited anyway |
| Wikidata | `GET /api/wikidata/entity/:id` | Curated facts for one Q-id | Admin research panel (a bare `Q123` query) | Stored as provenance; shown publicly only as a citation | CC0 1.0 |
| Wikimedia Commons | `GET /api/media/search` | File title, description, author, licence, page URL | Admin research panel; image picker on the travel pages | Citation metadata only — the image file is never downloaded or embedded | Per-file (PD / CC0 / CC BY / CC BY-SA allowlist) |
| OpenStreetMap / Nominatim | `GET /api/geo/place`, `GET /api/geo/config`, `GET /api/geo/destinations` | Place name, display name, coordinates | Travel map; admin research panel | Map attribution is rendered on the map itself; a citation keeps it | ODbL, © OpenStreetMap contributors |
| Wikimedia Foundation feed | `GET /api/news/latest` | Headline, link, short excerpt | News strip; admin research panel | Headlines link through and credit the feed | CC BY-SA 4.0 |
| Mongabay feed | `GET /api/news/latest` | Headline, link, short excerpt | News strip; admin research panel | Headlines link through and credit the feed | CC BY-ND 4.0 |

Nothing outside this table is fetched at run time. The disabled feeds stay in
the registry with `enabled: false` and are listed in the quick-reference table
above with the reason.

## Editorial research workflow

**Research, never republishing.** The rule the CMS repeats on every article
screen:

> Use external APIs for research, facts, images, locations, RSS and source
> discovery. Do not copy third-party articles, reviews or long passages into
> the CMS.

How that is expressed in the product:

- **The research panel is read-only.** `GET /api/admin/research`
  (`app/admin-research-routes.js`) sits behind the admin session and a rate
  limit, and has no write method at all — no POST, no article insert, no field
  the browser submits back into the body. It cannot edit, save or publish
  anything.
- **Attaching is provenance, not publishing.** "Attach as reference" stores the
  source's name, URL, licence label and a short excerpt in
  `article_research_metadata`. That table is internal: it is never served by a
  public endpoint and never rendered on the article page.
- **Citations are what the reader sees.** `article_sources` holds what the
  editor wrote by hand, and is served by `GET /api/articles/:id/sources` and
  `GET /api/articles/slug/:slug/sources`, both of which filter on
  `status = 'published'` so a draft's reference list cannot be read.
- **Nothing is invented.** A licence or an attribution line the source did not
  state is stored as NULL and rendered as absent. There is no default credit.
- **Copy similarity is a warning, not a verdict.** `app/content-similarity.js`
  scores the body against the attached reference excerpts using 5-word shingle
  containment and reports a percentage. At or above the threshold
  (`SIMILARITY_WARN_PERCENT`, default 35%) publishing asks for one explicit
  acknowledgement. Drafts are never blocked, a save is never refused, and the
  tool is explicitly not a plagiarism detector — it holds no index of anyone
  else's writing and reaches no legal conclusion.

### What is never done

- No third-party article, review or long passage is copied into
  `articles.content`.
- No media file is downloaded from Commons; only metadata is read.
- No research excerpt is inserted into the article body automatically.
- No API key, token or connection string is stored in either new table.
