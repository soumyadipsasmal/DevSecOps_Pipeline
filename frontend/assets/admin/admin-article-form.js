/* ==================================================================== */
/* KaliNova — admin article form                                        */
/* ==================================================================== */
/* Progressive enhancement only. The form is fully usable without this file:
 * the body textarea is a real form field, the slug is a real input, and every
 * submit button carries its intent. Nothing here stores anything — there is no
 * auto-save, and the server is still the only authority on validation.
 * ==================================================================== */

(function () {
  "use strict";

  var form = document.querySelector("[data-article-form]");
  if (!form) return;

  /* ================================================================== */
  /* Slug                                                               */
  /* ================================================================== */

  var titleInput = form.querySelector("[data-slug-source]");
  var slugInput = form.querySelector("[data-slug-target]");
  var slugTouched = slugInput && slugInput.value.trim() !== "";

  function slugify(value) {
    return String(value)
      .normalize("NFKD")
      // Drop combining marks so "Café" becomes "cafe" rather than "caf".
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/['"‘’“”]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 180)
      .replace(/-+$/g, "");
  }

  if (titleInput && slugInput) {
    titleInput.addEventListener("input", function () {
      if (!slugTouched) slugInput.value = slugify(titleInput.value);
    });

    // Once an author edits the slug, stop overwriting it.
    slugInput.addEventListener("input", function () {
      slugTouched = true;
    });

    var regenerate = form.querySelector("[data-regenerate-slug]");
    if (regenerate) {
      regenerate.addEventListener("click", function () {
        if (titleInput) slugInput.value = slugify(titleInput.value);
        slugTouched = false;
        slugInput.focus();
      });
    }
  }

  /* ================================================================== */
  /* Character counter                                                  */
  /* ================================================================== */

  var counter = form.querySelector("[data-counter]");
  // The marker carries no value; the field it belongs to is named by the
  // counter element's id (data-counter-for="article-meta-count").
  var counterField = counter && form.querySelector('[data-counter-for="' + counter.id + '"]');

  if (counter && counterField) {
    var updateCounter = function () {
      var length = counterField.value.length;
      var limit = Number(counterField.getAttribute("maxlength")) || 0;

      counter.textContent = String(length);
      counter.classList.toggle("is-over", limit > 0 && length > limit);
    };

    counterField.addEventListener("input", updateCounter);
  }

  /* ================================================================== */
  /* Banner preview                                                     */
  /* ================================================================== */

  var bannerPath = form.querySelector("[data-banner-path]");
  var bannerPreview = form.querySelector("[data-banner-preview]");
  var bannerPreviewImage = form.querySelector("[data-banner-preview-image]");

  function showBanner(path) {
    if (!bannerPreview || !bannerPreviewImage) return;

    if (path) {
      bannerPreviewImage.src = path;
      bannerPreview.hidden = false;
    } else {
      bannerPreviewImage.removeAttribute("src");
      bannerPreview.hidden = true;
    }
  }

  if (bannerPath) {
    bannerPath.addEventListener("input", function () {
      showBanner(bannerPath.value.trim());
    });
    showBanner(bannerPath.value.trim());
  }

  /* ================================================================== */
  /* Banner upload                                                      */
  /* ================================================================== */

  var bannerInput = form.querySelector("[data-banner-input]");
  var csrfField = form.querySelector('input[name="_csrf"]');
  var bannerHelp = bannerInput && bannerInput.parentElement;

  function bannerStatus(message, kind) {
    if (!bannerHelp) return;

    var existing = bannerHelp.querySelector("[data-banner-status]");
    if (!message) {
      if (existing) existing.remove();
      return;
    }

    if (!existing) {
      existing = document.createElement("p");
      existing.setAttribute("data-banner-status", "");
      bannerHelp.appendChild(existing);
    }

    existing.className = "admin-field-help" + (kind === "error" ? " admin-field-help--error" : "");
    existing.textContent = message;
  }

  if (bannerInput && csrfField) {
    bannerInput.addEventListener("change", function () {
      var file = bannerInput.files && bannerInput.files[0];
      if (!file) return;

      bannerStatus("Uploading " + file.name + "…");
      bannerInput.disabled = true;

      fetch("/api/admin/uploads", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-CSRF-Token": csrfField.value,
          "X-File-Name": encodeURIComponent(file.name)
        },
        body: file
      })
        .then(function (response) {
          return response.json().then(function (payload) {
            return { ok: response.ok, payload: payload };
          });
        })
        .then(function (result) {
          if (!result.ok) throw new Error((result.payload && result.payload.error) || "Upload failed");

          if (bannerPath) bannerPath.value = result.payload.upload.path;
          showBanner(result.payload.upload.path);

          bannerStatus(
            "Uploaded as " + result.payload.upload.file_name + " (" + Math.round(result.payload.upload.bytes / 1024) + " KB). Save the article to keep it."
          );
        })
        .catch(function (error) {
          bannerStatus(error.message, "error");
        })
        .then(function () {
          bannerInput.disabled = false;
          // Let the author pick the same file again after a failure.
          bannerInput.value = "";
        });
    });
  }

  /* ================================================================== */
  /* Editor                                                             */
  /* ================================================================== */

  var editor = form.querySelector("[data-editor]");
  var surface = editor && editor.querySelector("[data-editor-surface]");
  var source = editor && editor.querySelector("[data-editor-source]");
  var toolbar = editor && editor.querySelector("[data-editor-toolbar]");
  var wordCount = editor && editor.querySelector("[data-word-count]");

  /* Mirror of the server's sanitiser, used only for the word count. The stored
   * value is always sanitised server-side; this never decides what is saved. */
  function plainText(html) {
    var holder = document.createElement("div");
    holder.innerHTML = String(html);

    holder.querySelectorAll("script, style, iframe").forEach(function (node) {
      node.remove();
    });

    return (holder.textContent || "").replace(/\s+/g, " ").trim();
  }

  function updateWordCount() {
    if (!wordCount || !source) return;
    wordCount.textContent = String(plainText(source.value).split(/\s+/).filter(Boolean).length);
  }

  /* Prompt values are author input, so they are never interpolated into an HTML
   * string. Each is validated, then inserted as a real DOM node; the server
   * sanitiser still has the final say on what is stored. */
  function safeUrl(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";

    // Relative and same-origin paths are allowed, including already-encoded ones.
    if (raw.charAt(0) === "/" || raw.charAt(0) === "#" || raw.charAt(0) === "?") return raw;

    var match = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
    if (!match) return raw;

    return /^https?:$/i.test(match[1]) ? raw : "";
  }

  function makeLink(href, text) {
    var node = document.createElement("a");
    node.href = safeUrl(href);
    node.textContent = text || href;
    return node;
  }

  function makeImage(src, alt) {
    var node = document.createElement("img");
    node.src = safeUrl(src);
    node.alt = String(alt || "");
    return node;
  }

  /* Insert at the caret without going through innerHTML. */
  function insertNode(node) {
    if (!node.getAttribute("href") && !node.getAttribute("src")) return;
    if (node.tagName === "A" && node.href) {
      node.setAttribute("rel", "noopener noreferrer");
      node.setAttribute("target", "_blank");
    }

    surface.focus();

    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      surface.appendChild(node);
      return;
    }

    var range = selection.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) {
      surface.appendChild(node);
      return;
    }

    range.deleteContents();
    range.insertNode(node);

    // Leave the caret after the new node so typing continues after it.
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  if (editor && surface && source) {
    surface.innerHTML = source.value;
    source.hidden = true;
    surface.hidden = false;
    if (toolbar) toolbar.hidden = false;

    var inSourceMode = false;

    // Without this the browser would rewrite the body on submit even when the
    // author never touched it, and legacy plain-text bodies would be turned
    // into paragraphs without anybody asking for it.
    var touched = false;
    surface.addEventListener("input", function () {
      touched = true;
      source.value = surface.innerHTML;
      updateWordCount();
    });

    var sync = function () {
      source.value = surface.innerHTML;
      updateWordCount();
    };

    if (toolbar) toolbar.addEventListener("click", function (event) {
      var button = event.target.closest("[data-command]");
      if (!button) return;

      event.preventDefault();
      var command = button.getAttribute("data-command");
      var value = button.getAttribute("data-value");

      if (command === "source") {
        inSourceMode = !inSourceMode;

        if (inSourceMode) {
          source.value = surface.innerHTML;
          surface.hidden = true;
          source.hidden = false;
          source.focus();
          return;
        }

        surface.innerHTML = source.value;
        source.hidden = true;
        surface.hidden = false;
        updateWordCount();
        return;
      }

      if (command === "link") {
        var href = window.prompt("Link URL (https://… or /path):", "https://");
        if (!href) return;
        insertNode(makeLink(href, ""));
      } else if (command === "image") {
        var src = window.prompt("Image URL (/assets/…):", "/assets/");
        if (!src) return;
        var alt = window.prompt("Alt text describing the image:", "") || "";
        insertNode(makeImage(src, alt));
      } else if (value) {
        document.execCommand(command, false, value);
      } else {
        document.execCommand(command, false, null);
      }

      touched = true;
      sync();
      surface.focus();
    });

    surface.addEventListener("keyup", sync);
    surface.addEventListener("mouseup", sync);
    surface.addEventListener("blur", sync);

    // Insert an image picked from the upload library.
    form.addEventListener("click", function (event) {
      var insert = event.target.closest("[data-insert-image]");
      if (!insert) return;

      event.preventDefault();
      var path = insert.getAttribute("data-insert-image");
      var alt = window.prompt("Alt text describing the image:", "") || "";

      insertNode(makeImage(path, alt));
      touched = true;
      sync();
    });

    form.addEventListener("submit", function () {
      // Untouched body: keep exactly what was stored.
      if (!touched && !inSourceMode) {
        source.value = source.defaultValue;
        return;
      }
      sync();
    });

    updateWordCount();
  }

  /* ================================================================== */
  /* Unsaved-changes guard                                              */
  /* ================================================================== */

  var dirty = false;
  form.addEventListener("input", function () {
    dirty = true;
  });

  form.addEventListener("submit", function () {
    dirty = false;
  });

  window.addEventListener("beforeunload", function (event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
})();