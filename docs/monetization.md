# Monetization dashboard

The `/admin/monetization` screens manage every commercial surface KaliNova can
show readers. This page describes what each surface is, how the data is
privacy-costed, and what the dashboard deliberately does **not** do.

KaliNova is **not monetised by default**. Every surface below ships empty and
switched off: no affiliate link, campaign or banner exists until an
administrator creates one, and the public `<link>`/script changes only the
piece of JavaScript that already ships with the site. The Google AdSense
network (publisher ID, placements, consent) is managed separately on
`/admin/ads`.

## Surfaces

### AdSense (reuse, not duplication)

The existing ads component (`frontend/assets/ads.js`) is reused unchanged. The
monetization dashboard never re-decides whether AdSense may render: the
`ad_settings` gate decides that, exactly as it did before this feature. The
monetization overview just reads the same settings and reports whether AdSense
is configured (`configured` / `note`).

### Affiliate links

An affiliate link is a centrally managed destination an editor attaches to an
article or a category:

- stored in `affiliate_links`, served to readers as `/go/<slug>`
- the destination is always an absolute `http(s)` URL, validated on save and
  double-checked by a database `CHECK`
- a **paused** link answers `410 Gone` from `/go/<slug>` instead of silently
  dropping a reader somewhere the site no longer vouches for
- the public list never returns a tracking URL or a raw destination; only the
  server-side redirect (which picks the tracking URL, if one is configured, at
  click time) knows that

### Sponsored campaigns

One campaign per article (enforced with a unique key on `article_id`):

- a sponsor name, an optional sponsor URL, a label (exactly **Sponsored** or
  **Advertisement**), a disclosure text, a date window and a status
- only `active` campaigns are returned by the public article endpoint; drafts
  and paused campaigns are an editor's working state
- the article page renders a sponsored badge and the disclosure next to the
  headline. Each article also has an `ads_enabled` tri-state — *default* / *on*
  / *off* — so an article can opt out of **all** advertising (AdSense, direct
  ads and the sponsored badge) per-row; `NULL` defers to the category default.

### Direct ad campaigns

Banner campaigns sold directly to advertisers:

- artwork URL, alt text, destination URL, a placement, a date window, a
  priority and a status
- "servable" is derived from the stored status **and** the date window, so an
  `active` campaign whose dates have not started (or have lapsed) is not
  served
- one campaign per placement is served, highest priority first
- the placements are server-owned: `homepage_top`, `homepage_middle`,
  `article_top`, `article_middle`, `article_bottom`, `sidebar`,
  `category_top`, `footer`
- impressions and clicks go to `ad_events`; the denormalised counters on the
  campaign row are maintained in the same transaction

### Newsletter

The public `/api/newsletter/subscribe` endpoint stores a row — lowercased,
deduplicated, one row per email — with a random unsubscribe token that is never
derived from the address. **No email is ever sent**: the build ships without a
delivery provider, `NEWSLETTER_PROVIDER` is unset, and every screen says so
(`mailing.can_send` is always `false`). Subscribing is a stored row so the list
is never lost; sending is a future deployment decision, not a code path here.

### Disclosures

Site-wide texts (`affiliate_disclosure`, `sponsored_disclosure`,
`advertising_disclosure`, `privacy_notice`) edited on
`/admin/monetization/disclosures`, served to the public by the manifest,
seeded with honest defaults, and never fabricated.

### Settings and audit

- **Settings**: per-category defaults for ads, affiliates and direct ads
  (`default_ads_enabled`, `default_affiliate_enabled`,
  `default_direct_ads_enabled`). One shared update path —
  `setCategoryDefaults(client, body)` — is used by both the HTML form POST and
  the API `PUT /api/admin/monetization/settings`, so the two can never drift.
- **Audit**: every admin action on these screens is logged to
  `monetization_audit_logs` with a flat, primitive-only `details` JSON; nested
  or non-primitive values are stripped before writing.

## Privacy

- Event rows keep only four fields: `ip_hash`, `referrer`, `device`,
  `ua_snippet`.
- `ip_hash` is **HMAC-SHA256(client IP, ANALYTICS_SALT)**. `ANALYTICS_SALT`
  (see `.env.example`) is a server secret; when it is unset the hash is empty.
  Either way a raw IP is never stored, never logged and never returned.
- Referrer is stored **host-only** (the query string is dropped). The UA
  snippet is capped at 128 characters and bucketed to `desktop` / `mobile` /
  `bot`.
- The frontend fires impression/click tracking with `keepalive: true` and
  `.catch()`—tracking is fire-and-forget and never blocks a reader.

## Deliberate non-features

- **Revenue numbers.** There is no ad-network or payment provider wired in.
  The overview answers *"Revenue reporting not connected."* and shows activity
  (counts, clicks, events) — never invented figures.
- **Email delivery.** Subscriptions are rows, not emails, until a provider is
  configured.
- **No claiming of approvals.** The dashboard stores an AdSense publisher ID
  if one is entered but never claims AdSense approval or legal compliance.
- **No external tracking by default.** On the shipped build the only outbound
  URLs ever rendered are the affiliate destinations and direct-ad destinations
  an administrator stored. The opt-in GA4 loader described below is the one
  exception, and it stays dormant until an operator configures it *and* the
  reader consents.

## Optional analytics (GA4)

KaliNova ships with analytics **off**. No measurement id is configured, so
`frontend/assets/analytics.js` reads `/api/analytics/config`, sees
`enabled: false`, and makes no third-party request at all.

When an operator sets `GA_MEASUREMENT_ID` (a valid GA4 id, e.g.
`G-XXXXXXXXXX`) and leaves `ENABLE_ANALYTICS=true`, the loader still refuses to
reach Google until **both** of these hold:

- the reader is not sending Do Not Track or Global Privacy Control, and
- the reader has granted advertising consent through the existing banner (the
  same `kalinova:ads-consent` choice `ads.js` stores). Consent can be granted
  after the first attempt; the loader then starts without a reload.

Only then does it inject `gtag.js`, with `anonymize_ip: true` and
`send_page_view: false`. Pageviews are emitted per SPA route (one per path,
driven by the router's `kal:route` event), so navigation is measured without
double-counting. The public CSP in `frontend/_headers` already allows the
required `googletagmanager` / `google-analytics` origins; they are inert until
the loader actually runs.

## Environment

All optional, none switch advertising on:

| Variable               | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `ANALYTICS_SALT`       | HMAC secret for client-address hashing                   |
| `ENABLE_ANALYTICS`     | master switch for the opt-in GA4 loader (default true)   |
| `GA_MEASUREMENT_ID`    | GA4 id; unset keeps analytics off (the shipped default)  |
| `NEWSLETTER_PROVIDER`  | reserved; no sending is enabled by this build            |
| `NEWSLETTER_FROM_EMAIL`| reserved sender address for a future provider            |

`SITE_URL` and friends are shared with the open-data integrations; see
`docs/external-data-licenses.md` for the endpoint and licensing inventory of
the content surfaces this dashboard attaches to (Wikipedia/Wikidata/Commons,
OpenStreetMap/Nominatim, RSS) and the research-only rule.