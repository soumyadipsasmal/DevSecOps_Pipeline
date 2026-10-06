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

COPY database /database

COPY scripts/topic-images.tsv /seed-data/topic-images.tsv

COPY frontend /frontend

EXPOSE 3007

CMD ["node", "server.js"]