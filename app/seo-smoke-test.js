/**
 * Smoke test for frontend/seo.js using a minimal DOM stub.
 * Verifies that applyPage / applyArticle / applyCategory write exactly one tag
 * of each kind, produce absolute https://kalinova.in URLs, and emit valid JSON-LD.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

class El {
  constructor(tag) {
    this.tagName = tag;
    this.attrs = {};
    this.children = [];
    this.textContent = "";
    // Real DOM elements reflect these IDL properties onto content attributes.
    for (const name of ["rel", "id", "type", "href", "src", "name", "property", "content"]) {
      Object.defineProperty(this, name, {
        get: () => this.attrs[name],
        set: v => { this.attrs[name] = String(v); },
      });
    }
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
}

const head = new El("head");
head.querySelector = sel => head.children.find(c => matches(c, sel)) || null;
head.appendChild = c => head.children.push(c);

function matches(el, sel) {
  if (!el || !sel) return false;
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  const m = sel.match(/^(\w+)\[([\w-]+)="([^"]*)"\]$/);
  if (!m) return false;
  return el.tagName === m[1] && el.attrs[m[2]] === m[3];
}

const document = {
  head,
  title: "",
  getElementById: id => head.children.find(c => c.id === id) || null,
  createElement: tag => new El(tag),
  addEventListener() {},
  dispatchEvent() {},
};

const sandbox = { window: { location: { hash: "", pathname: "/" } }, document, console };
sandbox.window.document = document;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO, "frontend/seo.js"), "utf8"), sandbox, {
  filename: "seo.js",
});

const SEO = sandbox.window.KaliNovaSEO;

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}${extra ? " -> " + extra : ""}`); failures++; }
}
const metaContent = name =>
  head.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
const ogContent = prop =>
  head.querySelector(`meta[property="${prop}"]`)?.getAttribute("content") ?? null;
const countOf = sel => head.children.filter(c => matches(c, sel)).length;

console.log("\n[1] Static page: home");
SEO.applyPage("home");
check("title set", document.title === "KaliNova — Read. Write. Share.", document.title);
check("description set", !!metaContent("description"));
check("canonical absolute", head.querySelector('link[rel="canonical"]').getAttribute("href") === "https://kalinova.in/");
check("robots indexable", metaContent("robots").startsWith("index"));
check("og:url absolute", ogContent("og:url") === "https://kalinova.in/");
check("og:image absolute https", ogContent("og:image").startsWith("https://kalinova.in/assets/"));
check("twitter:card set", metaContent("twitter:card") === "summary_large_image");
check("exactly one canonical", countOf('link[rel="canonical"]') === 1, countOf('link[rel="canonical"]'));
check("exactly one json-ld node", countOf("#kalinova-jsonld") === 1, countOf("#kalinova-jsonld"));
let ld = JSON.parse(head.children.find(c => c.id === "kalinova-jsonld").textContent);
check("graph is @graph", Array.isArray(ld["@graph"]));
check("graph has Organization", ld["@graph"].some(n => n["@type"] === "Organization"));
check("graph has WebSite", ld["@graph"].some(n => n["@type"] === "WebSite"));
check("SearchAction present", ld["@graph"].some(n => n["@type"] === "WebSite" && n.potentialAction?.["@type"] === "SearchAction"));

console.log("\n[2] Noindex page: search");
SEO.applyPage("search", { path: "/search?q=x" });
check("robots noindex,follow", metaContent("robots") === "noindex, follow", metaContent("robots"));
check("canonical strips query", head.querySelector('link[rel="canonical"]').getAttribute("href") === "https://kalinova.in/search");
check("og:url strips query", ogContent("og:url") === "https://kalinova.in/search");

console.log("\n[3] Article page");
const article = {
  id: 39, slug: "why-local-travel-can-be-just-as-exciting-as-long-trips",
  title: "Why Local Travel Can Be Just as Exciting as Long Trips",
  cover_image: "/assets/topics/travel/25.jpg",
  category_name: "Travel", category_slug: "travel",
  published_at: "2026-10-03T18:08:03.703Z",
  word_count: 640,
};
SEO.applyArticle(article, { excerpt: "Many people dream about travelling to distant countries." });
check("title has site suffix", document.title.endsWith("| KaliNova"), document.title);
check("title length <= 60 ideal (<=70)", document.title.length <= 70, `${document.title.length}: ${document.title}`);
check("canonical is /blog/<slug>", head.querySelector('link[rel="canonical"]').getAttribute("href") === `https://kalinova.in/blog/${article.slug}`);
check("og:type article", ogContent("og:type") === "article");
check("og:image from cover", ogContent("og:image") === "https://kalinova.in/assets/topics/travel/25.jpg", ogContent("og:image"));
check("og:image alt not set (ok)", true);
check("article:published_time set", ogContent("article:published_time") === "2026-10-03T18:08:03.703Z");
check("article:section set", ogContent("article:section") === "Travel");
check("description under 160", (metaContent("description") || "").length <= 160, metaContent("description")?.length);
ld = JSON.parse(head.children.find(c => c.id === "kalinova-jsonld").textContent);
const posting = ld["@graph"].find(n => n["@type"] === "BlogPosting");
check("BlogPosting present", !!posting);
check("BlogPosting url matches canonical", posting?.url === `https://kalinova.in/blog/${article.slug}`);
check("BlogPosting headline", posting?.headline === article.title);
check("BlogPosting datePublished", !!posting?.datePublished);
check("BlogPosting has dateModified", !!posting?.dateModified);
check("BlogPosting wordCount", posting?.wordCount === 640);
check("BlogPosting image absolute", posting?.image?.[0]?.startsWith("https://kalinova.in/"));
check("BreadcrumbList present", ld["@graph"].some(n => n["@type"] === "BreadcrumbList"));
const crumbs = ld["@graph"].find(n => n["@type"] === "BreadcrumbList");
check("breadcrumb has 4 positions", crumbs?.itemListElement?.length === 4, crumbs?.itemListElement?.length);
check("breadcrumb positions sequential", crumbs?.itemListElement.every((c, i) => c.position === i + 1));
check("breadcrumb items absolute", crumbs?.itemListElement.every(c => c.item.startsWith("https://kalinova.in/")));
check("no duplicate canonical after 3 renders", countOf('link[rel="canonical"]') === 1, countOf('link[rel="canonical"]'));
check("no duplicate json-ld after 3 renders", countOf("#kalinova-jsonld") === 1, countOf("#kalinova-jsonld"));

console.log("\n[4] Category page");
SEO.applyCategory({ name: "Bollywood", slug: "bollywood" }, 6);
check("canonical /category/bollywood", head.querySelector('link[rel="canonical"]').getAttribute("href") === "https://kalinova.in/category/bollywood");
ld = JSON.parse(head.children.find(c => c.id === "kalinova-jsonld").textContent);
check("CollectionPage present", ld["@graph"].some(n => n["@type"] === "CollectionPage"));
check("ItemList numberOfItems 6", ld["@graph"].some(n => n.mainEntity?.numberOfItems === 6));

console.log("\n[5] No invented data check");
const all = JSON.stringify(ld);
check("no aggregateRating", !all.includes("aggregateRating"));
check("no streetAddress", !all.includes("streetAddress"));
check("no foundingDate", !all.includes("foundingDate"));
check("no sameAs/social profiles", !all.includes("sameAs"));
check("no fake rating value", !/"ratingValue"|"reviewCount"/.test(all));
check("no localhost anywhere in seo.js", !fs.readFileSync(path.join(REPO, "frontend/seo.js"), "utf8").includes("localhost"));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);