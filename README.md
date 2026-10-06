# KaliNova

Independent publishing platform: a public article site (Node.js + Express +
PostgreSQL, static frontend SPA) with an administrator-only dashboard.

```
app/        Express API, admin authentication, CLI scripts
database/   schema, seeds and migrations
frontend/   public SPA (index.html, router.js, pages.js) + admin stylesheet
scripts/    sitemap generation and image tooling
docs/       product, requirements and security documentation
terraform/  infrastructure
```

## Requirements

- Node.js 18+ (the container image uses Node 22)
- PostgreSQL 14+ (the compose file runs PostgreSQL 16)

## Quick start (Docker)

```bash
export ADMIN_SESSION_SECRET=$(openssl rand -hex 48)   # signs the admin session cookie
docker compose up --build
docker compose exec app npm run create-admin           # needs ADMIN_EMAIL/ADMIN_PASSWORD
```

`POSTGRES_*` credentials in `docker-compose.yml` are development values. Replace
them before deploying anywhere public.

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

### npm scripts (run from `app/`)

| Script | Purpose |
| --- | --- |
| `npm start` | Start the Express server |
| `npm run migrate` | Apply `database/schema-admin-auth.sql` (idempotent) |
| `npm run create-admin` | Create or repair an administrator account |
| `npm run seed:images` | Match article photos to article bodies |
| `npm run sitemap` | Regenerate `frontend/sitemap.xml` |
| `npm test` | SEO smoke test, offline admin auth tests, live admin HTTP checks |
| `npm run test:seo` | SEO smoke test only |
| `npm run test:admin` | Offline admin authentication tests (no database needed) |
| `npm run test:admin:live` | End-to-end admin HTTP checks against a running server |

## SECURITY PIPELINE

Every commit is checked locally, every push is checked by the seven jobs in
`.github/workflows/devsecops-pipeline.yml`, and Dependabot keeps the inputs to
both current.

### Pre-commit secret scan

```bash
git config core.hooksPath githooks     # once per clone
```

`githooks/pre-commit` runs `gitleaks git --staged` against the index and blocks
the commit when it finds a key. It needs [gitleaks](https://github.com/gitleaks/gitleaks#installation)
installed (`winget install gitleaks.gitleaks` on Windows); if it is missing the
hook refuses to pass rather than scanning nothing. One-off bypass:
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

## ADMIN SETUP

The admin area is **administrator-only**. There is no public registration, and
visitors cannot create articles: `POST /api/articles` sits behind the same
`requireAdmin` guard as the admin API.

### 1. Environment variables

Set these in `app/.env` (local) or in the shell / secret manager used by
`docker compose` (container).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ADMIN_SESSION_SECRET` | **yes in production** | random per boot in dev | HMAC key that signs the admin session cookie. At least 32 characters. |
| `ADMIN_SESSION_MINUTES` | no | `480` | Session lifetime in minutes |
| `ADMIN_COOKIE_NAME` | no | `kalinova_admin_session` | Session cookie name |
| `ADMIN_CSRF_COOKIE_NAME` | no | `kalinova_admin_csrf` | CSRF cookie name |
| `ADMIN_BCRYPT_ROUNDS` | no | `12` | bcrypt cost factor (10–15) |
| `ADMIN_LOGIN_ATTEMPTS` | no | `8` | Failed sign-ins allowed per window, per IP + email |
| `ADMIN_LOGIN_WINDOW_MINUTES` | no | `15` | Rate-limit window |
| `ADMIN_COOKIE_SECURE` | no | `true` when `NODE_ENV=production` | Force the `Secure` cookie flag |
| `TRUST_PROXY` | no | `false` | Set to `true` (or a hop count) behind a reverse proxy so rate limiting sees real client IPs |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`NODE_ENV=production` makes the app refuse to start without a strong
`ADMIN_SESSION_SECRET`: it must be at least 32 characters and must not still look
like a placeholder (`change-this…`, `dev-only…`, `replace-me…`, `secret`, …), so a
development value copied into production fails loudly instead of signing cookies
with a key an attacker already knows. `JWT_SECRET` is still accepted as a
fallback key for older deployments.

### 2. Database migration

Admin accounts live in the existing `users` table, which already stores the
site author's bcrypt `password_hash` — no second identity table is created. The
migration adds `role`, `is_active`, `session_version`, `last_login_at` and
`updated_at`, plus two check constraints and an index. It is idempotent and
never rewrites an existing `password_hash`.

```bash
cd app
npm run migrate
```

Equivalent without the script:

```bash
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
     -f database/schema-admin-auth.sql \
     -f database/schema-article-cms.sql
```

Fresh Docker volumes apply it automatically
(`docker-entrypoint-initdb.d/08-admin-auth.sql` and `09-article-cms.sql`). An
existing volume only runs init scripts on first creation, so run
`npm run migrate` after pulling.

The second file adds the article-CMS columns, trigger and indexes; see
[ADMIN ARTICLE CMS](#admin-article-cms).

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
  and invalidates current sessions. The password is only rewritten when it does
  not already match, so re-running after a password change cannot undo it.
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

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/admin` | GET | yes | Redirects to the dashboard |
| `/admin/login` | GET | no | Login form (redirects to the dashboard if already signed in) |
| `/admin/login` | POST | no | Sign in, then `303` to `/admin/dashboard` |
| `/admin/dashboard` | GET | yes | Counts and recent articles |
| `/admin/logout` | POST | yes | Ends the session, then `303` to `/admin/login?logged_out=1` |
| `/api/admin/csrf` | GET | no | Issues a CSRF token for the JSON API |
| `/api/admin/login` | POST | no | JSON sign-in; needs `X-CSRF-Token` |
| `/api/admin/logout` | POST | yes | Ends the session |
| `/api/admin/me` | GET | yes | `{ "id": 1, "email": "admin@example.com", "role": "admin" }` |
| `/api/admin/dashboard` | GET | yes | `{ "stats": {...}, "recentArticles": [...] }` |

Article CMS endpoints (all mutations need `X-CSRF-Token`):

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/admin/articles` | GET | Article list with status, category and search filters |
| `/admin/articles/new` | GET | Create form |
| `/admin/articles/new` | POST | Save; `intent=preview` renders the preview instead |
| `/admin/articles/:id/edit` | GET | Edit form |
| `/admin/articles/:id` | POST | Update, or publish / unpublish / delete via `intent` |
| `/admin/articles/:id/preview` | GET | Saved-article preview |
| `/admin/articles/:id/delete` | GET | Delete confirmation |
| `/api/admin/articles` | GET / POST | List / create (`201`) |
| `/api/admin/articles/:id` | GET / PATCH / PUT / DELETE | Read, update, delete |
| `/api/admin/articles/:id/status` | POST | `{ "status": "draft" \| "published" }` |
| `/api/admin/categories` | GET | Categories for the form's category picker |
| `/api/admin/uploads` | POST | Raw image upload (JPEG/PNG/WebP/AVIF) |

`password_hash` is never selected into a response. Any `/api/admin/*` request
without a valid session returns `401`; a signed-in account without the `admin`
role returns `403`.

### 6. Logout behaviour

`POST /admin/logout` requires a session and the CSRF token, then:

1. increments the account's `session_version`, which invalidates every session
   cookie ever issued for it (a copied cookie stops working immediately), and
2. clears the session cookie (`Max-Age=0`).

Afterwards `/admin/dashboard` answers `302` to `/admin/login?logged_out=1` and
`GET /api/admin/me` answers `401`.

### 7. How authentication is protected

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
  `Content-Security-Policy` that allows local origins only — the admin pages load
  no third-party font CDN, so opening the dashboard does not tell Google when an
  administrator is at work. Templates escape every interpolated value. Errors
  never include stack traces or database details.

### 8. Verifying it works

```bash
cd app
npm test                       # SEO, admin auth and CMS offline tests

# Live checks (needs the server running and an admin account):
BASE_URL=http://localhost:3007 \
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='your-password' \
npm run test:admin:live
```

The live script covers the sign-in page, invalid email, invalid password,
successful sign-in, the redirect to the dashboard, dashboard access while
authenticated and while anonymous, the admin API with and without a session,
logout, access after logout, replayed-cookie rejection, and that the public site
and article/category endpoints still respond. Without `ADMIN_EMAIL` /
`ADMIN_PASSWORD` it prints `SKIP` and exits successfully.

### 9. Operational notes

- Disabling an administrator: `UPDATE users SET is_active = false WHERE email =
  'admin@example.com';` — sign-in is blocked and existing sessions stop working.
- Changing a password through `npm run create-admin` invalidates existing
  sessions.
- `session_version` and the rate limiter are in-memory / row-level state: with
  several app instances, rate limits are enforced per instance.
- On the static Cloudflare Pages deployment there is no database, so `/admin/*`
  intentionally 404s there. Run the admin area on the Express deployment (or put
  `/admin` behind edge access control).

## ADMIN ARTICLE CMS

The blog CMS runs inside the existing admin area at `/admin/articles`. It reuses
the existing `articles` and `categories` tables and adds four columns.

### Migration

```bash
cd app
npm run migrate
```

`database/schema-article-cms.sql` is idempotent and never rewrites existing
article content. It adds:

| Column | Type | Notes |
| --- | --- | --- |
| `meta_description` | `text` | Used for search results and social descriptions |
| `banner_alt` | `text` | Alt text for the cover image |
| `body_format` | `varchar(10)` | `text` for seeded rows, `html` for CMS rows |
| `updated_at` | `timestamptz` | Backfilled from `published_at`/`created_at`, then kept current by a trigger |

It also tightens `status` to `draft` / `published` with a check constraint (added
`NOT VALID`, so existing rows are not re-scanned) and adds indexes for the
status, publication-date and category/status queries.

`npm run migrate` now applies `schema-admin-auth.sql` then
`schema-article-cms.sql`, each in its own transaction, and fails loudly if a
column is still missing afterwards. Fresh Docker volumes apply both from
`docker-entrypoint-initdb.d`; run the migration manually on an existing volume.

### Authoring

- **Format.** The editor is a plain textarea enhanced in the browser; it works
  with JavaScript disabled. Rich-text mode writes sanitised HTML, source mode
  writes Markdown. `body_format` records which, and the public site renders each
  correctly, so seeded Markdown articles keep their existing layout.
- **Sanitising.** Every body is sanitised server-side on save, in
  `app/article-html.js`. Scripts, iframes, event-handler attributes, inline
  styles, `javascript:` URLs and unknown tags are dropped; `target="_blank"` is
  given `rel="noopener noreferrer"`. Text is escaped exactly once, so `&` and
  `<` typed by an author are displayed rather than executed. Preview pages are
  sanitised too — the preview is the same render path as the public page.
- **Drafts.** A draft may have a short or empty body and no meta description.
  Publishing requires a title, slug, category, a body of at least 40 characters
  and a meta description of at least 50. Unpublishing keeps the original
  `published_at` so republishing restores the original publication date.
- **Images.** Uploads go to `POST /api/admin/uploads` as a raw request body and
  are checked by magic bytes, not by the declared content type. The file is
  written under a generated name in `frontend/assets/uploads/`, so an upload
  cannot choose its own path or extension. Accepted: JPEG, PNG, WebP, AVIF up
  to `ADMIN_UPLOAD_MAX_KB` (default 6144). Alt text is required whenever a
  banner is set.
- **Body size.** Article JSON bodies are limited separately from the rest of the
  API by `ADMIN_ARTICLE_BODY_KB` (default `512kb`), so a large article does not
  require raising the limit on every other endpoint.

### Draft visibility

Drafts never reach the public site. The list, single-article, category and
related-article queries all filter on `status = 'published'`, the
`/blog/:slug` existence check does the same before rendering, and the sitemap
generator only emits published rows. An unpublished article returns `404` from
the public API and its slug still loads the SPA shell, which then shows the
not-found state.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_ARTICLE_BODY_KB` | `512` | Request body limit for article JSON |
| `ADMIN_UPLOAD_MAX_KB` | `6144` | Maximum upload size in KB |

Uploaded images live in the container filesystem by default.
`docker-compose.yml` mounts a named `uploads` volume at
`/frontend/assets/uploads` so they survive a rebuild.

### Testing

```bash
cd app
npm test              # SEO, admin auth, CMS offline tests, live admin checks
npm run test:cms      # CMS only, no database or server needed
```

`test:cms` covers the sanitiser, validation rules, slug uniqueness, upload safety,
the rendered admin views, route guards and public draft visibility. The live
suite additionally creates, edits, publishes, unpublishes, uploads and deletes a
real article over HTTP, then confirms it is gone.