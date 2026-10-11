# Publishing an article

KaliNova has no separate publishing API: the admin CMS already exposes one.
`POST /api/admin/articles` (and `PUT /api/admin/articles/:id`) create and update
a full article — body, SEO metadata, tags, citations and scheduling — through the
same validation, sanitiser and copy-similarity gate the `/admin/articles` editor
uses. This page describes the small local client that drives those endpoints so
an author or an automated run can publish without a browser.

There is deliberately **no new endpoint, no second database pool and no
machine credential**. The client signs in as an administrator with the existing
cookie session plus the signed double-submit CSRF token, exactly as the admin
UI does.

## The client

`scripts/publish-article.js` is a dependency-free Node program. It:

1. reads a JSON payload;
2. validates it locally with the real rule set (`app/article-validation.js`);
3. signs in (`GET /api/admin/csrf` → `POST /api/admin/login`);
4. resolves a category **name** to its id (`GET /api/admin/categories`) — it
   never creates or renames a category;
5. refuses to create a duplicate when the slug already exists, unless `--update`
   is given;
6. creates (`POST /api/admin/articles`) or updates (`PUT /api/admin/articles/:id`);
7. surfaces the `422 SIMILARITY_ACK_REQUIRED` gate instead of silently
   publishing copy that matches attached reference material;
8. verifies the result (`GET /api/admin/articles/:id`, and the public
   `GET /api/articles/slug/:slug` once published);
9. prints a single machine-readable JSON object to stdout.

It never connects to PostgreSQL directly and never logs a password or token.

```bash
# From the repository root
BASE_URL=http://localhost:3007 \
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='…' \
node scripts/publish-article.js payload.json --pretty
```

## Options

| Option | Meaning |
| --- | --- |
| `<payload.json>` / `-f, --file` | The payload file (first positional or `--file`) |
| `--base-url <url>` | Backend origin; default `$BASE_URL` or `http://localhost:3007` |
| `--env-file <path>` | Optional `KEY=VALUE` file for `BASE_URL` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` |
| `--dry-run` | Validate and build the request; make **no** HTTP calls |
| `--update` | Replace the existing article when the slug already exists |
| `--ack-similarity` | Re-submit with `acknowledge_similarity=1` after reviewing a match |
| `--pretty` | Indent the JSON result |
| `-h, --help` | Usage |

`ADMIN_PASSWORD` is read from the environment (or `--env-file`), never from an
argument, so it does not land in shell history or the process list. The client
does **not** auto-load `app/.env`: credentials are supplied deliberately.

## Payload

```json
{
  "title": "How to read a CVE",
  "slug": "how-to-read-a-cve",
  "category": "Security",
  "status": "published",
  "content": "<p>…</p>",
  "meta_description": "A 50–160 character summary used for search and social cards.",
  "excerpt": "Optional standfirst.",
  "cover_image": "/assets/topics/security/a.jpg",
  "banner_alt": "Describe the banner image.",
  "tags": ["cve", "appsec"],
  "scheduled_at": null,
  "sources": [
    { "name": "NVD", "url": "https://nvd.nist.gov/", "license": "Public domain", "attribution": "NIST" }
  ],
  "research_refs": [
    { "source_key": "wikidata", "name": "Common Vulnerabilities and Exposures", "url": "https://www.wikidata.org/wiki/Q21013155", "text": "…" }
  ]
}
```

- `category` accepts a name or slug; `category_id` may be used instead.
- `status` is one of `draft`, `published`, `scheduled`, `archived` (default
  `draft`). `scheduled` requires `scheduled_at`.
- A **published** article needs a meta description and at least 40 characters of
  body text; a draft does not.
- `cover_image` must be a local `/assets/...` path or an absolute `https://` URL,
  and `banner_alt` is required whenever a cover image is set.
- `tags` may be an array or a comma-separated string; unknown tags are created by
  the existing tag service.
- `research_refs` are provenance excerpts (never published); they exist so the
  copy-similarity check can compare the finished body against the material it was
  drafted from.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (created, updated, or a clean `--dry-run`) |
| `1` | Unexpected error |
| `2` | Local validation or configuration failure |
| `3` | `422 SIMILARITY_ACK_REQUIRED` — re-run with `--ack-similarity` after review |
| `4` | A slug collision; re-run with `--update` to replace the existing article |

## Safety

- The client is an administrative tool. Point `--base-url` at the environment you
  intend to change; the default is a local server.
- It reuses the admin rate limiter (`ADMIN_LOGIN_ATTEMPTS`, default 8 per 15
  minutes), so a wrong password cannot be brute forced.
- Publishing respects the copy-similarity gate; nothing is written until the
  acknowledgement is supplied.
- Run the offline checks with `npm run test:publish` (or `npm test`). The
  endpoints this client drives are exercised end-to-end by
  `npm run test:admin:live`, which requires a loopback server, an admin account,
  a disposable `TEST_DATABASE_URL` and `KALINOVA_LIVE_TEST_ENABLED=1`.
