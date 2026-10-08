# SEO Engine (v1)

The admin "SEO check" panel (`/admin/articles/...` -> *SEO check*) runs a
deterministic, server-side content-quality analyzer over the article being
edited. This page describes what the engine scores, how the score is built,
and what it deliberately does **not** claim to be.

The engine is **not a Google ranking metric**. It is a fixed, transparent
checklist (38 checks in this build) that helps an editor notice a missing meta
description, an over-long title, a broken internal link or a body that never
mentions its own subject. The output is a checklist a human reads, not a
prediction.

## What it is

- **Pure and deterministic.** The same article always gets the same report.
  There are no random weights, no machine-learning models and no calls to any
  third-party service; the analyzer needs no upstream network access.
- **Transparent.** Six categories with fixed weights that sum to 100. Every
  point can be traced back to a named check.
- **Stateless.** Analysis is computed on demand and persists nothing. The only
  table the SEO feature owns is `redirects` (below), and the engine never
  writes to it — the redirect table exists for slug changes, separately.
- **Readiness, not blocking.** A low score alone never stops anything. Only a
  critical technical or content problem (for example a missing title) produces
  `BLOCKED`, and even then a draft can still be saved. Publishing is an editor
  decision; the panel only reports.

## The categories

| Category       | Weight | What it covers                                              |
| -------------- | ------ | ----------------------------------------------------------- |
| `onPage`       | 30     | title, slug, meta description, duplicate title/slug         |
| `content`      | 25     | word count, paragraph quality, headings, phrasing, keywords |
| `technical`    | 20     | canonical, robots, structured data, schema, category        |
| `internalLink` | 10     | internal links, self-links, broken-link check, suggestions  |
| `media`        | 10     | banner present, alt text quality, file type, body images    |
| `social`       | 5      | Open Graph / Twitter/X card sources                         |

The score in each category is the sum of `points` earned by its checks; every
`PASS`/`INFO` check earns its full weight, a `WARNING` earns half, an `ERROR`
earns zero. `INFO` is also used for a check that could not run (for example the
broken-link check when the engine has no database access) so a missing
service degrades to an advisory, never a failure.

## Severity and readiness

Checks carry one of four severities:

- `PASS` — the finding is satisfied
- `WARNING` — worth reviewing before publishing
- `ERROR` — a critical technical or content problem
- `INFO` — neutral, or a check that could not be completed

The readiness status is derived from the checks:

- `BLOCKED` — one or more `ERROR`s (e.g. the title is empty). Saving a draft is
  unaffected; the panel is advisory.
- `NEEDS_REVIEW` — warnings exist, or content quality is weak. The normal state
  for an article that is good but not perfect.
- `READY` — nothing was flagged.

A low score on its own never produces `BLOCKED`; engineering flexibility for a
*subject-matter* verdict is editor work, not an engine rating.

## Backing services

The engine is pure, so the checks that need the site database are injected as
services by `app/admin-seo-routes.js`:

- `similarTitles(title, excludeId)` — published titles, token-overlap based
- `slugTaken(slug, excludeId)` — is the slug already used elsewhere
- `articleTargetExists(kind, slug)` — does `/blog/<slug>` resolve to a
  published article (used by the broken-internal-link check)
- `suggestCandidates()` — recent published articles for the internal-link
  suggestions

## Suggested internal links

`internalLinkSuggestions` ranks recent published candidates by shared category,
title overlap and body-topic overlap, capping the list at
`SEO_INTERNAL_LINK_LIMIT` (default 5). The panel renders each as a plain link to
the candidate's `/blog/<slug>` URL; it never rewrites the article, it only
suggests.

## Slug-change redirects

The `redirects` table (`database/schema-seo-engine.sql`) holds 301/302 sources.
Two writers:

- **Automatic** — when a *published* article's slug is renamed, the CMS writes
  `/blog/<old>` -> `/blog/<new>` (301). Conflicts are a no-op: an existing
  redirect for the same source is never overwritten.
- **Manual** — the `/admin/redirects` screens for retired URLs.

Rules that hold for every row:

- a source is a clean public site path — leading `/`, no query string, no
  fragment, no trailing slash — and never `/admin`, `/api`, `/assets`, `/go` or
  `/health`
- a destination is a site path or an absolute `http(s)` URL; a destination that
  points back at `siteOrigin` must also avoid the reserved prefixes, so a 301
  can never land a visitor in the admin area or a JSON API
- a unique index on `source_path` is the final duplicate guard
- paused rows (`is_active = false`) stop forwarding without being deleted
- the public server middleware answers only `GET`/`HEAD`, never caches the
  response, and skips the reserved surfaces

## Environment

All optional:

| Variable                 | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `ENABLE_SEO_ENGINE`      | false hides the panel; analysis stays disabled |
| `SEO_INTERNAL_LINK_LIMIT`| 0-20, related-story suggestions per run        |

The site origin used for canonical/absolute-link decisions comes from the
shared `SITE_URL`/`siteOrigin` configuration.

## Deliberate non-features

- **No ranking prediction.** The score is a transparent checklist, not a
  Google-adjacent number.
- **No persistence.** Analysis reports are computed and discarded.
- **No external calls.** Nothing here phones home; the open-data integrations
  (`docs/external-data-licenses.md`) are a separate, opt-in system.
- **No automatic rewriting.** The engine never edits the article; it only
  reports and suggests.
- **No copy-similarity work.** The "copy-similarity" nudge against attached
  references lives in the research panel (`content-similarity.js`), not in this
  engine.