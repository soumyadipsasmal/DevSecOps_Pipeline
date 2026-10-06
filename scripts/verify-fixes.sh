#!/usr/bin/env bash
# Post-fix verification: routes, sitemap, and article coverage.
BASE=http://localhost:3007
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; pass=$((pass+1));
        else echo "  FAIL  $1 -> got $2 want $3"; fail=$((fail+1)); fi }

echo "== TASK 1: /blog and neighbours =="
for p in / /blog /blog/ /stories /news /about /services /contact /careers \
         /category/bollywood /category/travel /sitemap.xml /robots.txt; do
  chk "GET $p" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")" 200
done
chk "GET /nope (still 404)" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/nope")" 404
chk "/blog is not a redirect" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/blog")" 200
chk "/blog serves the SPA shell" "$(curl -s "$BASE/blog" | grep -c 'id="app"')" 1

echo
echo "== sitemap served statically =="
curl -s -D /tmp/h.txt -o /tmp/sm.xml "$BASE/sitemap.xml"
chk "content-type xml" "$(grep -ci 'content-type:.*xml' /tmp/h.txt)" 1
chk "no dynamic marker" "$(curl -s "$BASE/sitemap.xml" | grep -c 'urlset')" 2
chk "url count" "$(grep -c '<loc>' /tmp/sm.xml)" 72
chk "unique locs" "$(grep -o '<loc>[^<]*</loc>' /tmp/sm.xml | sort -u | wc -l)" 72
chk "no localhost" "$(grep -c 'localhost' /tmp/sm.xml)" 0

echo
echo "== every DB article URL is in the sitemap and resolves =="
cd /home/soumya/DevSecOps_Pipeline
docker compose exec -T db psql -U medium_user -d medium_clone -t -A -c \
  "select slug from articles where status='published' and slug is not null" \
  > /tmp/slugs.txt
missing=0; broken=0; total=0
while read -r slug; do
  [ -z "$slug" ] && continue
  total=$((total+1))
  grep -q "https://kalinova.in/blog/$slug<" /tmp/sm.xml || { echo "  NOT IN SITEMAP: $slug"; missing=$((missing+1)); }
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/blog/$slug")
  [ "$code" = "200" ] || { echo "  BROKEN $code /blog/$slug"; broken=$((broken+1)); }
done < /tmp/slugs.txt
chk "articles checked" "$total" 59
chk "articles missing from sitemap" "$missing" 0
chk "articles not returning 200" "$broken" 0

echo
echo "== /blog page metadata (rendered client-side, verify via seo.js) =="
chk "/blog in sitemap once" "$(grep -c '<loc>https://kalinova.in/blog</loc>' /tmp/sm.xml)" 1
chk "/stories not in sitemap" "$(grep -c '<loc>https://kalinova.in/stories</loc>' /tmp/sm.xml)" 0

echo
echo "RESULT: $pass passed, $fail failed"