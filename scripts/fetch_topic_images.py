#!/usr/bin/env python3
"""
Download freely-licensed topic images from Openverse for the KaliNova blog
categories, resize them to a blog-banner size and compress each one under
100 KB.

Images land in frontend/assets/topics/<slug>/<nn>.jpg and are recorded in
scripts/topic-images.json so the slugs can be mapped onto articles later.

Usage:
    python3 scripts/fetch_topic_images.py [--per-topic 50] [--max-kb 100]
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image

USER_AGENT = "DevSecOpsPipeline/1.0 (KaliNova blog asset fetcher)"

API = "https://api.openverse.org/v1/images/"

# Each category gets several search terms. Openverse matches on title,
# description and tags, so varied phrasing surfaces different photos.
TOPICS = {
    "bollywood": [
        "bollywood",
        "bollywood actress",
        "bollywood film",
        "indian cinema film set",
        "bollywood premiere",
        "film camera shooting",
        "indian film poster",
        "cinema projector",
    ],
    "tollywood": [
        "tollywood",
        "telugu film",
        "tollywood actor",
        "telugu cinema",
        "andhra pradesh temple",
        "telugu festival",
        "south indian cinema",
        "hyderabad film",
    ],
    "fashion": [
        "fashion model runway",
        "saree",
        "lehenga",
        "indian fashion",
        "textile weaving",
        "embroidery",
        "fashion accessories",
        "clothing rack boutique",
    ],
    "latest-news": [
        "newsroom",
        "newspaper reading",
        "press conference",
        "city skyline traffic",
        "stock market board",
        "government building",
        "crowd street india",
        "telecommunication tower",
    ],
    "wildlife": [
        "tiger india",
        "asian elephant",
        "leopard",
        "indian rhinoceros",
        "bird wetland",
        "deer forest",
        "wildlife sanctuary",
        "butterfly insect",
    ],
    "travel": [
        "kerala backwaters",
        "india train journey",
        "himalaya mountain",
        "taj mahal",
        "beach india",
        "old city street",
        "monsoon rain landscape",
        "river boat",
    ],
}

MAX_DIM = 1200
MIN_DIM = 400


def http_get(url, params=None, timeout=30):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def search(term, page_size=20, page=1):
    """
    Return (results, page_count) for one search term.

    The anonymous Openverse tier caps page_size at 20, so deep result sets are
    reached by walking pages rather than asking for a bigger page.
    """
    params = {
        "q": term,
        "page_size": page_size,
        "page": page,
        # Only images licensed for commercial reuse with modification.
        "license_type": "commercial",
        "mature": "false",
        "extension": "jpg",
    }
    raw = http_get(API, params)
    data = json.loads(raw)
    return data.get("results", []), data.get("page_count", 1)


def fetch_image(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def compress(raw, max_kb, max_dim=MAX_DIM):
    """
    Re-encode bytes as JPEG under max_kb. Steps quality down, then shrinks the
    image if quality alone is not enough. Returns (bytes, w, h).
    """
    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")

    # Guard against thumbnails and SVGs masquerading as jpgs.
    if img.width < MIN_DIM or img.height < MIN_DIM:
        raise ValueError("too small: %dx%d" % (img.width, img.height))

    # Only ever downscale; never upscale a small original.
    if max(img.width, img.height) > max_dim:
        scale = max_dim / float(max(img.width, img.height))
        new_size = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
        img = img.resize(new_size, Image.LANCZOS)

    target = max_kb * 1024
    for quality in (85, 78, 72, 66, 60, 55, 50, 45, 40):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
        if buf.tell() <= target:
            return buf.getvalue(), img.width, img.height

    # Still too big: halve the dimensions and try a short quality sweep.
    for _ in range(3):
        img = img.resize((max(1, img.width // 2), max(1, img.height // 2)), Image.LANCZOS)
        for quality in (75, 65, 55, 45):
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
            if buf.tell() <= target:
                return buf.getvalue(), img.width, img.height
        if max(img.width, img.height) < 480:
            break

    raise ValueError("could not compress under %d KB" % max_kb)


def slugify(text):
    out = []
    for ch in text.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-")


def fetch_with_retry(fn, retries=3, pause=2.0):
    """Call fn, retrying transient network failures with a linear backoff."""
    last = None
    for attempt in range(1, retries + 1):
        try:
            return fn()
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            last = exc
            if attempt < retries:
                time.sleep(pause * attempt)
    raise last


def existing_sources(tsv_path):
    """
    Read already-attributed source URLs so a second run does not re-download
    the same photos. Returns a set of normalised URLs, or empty if missing.
    """
    seen = set()
    if not os.path.exists(tsv_path):
        return seen
    with open(tsv_path, encoding="utf-8") as fh:
        header = fh.readline()
        cols = header.rstrip("\n").split("\t")
        if "source" not in cols:
            return seen
        idx = cols.index("source")
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) > idx and parts[idx]:
                seen.add(parts[idx].strip())
    return seen


def collect(topic_slug, terms, want, max_kb, out_dir,
            dry_run=False, start_index=1, max_pages=6, retries=3,
            skip_sources=None):
    saved = []
    seen_ids = set()
    seen_urls = set(skip_sources or set())
    idx = start_index

    for term in terms:
        if len(saved) >= want:
            break

        try:
            results, page_count = fetch_with_retry(
                lambda t=term: search(t, page_size=20, page=1), retries=retries)
        except Exception as exc:  # noqa: BLE001
            print("    search failed for %r: %s" % (term, exc))
            continue

        pages = min(page_count or 1, max_pages)
        for page in range(1, pages + 1):
            if len(saved) >= want:
                break

            if page > 1:
                try:
                    results, _ = fetch_with_retry(
                        lambda t=term, p=page: search(t, page_size=20, page=p),
                        retries=retries)
                except Exception as exc:  # noqa: BLE001
                    print("    search page %d failed for %r: %s" % (page, term, exc))
                    break

            for item in results:
                if len(saved) >= want:
                    break

                img_id = item.get("id")
                url = item.get("url")
                landing = (item.get("foreign_landing_url") or "").strip()
                if not url or img_id in seen_ids or url in seen_urls:
                    continue
                # Already attributed on a previous run?
                if landing and landing in seen_urls:
                    continue
                seen_ids.add(img_id)
                seen_urls.add(url)
                if landing:
                    seen_urls.add(landing)

                if dry_run:
                    print("    [dry] %s | %s" % (item.get("title"), url))
                    saved.append({"topic": topic_slug, "title": item.get("title"), "url": url})
                    continue

                try:
                    raw = fetch_with_retry(lambda u=url: fetch_image(u), retries=retries)
                    data, w, h = compress(raw, max_kb)
                except Exception as exc:  # noqa: BLE001 - many remote failure modes
                    print("    skip %s: %s" % (url, exc))
                    continue

                fname = "%03d.jpg" % idx
                path = os.path.join(out_dir, fname)
                with open(path, "wb") as fh:
                    fh.write(data)

                saved.append(
                    {
                        "topic": topic_slug,
                        "file": "/assets/topics/%s/%s" % (topic_slug, fname),
                        "title": item.get("title"),
                        "creator": item.get("creator"),
                        "license": item.get("license"),
                        "source": landing,
                        "width": w,
                        "height": h,
                        "bytes": len(data),
                    }
                )
                print("    %s  %5.1f KB  %dx%d  %s" % (fname, len(data) / 1024.0, w, h, (item.get("title") or "")[:44]))

                idx += 1

                # Small politeness delay so the API is not hammered.
                time.sleep(0.12)

    return saved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-topic", type=int, default=50,
                    help="total images wanted per topic")
    ap.add_argument("--max-kb", type=int, default=100)
    ap.add_argument("--topics", default="", help="comma separated subset")
    ap.add_argument("--out", default="frontend/assets/topics")
    ap.add_argument("--manifest", default="scripts/topic-images.json")
    ap.add_argument("--append-tsv", default="scripts/topic-images.tsv",
                    help="attribution TSV to append to")
    ap.add_argument("--skip-existing", action="store_true",
                    help="keep images already on disk and only add up to --per-topic")
    ap.add_argument("--max-pages", type=int, default=6,
                    help="max result pages to walk per search term")
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    topics = TOPICS
    if args.topics:
        wanted = {t.strip() for t in args.topics.split(",") if t.strip()}
        topics = {k: v for k, v in TOPICS.items() if k in wanted}
        if not topics:
            sys.exit("no matching topics; known: %s" % ", ".join(TOPICS))

    if not args.dry_run:
        os.makedirs(args.out, exist_ok=True)

    # Sources already attributed, so re-running tops up rather than
    # re-downloading photos that are already on disk.
    skip_sources = set()
    if args.skip_existing:
        skip_sources = existing_sources(args.append_tsv)

    manifest = []
    for slug, terms in topics.items():
        out_dir = os.path.join(args.out, slug)
        print("\n== %s (target %d) ==" % (slug, args.per_topic))
        if not args.dry_run:
            os.makedirs(out_dir, exist_ok=True)

        # Continue numbering after whatever is already on disk.
        on_disk = 0
        if not args.dry_run and os.path.isdir(out_dir):
            for name in os.listdir(out_dir):
                stem, ext = os.path.splitext(name)
                if ext.lower() in (".jpg", ".jpeg") and stem.isdigit():
                    on_disk = max(on_disk, int(stem))

        start_index = on_disk + 1
        want = max(0, args.per_topic - on_disk)
        if want == 0:
            print("   already has %d images, nothing to do" % on_disk)
            continue

        got = collect(slug, terms, want, args.max_kb, out_dir,
                      args.dry_run, start_index=start_index,
                      max_pages=args.max_pages, retries=args.retries,
                      skip_sources=skip_sources)
        print("   added %d (now %d)" % (len(got), on_disk + len(got)))
        manifest.extend(got)

    if not args.dry_run:
        with open(args.manifest, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, ensure_ascii=False)

        if manifest and args.append_tsv:
            new = os.path.exists(args.append_tsv)
            with open(args.append_tsv, "a", encoding="utf-8") as fh:
                if not new:
                    fh.write("file\ttitle\tcreator\tlicense\tsource\n")
                for m in manifest:
                    row = [
                        m.get("file", ""),
                        (m.get("title") or "").replace("\t", " "),
                        (m.get("creator") or "").replace("\t", " "),
                        m.get("license") or "",
                        m.get("source") or "",
                    ]
                    fh.write("\t".join(row) + "\n")

        total = sum(m.get("bytes", 0) for m in manifest)
        print("\nwrote %s: %d images, %.1f MB total"
              % (args.manifest, len(manifest), total / 1048576.0))


if __name__ == "__main__":
    main()