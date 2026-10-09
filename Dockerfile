FROM node:22-alpine

WORKDIR /app

COPY app/package*.json ./

RUN npm ci --omit=dev

COPY app/server.js .
COPY app/db.js .
COPY app/config.js .
COPY app/security.js .
COPY app/admin-service.js .
COPY app/admin-views.js .
COPY app/admin-routes.js .
COPY app/create-admin.js .
COPY app/migrate.js .
COPY app/article-images.js .
COPY app/seed-images.js .
COPY app/article-html.js .
COPY app/article-validation.js .
COPY app/article-uploads.js .
COPY app/article-service.js .
COPY app/admin-article-views.js .
COPY app/admin-article-routes.js .
# Ads and monetization. Copied individually like the rest of the app modules, so
# a new module that is not listed here fails at start-up rather than silently
# missing from the image.
COPY app/ads-service.js .
COPY app/admin-ads-views.js .
COPY app/admin-ads-routes.js .

# Open-data integrations (Wikidata / Commons / OSM / RSS). Same rule as the
# ads modules above: each file is listed explicitly, so a forgotten module
# fails the build instead of missing at run time.
COPY app/external-http.js .
COPY app/external-cache.js .
COPY app/external-routes.js .
COPY app/wikidata-service.js .
COPY app/media-service.js .
COPY app/geo-service.js .
COPY app/travel-destinations.js .
COPY app/feed-parser.js .
COPY app/rss-feeds.js .
COPY app/rss-service.js .
# Automatic open-data safety (Phase 2): circuit breakers, background jobs,
# tile health and licence re-checks. Listed explicitly, same rule as above.
COPY app/circuit-breaker.js .
COPY app/background-jobs.js .
COPY app/map-health.js .
COPY app/license-audit.js .
COPY app/admin-integrations-routes.js .
COPY app/admin-integrations-views.js .

# Editorial research workflow (sources, provenance, copy-similarity warning).
# Same rule as every module above: listed explicitly, so a forgotten file fails
# the build rather than missing from the image at run time.
COPY app/content-similarity.js .
COPY app/article-sources.js .
COPY app/admin-research-routes.js .

# Monetization dashboard (affiliate links, sponsored campaigns, direct ads,
# newsletter, disclosures, audit). Same rule as every module above.
COPY app/monetization-service.js .
COPY app/affiliate-service.js .
COPY app/sponsored-service.js .
COPY app/direct-ads-service.js .
COPY app/monetization-routes.js .
COPY app/admin-monetization-routes.js .
COPY app/admin-monetization-views.js .

# SEO engine and slug-change redirects. The analyzer is pure JavaScript, the
# redirect service owns the redirects table, and the two admin surfaces expose
# both. Listed explicitly, same rule as every module above.
COPY app/seo-engine.js .
COPY app/redirect-service.js .
COPY app/admin-seo-routes.js .
COPY app/admin-redirect-routes.js .
COPY app/admin-redirect-views.js .

# SEO master pipeline: per-page metadata, the dynamic sitemap/robots service,
# the tag taxonomy, the public SEO routes and the scheduled-article poller.
# Listed explicitly, same rule as every module above.
COPY app/seo-meta.js .
COPY app/sitemap-service.js .
COPY app/tag-service.js .
COPY app/seo-master-routes.js .
COPY app/scheduled-publisher.js .

COPY database /database

COPY scripts/topic-images.tsv /seed-data/topic-images.tsv

COPY frontend /frontend

EXPOSE 3007

CMD ["node", "server.js"]