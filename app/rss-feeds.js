"use strict";

/**
 * KaliNova — approved RSS feed registry
 *
 * Adding a feed is a licensing decision, not a code change: copy a block
 * below, fill in what you verified, and flip `enabled: true`. The engine in
 * rss-service.js only ever fetches enabled entries.
 *
 * Review checklist (also documented in docs/external-data-licenses.md):
 *   1. Does the publisher's terms/ licence permit headline + short excerpt +
 *      link use on a commercial, advertising-supported site?
 *   2. What attribution does it require, and is that shown here?
 *   3. Does the feed itself carry only what we are allowed to keep
 *      (headline, date, excerpt, link)? We never store full article bodies.
 *   4. Record the source of the answer in `termsNote` and the date in
 *      `reviewedAt`.
 *
 * Entries with enabled:false are documents of a decision already taken —
 * they show what was considered and why it was refused. Nothing fetches them.
 */

module.exports = [
  {
    source: "Wikimedia Foundation",
    url: "https://wikimediafoundation.org/feed/",
    category: "latest-news",
    enabled: true,
    termsReviewed: true,
    license: "CC BY-SA 4.0",
    attribution: "Wikimedia Foundation (linked per item)",
    termsNote:
      "Site content is CC BY-SA 4.0 unless noted: commercial reuse allowed with attribution and share-alike. Headline + short excerpt + link with credit is within the licence.",
    reviewedAt: "2026-10-06"
  },
  {
    source: "Mongabay News",
    url: "https://news.mongabay.com/feed/",
    category: "wildlife",
    enabled: true,
    termsReviewed: true,
    license: "CC BY-ND 4.0",
    attribution: "Author and Mongabay, linked per item",
    termsNote:
      "Articles are CC BY-ND 4.0; the publisher's own guidelines allow printing the first few sentences with a link back and state that putting articles on ad-supported pages is fine. Unedited excerpt + link used here.",
    reviewedAt: "2026-10-06"
  },

  /* --------------------------------------------------------------------
   * Considered and NOT enabled. Kept as the paper trail for the decision.
   * -------------------------------------------------------------------- */

  {
    source: "The Guardian",
    url: "https://www.theguardian.com/uk/rss",
    category: "latest-news",
    enabled: false,
    license: "not open",
    attribution: "",
    termsNote:
      "Refused: the publisher states its RSS feeds are for “personal, non-commercial purposes in accordance with our terms of service”, and its terms reserve all commercial use. Not usable on an ad-supported site.",
    reviewedAt: "2026-10-06"
  },
  {
    source: "The Conversation",
    url: "https://theconversation.com/in/articles.rss",
    category: "latest-news",
    enabled: false,
    license: "CC BY-ND 4.0 (articles)",
    attribution: "",
    termsNote:
      "Refused pending clarification: articles are CC BY-ND and republishing with ads is generally permitted, but the publisher's UK guidelines say commercial use needs a paid licence and forbid systematic republication. Needs written confirmation before enabling.",
    reviewedAt: "2026-10-06"
  },
  {
    source: "Indian mainstream news feeds (TOI, Indian Express, NDTV, HT, India Today…)",
    url: "",
    category: "latest-news",
    enabled: false,
    license: "not verified",
    attribution: "",
    termsNote:
      "Refused: no reviewed evidence that these publishers permit commercial aggregation of their feeds; their site terms generally reserve rights. Do not enable without a written terms review per feed.",
    reviewedAt: "2026-10-06"
  }
];
