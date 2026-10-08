/* ==================================================================== */
/* KaliNova — admin research panel + citations repeater                */
/* ==================================================================== */
/* Progressive enhancement for the "Sources & research" card on the
 * article form. Everything here only rearranges what the server already
 * rendered: the citation inputs are real fields with real names, the
 * attached references live in a hidden input the server reads back, and
 * the panel is a <details> element that opens without any script at all.
 *
 * Rules this file keeps:
 *   - it never touches the article body. Research results are attached as
 *     a reference (name, URL, licence, short excerpt), not pasted in.
 *   - every string that came off the network goes in through textContent,
 *     never through innerHTML.
 *   - a failed lookup only costs you a message in the panel; the form
 *     still submits normally.
 * ==================================================================== */

(function () {
  "use strict";

  var form = document.querySelector("[data-article-form]");
  if (!form) return;

  /* ================================================================== */
  /* Citations repeater                                                 */
  /* ================================================================== */

  var sourcesBox = form.querySelector("[data-sources]");
  var sourceCount = form.querySelector("[data-source-count]");
  var maxSources = 12;

  function rowFields(index) {
    var id = function (name) {
      return name + "-" + index;
    };

    var fieldset = document.createElement("fieldset");
    fieldset.className = "admin-source-row";
    fieldset.setAttribute("data-source-row", "");

    var legend = document.createElement("legend");
    legend.className = "sr-only";
    legend.textContent = "Source " + (index + 1);
    fieldset.appendChild(legend);

    var fields = [
      { name: "source_name_" + index, id: id("source-name"), label: "Source name", placeholder: "Wikidata, OSM, an interview…", type: "text" },
      { name: "source_url_" + index, id: id("source-url"), label: "URL", placeholder: "https://…", type: "url" },
      { name: "source_license_" + index, id: id("source-license"), label: "Licence", placeholder: "Leave blank if the source states none", type: "text" },
      { name: "source_attribution_" + index, id: id("source-attribution"), label: "Attribution", placeholder: "Leave blank when no credit is required", type: "text" }
    ];

    fields.forEach(function (spec) {
      var wrap = document.createElement("div");
      wrap.className = "admin-field";

      var label = document.createElement("label");
      label.setAttribute("for", spec.id);
      label.textContent = spec.label;

      var input = document.createElement("input");
      input.type = spec.type;
      input.id = spec.id;
      input.name = spec.name;
      input.maxLength = 500;
      input.placeholder = spec.placeholder;

      wrap.appendChild(label);
      wrap.appendChild(input);
      fieldset.appendChild(wrap);
    });

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "admin-button admin-button--tiny";
    remove.setAttribute("data-remove-source", "");
    remove.textContent = "Remove";
    fieldset.appendChild(remove);

    return fieldset;
  }

  function renumberCitations() {
    if (!sourcesBox || !sourceCount) return;

    var rows = sourcesBox.querySelectorAll("[data-source-row]");
    rows.forEach(function (row, index) {
      row.querySelectorAll("input[name]").forEach(function (input) {
        input.name = input.name.replace(/_\d+$/, "_" + index);
        input.id = input.id.replace(/-\d+$/, "-" + index);
      });

      var label = row.querySelector("label[for]");
      if (label) label.setAttribute("for", inputIdFor(row));

      var legend = row.querySelector("legend");
      if (legend) legend.textContent = "Source " + (index + 1);
    });

    sourceCount.value = String(rows.length);
  }

  function inputIdFor(row) {
    var input = row.querySelector("input[name^='source_name_']");
    return input ? input.id : "";
  }

  if (sourcesBox) {
    sourcesBox.addEventListener("click", function (event) {
      var add = event.target.closest("[data-add-source]");
      if (add) {
        var existing = sourcesBox.querySelectorAll("[data-source-row]");
        if (existing.length >= maxSources) return;

        var newRow = rowFields(existing.length);
        var anchor = existing.length ? existing[existing.length - 1].nextSibling : sourceCount.nextSibling;
        sourcesBox.insertBefore(newRow, anchor);

        renumberCitations();
        var firstInput = newRow.querySelector("input");
        if (firstInput) firstInput.focus();
        return;
      }

      var remove = event.target.closest("[data-remove-source]");
      if (remove) {
        var row = remove.closest("[data-source-row]");
        if (row) row.parentNode.removeChild(row);
        renumberCitations();
      }
    });

    renumberCitations();
  }

  /* ================================================================== */
  /* Attached references                                                */
  /* ================================================================== */

  var refsInput = form.querySelector("[data-research-refs]");
  var attachedList = form.querySelector("[data-research-attached]");
  var refCount = form.querySelector("[data-ref-count]");
  var maxRefs = 20;

  function readRefs() {
    if (!refsInput) return [];
    try {
      var parsed = JSON.parse(refsInput.value || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function writeRefs(refs) {
    if (!refsInput) return;
    refsInput.value = JSON.stringify(refs);
    renderRefs(refs);
  }

  function refKey(ref) {
    return String(ref.source_key || "") + ":" + String(ref.source_url || ref.source_name || "");
  }

  function renderRefs(refs) {
    if (!attachedList) return;

    attachedList.textContent = "";

    if (!refs.length) {
      var empty = document.createElement("li");
      empty.className = "admin-field-help";
      empty.textContent = "Nothing attached yet.";
      attachedList.appendChild(empty);
    } else {
      refs.forEach(function (ref) {
        var item = document.createElement("li");
        item.setAttribute("data-ref-key", refKey(ref));

        var name = document.createElement("strong");
        name.textContent = ref.source_name || "(unnamed reference)";
        item.appendChild(name);

        var meta = document.createElement("span");
        meta.className = "admin-field-help";
        meta.textContent = ref.source_key || "";
        if (ref.source_url) meta.textContent += " · " + ref.source_url;
        item.appendChild(meta);

        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "admin-button admin-button--tiny";
        remove.setAttribute("data-remove-ref", "");
        remove.textContent = "Remove";
        item.appendChild(remove);

        attachedList.appendChild(item);
      });
    }

    if (refCount) refCount.textContent = String(refs.length);
  }

  if (attachedList) {
    attachedList.addEventListener("click", function (event) {
      var remove = event.target.closest("[data-remove-ref]");
      if (!remove) return;

      var item = remove.closest("[data-ref-key]");
      if (!item) return;

      var key = item.getAttribute("data-ref-key");
      writeRefs(readRefs().filter(function (ref) {
        return refKey(ref) !== key;
      }));
    });

    renderRefs(readRefs());
  }

  /* ================================================================== */
  /* Research lookups                                                   */
  /* ================================================================== */

  var sourceSelect = form.querySelector("[data-research-source]");
  var queryInput = form.querySelector("[data-research-query]");
  var searchButton = form.querySelector("[data-research-search]");
  var statusEl = form.querySelector("[data-research-status]");
  var resultsBox = form.querySelector("[data-research-results]");
  var disclaimerEl = form.querySelector("[data-research-disclaimer]");

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function appendText(parent, tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text == null ? "" : String(text);
    parent.appendChild(node);
    return node;
  }

  function attachReference(ref) {
    var refs = readRefs();
    var key = refKey(ref);

    for (var i = 0; i < refs.length; i += 1) {
      if (refKey(refs[i]) === key) {
        setStatus("Already attached.");
        return;
      }
    }

    if (refs.length >= maxRefs) {
      setStatus("Reference limit reached (" + maxRefs + ").");
      return;
    }

    refs.push({
      source_key: ref.source_key,
      source_name: ref.source_name,
      source_url: ref.source_url || "",
      license: ref.license || "",
      reference_text: ref.reference_text || ""
    });

    writeRefs(refs);
    setStatus("Attached as a reference.");
  }

  function renderResult(result, meta) {
    var card = document.createElement("div");
    card.className = "admin-research-result";

    appendText(card, "h4", "admin-research-result-title", result.name || "(no title)");

    if (result.description) appendText(card, "p", "admin-field-help", result.description);

    var lines = [];
    if (result.license) lines.push("Licence: " + result.license);
    if (result.attribution) lines.push("Attribution: " + result.attribution);
    if (lines.length) appendText(card, "p", "admin-field-help", lines.join(" · "));

    if (result.url) {
      var link = document.createElement("a");
      link.href = result.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer nofollow";
      link.className = "admin-research-result-link";
      link.textContent = "Open source";
      card.appendChild(link);
    }

    var attach = document.createElement("button");
    attach.type = "button";
    attach.className = "admin-button admin-button--tiny";
    attach.textContent = "Attach as reference";
    attach.addEventListener("click", function () {
      attachReference({
        source_key: meta.source,
        source_name: result.name || meta.source_name,
        source_url: result.url || "",
        license: result.license || meta.license,
        reference_text: result.text || result.description || ""
      });
    });
    card.appendChild(attach);

    return card;
  }

  function runSearch() {
    if (!resultsBox || !sourceSelect || !queryInput) return;

    var source = sourceSelect.value;
    var query = queryInput.value.trim();

    if (!query) {
      setStatus("Type something to search for.");
      queryInput.focus();
      return;
    }

    var params = new URLSearchParams({ source: source, q: query, limit: "12" });
    // A bare Q-id on the Wikidata tab asks for that entity's curated facts
    // instead of a search result.
    if (source === "wikidata" && /^Q\d{1,9}$/i.test(query)) {
      params.set("entity", query.toUpperCase());
      params.delete("q");
    }

    setStatus("Searching…");
    resultsBox.textContent = "";

    fetch("/api/admin/research?" + params.toString(), {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { ok: response.ok, status: response.status, payload: payload };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          setStatus(result.payload && result.payload.error ? result.payload.error : "Lookup failed.");
          if (disclaimerEl) disclaimerEl.hidden = true;
          return;
        }

        var payload = result.payload;
        setStatus((payload.results || []).length + " result" + ((payload.results || []).length === 1 ? "" : "s"));

        if (disclaimerEl) {
          disclaimerEl.textContent = payload.disclaimer || "";
          disclaimerEl.hidden = !payload.disclaimer;
        }

        resultsBox.textContent = "";
        (payload.results || []).forEach(function (row) {
          resultsBox.appendChild(renderResult(row, payload));
        });

        if (!(payload.results || []).length) {
          appendText(resultsBox, "p", "admin-field-help", "No results.");
        }
      })
      .catch(function () {
        setStatus("Lookup failed. The article form still works — try again shortly.");
      });
  }

  if (searchButton) {
    searchButton.addEventListener("click", runSearch);
  }

  if (queryInput) {
    queryInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
    });
  }

  /* ================================================================== */
  /* Copy-similarity acknowledgement                                    */
  /* ================================================================== */

  // The box is only ever an acknowledgement of a number already shown. If the
  // editor changes the body again, the server recomputes and the box clears.
  var ackBox = form.querySelector("[data-similarity-ack]");
  if (ackBox) {
    var bodySource = form.querySelector("[data-editor-source]");
    if (bodySource) {
      bodySource.addEventListener("input", function () {
        // Any edit to the body invalidates an acknowledgement the server has
        // not seen yet, so the next publish is checked again.
        ackBox.checked = false;
      });
    }
  }
})();
