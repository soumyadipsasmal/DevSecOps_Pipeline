# KaliNova

Independent publishing platform: a public article site (Node.js + Express +
PostgreSQL, static frontend SPA) with an administrator-only dashboard, an
article CMS, an opt-in ads module and open-data integrations — wrapped in a
seven-gate DevSecOps pipeline that checks every commit locally and every push
in CI.

```
app/          Express API, admin authentication, CMS, ads, integrations, CLI scripts
database/     schema, seeds and idempotent migrations
frontend/     public SPA (index.html, router.js, pages.js) + admin stylesheet
scripts/      sitemap generation, image tooling, verification scripts
docs/         product, requirements, security and licence documentation
terraform/    infrastructure-as-code scaffold (scanned by Checkov)
security/     security documentation
githooks/     pre-commit secret scan
.github/      seven-job security pipeline + Dependabot
```

---

## Contents

1. [Requirements](#requirements)
2. [Quick start (Docker)](#quick-start-docker)
3. [Quick start (local)](#quick-start-local)
4. [npm scripts](#npm-scripts-run-from-app)
5. [Configuration](#configuration)
6. [Database and migrations](#database-and-migrations)
7. [Testing](#testing)
8. [Security pipeline](#security-pipeline)
9. [Admin area](#admin-setup)
10. [Admin article CMS](#admin-article-cms)
11. [Ads and monetization](#ads-and-monetization)
12. [Open-data integrations](#open-data-integrations)
13. [Public site](#public-site)
14. [Deployment](#deployment)
15. [Documentation](#documentation)
16. [Verified end-to-end run](#verified-end-to-end-run)

---

## Requirements

- Node.js 18+ (the container image uses Node 22)
- PostgreSQL 14+ (the compose file runs PostgreSQL 16)
- Docker Desktop (optional, for the containerised stack)

## Quick start (Docker)

```bash
export ADMIN_SESSION_SECRET=$(openssl rand -hex 48)   # signs the admin session cookie
docker compose up --build
docker compose exec app npm run create-admin          # needs ADMIN_EMAIL/ADMIN_PASSWORD
```

- App: <http://localhost:3007> (`APP_PORT` overrides the host port)
- Database: `localhost:5434` (`DB_HOST_PORT` overrides it)
- A fresh volume applies every file in `database/` through
  `docker-entrypoint-initdb.d` (schema, seeds, admin auth, CMS, ads,
  external data, integration safety) before the app starts.
- Uploaded banners live in the `uploads` named volume, so they survive a
  rebuild.

`POSTGRES_*` credentials in `docker-compose.yml` are development values.
Replace them before deploying anywhere public.

## Quick start (local)

```bash
cd app
npm install
# point DB_* in app/.env at your PostgreSQL instance, then:
psql -h localhost -U medium_user -d medium_clone -f ../database/schema.sql
psql -h localhost -U medium_user -d medium_clone -f ../database/seed-categories.sql
psql -h localhost -U medium_user -d medium_clone -f ../database/seed.sql
npm run migrate
npm start                     # http://localhost:3007
```

> **Windows / WSL note.** npm resolves relative paths against the shell's
> working directory, so a `\\wsl.localhost\...` UNC path makes `npm test` fall
> back to `C:\Windows` and fail with `Cannot find module`. From PowerShell, run
> npm through WSL with an *interactive* shell (`-i`), because that is what
> loads nvm and puts the Linux npm ahead of the Windows one:
>
> ```powershell
> wsl bash -ic "cd /home/<you>/DevSecOps_Pipeline/app && npm test"
> ```
>
> A non-interactive `wsl bash -c` skips `.bashrc`, `npm` resolves to the
> Windows shim over `/mnt/c`, and the same UNC failure comes back.

### npm scripts (run from `app/`)

| Script | Purpose |
| --- | --- |
| `npm start` | Start the Express server |
| `npm run migrate` | Apply the five idempotent migrations and verify the columns landed |
| `npm run create-admin` | Create or repair an administrator account |
| `npm run seed:images` | Match article photos to article bodies |
| `npm run sitemap` | Regenerate `frontend/sitemap.xml` |
| `npm test` | The whole test battery (8 suites, 829 checks) |
| `npm run test:seo` | SEO smoke test |
| `npm run test:admin` | Offline admin authentication tests (no database needed) |
| `npm run test:cms` | Article CMS: sanitiser, validation, uploads, views |
| `npm run test:admin:ads` | Ads admin screens, settings, CSP and packaging rules |
| `npm run test:ads` | Public ad manifest, consent and legal-page checks |
| `npm run test:admin:live` | End-to-end admin HTTP checks against a running server |
| `npm run test:cb` | Circuit-breaker and feed-safety tests |
| `npm run test:external` | Open-data services, licences and repository guardrails |

## Configuration

Everything is driven by environment variables; [`.env.example`](.env.example)
documents every one of them with its default. Copy it to `.env` (gitignored)
and fill in real values — never commit a filled-in copy.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Key variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ADMIN_SESSION_SECRET` | **yes in production** | random per boot in dev | HMAC key that signs the admin session cookie. At least 32 characters. |
| `ADMIN_SESSION_MINUTES` | no | `480` | Session lifetime in minutes |
| `ADMIN_COOKIE_NAME` | no | `kalinova_admin_session` | Session cookie name |
| `ADMIN_CSRF_COOKIE_NAME` | no | `kalinova_admin_csrf` | CSRF cookie name |
| `ADMIN_BCRYPT_ROUNDS` | no | `12` | bcrypt cost factor (10–15) |
| `ADMIN_LOGIN_ATTEMPTS` / `ADMIN_LOGIN_WINDOW_MINUTES` | no | `8` / `15` | Sign-in rate limit per IP + email |
| `ADMIN_COOKIE_SECURE` | no | `true` when `NODE_ENV=production` | Force the `Secure` cookie flag |
| `ADMIN_ARTICLE_BODY_KB` | no | `512` | Request body limit for article JSON |
| `ADMIN_UPLOAD_MAX_KB` | no | `6144` | Maximum banner upload size in KB |
| `TRUST_PROXY` | no | `false` | `true` (or a hop count) behind a reverse proxy |
| `SITE_URL` | no | `https://kalinova.in` | Origin used in the User-Agent for open-data calls |
| `ENABLE_WIKIDATA` / `ENABLE_COMMONS` / `ENABLE_MAPS` / `ENABLE_RSS` | no | `true` | Master switches for each integration |
| `CB_*`, `*_HOURLY_LIMIT`, `*_DAILY_LIMIT` | no | see `.env.example` | Circuit-breaker tuning and request envelopes |

`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` are read by
`app/db.js` from `app/.env` when you run the server outside Docker;
`docker-compose.yml` supplies them inside the compose network.

`NODE_ENV=production` makes the app refuse to start without a strong
`ADMIN_SESSION_SECRET`: it must be at least 32 characters and must not still
look like a placeholder (`change-this…`, `dev-only…`, `replace-me…`,
`secret`, …), so a development value copied into production fails loudly
instead of signing cookies with a key an attacker already knows.
`JWT_SECRET` is still accepted as a fallback key for older deployments.

## Database and migrations

Tables: `users`, `articles`, `categories`, `article_images`, `ad_settings`,
`ad_placements`, `external_data_cache`, `rss_items`, `integration_status`,
`integration_events`.

| File | Adds |
| --- | --- |
| `database/schema.sql` | Core `users`, `articles`, `categories` (base file — applied by the DB init, not by `migrate`) |
| `database/schema-article-images.sql` | `article_images` (base file — applied by the DB init, not by `migrate`) |
| `database/schema-admin-auth.sql` | `role`, `is_active`, `session_version`, `last_login_at`, `updated_at` on `users` |
| `database/schema-article-cms.sql` | `meta_description`, `banner_alt`, `body_format`, `updated_at`, status check, indexes |
| `database/schema-ad-placements.sql` | `ad_settings` + `ad_placements`, seeded **disabled** with no publisher id |
| `database/schema-external-data.sql` | `external_data_cache` + reviewed `rss_items` (start empty) |
| `database/schema-integration-safety.sql` | Per-service breaker state and the automatic-stop event log |

```bash
cd app
npm run migrate
```

The runner applies the last five files in the table above
(`schema-admin-auth`, `schema-article-cms`, `schema-ad-placements`,
`schema-external-data`, `schema-integration-safety`), each in its own
transaction, then reads `information_schema` and fails loudly if a column is
still missing. It is idempotent and never rewrites existing article content
or an existing `password_hash`. The first two files are base schema and are
applied by the database init (or your own `psql`) before any migration runs.

Equivalent without the script:

```bash
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
     -f database/schema-admin-auth.sql \
     -f database/schema-article-cms.sql
```

Fresh Docker volumes apply everything automatically; an existing volume only
runs init scripts on its first creation, so run `npm run migrate` after
pulling.

Seeds: `seed-categories.sql`, `seed.sql`, `seed-topics.sql`,
`seed-editorial-2026.sql`, `fix-article-categories.sql` — all mounted into
`docker-entrypoint-initdb.d` by `docker-compose.yml`.

## Testing

`npm test` runs eight independent suites — **829 checks in total** — and any
failing check exits non-zero:

| # | Suite | Script | Needs | Checks |
| --- | --- | --- | --- | --- |
| 1 | SEO smoke | `test:seo` | nothing | 76 |
| 2 | Admin authentication (offline) | `test:admin` | nothing | 100 |
| 3 | Article CMS | `test:cms` | nothing | 189 |
| 4 | Admin ads screens | `test:admin:ads` | nothing | 167 |
| 5 | Public ads / consent | `test:ads` | a reachable database | 72 |
| 6 | Live admin HTTP | `test:admin:live` | server + admin account | 116 |
| 7 | Circuit breakers | `test:cb` | nothing | 30 |
| 8 | Open-data services | `test:external` | nothing | 79 |

The live suite covers the sign-in page, invalid email, invalid password,
successful sign-in, the redirect to the dashboard, dashboard access while
authenticated and while anonymous, the admin API with and without a session,
logout, access after logout, replayed-cookie rejection, full CMS create /
edit / publish / unpublish / upload / delete over HTTP, and that the public
site and article/category endpoints still respond. Without `ADMIN_EMAIL` /
`ADMIN_PASSWORD` it prints `SKIP` and exits successfully.

```bash
cd app
npm test                       # all 8 suites; the live one SKIPs without a server

BASE_URL=http://localhost:3007 \
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='your-password' \
npm run test:admin:live        # end-to-end checks over HTTP
```

> **Re-running the live suite.** It deliberately spends failed sign-ins
> (unknown email, wrong password, missing CSRF), and the login limiter allows
> only `ADMIN_LOGIN_ATTEMPTS` (8) per `ADMIN_LOGIN_WINDOW_MINUTES` (15).
> Running it back to back therefore trips `429` and the suite fails. Either
> wait out the window or restart the app, which clears the in-memory limiter.

## Security pipeline

Every commit is checked locally, every push is checked by the seven jobs in
`.github/workflows/devsecops-pipeline.yml`, and Dependabot keeps the inputs to
both current.

### Pre-commit secret scan

```bash
git config core.hooksPath githooks     # once per clone
```

`githooks/pre-commit` runs `gitleaks git --staged` against the index and
blocks the commit when it finds a key. It needs
[gitleaks](https://github.com/gitleaks/gitleaks#installation) installed
(`winget install gitleaks.gitleaks` on Windows); if it is missing the hook
refuses to pass rather than scanning nothing. One-off bypass:
`SKIP_SECRET_SCAN=1 git commit ...`. CI repeats the same scan over the full
history, together with TruffleHog.

### CI stages

| # | Gate | Tool | Fails the build when |
| --- | --- | --- | --- |
| 1 | Secrets | gitleaks 8.30.1 + TruffleHog | a secret exists anywhere in the history |
| 2 | SAST | Semgrep `p/ci` on `app/` and `frontend/` | any rule matches |
| 3 | SCA | `npm audit --audit-level=high` | a high or critical advisory is installed |
| 4 | IaC | Checkov on `terraform/` | a high-severity misconfiguration |
| 5 | Container | Trivy on the freshly built image | an unfixed HIGH/CRITICAL CVE in the runtime image |
| 6 | Tests | `npm test`, then `npm run test:admin:live` against PostgreSQL | any check fails |
| 7 | DAST | OWASP ZAP baseline against the compose deployment | a FAIL-level alert; warnings land in the uploaded report |

`.github/dependabot.yml` opens weekly pull requests for npm, the Docker base
image and the GitHub Actions used here.

### Running the same scans locally

```bash
# secrets, whole history
gitleaks git --redact

# static analysis
docker run --rm -v "$PWD":/repo semgrep/semgrep \
  semgrep scan --config p/ci --error /repo/app /repo/frontend

# infrastructure
docker run --rm -v "$PWD/terraform:/tf" bridgecrew/checkov \
  -d /tf --compact --hard-fail-on HIGH

# container (npm/corepack inside the base image are build tooling, not runtime)
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest \
  image --severity HIGH,CRITICAL --ignore-unfixed \
  --skip-dirs /usr/local/lib/node_modules/npm devsecops_pipeline-app:latest

# dependencies — from app/
npm audit --audit-level=high
```

---

## Admin setup

The admin area is **administrator-only**. There is no public registration, and
visitors cannot create articles: `POST /api/articles` sits behind the same
`requireAdmin` guard as the admin API.

### 1. Environment variables

Set `ADMIN_SESSION_SECRET` (see [Configuration](#configuration)) in `app/.env`
for local runs, or in the shell / `.env` file used by `docker compose`.

### 2. Database migration

```bash
cd app
npm run migrate
```

Admin accounts live in the existing `users` table — no second identity table
is created. The migration adds `role`, `is_active`, `session_version`,
`last_login_at` and `updated_at`, plus two check constraints and an index. It
is idempotent and never rewrites an existing `password_hash`.

### 3. Create the first administrator

There is no other way to create an admin: the password is read from the
environment, hashed with bcrypt, and never stored, printed or logged anywhere
else.

```bash
cd app
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a-long-unique-passphrase' npm run create-admin
```

- At least 12 characters; a short deny list rejects obvious values.
- Re-running never creates a duplicate (the email is unique).
- Re-running on an existing account re-promotes it to `admin`, reactivates it
  and invalidates current sessions. The password is only rewritten when it
  does not already match, so re-running after a password change cannot undo it.
- Only the account id, email and role are printed.

Inside Docker:

```bash
docker compose exec -e ADMIN_EMAIL=admin@example.com \
                    -e ADMIN_PASSWORD='a-long-unique-passphrase' \
                    app npm run create-admin
```

### 4. Start the application

```bash
npm start                 # local
docker compose up --build # container
```

### 5. URLs

| Page | URL |
| --- | --- |
| Admin login | `http://localhost:3007/admin/login` |
| Admin dashboard | `http://localhost:3007/admin/dashboard` |
| Articles | `http://localhost:3007/admin/articles` |
| New article | `http://localhost:3007/admin/articles/new` |
| Ads & Monetization | `http://localhost:3007/admin/ads` |
| Integrations | `http://localhost:3007/admin/integrations` |

### 6. Endpoints

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/admin` | GET | yes | Redirects to the dashboard |
| `/admin/login` | GET | no | Login form (redirects to the dashboard if already signed in) |
| `/admin/login` | POST | no | Sign in, then `303` to `/admin/dashboard` |
| `/admin/dashboard` | GET | yes | Counts and recent articles |
| `/admin/logout` | POST | yes | Ends the session, then `303` to `/admin/login?logged_out=1` |
| `/health` | GET | no | `{ status, database, time }` health probe |
| `/api/admin/csrf` | GET | no | Issues a CSRF token for the JSON API |
| `/api/admin/login` | POST | no | JSON sign-in; needs `X-CSRF-Token` |
| `/api/admin/logout` | POST | yes | Ends the session |
| `/api/admin/me` | GET | yes | `{ "id": 1, "email": "admin@example.com", "role": "admin" }` |
| `/api/admin/dashboard` | GET | yes | `{ "stats": {...}, "recentArticles": [...] }` |

Article CMS endpoints (all mutations need `X-CSRF-Token`):

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/admin/articles` | GET | Article list with status, category and search filters |
| `/admin/articles/new` | GET | Create form (the form itself posts to `/admin/articles`) |
| `/admin/articles` | POST | Create; `intent=preview` renders the preview instead of saving |
| `/admin/articles/preview` | POST | Preview submitted values without saving |
| `/admin/articles/:id/edit` | GET | Edit form |
| `/admin/articles/:id` | POST | Update (the `intent` field picks published / draft / preview) |
| `/admin/articles/:id/status` | POST | Publish or unpublish |
| `/admin/articles/:id/preview` | GET | Saved-article preview |
| `/admin/articles/:id/delete` | GET / POST | Delete confirmation, then delete |
| `/api/admin/articles` | GET / POST | List / create (`201`) |
| `/api/admin/articles/:id` | GET / PATCH / PUT / DELETE | Read, update, delete |
| `/api/admin/articles/:id/status` | POST | `{ "status": "draft" \| "published" }` |
| `/api/admin/categories` | GET | Categories for the form's category picker |
| `/api/admin/uploads` | POST | Raw image upload (JPEG/PNG/WebP/AVIF) |
| `/api/admin/ads/settings` | GET / PUT | Site-wide ads switch and publisher id |
| `/api/admin/ads/placements` | GET | Placement list; `GET/PUT/PATCH /:id` for one placement |
| `/api/admin/integrations` | GET | Breaker + feature state (JSON mirror of the admin page) |
| `/api/admin/integrations/:service/enable` / `/disable` | POST | Restore automatic protection / manual stop, with a recorded reason |

`password_hash` is never selected into a response. Any `/api/admin/*` request
without a valid session returns `401`; a signed-in account without the
`admin` role returns `403`.

### 7. Logout behaviour

`POST /admin/logout` requires a session and the CSRF token, then:

1. increments the account's `session_version`, which invalidates every session
   cookie ever issued for it (a copied cookie stops working immediately), and
2. clears the session cookie (`Max-Age=0`).

Afterwards `/admin/dashboard` answers `302` to `/admin/login?logged_out=1` and
`GET /api/admin/me` answers `401`.

### 8. How authentication is protected

- **Passwords**: bcrypt (cost 12 by default), never plaintext, never logged.
- **Sessions**: signed HS256 tokens in an `HttpOnly`, `SameSite=Lax` cookie,
  `Secure` in production. A fresh token is minted per sign-in (no session
  fixation), and each request re-reads the account row, so disabling an
  administrator takes effect at once.
- **Authorisation**: the role is read from the database on every request; the
  server never trusts a role sent by a client.
- **CSRF**: signed double-submit token on every state-changing admin request,
  plus `SameSite` cookies.
- **Rate limiting**: sliding window per IP + email, with a separate per-IP
  ceiling for password spraying. Failed and successful attempts are counted
  server-side; nothing about the request is logged.
- **Enumeration**: one generic message — "Invalid email or password." — for an
  unknown address, a wrong password, a disabled account and a non-admin role.
  A decoy bcrypt comparison keeps the response time constant.
- **Responses**: admin responses are `no-store`, `noindex`, and carry a strict
  `Content-Security-Policy` that allows local origins only — the admin pages
  load no third-party font CDN, so opening the dashboard does not tell Google
  when an administrator is at work. Templates escape every interpolated value.
  Errors never include stack traces or database details.

### 9. Operational notes

- Disabling an administrator: `UPDATE users SET is_active = false WHERE email =
  'admin@example.com';` — sign-in is blocked and existing sessions stop
  working.
- Changing a password through `npm run create-admin` invalidates existing
  sessions.
- `session_version` and the rate limiter are in-memory / row-level state: with
  several app instances, rate limits are enforced per instance.
- On the static Cloudflare Pages deployment there is no database, so
  `/admin/*` intentionally 404s there. Run the admin area on the Express
  deployment (or put `/admin` behind edge access control).

---

## Admin article CMS

The blog CMS runs inside the existing admin area at `/admin/articles`. It
reuses the existing `articles` and `categories` tables and adds four columns
(`meta_description`, `banner_alt`, `body_format`, `updated_at`) — see
[Database and migrations](#database-and-migrations).

### Authoring

- **Format.** The editor is a plain textarea enhanced in the browser; it works
  with JavaScript disabled. Rich-text mode writes sanitised HTML, source mode
  writes Markdown. `body_format` records which, and the public site renders
  each correctly, so seeded Markdown articles keep their existing layout.
- **Sanitising.** Every body is sanitised server-side on save, in
  `app/article-html.js`. Scripts, iframes, event-handler attributes, inline
  styles, `javascript:` URLs and unknown tags are dropped;
  `target="_blank"` is given `rel="noopener noreferrer"`. Text is escaped
  exactly once, so `&` and `<` typed by an author are displayed rather than
  executed. Preview pages are sanitised too — the preview is the same render
  path as the public page.
- **Drafts.** A draft may have a short or empty body and no meta description.
  Publishing requires a title, slug, category, a body of at least 40
  characters and a non-empty meta description (at most 160 characters).
  Unpublishing keeps the original `published_at` so republishing restores the
  original publication date.
- **Images.** Uploads go to `POST /api/admin/uploads` as a raw request body
  and are checked by magic bytes, not by the declared content type. The file
  is written under a generated name in `frontend/assets/uploads/`, so an
  upload cannot choose its own path or extension. Accepted: JPEG, PNG, WebP,
  AVIF up to `ADMIN_UPLOAD_MAX_KB`. Alt text is required whenever a banner is
  set.
- **Body size.** Article JSON bodies are limited separately from the rest of
  the API by `ADMIN_ARTICLE_BODY_KB` (default `512kb`).

### Draft visibility

Drafts never reach the public site. The list, single-article, category and
related-article queries all filter on `status = 'published'`, the
`/blog/:slug` handler checks the same before serving the shell, and the
sitemap generator only emits published rows. An unpublished article returns
`404` from the public API, and its slug answers `404` with the static 404
page (noindex), not a `200` SPA shell.

### Testing

```bash
cd app
npm run test:cms     # sanitiser, validation, uploads, views, guards — no server needed
```

The live suite additionally creates, edits, publishes, unpublishes, uploads
and deletes a real article over HTTP, then confirms it is gone.

---

## Ads and monetization

The site ships **unmonetised**: `ad_settings.ads_enabled` starts false, no
publisher id is seeded anywhere, and a fresh deployment serves no ad markup at
all.

- **Admin screen.** `/admin/ads` turns the site-wide switch on, stores the
  AdSense publisher id and edits each placement (header / sidebar / content /
  footer; type `none`, `adsense` or `custom`).
- **Validation.** The database refuses a publisher id that is not
  `ca-pub-<digits>` and a slot id that is not numeric, so a deployment cannot
  accidentally serve an ad against somebody else's account.
- **Public payload.** `GET /api/ads` returns only what may be rendered: a
  placement is served when it is enabled, has a usable type and resolves a
  real publisher id. `custom_html` is returned to the admin preview only and
  never to the public endpoint — a raw third-party snippet in an article body
  would otherwise be stored XSS.
- **CSP.** `frontend/_headers` ships a closed policy with no third-party ad
  origin. Switching ads on requires widening `script-src` in the same deploy,
  otherwise the script is blocked and the reserved slot stays empty; the exact
  directives are documented in that file.
- **Consent and legal pages.** `consent_required` defaults to true, so no ad
  is requested until the reader has consented; an optional consent-provider
  script URL may be configured and must be `https`, and `/privacy` and
  `/terms` are real routes linked from the footer.

`npm run test:admin:ads` and `npm run test:ads` cover all of the above
(239 checks).

---

## Open-data integrations

Optional enrichments read from public open data. Every one has a working
default in `app/config.js`, so leaving the environment unset runs the site
exactly as shipped.

| Service | Endpoints | Source / licence |
| --- | --- | --- |
| Wikidata facts | `/api/wikidata/search`, `/api/wikidata/entity/:id` | Wikidata — CC0 1.0 |
| Media metadata | `/api/media/search` | Wikimedia Commons — per-file CC/PD licences, never downloaded |
| Maps & geocoding | `/api/geo/config`, `/api/geo/destinations`, `/api/geo/place` | OpenStreetMap tiles + Nominatim — ODbL / usage policy |
| Headlines | `/api/news/latest` | Reviewed RSS feeds (Wikimedia Foundation, Mongabay) — CC BY-SA / CC BY-ND |

The full per-source licence and compliance record lives in
[`docs/external-data-licenses.md`](docs/external-data-licenses.md). The feed
registry in `app/rss-feeds.js` marks each entry `enabled` and `termsReviewed`;
an entry that is disabled or unreviewed is filtered out before any fetch, so
only reviewed feeds ever publish a headline.

### Automatic safety layer

Outbound calls are protected in `app/circuit-breaker.js` and surfaced on
`/admin/integrations`:

- **Master switches.** `ENABLE_WIKIDATA`, `ENABLE_COMMONS`, `ENABLE_MAPS`,
  `ENABLE_RSS` — an `ENABLE_*` flag set to `false` disables the service no
  matter what the breakers or the UI say.
- **Circuit breakers.** Open on N consecutive failures, on a failure rate
  above a threshold inside a trailing window, or immediately on 401/403/429.
  One probe is let through after a cooldown that doubles per failure, up to a
  ceiling. Three 403 answers in 24h lock the service until an administrator
  re-enables it.
- **Request envelopes.** Per-service hourly and daily caps; once spent,
  further calls are refused and whatever is cached is served instead.
- **Caching.** `external_data_cache` + `rss_items` absorb misses, so a broken
  upstream degrades to stale data rather than to an error page.
- **Map health.** A `0/0/0` tile probe runs periodically; while the tile
  breaker is open the frontend renders a text destination index instead of
  the map.
- **Licence re-audit.** A background job re-checks media licences; a file
  that drops off the allowlist is marked `HIDDEN` and disappears from the
  public images endpoint.
- **Events.** Every automatic stop and every admin override is recorded in
  `integration_events` (90-day retention) with a reason.
- **Background jobs** run under a Postgres advisory lock, so multiple app
  processes never run the same job twice; if the database is unreachable the
  job is skipped and the web server keeps serving.

Repository guardrails (the Dockerfile lists every runtime module explicitly,
the compose file mounts the safety schema, the migration runner applies it
last) are covered by `npm run test:external` (79 checks).

---

## Public site

A static SPA served identically by Express and by Cloudflare Pages. Every
clean route is `frontend/index.html` rendered by `frontend/router.js`.

| Route | Page |
| --- | --- |
| `/` | Home |
| `/blog`, `/stories` | Article listing (`/blog` is the indexed one) |
| `/blog/:slug` | Article detail (`/stories/:id` is the legacy id form) |
| `/news` | Latest news |
| `/category/:slug` | Category listing |
| `/about`, `/services`, `/contact`, `/careers` | Company pages |
| `/privacy`, `/terms` | Legal pages |
| `/guest-posts`, `/search`, `/portfolio`, `/marketplace`, `/cv`, `/dashboard`, `/profile/:id`, `/settings` | Tool views — noindex, excluded from the sitemap |
| anything else | 404 page |

Public API:

| Endpoint | Purpose |
| --- | --- |
| `/api/articles` | Published articles only (`LIMIT 50`); `search`, `category` and `trending` query filters |
| `/api/articles/:id`, `/api/articles/slug/:slug` | One published article |
| `/api/articles/:id/images` | Licence-audited images for an article |
| `/api/categories` | Categories ordered by display order |
| `/api/ads` | Public ad manifest (empty on a default install) |
| `/api/wikidata/*`, `/api/media/search`, `/api/geo/*`, `/api/news/latest` | Open-data integrations |

SEO and ops:

- `frontend/seo.js` rewrites title, description, canonical, robots and social
  tags per route on the client; Express answers with
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` and a strict
  `Referrer-Policy` (a strict `Content-Security-Policy` is applied to the admin
  surface only — see `app/server.js`).
- `frontend/sitemap.xml` is a generated file (not a per-request query) —
  regenerate after publishing with `npm run sitemap`.
- `frontend/robots.txt` disallows `/admin`, `/api/admin` and the tool views
  (all eight also emit `noindex` from `pages.js`; `/guest-posts` is noindexed
  and absent from the sitemap but is not listed in `robots.txt`);
  `frontend/_redirects` and `frontend/_headers` implement the same routing and
  headers on Cloudflare Pages.
- Leaflet is vendored locally under `frontend/vendor/leaflet` — no third-party
  CDN is loaded, so the page works offline and tells nothing to a font or
  script CDN.

---

## Deployment

### Container

```bash
export ADMIN_SESSION_SECRET=$(openssl rand -hex 48)
docker compose up --build -d
docker compose exec -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... app npm run create-admin
```

The image copies each `app/*.js` module explicitly, so a new module that is
not listed in the `Dockerfile` fails the build instead of missing at run time.

### Static (Cloudflare Pages / Netlify)

`frontend/` deploys as-is. `/admin/*` and the API 404 there by design (no
database at the edge) — serve the admin area from the Express deployment or
put it behind edge access control.

### Infrastructure

`terraform/` holds the IaC scaffold — `providers.tf`, `variables.tf`,
`main.tf`, `outputs.tf`, all currently **empty placeholders**. Checkov scans
them in CI gate 4 and fails on any high-severity misconfiguration, so real
resources must be written before they can pass or fail that gate.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/05-security/SECURITY-SRS.md`](docs/05-security/SECURITY-SRS.md) | Security requirements specification |
| [`docs/external-data-licenses.md`](docs/external-data-licenses.md) | Every runtime data source, its licence and our compliance |
| [`docs/11-ux-ui/MARKETPLACE-UX-UI.md`](docs/11-ux-ui/MARKETPLACE-UX-UI.md) | Marketplace UX/UI specification |
| [`docs/diagrams/index.html`](docs/diagrams/index.html) | Architecture, pipeline, ER, user-flow and defence-in-depth diagrams (SVG + PNG) |
| `docs/01-product/PRD.md`, `docs/02-requirements/SRS.md`, `docs/02-requirements/TRD.md`, `docs/11-ux-ui/UX-UI-DESIGN.md`, `security/README.md` | Placeholders — reserved for the product, requirements, design and security notes |

Scripts:

| Script | Purpose |
| --- | --- |
| `scripts/generate-sitemap.js` | Rebuild `frontend/sitemap.xml` from published articles |
| `scripts/verify-editorial.sh` | Check rendered article pages for markup faults |
| `scripts/verify-fixes.sh` | Route / sitemap / coverage verification against a running server |
| `scripts/fetch_topic_images.py` | Topic image tooling (writes `scripts/topic-images.tsv`) |

---

## Verified end-to-end run

The full stack has been brought up and the entire test battery re-run against
it (October 2026, local machine):

| Step | Command | Result |
| --- | --- | --- |
| 1. Build and start | `docker compose up -d --build` | `devsecops-app` (:3007) and `devsecops-compose-db` (:5434, healthy) running |
| 2. Schema and seeds | `docker-entrypoint-initdb.d` (on first volume creation) | Verified present: 10 tables, 59 published articles, 6 categories |
| 3. Create the administrator | `docker compose exec app npm run create-admin` | `Administrator ready: admin@example.com (id 4, role admin)` |
| 4. Public site | `GET /` | `200`, SPA shell served |
| 5. Admin login page | `GET /admin/login` | `200` |
| 6. Public API | `GET /api/articles` | `200` |
| 7. Full test battery | `npm test` | **8 suites, 829 checks, 0 failures** |
| 8. Live admin suite | `npm run test:admin:live` | `ALL 116 CHECKS PASSED` |

Per-suite results:

```
seo-smoke-test        ALL CHECKS PASSED            (76)
admin-auth-test       ALL 100 CHECKS PASSED
cms-test              189 checks passed, 0 failed
admin-ads-test        167 checks passed, 0 failed
ads-test              72/72 passed
admin-smoke-test      ALL 116 CHECKS PASSED
circuit-breaker-test  30/30 passed
external-test         79/79 passed
```

The seven CI gates mirror these steps: secrets, SAST, SCA, IaC, container,
tests and DAST, each failing the build on its own findings.
