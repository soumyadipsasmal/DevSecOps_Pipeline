/* ==================================================================== */
/* KaliNova — admin SEO panel                                           */
/* ==================================================================== */
/* Progressive enhancement for the SEO check card on the article form.
 * Nothing here runs without JavaScript, and the underlying form never
 * depends on the score. Analysis always goes to the server where the
 * deterministic engine runs; the only CSRF token used is the one the
 * server already issued to this page, and every dynamic string is written
 * through textContent so a stored title can never execute here.
 * ==================================================================== */

(function () {
  "use strict";

  var panel = document.querySelector("[data-seo-panel]");
  if (!panel) return;

  var form = panel.closest("form");
  var csrfField = form && form.querySelector('input[name="_csrf"]');
  var runButton = panel.querySelector("[data-seo-run]");
  var statusEl = panel.querySelector("[data-seo-status]");
  var reportEl = panel.querySelector("[data-seo-report]");
  var articleId = panel.getAttribute("data-article-id") || "";

  var checkedRadio = function (name) {
    if (!form) return "";
    var selected = form.querySelector('input[name="' + name + '"]:checked');
    return selected ? selected.value : "";
  };

  var field = function (name) {
    if (!form) return "";
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value : "";
  };

  /* ------------------------------------------------------------------ */
  /* Status line                                                        */
  /* ------------------------------------------------------------------ */

  function setStatus(message) {
    if (!statusEl) return;
    if (!message) {
      statusEl.textContent = "";
      statusEl.classList.remove("admin-seo-status--error");
      return;
    }
    statusEl.textContent = message;
  }

  function setStatusError(message) {
    setStatus(message);
    if (statusEl) statusEl.classList.add("admin-seo-status--error");
  }

  /* ------------------------------------------------------------------ */
  /* Report rendering — DOM-built, never innerHTML                       */
  /* ------------------------------------------------------------------ */

  function node(tag, className) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  function appendText(parent, tag, className, value) {
    var el = node(tag, className);
    el.textContent = String(value);
    parent.appendChild(el);
    return el;
  }

  function scoreClass(status) {
    if (status === "BLOCKED") return "admin-seo-score--blocked";
    if (status === "NEEDS_REVIEW") return "admin-seo-score--review";
    return "admin-seo-score--ready";
  }

  function blockClass(severity) {
    if (severity === "ERROR" || severity === "WARNING") return "admin-seo-block--problem";
    return "admin-seo-block--info";
  }

  function renderCheckList(parent, checks) {
    (checks || []).forEach(function (check) {
      var row = node("li", "admin-seo-checks-row " + blockClass(check.severity));
      appendText(row, "span", "admin-seo-check-severity", check.severity);
      appendText(row, "span", "admin-seo-check-message", check.message);
      parent.appendChild(row);
    });
  }

  function renderSuggestions(parent, suggestions) {
    (suggestions || []).forEach(function (suggestion) {
      var row = node("li", "admin-seo-suggestion");
      appendText(row, "span", "", suggestion);
      parent.appendChild(row);
    });
  }

  function renderInternalLinks(parent, links) {
    (links || []).forEach(function (link) {
      var row = node("li", "admin-seo-link");
      var anchor = node("a", "admin-seo-link-title");
      anchor.href = link.url || ("/blog/" + encodeURIComponent(link.slug || ""));
      anchor.textContent = link.title || "(untitled)";
      row.appendChild(anchor);

      if (link.reason) appendText(row, "span", "admin-seo-link-reason", link.reason);
      if (typeof link.relevance === "number") {
        appendText(row, "span", "admin-seo-link-relevance", "relevance " + Math.round(link.relevance) + "%");
      }
      parent.appendChild(row);
    });
  }

  function renderReport(report) {
    reportEl.textContent = "";

    var total = node("div", "admin-seo-total");
    total.appendChild(appendText(node("span", "admin-seo-score " + scoreClass(report.status)), "span", "admin-seo-score-value", String(report.score)));
    appendText(total, "span", "admin-seo-status", report.status === "BLOCKED" ? "Blocked — fix before publishing" : report.status === "NEEDS_REVIEW" ? "Needs review" : "Ready to publish");

    if (report.topic && report.topic.value) {
      appendText(
        total,
        "span",
        "admin-seo-topic",
        "Topic detected: “" + report.topic.value + "”" + (report.topic.inferred ? " (inferred)" : "")
      );
    }
    reportEl.appendChild(total);

    var categories = report.categories || {};
    var keys = ["onPage", "content", "technical", "internalLinks", "media", "social"];
    var bars = node("div", "admin-seo-categories");
    keys.forEach(function (key) {
      var cat = categories[key];
      if (!cat) return;
      var row = node("div", "admin-seo-category");
      appendText(row, "span", "admin-seo-category-name", key);
      appendText(row, "span", "admin-seo-category-value", cat.score + "/" + cat.max);
      var track = node("span", "admin-seo-bar");
      var fill = node("span", "admin-seo-bar-fill");
      var percent = cat.max > 0 ? Math.max(2, Math.min(100, Math.round((cat.score / cat.max) * 100))) : 0;
      fill.style.width = percent + "%";
      track.appendChild(fill);
      row.appendChild(track);
      bars.appendChild(row);
    });
    reportEl.appendChild(bars);

    if (report.checks && report.checks.length) {
      var problems = (report.checks || []).filter(
        function (check) { return check.severity === "ERROR" || check.severity === "WARNING"; }
      );
      var problemsBlock = node("div", "admin-seo-block");
      appendText(
        problemsBlock,
        "h3",
        "admin-seo-block-heading",
        problems.length
          ? "What to review (" + problems.length + ")"
          : "All checks passed"
      );
      var problemsList = node("ul", "admin-seo-checks");
      if (problems.length) renderCheckList(problemsList, problems);
      else appendText(problemsList, "li", "admin-seo-checks-row admin-seo-block--info", "No errors or warnings across the " + report.checks.length + " checks.");
      problemsBlock.appendChild(problemsList);
      reportEl.appendChild(problemsBlock);
    }

    if (report.suggestions && report.suggestions.length) {
      var suggestionsBlock = node("div", "admin-seo-block");
      appendText(suggestionsBlock, "h3", "admin-seo-block-heading", "Suggestions");
      var suggestionsList = node("ul", "admin-seo-suggestions");
      renderSuggestions(suggestionsList, report.suggestions);
      suggestionsBlock.appendChild(suggestionsList);
      reportEl.appendChild(suggestionsBlock);
    }

    if (report.internalLinkSuggestions && report.internalLinkSuggestions.length) {
      var linksBlock = node("div", "admin-seo-block");
      appendText(linksBlock, "h3", "admin-seo-block-heading", "Related articles worth linking to");
      var linksList = node("ul", "admin-seo-links");
      renderInternalLinks(linksList, report.internalLinkSuggestions);
      linksBlock.appendChild(linksList);
      reportEl.appendChild(linksBlock);
    }

    var footer = node("p", "admin-field-help admin-seo-footer");
    footer.textContent = "Version " + report.version + " — computed locally by the server; nothing was sent off-site and nothing was stored.";
    reportEl.appendChild(footer);
  }

  /* ------------------------------------------------------------------ */
  /* Fetch                                                              */
  /* ------------------------------------------------------------------ */

  function analyze(payload) {
    if (!csrfField) return;

    setStatus("Checking the current editor content…");
    runButton.disabled = true;

    fetch("/api/admin/articles/seo/analyze", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfField.value
      },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, status: response.status, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(
            (result.body && result.body.error) ||
            ((result.status === 429) ? "Too many checks just now — wait a moment and try again." : "The SEO check could not run.")
          );
        }
        reportEl.hidden = false;
        renderReport(result.body.report);
        setStatus("");
      })
      .catch(function (error) {
        setStatusError(error.message || "The SEO check could not run.");
      })
      .then(function () {
        runButton.disabled = false;
      });
  }

  function editorPayload() {
    var categoryId = field("category_id");
    return {
      title: field("title"),
      slug: field("slug"),
      meta_description: field("meta_description"),
      content: field("content"),
      cover_image: field("cover_image"),
      banner_alt: field("banner_alt"),
      category_id: categoryId ? String(Number(categoryId)) : "",
      category_name: field("category_name"),
      category_slug: "",
      status: checkedRadio("status") || "",
      article_id: articleId || null
    };
  }

  if (runButton) {
    runButton.addEventListener("click", function () {
      analyze(editorPayload());
    });
  }

  /* For a stored article, run one check on load so the panel greets the editor
   * with the state the server already knows about. Unsaved content is only
   * analysed when the button is pressed again. */
  if (articleId && runButton) {
    var prefetch = function () {
      runButton.disabled = true;
      fetch("/api/admin/articles/" + encodeURIComponent(articleId) + "/seo", {
        credentials: "same-origin",
        headers: { "Accept": "application/json" }
      })
        .then(function (response) {
          return response.json().then(function (body) {
            return { ok: response.ok, body: body };
          });
        })
        .then(function (result) {
          if (!result.ok) throw new Error("The stored check could not be loaded.");
          reportEl.hidden = false;
          renderReport(result.body.report);
          setStatus("");
        })
        .catch(function () {
          // The stored check is a nicety; the button still works.
        })
        .then(function () {
          runButton.disabled = false;
        });
    };

    window.addEventListener("DOMContentLoaded", prefetch);
    if (document.readyState !== "loading") prefetch();
  }
})();