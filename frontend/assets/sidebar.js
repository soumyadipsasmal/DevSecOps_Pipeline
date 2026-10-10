/**
 * KaliNova — Sidebar blocks
 *
 * The social grid, newsletter card and promo banner that sit under the
 * trending list. Exposed as window.KaliNovaSidebar so any page that renders a
 * .sidebar can drop in the same markup.
 *
 * Config lives in SOCIAL_LINKS and PROMO at the top of the file. Replace the
 * URLs there and every sidebar on the site follows.
 */
(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Configuration                                                      */
  /* ------------------------------------------------------------------ */

  /* Point these at the real KaliNova accounts to go live. The markup does not
     care which network it is; only `id`, `label`, `url` and `color` are read. */
  const SOCIAL_LINKS = [
    { id: "facebook",  label: "Facebook",  url: "https://www.facebook.com/",        color: "#1877F2" },
    { id: "x",         label: "X",         url: "https://x.com/",                    color: "#000000" },
    { id: "pinterest", label: "Pinterest", url: "https://www.pinterest.com/",       color: "#E60023" },
    { id: "instagram", label: "Instagram", url: "https://www.instagram.com/",       color: "#C13584" },
    { id: "youtube",   label: "YouTube",   url: "https://www.youtube.com/",         color: "#FF0000" },
    { id: "whatsapp",  label: "WhatsApp",  url: "https://wa.me/918945511785",       color: "#25D366" }
  ];

  const PROMO = {
    eyebrow: "KaliNova",
    headline: "Build. Innovate. Grow.",
    cta: "Get Started",
    href: "/about",
    /* og-image.png is the existing 1200x630 brand image, so the banner needs no
       new asset and matches the social cards already shared by the site. */
    image: "/assets/og-image.png",
    alt: "KaliNova — Build. Innovate. Grow."
  };

  // Set once the list endpoint exists, either by editing this value or by
  // calling KaliNovaSidebar.setEndpoint("/api/newsletter") from the shell.
  let NEWSLETTER_ENDPOINT = "";
  const TERMS_URL = "/terms";
  const PRIVACY_URL = "/privacy";

  /* ------------------------------------------------------------------ */
  /* Icons (inline, single path each)                                   */
  /* ------------------------------------------------------------------ */

  const ICONS = {
    facebook: '<path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07z"/>',
    x: '<path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.64 7.58H.47l8.6-9.83L0 1.15h7.6l5.24 6.93 6.06-6.93zm-1.29 19.49h2.04L6.49 3.24H4.3l13.31 17.4z"/>',
    pinterest: '<path d="M12.02 0C5.4 0 .11 5.3.1 11.92c0 2.1.55 4.14 1.59 5.94.14.2.24.43.24.66 0 .27-.14.54-.33.74-.23.26-.51.4-.79.4-.32 0-.57-.2-.73-.53-.21-.44-.32-.87-.32-1.22 0-.43.44-1.06 1.11-1.75.51-.52.81-1.02.81-1.5 0-.63-.57-1.14-1.37-1.14-.93 0-1.58.73-1.58 1.68 0 .48.2.87.47 1.03.16.11.19.21.14.36-.13.35-.4.88-.46.99-.08.15-.21.18-.39.11-.57-.25-.9-.9-.9-1.77 0-1.29 1.06-2.79 3-2.79 1.53 0 2.84 1.07 2.84 2.71 0 1.83-1.02 3.2-2.44 3.2-.53 0-1.02-.3-1.19-.63l-.66 2.64c-.24.94-.85 2.1-.85 2.1 0 .04.02.06.07.05.03-.01 1.42-.83 3.02-1.56 1.56-.72 2.95-1.41 3.33-1.73.74-.63 1.37-1.56 1.37-2.45 0-.04-.02-.07-.05-.1-.02-.03-.04-.05-.07-.04z"/>',
    instagram: '<path d="M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63c-.79.31-1.46.72-2.13 1.38S.94 3.35.63 4.14c-.3.76-.5 1.63-.56 2.91C.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.28.26 2.15.56 2.91.31.79.72 1.46 1.38 2.13.67.67 1.34 1.08 2.13 1.38.76.3 1.63.5 2.91.56C8.33 24 8.74 24 12 24s3.67-.01 4.95-.07c1.28-.06 2.15-.26 2.91-.56.79-.31 1.46-.72 2.13-1.38.67-.67 1.08-1.34 1.38-2.13.3-.76.5-1.63.56-2.91.06-1.28.07-1.68.07-4.95s-.01-3.67-.07-4.95c-.06-1.28-.26-2.15-.56-2.91-.31-.79-.72-1.46-1.38-2.13C21.33 1.34 20.66.94 19.87.63c-.76-.3-1.63-.5-2.91-.56C15.67.01 15.26 0 12 0zm0 2.16c3.2 0 3.58.02 4.85.07 1.17.06 1.8.25 2.23.42.56.21.96.47 1.38.89.42.42.68.82.9 1.38.16.43.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.06 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.43.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07-3.21 0-3.59-.01-4.86-.07-1.17-.06-1.81-.25-2.23-.42-.57-.22-.96-.48-1.38-.9-.42-.42-.69-.82-.9-1.38-.17-.43-.36-1.06-.42-2.23-.05-1.26-.06-1.65-.06-4.85 0-3.19.02-3.58.06-4.85.06-1.17.26-1.81.42-2.23.21-.57.48-.96.9-1.38.42-.42.81-.69 1.38-.9.42-.16 1.05-.36 2.22-.42C8.43 2.18 8.8 2.16 12 2.16zM12 16a4 4 0 110-8 4 4 0 010 8zm7.85-10.4a1.44 1.44 0 11-2.88 0 1.44 1.44 0 012.88 0z"/>',
    youtube: '<path d="M23.5 6.19a3.02 3.02 0 00-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 00.5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 002.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 002.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z"/>',
    whatsapp: '<path d="M17.472 14.382c-.297-.149-1.758-.719-2.03-.807-.273-.088-.472-.132-.67.132-.198.264-.768.807-.942.973-.174.165-.348.186-.645.062-.297-.124-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.174-.297-.019-.458.13-.606.134-.133.297-.347.446-.521.148-.174.198-.298.297-.497.099-.198.05-.371-.025-.52-.075-.148-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.888 9.884"/>',
    mail: '<path d="M2 4a2 2 0 00-2 2v12a2 2 0 002 2h20a2 2 0 002-2V6a2 2 0 00-2-2H2zm0 2h20v.5l-10 6-10-6V6zm0 14V8.2l9.5 5.7a1 1 0 001 0L22 8.2V20H2z"/>'
  };

  function icon(name) {
    const path = ICONS[name] || "";
    return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${path}</svg>`;
  }

  /* Escapes text before it reaches innerHTML. */
  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* The URL comes from SOCIAL_LINKS rather than user input, but it is still
     quoted into an href, so validate the shape once here. */
  function safeUrl(url) {
    const value = String(url || "").trim();
    if (/^https?:\/\//i.test(value)) return value;
    if (/^\//.test(value)) return value;
    return "#";
  }

  /* ------------------------------------------------------------------ */
  /* Blocks                                                             */
  /* ------------------------------------------------------------------ */

  function socialBlock() {
    const buttons = SOCIAL_LINKS.map(s => `
            <li>
              <a class="social-btn" href="${esc(safeUrl(s.url))}"
                 target="_blank" rel="noopener noreferrer"
                 style="--social-color:${esc(s.color)}">
                ${icon(s.id)}
                <span class="social-btn-label">${esc(s.label)}</span>
              </a>
            </li>`).join("");

    return `
          <section class="side-card side-social" aria-labelledby="side-social-heading">
            <h2 class="side-heading side-heading-rule" id="side-social-heading">Stay In Touch</h2>
            <ul class="social-grid">${buttons}
            </ul>
          </section>`;
  }

  function newsletterBlock() {
    return `
          <section class="side-card side-newsletter" aria-labelledby="side-newsletter-heading">
            <div class="newsletter-card">
              <span class="newsletter-icon" aria-hidden="true">${icon("mail")}</span>
              <div class="newsletter-body">
                <h3 class="newsletter-title" id="side-newsletter-heading">Subscribe to Updates</h3>
                <p class="newsletter-desc">Get the latest updates, articles and insights from KaliNova.</p>
                <form class="newsletter-form" novalidate>
                  <label class="sr-only" for="newsletter-email">Email address</label>
                  <input class="newsletter-input" id="newsletter-email" name="email"
                         type="email" placeholder="Your email address.."
                         autocomplete="email" required>
                  <button class="newsletter-btn" type="submit">Subscribe</button>
                  <p class="newsletter-note">
                    <label class="newsletter-consent">
                      <input type="checkbox" name="consent" required>
                      <span>By signing up, you agree to our
                        <a href="${esc(TERMS_URL)}">Terms</a> and
                        <a href="${esc(PRIVACY_URL)}">Privacy Policy</a>.</span>
                    </label>
                  </p>
                  <p class="newsletter-status" role="status" aria-live="polite"></p>
                </form>
              </div>
            </div>
          </section>`;
  }

  function promoBlock() {
    return `
          <section class="side-card side-promo">
            <a class="promo-banner" href="${esc(safeUrl(PROMO.href))}" aria-label="${esc(PROMO.eyebrow)} — ${esc(PROMO.headline)} — ${esc(PROMO.cta)}">
              <img class="promo-img" src="${esc(safeUrl(PROMO.image))}"
                   alt="${esc(PROMO.alt)}" width="1200" height="630"
                   loading="lazy" decoding="async">
              <span class="promo-overlay">
                <span class="promo-eyebrow">${esc(PROMO.eyebrow)}</span>
                <span class="promo-headline">${esc(PROMO.headline)}</span>
                <span class="promo-cta" aria-hidden="true">${esc(PROMO.cta)}</span>
              </span>
            </a>
          </section>`;
  }

  /* The markup for every block below the trending list. */
  function extra() {
    return `${socialBlock()}${newsletterBlock()}${promoBlock()}`;
  }

  /* ------------------------------------------------------------------ */
  /* Newsletter submission                                              */
  /* ------------------------------------------------------------------ */

  /* Transport only: validation and the request live here so the UI has no
     knowledge of the endpoint. With NEWSLETTER_ENDPOINT empty this validates
     and reports, but sends nothing. */
  function submit(email) {
    if (!NEWSLETTER_ENDPOINT) {
      return Promise.resolve({ ok: false, reason: "not-configured" });
    }
    return fetch(NEWSLETTER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    }).then(res => ({ ok: res.ok, reason: res.ok ? null : "request-failed" }))
      .catch(() => ({ ok: false, reason: "network-error" }));
  }

  function bind(root) {
    const scope = root || document;
    const form = scope.querySelector(".newsletter-form");
    if (!form) return;

    const input = form.querySelector(".newsletter-input");
    const consent = form.querySelector('input[name="consent"]');
    const status = form.querySelector(".newsletter-status");
    const button = form.querySelector(".newsletter-btn");

    form.addEventListener("submit", event => {
      event.preventDefault();
      status.textContent = "";
      status.className = "newsletter-status";

      const email = String(input.value || "").trim();
      if (!email || !input.checkValidity()) {
        status.textContent = "Enter a valid email address.";
        status.classList.add("is-error");
        input.focus();
        return;
      }
      if (consent && !consent.checked) {
        status.textContent = "Please accept the Terms and Privacy Policy.";
        status.classList.add("is-error");
        return;
      }

      button.disabled = true;
      submit(email).then(result => {
        button.disabled = false;
        if (result.ok) {
          status.textContent = "Thanks! You're on the list.";
          status.classList.add("is-success");
          form.reset();
        } else if (result.reason === "not-configured") {
          status.textContent = "Thanks! Subscriptions are being set up.";
          status.classList.add("is-success");
          form.reset();
        } else {
          status.textContent = "Something went wrong. Please try again.";
          status.classList.add("is-error");
        }
      });
    });
  }

  window.KaliNovaSidebar = {
    SOCIAL_LINKS,
    PROMO,
    extra,
    bind,
    // Exposed so a backend can be wired in without touching the UI.
    submit,
    setEndpoint(url) { NEWSLETTER_ENDPOINT = String(url || "").trim(); }
  };
})();