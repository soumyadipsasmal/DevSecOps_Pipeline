/**
 * KaliNova — Central SEO configuration
 *
 * Single source of truth for the canonical origin, per-page metadata and the
 * JSON-LD builders. Loaded before router.js so every page render can describe
 * itself without repeating URLs or titles.
 *
 * Everything here is derived from information already in this repository or the
 * database. Nothing is invented: no fake ratings, addresses, founding dates or
 * social profiles.
 */
(() => {
  "use strict";

  const SITE = {
    name: "KaliNova",
    origin: "https://kalinova.in",
    locale: "en_IN",
    // Organization logo: a square, crawlable brand image. The full-width
    // wordmark (assets/kalinova-logo.png) is 2172x724, which no crawler needs.
    logo: "/assets/icon-512.png",
    // Fallback social card for pages that have no article cover of their own.
    defaultOgImage: "/assets/og-image.png",
    // Used for og:image:alt whenever a page supplies no alt text of its own, so
    // the tag is never empty.
    defaultOgImageAlt: "KaliNova",
    tagline: "Read. Write. Share.",
    // Wording reused from the existing homepage and footer copy.
    description:
      "KaliNova is an independent publishing platform for readers and writers, " +
      "covering stories on cinema, fashion, news, wildlife and travel.",
    founder: {
      name: "Soumyadip Sasmal",
      jobTitle: "Founder & Entrepreneur",
    },
    contact: {
      email: "soumyadipsasmal88@gmail.com",
      phone: "+91 6290687215",
    },
  };

  /* Canonical paths for the real, indexable pages. Private or thin views are
     deliberately absent so they cannot be linked from the sitemap. */
  const PATHS = {
    home: "/",
    about: "/about",
    services: "/services",
    contact: "/contact",
    stories: "/stories",
    blog: "/blog",
    news: "/news",
    careers: "/careers",
    search: "/search",
    privacy: "/privacy",
    terms: "/terms",
    blogPrefix: "/blog/",
    categoryPrefix: "/category/",
    tagPrefix: "/tag/",
    authorPrefix: "/author/",
  };

  /* Per-page title/description. `title` is the full <title>; `description` is
     the meta description. Both are written for a human first. */
  const PAGE_META = {
    home: {
      title: "KaliNova — Read. Write. Share.",
      description:
        "KaliNova is an independent publishing platform covering cinema, fashion, " +
        "news, wildlife and travel. Read the latest stories, or write and publish your own.",
      path: PATHS.home,
      ogType: "website",
    },
    about: {
      title: "About KaliNova — Our Story and Our Founder",
      description:
        "The story behind KaliNova, founded by Soumyadip Sasmal: why an independent " +
        "publishing platform was built from the ground up, and where it is heading.",
      path: PATHS.about,
      ogType: "article",
    },
    services: {
      title: "What KaliNova Offers — Read, Write and Publish",
      description:
        "What KaliNova offers: long-form stories across six topics, topic pages that " +
        "collect related writing, in-article photo essays, and a simple way to publish.",
      path: PATHS.services,
      ogType: "website",
    },
    contact: {
      title: "Contact KaliNova",
      description:
        "Get in touch with KaliNova about stories, corrections, writing enquiries or " +
        "anything else. Email and phone details, plus where to find us.",
      path: PATHS.contact,
      ogType: "website",
    },
    stories: {
      // /stories is the older name for the same listing. It still renders and
      // is still linked from older pages, but it is not the indexable URL: the
      // canonical is always /blog so the two never compete in search results.
      title: "All Stories — KaliNova",
      description:
        "Every story published on KaliNova, covering cinema, fashion, news, wildlife " +
        "and travel.",
      path: PATHS.blog,
      ogType: "website",
    },
    blog: {
      title: "All Stories — KaliNova",
      description:
        "Every story published on KaliNova, covering cinema, fashion, news, wildlife " +
        "and travel.",
      path: PATHS.blog,
      ogType: "website",
    },
    news: {
      title: "Latest News and Stories — KaliNova",
      description:
        "The most recent stories published on KaliNova across news, cinema, fashion, " +
        "wildlife and travel.",
      path: PATHS.news,
      ogType: "website",
    },
    careers: {
      title: "Careers at KaliNova",
      description:
        "KaliNova is hiring across writing, design and engineering. Read about how the " +
        "company works and how to apply.",
      path: PATHS.careers,
      ogType: "website",
    },
    search: {
      // The search page is a tool, not a content page: it should not compete
      // with the stories it returns.
      title: "Search — KaliNova",
      description: "Search stories on KaliNova by keyword, topic or author.",
      path: PATHS.search,
      ogType: "website",
      noindex: true,
    },
    privacy: {
      title: "Privacy Policy — KaliNova",
      description:
        "What KaliNova collects, which cookies it uses, and what happens to your " +
        "data. Advertising is not currently running on this site.",
      path: PATHS.privacy,
      ogType: "website",
    },
    terms: {
      title: "Terms of Use — KaliNova",
      description:
        "The terms that apply to reading and writing on KaliNova, covering " +
        "republishing, guest posts and external links.",
      path: PATHS.terms,
      ogType: "website",
    },
  };

  /* ------------------------------------------------------------------ */
  /* URL helpers                                                         */
  /* ------------------------------------------------------------------ */

  /** Absolute URL for a root-relative path, with no double slashes. */
  function abs(path) {
    if (!path) return `${SITE.origin}/`;
    if (/^https?:\/\//i.test(path)) return path;
    const clean = path.startsWith("/") ? path : `/${path}`;
    return `${SITE.origin}${clean.replace(/\/{2,}/g, "/")}`;
  }

  const articlePath = slug => `${PATHS.blogPrefix}${encodeURIComponent(slug)}`;
  const categoryPath = slug => `${PATHS.categoryPrefix}${encodeURIComponent(slug)}`;
  const tagPath = slug => `${PATHS.tagPrefix}${encodeURIComponent(slug)}`;
  const authorPath = slug => `${PATHS.authorPrefix}${encodeURIComponent(slug)}`;
  const articleUrl = slug => abs(articlePath(slug));

  /** Strip protocol and any trailing slash so one page yields one canonical. */
  function canonicalPath(path) {
    const clean = String(path || "/").split("?")[0].split("#")[0];
    const trimmed = clean.replace(/\/+$/, "");
    return trimmed === "" ? "/" : trimmed;
  }

  /* ------------------------------------------------------------------ */
  /* Head writers                                                        */
  /* ------------------------------------------------------------------ */

  function upsertMeta(selector, attrs) {
    let el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement("meta");
      document.head.appendChild(el);
    }
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === "") {
        el.removeAttribute(key);
      } else {
        el.setAttribute(key, value);
      }
    }
    return el;
  }

  function setTitle(title) {
    document.title = title;
    upsertMeta('meta[name="title"]', { name: "title", content: title });
  }

  function setDescription(description) {
    upsertMeta('meta[name="description"]', { name: "description", content: description });
  }

  function setCanonical(path) {
    const href = abs(canonicalPath(path));
    let link = document.head.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement("link");
      document.head.appendChild(link);
    }
    link.setAttribute("rel", "canonical");
    link.setAttribute("href", href);
    return href;
  }

  function setRobots(directives) {
    upsertMeta('meta[name="robots"]', {
      name: "robots",
      content: directives || "index, follow",
    });
  }

  /**
   * Write the Open Graph and Twitter card tags together, since both are always
   * derived from the same four values.
   */
  function setSocial({
    title,
    description,
    url,
    image,
    type = "website",
    siteName = SITE.name,
    locale = SITE.locale,
    card = "summary_large_image",
    publishedTime,
    modifiedTime,
    section,
    tags,
    imageAlt,
    // Per-entity overrides an editor can set in the CMS. Each one falls back to
    // the value above, so a page that sets none behaves exactly as before.
    canonicalOverride,
    ogTitle,
    ogDescription,
    ogImage,
    twitterTitle,
    twitterDescription,
    twitterImage,
    robots,
  }) {
    const canonicalPathValue = canonicalPath(url);
    const canonical = abs(canonicalOverride ? canonicalPath(canonicalOverride) : canonicalPathValue);
    const socialTitle = ogTitle || title;
    const socialDescription = ogDescription || description;
    const imageUrl = abs(ogImage || image || SITE.defaultOgImage);

    // The canonical link and og:url must never disagree, so they are written
    // together here rather than by each page renderer. setCanonical expects a
    // path, not an already-absolute URL. A canonical override may be absolute,
    // in which case canonicalPath keeps its host but drops the query/hash.
    setCanonical(canonicalOverride ? canonicalOverride : canonicalPathValue);
    if (robots) setRobots(robots);

    const og = {
      "og:title": socialTitle,
      "og:description": socialDescription,
      "og:type": type,
      "og:url": canonical,
      "og:image": imageUrl,
      "og:site_name": siteName,
      "og:locale": locale,
    };
    // Alt text written by an administrator in the CMS. Falls back to the
    // default image's own alt so the tag is never empty.
    const ogAlt = imageAlt || SITE.defaultOgImageAlt;
    if (ogAlt) og["og:image:alt"] = ogAlt;

    if (type === "article") {
      if (publishedTime) og["article:published_time"] = publishedTime;
      if (modifiedTime) og["article:modified_time"] = modifiedTime;
      if (section) og["article:section"] = section;
      if (tags && tags.length) og["article:tag"] = tags;
    }

    for (const [property, content] of Object.entries(og)) {
      if (content === null || content === undefined) continue;
      upsertMeta(`meta[property="${property}"]`, { property, content });
    }

    const tw = {
      "twitter:card": card,
      "twitter:title": twitterTitle || socialTitle,
      "twitter:description": twitterDescription || socialDescription,
      "twitter:image": abs(twitterImage || ogImage || image || SITE.defaultOgImage),
    };
    if (ogAlt) tw["twitter:image:alt"] = ogAlt;
    if (type === "article") {
      if (publishedTime) tw["twitter:label1"] = "Published";
      if (publishedTime) upsertMeta('meta[name="twitter:label1"]', { name: "twitter:label1", content: "Published" });
      upsertMeta('meta[name="twitter:data1"]', { name: "twitter:data1", content: publishedTime || "" });
      if (section) {
        upsertMeta('meta[name="twitter:label2"]', { name: "twitter:label2", content: "Topic" });
        upsertMeta('meta[name="twitter:data2"]', { name: "twitter:data2", content: section });
      }
    }

    for (const [name, content] of Object.entries(tw)) {
      if (content === null || content === undefined) continue;
      upsertMeta(`meta[name="${name}"]`, { name, content });
    }

    return { canonical, imageUrl };
  }

  /* ------------------------------------------------------------------ */
  /* JSON-LD                                                             */
  /* ------------------------------------------------------------------ */

  const SCHEMA_ORG = "https://schema.org";

  let jsonLdNode = null;

  /** Replace the single managed JSON-LD block with the given node or array. */
  function setJsonLd(node) {
    // index.html ships a static graph so crawlers that do not execute JS still
    // see it. Reuse that same node rather than adding a second one.
    if (!jsonLdNode) {
      jsonLdNode = document.getElementById("kalinova-jsonld");
    }
    if (!jsonLdNode) {
      jsonLdNode = document.createElement("script");
      jsonLdNode.setAttribute("type", "application/ld+json");
      jsonLdNode.setAttribute("id", "kalinova-jsonld");
      document.head.appendChild(jsonLdNode);
    }
    jsonLdNode.textContent = JSON.stringify(node);
  }

  function clearJsonLd() {
    if (jsonLdNode) jsonLdNode.textContent = "";
  }

  /**
   * KaliNova publishes under a single author account named for the site, so the
   * publisher is the Organization and the article author is the Organization
   * too. The founder is a separate Person and is referenced from the About page
   * only, where the site actually talks about him.
   */
  function organizationNode() {
    return {
      "@type": "Organization",
      "@id": `${SITE.origin}/#organization`,
      name: SITE.name,
      url: `${SITE.origin}/`,
      logo: {
        "@type": "ImageObject",
        url: abs(SITE.logo),
      },
      email: SITE.contact.email,
      contactPoint: [
        {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: SITE.contact.email,
          telephone: SITE.contact.phone,
          availableLanguage: ["en", "hi"],
        },
      ],
    };
  }

  function websiteNode() {
    return {
      "@type": "WebSite",
      "@id": `${SITE.origin}/#website`,
      name: SITE.name,
      url: `${SITE.origin}/`,
      description: SITE.description,
      inLanguage: "en-IN",
      publisher: { "@id": `${SITE.origin}/#organization` },
      // Search really is implemented: /search?q= is handled by the frontend and
      // GET /api/articles?search= does the matching.
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${SITE.origin}${PATHS.search}?q={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
    };
  }

  function webPageNode({ path, name, description, breadcrumb, type = "WebPage" }) {
    const node = {
      "@context": SCHEMA_ORG,
      "@type": type,
      "@id": `${abs(path)}#webpage`,
      url: abs(path),
      name,
      description,
      isPartOf: { "@id": `${SITE.origin}/#website` },
      about: { "@id": `${SITE.origin}/#organization` },
      inLanguage: "en-IN",
    };
    if (breadcrumb) node.breadcrumb = { "@id": `${abs(path)}#breadcrumb` };
    return node;
  }

  function breadcrumbNode(items, path) {
    return {
      "@type": "BreadcrumbList",
      "@id": `${abs(path)}#breadcrumb`,
      itemListElement: items.map((item, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: item.name,
        item: abs(item.path),
      })),
    };
  }

  /**
   * BlogPosting for a real article. Every field is taken from the API row;
   * anything missing is omitted rather than guessed.
   */
  function articleNode(article) {
    if (!article || !article.slug) return null;

    const path = articlePath(article.slug);
    const url = abs(path);
    const image = article.cover_image ? abs(article.cover_image) : abs(SITE.defaultOgImage);
    const published = article.published_at || article.created_at || null;
    const modified = article.updated_at || published;

    const node = {
      "@type": "BlogPosting",
      "@id": `${url}#article`,
      mainEntityOfPage: { "@type": "WebPage", "@id": `${url}#webpage` },
      url,
      headline: article.title,
      isAccessibleForFree: true,
      inLanguage: "en-IN",
      image: [image],
      author: { "@id": `${SITE.origin}/#organization` },
      publisher: { "@id": `${SITE.origin}/#organization` },
    };

    const nodeDescription = article.meta_description || article.excerpt;
    if (nodeDescription) node.description = nodeDescription;
    if (published) {
      node.datePublished = published;
      node.dateModified = modified;
    }
    if (article.category_name) node.articleSection = article.category_name;
    if (article.tags && article.tags.length) node.keywords = article.tags.join(", ");
    if (article.word_count) node.wordCount = article.word_count;

    return node;
  }

  /** Assemble a page's schema graph, always including the site entities. */
  function pageGraph(pageNode, extraNodes = []) {
    const graph = [organizationNode(), websiteNode()];
    if (pageNode) graph.push(pageNode);
    for (const node of extraNodes) {
      if (node) graph.push(node);
    }
    return { "@context": SCHEMA_ORG, "@graph": graph };
  }

  /* ------------------------------------------------------------------ */
  /* Text helpers                                                        */
  /* ------------------------------------------------------------------ */

  function clamp(text, max) {
    const clean = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]$/, "")}…`;
  }

  /**
   * Apply a static page definition: title, description, canonical, robots,
   * social cards and a WebPage schema graph.
   */
  function applyPage(key, overrides = {}) {
    const base = PAGE_META[key];
    if (!base) return null;

    const meta = { ...base, ...overrides };
    const path = canonicalPath(meta.path || PATHS[key]);
    const robots = meta.noindex ? "noindex, follow" : "index, follow";

    setTitle(meta.title);
    setDescription(meta.description);
    setRobots(robots);
    const { canonical } = setSocial({
      title: meta.title,
      description: meta.description,
      url: path,
      image: meta.image,
      type: meta.ogType,
      publishedTime: meta.publishedTime,
      modifiedTime: meta.modifiedTime,
      section: meta.section,
      tags: meta.tags,
    });

    setJsonLd(
      pageGraph(
        webPageNode({
          path,
          name: meta.title,
          description: meta.description,
          type: meta.schemaType || "WebPage",
          breadcrumb: meta.breadcrumb,
        }),
        meta.extraSchema
      )
    );

    return { canonical, meta };
  }

  /**
   * Apply an article's metadata. Titles keep the site suffix; descriptions come
   * from the article excerpt so they are never generic.
   */
  function applyArticle(article, { excerpt, breadcrumb } = {}) {
    if (!article || !article.slug) return null;

    const path = articlePath(article.slug);
    // Prefer the administrator's own meta description, then a page-supplied
    // excerpt, then the title. Never truncated silently beyond the SEO limit.
    const description = clamp(article.meta_description || excerpt || article.excerpt || article.title, 158);
    // A hand-written meta title is used verbatim (minus the site suffix the
    // editor already sees in the SERP preview); otherwise the suffix is added.
    const title = article.meta_title
      ? clamp(article.meta_title, 60)
      : `${clamp(article.title, 95)} | ${SITE.name}`;
    const robots = `${article.robots_index || "index"}, ${article.robots_follow || "follow"}`;

    setTitle(title);
    setDescription(description);
    setRobots(robots);

    const { canonical } = setSocial({
      title,
      description,
      url: path,
      image: article.cover_image,
      imageAlt: article.banner_alt,
      type: "article",
      publishedTime: article.published_at || article.created_at,
      modifiedTime: article.updated_at || article.published_at || article.created_at,
      section: article.category_name,
      tags: article.tags,
      canonicalOverride: article.canonical_url,
      ogTitle: article.og_title,
      ogDescription: article.og_description,
      ogImage: article.og_image,
      twitterTitle: article.twitter_title,
      twitterDescription: article.twitter_description,
      twitterImage: article.twitter_image,
      robots,
    });

    const crumbs = breadcrumb || [
      { name: "Home", path: PATHS.home },
      { name: "Stories", path: PATHS.stories },
      { name: article.category_name || "Article", path: article.category_slug ? categoryPath(article.category_slug) : PATHS.stories },
      { name: article.title, path },
    ];

    setJsonLd(
      pageGraph(
        webPageNode({
          path,
          name: article.title,
          description,
          type: "WebPage",
          breadcrumb: true,
        }),
        [articleNode(article), breadcrumbNode(crumbs, path)]
      )
    );

    return { canonical };
  }

  /** Apply a category listing page. */
  function applyCategory(category, articleCount) {
    if (!category || !category.slug) return null;

    const path = categoryPath(category.slug);
    const name = category.name;
    const description = clamp(
      category.description ||
        `The latest ${name} stories published on KaliNova.`,
      158
    );
    const title = category.meta_title ? clamp(category.meta_title, 60) : `${name} — ${SITE.name}`;
    const robots = `${category.robots_index || "index"}, ${category.robots_follow || "follow"}`;

    setTitle(title);
    setDescription(description);
    setRobots(robots);

    const { canonical } = setSocial({
      title,
      description,
      url: path,
      image: category.image,
      type: "website",
      canonicalOverride: category.canonical_url,
      ogTitle: category.og_title,
      ogDescription: category.og_description,
      ogImage: category.og_image,
      twitterTitle: category.twitter_title,
      twitterDescription: category.twitter_description,
      twitterImage: category.twitter_image,
      robots,
    });

    const crumbs = [
      { name: "Home", path: PATHS.home },
      { name: "Stories", path: PATHS.stories },
      { name, path },
    ];

    setJsonLd(
      pageGraph(webPageNode({ path, name, description, type: "CollectionPage", breadcrumb: true }), [
        breadcrumbNode(crumbs, path),
        {
          "@type": "CollectionPage",
          "@id": `${abs(path)}#collection`,
          url: abs(path),
          name,
          description,
          isPartOf: { "@id": `${SITE.origin}/#website` },
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: articleCount || 0,
            itemListOrder: "https://schema.org/ItemListOrderDescending",
          },
        },
      ])
    );

    return { canonical };
  }

  /** Apply a tag archive page (/tag/<slug>). */
  function applyTag(tag, articleCount) {
    if (!tag || !tag.slug) return null;

    const path = tagPath(tag.slug);
    const name = tag.name || "Tag";
    const description = clamp(
      tag.meta_description ||
        tag.description ||
        `Stories tagged “${name}” on KaliNova.`,
      158
    );
    const title = tag.meta_title ? clamp(tag.meta_title, 60) : `${name} — ${SITE.name}`;
    const robots = `${tag.robots_index || "index"}, ${tag.robots_follow || "follow"}`;

    setTitle(title);
    setDescription(description);
    setRobots(robots);

    const { canonical } = setSocial({
      title,
      description,
      url: path,
      type: "website",
      canonicalOverride: tag.canonical_url,
      ogTitle: tag.og_title,
      ogDescription: tag.og_description,
      ogImage: tag.og_image,
      twitterTitle: tag.twitter_title,
      twitterDescription: tag.twitter_description,
      twitterImage: tag.twitter_image,
      robots,
    });

    const crumbs = [
      { name: "Home", path: PATHS.home },
      { name: "Stories", path: PATHS.stories },
      { name, path },
    ];

    setJsonLd(
      pageGraph(webPageNode({ path, name, description, type: "CollectionPage", breadcrumb: true }), [
        breadcrumbNode(crumbs, path),
        {
          "@type": "CollectionPage",
          "@id": `${abs(path)}#collection`,
          url: abs(path),
          name,
          description,
          isPartOf: { "@id": `${SITE.origin}/#website` },
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: articleCount || 0,
            itemListOrder: "https://schema.org/ItemListOrderDescending",
          },
        },
      ])
    );

    return { canonical };
  }

  /** Apply an author archive page (/author/<slug>). */
  function applyAuthor(author, articleCount) {
    if (!author || !author.slug) return null;

    const path = authorPath(author.slug);
    const name = author.display_name || author.username || "Author";
    const description = clamp(
      author.meta_description ||
        author.bio ||
        `Stories written by ${name} on KaliNova.`,
      158
    );
    const title = author.meta_title ? clamp(author.meta_title, 60) : `${name} — ${SITE.name}`;
    const robots = `${author.robots_index || "index"}, ${author.robots_follow || "follow"}`;

    setTitle(title);
    setDescription(description);
    setRobots(robots);

    const { canonical } = setSocial({
      title,
      description,
      url: path,
      image: author.avatar_url,
      type: "profile",
      canonicalOverride: author.canonical_url,
      ogTitle: author.og_title,
      ogDescription: author.og_description,
      ogImage: author.og_image,
      twitterTitle: author.twitter_title,
      twitterDescription: author.twitter_description,
      twitterImage: author.twitter_image,
      robots,
    });

    const crumbs = [
      { name: "Home", path: PATHS.home },
      { name: "Stories", path: PATHS.stories },
      { name, path },
    ];

    const person = {
      "@type": "Person",
      "@id": `${abs(path)}#person`,
      name,
      url: abs(path),
    };
    if (author.bio) person.description = author.bio;
    if (author.avatar_url) person.image = abs(author.avatar_url);

    setJsonLd(
      pageGraph(webPageNode({ path, name, description, type: "ProfilePage", breadcrumb: true }), [
        breadcrumbNode(crumbs, path),
        person,
        {
          "@type": "ProfilePage",
          "@id": `${abs(path)}#profile`,
          url: abs(path),
          name: title,
          description,
          about: { "@id": `${abs(path)}#person` },
          isPartOf: { "@id": `${SITE.origin}/#website` },
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: articleCount || 0,
            itemListOrder: "https://schema.org/ItemListOrderDescending",
          },
        },
      ])
    );

    return { canonical };
  }

  /**
   * Legacy hash URLs (#/stories/12) are still reachable but must never be the
   * indexed version of a page. Point them at the clean path instead.
   */
  function redirectLegacyHash() {
    const hash = window.location.hash;
    if (!hash || hash.length < 2) return false;

    const match = hash.match(/^#\/(stories|category|about|services|contact|careers|news|stories)(?:\/([^?#]*))?/);
    if (!match) return false;

    const [, section, value] = match;
    if (section === "stories" && value) {
      // Numeric ids are remapped to slugs by the article route once it loads,
      // so only non-numeric slugs can be rewritten without an API round trip.
      if (/^\d+$/.test(value)) return false;
      window.location.replace(abs(articlePath(value)));
      return true;
    }
    if (section === "category" && value) {
      window.location.replace(abs(categoryPath(value)));
      return true;
    }
    return false;
  }

  window.KaliNovaSEO = {
    SITE,
    PATHS,
    PAGE_META,
    abs,
    articlePath,
    articleUrl,
    categoryPath,
    tagPath,
    authorPath,
    canonicalPath,
    clamp,
    setTitle,
    setDescription,
    setCanonical,
    setRobots,
    setSocial,
    setJsonLd,
    clearJsonLd,
    applyPage,
    applyArticle,
    applyCategory,
    applyTag,
    applyAuthor,
    redirectLegacyHash,
  };
})();