#!/usr/bin/env bash
set -euo pipefail
cd /home/soumya/DevSecOps_Pipeline

echo "== no stray ** in rendered article pages =="
for slug in drishyam-3-final-chapter-matters \
           ranbir-kapoor-ramayana-global-attention \
           salman-khan-maatrubhumi-new-attention \
           how-bollywood-franchises-are-changing-in-2026 \
           the-paradise-nani-box-office-milestone \
           remembering-singeetham-srinivasa-rao \
           why-telugu-cinema-continues-to-grow \
           new-generation-of-telugu-actors-and-storytellers; do
  hits=$(curl -s "http://localhost:3007/blog/$slug" | grep -c '\*\*' || true)
  strong=$(curl -s "http://localhost:3007/blog/$slug" | grep -c '<strong>' || true)
  echo "$slug  literal_asterisk_markers=$hits  strong_tags=$strong"
done

echo "== final counts =="
docker compose exec -T db psql -U medium_user -d medium_clone -t -A -F'|' -c \
  "select (select count(*) from articles) as articles, (select count(*) from article_images) as images, (select count(distinct file_path) from article_images) as distinct_paths"

echo "== sitemap =="
curl -s http://localhost:3007/sitemap.xml | grep -c "<loc>"

echo "== all 24 new slugs resolve =="
fail=0
for slug in drishyam-3-final-chapter-matters ranbir-kapoor-ramayana-global-attention \
  salman-khan-maatrubhumi-new-attention how-bollywood-franchises-are-changing-in-2026 \
  the-paradise-nani-box-office-milestone remembering-singeetham-srinivasa-rao \
  why-telugu-cinema-continues-to-grow new-generation-of-telugu-actors-and-storytellers \
  saree-without-a-traditional-blouse durga-puja-fashion-guide-2026 \
  indian-handloom-fashion-new-generation quiet-luxury-meets-indian-fashion \
  india-fourth-asian-games-2026-85-medals gst-arrest-powers-proposal-explained \
  october-2026-bank-holidays-guide jaishankar-india-russia-ukraine-peace-efforts \
  buxa-tiger-reserve-new-tigress plan-bee-255-elephants-saved \
  six-tiger-reserves-india national-parks-reopen-safari-season \
  best-places-in-india-for-october 10-weekend-getaways-from-delhi \
  scenic-train-journeys-india travel-destinations-to-watch-in-2026; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3007/blog/$slug")
  if [ "$code" != "200" ]; then echo "FAIL $code $slug"; fail=1; fi
done
[ "$fail" = "0" ] && echo "all 24 slugs return 200"