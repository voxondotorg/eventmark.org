(function () {
  "use strict";

  var state = {
    user: null,
    config: { turnstileSiteKey: "", environment: "", noticeBanner: "" },
    events: [],
    eventsCursor: null,
    eventsHasMore: false,
    currentEvent: null,
    dashboard: null,
    contributions: [],
    organizerEventId: null,
    organizerReviewEventId: null,
    pendingBannerBlob: null,
    pendingBannerPreviewUrl: null,
    eventSaveInFlight: false,
    flash: "",
    flashKind: "info",
    calendarMonth: new Date(),
    calendarRegion: "all",
    calendarItems: [],
    calendarBadges: [],
    calendarTotalEvents: 0,
    calendarSelectedKey: null,
    eventSearchQuery: "",
  };

  function $(sel) {
    return document.querySelector(sel);
  }

  /** Non-production builds may show a short deployer hint after user-facing security messages. */
  function showOpsSecurityHint() {
    var e = (state.config.environment || "").toLowerCase();
    return e === "dev" || e === "test" || e === "development";
  }

  function setFlash(msg, kind) {
    state.flash = msg || "";
    state.flashKind = kind || "info";
  }

  var TOAST_TIMEOUT_MS = 5500;
  var ORG_DESCRIPTION_MIN_WORDS = 160;
  var COUNTRIES = window.EVENTMARK_COUNTRIES || [];

  function ensureToastStack() {
    var stack = document.getElementById("toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "toast-stack";
      stack.className = "toast-stack";
      stack.setAttribute("aria-live", "polite");
      document.body.appendChild(stack);
    }
    return stack;
  }

  function toast(message, kind, opts) {
    if (!message) return function () {};
    opts = opts || {};
    var stack = ensureToastStack();
    var node = document.createElement("div");
    var k = kind === "error" ? "error" : kind === "success" ? "success" : "info";
    node.className = "toast toast--" + k;
    node.setAttribute("role", k === "error" ? "alert" : "status");
    var msg = document.createElement("span");
    msg.className = "toast-msg";
    msg.textContent = String(message);
    node.appendChild(msg);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-close";
    btn.setAttribute("aria-label", "Dismiss");
    btn.textContent = "×";
    node.appendChild(btn);
    stack.appendChild(node);
    function dismiss() {
      if (!node.parentNode) return;
      node.classList.add("toast--out");
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    }
    btn.addEventListener("click", dismiss);
    var ttl = typeof opts.ttl === "number" ? opts.ttl : TOAST_TIMEOUT_MS;
    if (ttl > 0) setTimeout(dismiss, ttl);
    return dismiss;
  }

  /** Map server / network errors to short, human messages — never show raw codes. */
  function friendlyError(err, fallback) {
    var d = err && err.data ? err.data : null;
    var code = d && d.error;
    if (d && d.message) return d.message;
    if (code === "turnstile_failed") {
      var base =
        "We could not finish the security check. Refresh the page, complete it again, and try once more.";
      if (showOpsSecurityHint()) {
        base += " (Deployer: site key and secret must come from the same Turnstile widget.)";
      }
      return base;
    }
    if (code === "rate_limited" || (err && err.status === 429)) {
      return "Too many attempts in a short time. Please wait a moment and try again.";
    }
    if (code === "email_send_failed") {
      var emailMsg =
        "We could not deliver the sign-in code to that email. Try again in a minute, or use a different email.";
      if (showOpsSecurityHint()) {
        emailMsg +=
          " (Deployer: Cloudflare Send Email only delivers to verified Email Routing destination addresses. Add the recipient under Email → Email Routing → Destination Addresses, or switch to a transactional provider.)";
      }
      return emailMsg;
    }
    if (code === "invalid_dimensions") return "Banner must be exactly 150×150 pixels after optimization.";
    if (code === "banner_too_large") return "Banner file is too large. Try a simpler image.";
    if (code === "invalid_format") return "Banner must be a JPEG or WebP image.";
    if (code === "title_too_long") return "Event title must be 26 characters or fewer.";
    if (code === "description_too_long") return "Description must be 500 words or fewer.";
    if (code === "emoji_not_allowed") return "Emojis are not allowed in this field.";
    if (code === "invalid_input") return "Input contains disallowed characters or patterns.";
    if (code === "end_before_start") return "End date/time must be after the start.";
    if (code === "seats_invalid") return "Seat counts must be zero or positive, and minimum cannot exceed maximum.";
    if (code === "speaker_name_too_long") return "Speaker names must be 26 characters or fewer.";
    if (code === "online_url_required") return "Online events need a link participants can join.";
    if (code === "external_url_required") return "Add the link where attendees register.";
    if (code === "invalid_code" || code === "invalid_otp") {
      return "That code is incorrect or has expired. Request a new code.";
    }
    if (code === "otp_missing" || code === "otp_expired") {
      return "That sign-in code is no longer valid. Request a new code.";
    }
    if (code === "too_many_attempts") return "Too many wrong attempts. Request a new code.";
    if (code === "invalid_otp") return "That code is incorrect or has expired. Send a new one.";
    if (code === "unauthorized" || (err && err.status === 401)) return "Please sign in to continue.";
    if (code === "forbidden" || (err && err.status === 403)) return "You do not have permission to do that.";
    if (code === "not_found" || (err && err.status === 404)) return "We could not find that. It may have been removed.";
    if (code === "validation_failed") return (d && d.message) || "Some fields are not filled in correctly.";
    if (code === "orgreq_not_verified") return "Please verify your email with the org-request code first.";
    if (code === "org_requests_paused") return "Organizer applications are temporarily paused. Please try again later.";
    if (code === "registrations_paused") return "Registrations are temporarily paused on this site. Please try again later.";
    if (code === "event_full") return "This event is full — no seats remaining.";
    if (code === "missing_org") return "You are not part of an approved organization yet.";
    if (code === "org_not_approved") return "Your organization is not approved yet — wait for the EventMark admin decision.";
    if (code === "event_not_editable") {
      return "Published events cannot be edited directly. Move the event back to draft, make your changes, then publish again.";
    }
    if (code === "name_required" || code === "website_required" || code === "description_required" ||
        code === "activities_required" || code === "directors_required" || code === "modes_required" ||
        code === "motto_required") {
      return "Please fill in the required fields before submitting.";
    }
    if (code === "description_min_words") {
      return "Description must be at least " + ORG_DESCRIPTION_MIN_WORDS + " words.";
    }
    if (code === "invalid_url") return "That link is not allowed. Use a full http(s) URL from your own site — shorteners and suspicious links are blocked.";
    if (code === "invalid_director_link") return "One of the director links is not a valid URL.";
    if (code === "not_info_requested") return "This contribution is not waiting for more information.";
    if (code === "already_pending") return "Your verification request is already pending review.";
    if (code === "already_verified") return "Your profile is already verified.";
    if (code === "already_checked_recently") return "That pass was scanned moments ago. Try another attendee.";
    if (code === "duplicate_topic") return "That speaker topic is already on the agenda. Use a different topic.";
    if (code === "duplicate_title") return "That title is already in use. Choose a different title.";
    if (err && err.message === "Failed to fetch") {
      return "We could not reach the server. Check your connection and try again.";
    }
    if (err && err.message && err.message !== "request_failed") return err.message;
    return fallback || "Something went wrong. Please try again.";
  }

  function setFieldError(inputId, msg) {
    var el = document.getElementById(inputId);
    if (!el) return;
    el.setAttribute("aria-invalid", "true");
    var holder = el.closest(".field") || el.parentElement;
    if (!holder) return;
    holder.classList.add("field--error");
    var existing = holder.querySelector(".field-error");
    if (!existing) {
      existing = document.createElement("small");
      existing.className = "field-error";
      holder.appendChild(existing);
    }
    existing.textContent = msg;
  }

  function clearFieldError(inputId) {
    var el = document.getElementById(inputId);
    if (!el) return;
    el.removeAttribute("aria-invalid");
    var holder = el.closest(".field") || el.parentElement;
    if (!holder) return;
    holder.classList.remove("field--error");
    var existing = holder.querySelector(".field-error");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function clearFieldErrors(rootEl) {
    if (!rootEl) return;
    Array.prototype.forEach.call(rootEl.querySelectorAll(".field-error"), function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    Array.prototype.forEach.call(rootEl.querySelectorAll(".field--error"), function (n) {
      n.classList.remove("field--error");
    });
    Array.prototype.forEach.call(rootEl.querySelectorAll("[aria-invalid]"), function (n) {
      n.removeAttribute("aria-invalid");
    });
  }

  function isoToDatetimeLocal(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      "T" +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  function formatEventDateTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  function formatEventDate(iso, opts) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, opts);
  }

  function formatEventWhen(startsAt, endsAt) {
    var start = formatEventDateTime(startsAt);
    if (!start) return "";
    var end = formatEventDateTime(endsAt);
    return end ? start + " — " + end : start;
  }

  function formatAgendaWhen(startsAt, endsAt) {
    return formatEventWhen(startsAt, endsAt);
  }

  function formatEventShortDate(startsAt, endsAt) {
    var start = startsAt ? new Date(startsAt) : null;
    if (!start || isNaN(start.getTime())) return "";
    var end = endsAt ? new Date(endsAt) : null;
    var month = start.toLocaleDateString(undefined, { month: "short" });
    var startDay = start.getDate();
    if (!end || isNaN(end.getTime())) return month + " " + startDay;
    if (
      start.getFullYear() === end.getFullYear() &&
      start.getMonth() === end.getMonth()
    ) {
      if (startDay === end.getDate()) return month + " " + startDay;
      return month + " " + startDay + "-" + end.getDate();
    }
    var endMonth = end.toLocaleDateString(undefined, { month: "short" });
    if (start.getFullYear() === end.getFullYear()) {
      return month + " " + startDay + " – " + endMonth + " " + end.getDate();
    }
    return (
      month +
      " " +
      startDay +
      ", " +
      start.getFullYear() +
      " – " +
      endMonth +
      " " +
      end.getDate() +
      ", " +
      end.getFullYear()
    );
  }

  function formatEventCountryLabel(ev) {
    if (ev.mode === "online") return "Online";
    var loc = String(ev.location || "").trim();
    if (!loc) return "Location TBD";
    var parts = loc.split(",").map(function (p) {
      return p.trim();
    }).filter(Boolean);
    if (parts.length >= 2) return "Country: " + parts[parts.length - 1];
    return "Country: " + loc;
  }

  function countryNameMatches(value) {
    var q = String(value || "").trim().toLowerCase();
    if (!q) return "";
    for (var i = 0; i < COUNTRIES.length; i++) {
      if (COUNTRIES[i].toLowerCase() === q) return COUNTRIES[i];
    }
    return "";
  }

  function parseEventLocation(location) {
    var loc = String(location || "").trim();
    if (!loc || loc.toLowerCase() === "online") return { city: "", country: "" };
    var parts = loc.split(",").map(function (p) {
      return p.trim();
    }).filter(Boolean);
    if (parts.length >= 2) {
      var countryPart = parts[parts.length - 1];
      var matched = countryNameMatches(countryPart);
      if (matched) {
        return {
          city: parts.slice(0, -1).join(", "),
          country: matched,
        };
      }
    }
    var exact = countryNameMatches(loc);
    if (exact) return { city: "", country: exact };
    return { city: loc, country: "" };
  }

  function buildEventLocation(city, country, mode) {
    if (mode === "online") return "Online";
    var c = String(city || "").trim();
    var co = String(country || "").trim();
    if (c && co) return c + ", " + co;
    if (co) return co;
    return c;
  }

  function wireCountrySelect() {
    var input = $("#ev-country-input");
    var list = $("#ev-country-list");
    var wrap = $("#ev-country-wrap");
    if (!input || !list || !wrap) return null;

    var selectedCountry = "";

    function renderList(filter) {
      var q = String(filter || "").trim().toLowerCase();
      var items = COUNTRIES.filter(function (c) {
        return !q || c.toLowerCase().indexOf(q) >= 0;
      }).slice(0, 80);
      if (!items.length) {
        list.innerHTML = "<li class='country-select-empty muted'>No matches</li>";
        list.classList.remove("hidden");
        return;
      }
      list.innerHTML = items
        .map(function (c) {
          return (
            "<li role='option' tabindex='-1' data-country='" +
            escapeHtml(c) +
            "'>" +
            escapeHtml(c) +
            "</li>"
          );
        })
        .join("");
      list.classList.remove("hidden");
    }

    function setCountry(name, fromList) {
      selectedCountry = name || "";
      input.value = selectedCountry;
      if (selectedCountry) {
        wrap.setAttribute("data-selected", selectedCountry);
      } else {
        wrap.removeAttribute("data-selected");
      }
      list.classList.add("hidden");
      if (fromList) clearFieldError("ev-country-input");
    }

    input.addEventListener("focus", function () {
      renderList(input.value);
    });
    input.addEventListener("input", function () {
      selectedCountry = "";
      wrap.removeAttribute("data-selected");
      renderList(input.value);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        list.classList.add("hidden");
        return;
      }
      if (e.key === "Enter") {
        var first = list.querySelector("[data-country]");
        if (first && !list.classList.contains("hidden")) {
          e.preventDefault();
          setCountry(first.getAttribute("data-country"), true);
        }
      }
    });
    list.addEventListener("click", function (e) {
      var li = e.target instanceof HTMLElement ? e.target.closest("[data-country]") : null;
      if (li) setCountry(li.getAttribute("data-country"), true);
    });
    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target)) list.classList.add("hidden");
    });

    return {
      get: function () {
        var typed = (input.value || "").trim();
        if (selectedCountry) return selectedCountry;
        return countryNameMatches(typed) || typed;
      },
      set: function (name) {
        setCountry(name || "", false);
      },
      clear: function () {
        setCountry("", false);
      },
    };
  }

  function syncEventCountryFieldVisibility() {
    var field = $("#ev-country-field");
    var modeRadio = document.querySelector("input[name='ev-mode']:checked");
    var mode = modeRadio ? modeRadio.value : "in_person";
    if (field) field.classList.toggle("hidden", mode === "online");
  }

  var DEFAULT_EVENT_BANNER = "/assets/event-banner-default.jpg";

  function eventBannerUrl(ev) {
    if (!ev || !ev.hasBanner) return DEFAULT_EVENT_BANNER;
    var v = ev.updatedAt ? new Date(ev.updatedAt).getTime() : 0;
    return "/api/events/" + encodeURIComponent(ev.id) + "/banner.webp?v=" + v;
  }

  function renderEventBannerVisual(ev, className) {
    return (
      '<img class="' + className + '" src="' + escapeHtml(eventBannerUrl(ev)) + '" alt="' +
      escapeHtml((ev.title || "Event") + " banner") +
      '" width="' + BANNER_PX + '" height="' + BANNER_PX + '" loading="lazy" />'
    );
  }

  function encodeBannerBlob(canvas, resolve, reject) {
    var qualities = [0.82, 0.72, 0.62, 0.52];
    var i = 0;
    function tryNext() {
      if (i >= qualities.length) {
        reject(new Error("Could not optimize image below size limit. Try a simpler image."));
        return;
      }
      canvas.toBlob(
        function (blob) {
          if (!blob) {
            reject(new Error("Could not optimize image."));
            return;
          }
          if (blob.size <= 60000 || i === qualities.length - 1) {
            resolve(blob);
            return;
          }
          i++;
          tryNext();
        },
        "image/webp",
        qualities[i]
      );
    }
    tryNext();
  }

  function optimizeEventBannerFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        reject(new Error("Choose an image file (JPEG, PNG, or WebP)."));
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        reject(new Error("Image is too large. Use a file under 10 MB."));
        return;
      }
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        if (w < 50 || h < 50) {
          reject(new Error("Image is too small. Use at least 50×50 pixels."));
          return;
        }
        var side = Math.min(w, h);
        var sx = Math.floor((w - side) / 2);
        var sy = Math.floor((h - side) / 2);
        var canvas = document.createElement("canvas");
        canvas.width = BANNER_PX;
        canvas.height = BANNER_PX;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, side, side, 0, 0, BANNER_PX, BANNER_PX);
        encodeBannerBlob(canvas, resolve, reject);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that image."));
      };
      img.src = url;
    });
  }

  function uploadEventBanner(eventId, blob, turnstileToken) {
    return fetch("/api/events/" + encodeURIComponent(eventId) + "/banner", {
      method: "PUT",
      headers: {
        "Content-Type": blob.type || "image/webp",
        "X-Turnstile-Token": turnstileToken || "",
      },
      body: blob,
      credentials: "same-origin",
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = { raw: text };
        }
        if (!res.ok) {
          var err = new Error((data && data.error) || res.statusText || "upload_failed");
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function clearPendingBannerPreview() {
    if (state.pendingBannerPreviewUrl) {
      URL.revokeObjectURL(state.pendingBannerPreviewUrl);
    }
    state.pendingBannerBlob = null;
    state.pendingBannerPreviewUrl = null;
    var input = $("#ev-banner");
    if (input) input.value = "";
    var wrap = $("#ev-banner-preview-wrap");
    if (wrap) wrap.classList.add("hidden");
    var img = $("#ev-banner-preview");
    if (img) img.removeAttribute("src");
  }

  function showPendingBannerPreview(blob) {
    clearPendingBannerPreview();
    state.pendingBannerBlob = blob;
    state.pendingBannerPreviewUrl = URL.createObjectURL(blob);
    var wrap = $("#ev-banner-preview-wrap");
    var img = $("#ev-banner-preview");
    if (wrap) wrap.classList.remove("hidden");
    if (img) img.src = state.pendingBannerPreviewUrl;
  }

  function showExistingBannerPreview(ev) {
    clearPendingBannerPreview();
    var wrap = $("#ev-banner-preview-wrap");
    var img = $("#ev-banner-preview");
    if (wrap) wrap.classList.remove("hidden");
    if (img) img.src = eventBannerUrl(ev || {});
  }

  function renderEventCard(ev) {
    var ext = ev.is_external;
    var eventUrl = window.location.origin + "/#/event/" + encodeURIComponent(ev.id);
    var shareX =
      "https://x.com/intent/tweet?text=" +
      encodeURIComponent((ev.title || "Event") + " on EventMark") +
      "&url=" +
      encodeURIComponent(eventUrl);
    var shareLinkedin =
      "https://www.linkedin.com/sharing/share-offsite/?url=" +
      encodeURIComponent(eventUrl);
    var shareWhatsapp =
      "https://wa.me/?text=" +
      encodeURIComponent((ev.title || "Event") + " on EventMark " + eventUrl);
    function toCalStamp(iso) {
      return String(iso || "").replace(/[-:]/g, "").replace(/\.\d{3}Z?$/, "Z");
    }
    var googleCal =
      "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=" + encodeURIComponent(ev.title || "Event") +
      "&dates=" + encodeURIComponent(toCalStamp(ev.startsAt) + "/" + toCalStamp(ev.endsAt)) +
      "&details=" + encodeURIComponent((ev.description || "") + "\n" + eventUrl) +
      "&location=" + encodeURIComponent(ev.location || "");
    var registerBtn = ext
      ? '<a class="event-card__btn event-card__btn--primary" href="' +
        escapeHtml(ev.external_url || "#") +
        '" target="_blank" rel="noopener">Register</a>'
      : '<button type="button" class="event-card__btn event-card__btn--primary" data-native-register="' +
        escapeHtml(ev.id) +
        '">Register</button>';
    var desc = escapeHtml(ev.description || "No description provided yet.");
    var whenLine = escapeHtml(formatEventWhen(ev.startsAt, ev.endsAt));
    var bannerHtml = renderEventBannerVisual(ev, "event-card__banner");
    return (
      '<article class="event-card" data-event-id="' + escapeHtml(ev.id) + '">' +
      '<header class="event-card__header">' +
      bannerHtml +
      '<div class="event-card__headline">' +
      "<h3 class=\"event-card__title\">" + escapeHtml(ev.title) + "</h3>" +
      '<p class="event-card__country">' + escapeHtml(formatEventCountryLabel(ev)) + "</p>" +
      '<p class="event-card__short-date">' + escapeHtml(formatEventShortDate(ev.startsAt, ev.endsAt)) + "</p>" +
      "</div></header>" +
      '<div class="event-card__accordions">' +
      '<div class="event-card__accordion is-open" data-accordion>' +
      '<button type="button" class="event-card__accordion-trigger" data-accordion-trigger aria-expanded="true">' +
      "<span>Date/Time</span>" +
      '<svg class="event-card__chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>' +
      "</button>" +
      '<div class="event-card__accordion-panel" data-accordion-panel aria-hidden="false">' +
      '<div class="event-card__accordion-body">' + whenLine + "</div></div></div>" +
      '<div class="event-card__accordion is-open" data-accordion>' +
      '<button type="button" class="event-card__accordion-trigger" data-accordion-trigger aria-expanded="true">' +
      "<span>Description</span>" +
      '<svg class="event-card__chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>' +
      "</button>" +
      '<div class="event-card__accordion-panel" data-accordion-panel aria-hidden="false">' +
      '<div class="event-card__accordion-body">' + desc + "</div></div></div></div>" +
      '<p class="event-card__metrics">' +
      '<svg class="event-card__eye" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5M12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3"/></svg>' +
      "<span>" + (ev.viewCount || 0) + " views, " + (ev.interestedCount || 0) + " interested</span></p>" +
      '<footer class="event-card__footer">' +
      '<div class="event-card__actions">' +
      registerBtn +
      '<a class="event-card__btn event-card__btn--outline" href="#/event/' +
      escapeHtml(ev.id) +
      '">More Details</a>' +
      '<div class="event-card__share">' +
      '<button type="button" class="event-card__share-btn" data-share-toggle aria-label="Share event" aria-expanded="false" aria-haspopup="true">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92"/></svg>' +
      "</button>" +
      '<div class="event-card__share-popup" role="menu">' +
      '<a class="event-card__share-link" href="' + escapeHtml(shareX) + '" target="_blank" rel="noopener" role="menuitem">X</a>' +
      '<a class="event-card__share-link" href="' + escapeHtml(shareLinkedin) + '" target="_blank" rel="noopener" role="menuitem">LinkedIn</a>' +
      '<a class="event-card__share-link" href="' + escapeHtml(shareWhatsapp) + '" target="_blank" rel="noopener" role="menuitem">WhatsApp</a>' +
      '<a class="event-card__share-link" href="' + escapeHtml(googleCal) + '" target="_blank" rel="noopener" role="menuitem">Google Calendar</a>' +
      '<a class="event-card__share-link" href="/api/events/' + escapeHtml(ev.id) + '/ics.ics" role="menuitem">ICS</a>' +
      "</div></div></div></footer></article>"
    );
  }

  function syncEventViewCount(eventId, viewCount) {
    if (typeof viewCount !== "number") return;
    var i;
    if (state.events && state.events.length) {
      for (i = 0; i < state.events.length; i++) {
        if (state.events[i].id === eventId) {
          state.events[i].viewCount = viewCount;
          break;
        }
      }
    }
    if (state.currentEvent && state.currentEvent.id === eventId) {
      state.currentEvent.viewCount = viewCount;
    }
    var card = document.querySelector('.event-card[data-event-id="' + eventId + '"]');
    if (!card) return;
    var metrics = card.querySelector(".event-card__metrics span");
    if (!metrics) return;
    var interested = 0;
    if (state.events) {
      for (i = 0; i < state.events.length; i++) {
        if (state.events[i].id === eventId) {
          interested = state.events[i].interestedCount || 0;
          break;
        }
      }
    }
    metrics.textContent = viewCount + " views, " + interested + " interested";
  }

  function closeEventSharePopups(except) {
    document.querySelectorAll(".event-card__share.is-open").forEach(function (wrap) {
      if (except && wrap === except) return;
      wrap.classList.remove("is-open");
      var btn = wrap.querySelector("[data-share-toggle]");
      if (btn) btn.setAttribute("aria-expanded", "false");
    });
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (!headers["Content-Type"] && opts.body && typeof opts.body === "string") {
      headers["Content-Type"] = "application/json";
    }
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body,
      credentials: "same-origin",
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = { raw: text };
        }
        if (!res.ok) {
          var err = new Error((data && data.error) || res.statusText || "request_failed");
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function getTheme() {
    return localStorage.getItem("eventmark_theme") || "dark";
  }

  function applyTheme(theme) {
    var body = document.body;
    if (theme === "light") {
      body.classList.add("light");
    } else {
      body.classList.remove("light");
    }
    var light = theme === "light";
    var logo = $("#brand-logo");
    if (logo) {
      logo.src = light ? "/assets/logo-black.svg" : "/assets/logo-white.svg";
    }
    var footerLogo = $("#footer-logo");
    if (footerLogo) {
      footerLogo.src = light ? "/assets/logo-black.svg" : "/assets/logo-white.svg";
    }
    var themeBtn = $("#btn-theme");
    if (themeBtn) {
      themeBtn.setAttribute("aria-label", light ? "Use dark theme" : "Use light theme");
    }
  }

  function setTheme(theme) {
    localStorage.setItem("eventmark_theme", theme);
    applyTheme(theme);
  }

  function toggleTheme() {
    var next = getTheme() === "light" ? "dark" : "light";
    setTheme(next);
  }

  function closeCalendarDrawer() {
    var d = $("#calendar-drawer");
    var btn = $("#btn-calendar");
    var inlineBtn = $("#btn-calendar-inline");
    if (d) {
      d.classList.remove("open");
      d.setAttribute("aria-hidden", "true");
    }
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
    }
    if (inlineBtn) {
      inlineBtn.setAttribute("aria-expanded", "false");
    }
  }

  function openCalendarDrawer() {
    var d = $("#calendar-drawer");
    var btn = $("#btn-calendar");
    var inlineBtn = $("#btn-calendar-inline");
    if (!d) return;
    d.classList.add("open");
    d.setAttribute("aria-hidden", "false");
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (inlineBtn) inlineBtn.setAttribute("aria-expanded", "true");
    return refreshCalendarStrip();
  }

  function openMobileNav() {
    var nav = $("#main-nav");
    var overlay = $("#nav-overlay");
    var toggle = $("#mobile-nav-toggle");
    if (nav) {
      nav.classList.add("open");
    }
    if (overlay) {
      overlay.classList.add("open");
    }
    if (toggle) {
      toggle.setAttribute("aria-expanded", "true");
    }
    document.body.style.overflow = "hidden"; // Prevent background scrolling
  }

  function closeMobileNav() {
    var nav = $("#main-nav");
    var overlay = $("#nav-overlay");
    var toggle = $("#mobile-nav-toggle");
    if (nav) {
      nav.classList.remove("open");
    }
    if (overlay) {
      overlay.classList.remove("open");
    }
    if (toggle) {
      toggle.setAttribute("aria-expanded", "false");
    }
    document.body.style.overflow = ""; // Restore scrolling
  }

  function openModal(html) {
    closeCalendarDrawer();
    closeMobileNav(); // Close mobile nav when opening modal
    var root = $("#modal-root");
    var body = $("#modal-body");
    body.innerHTML = html;
    root.classList.add("open");
    root.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden"; // Prevent background scrolling on mobile
  }

  function closeModal() {
    var root = $("#modal-root");
    root.classList.remove("open");
    root.setAttribute("aria-hidden", "true");
    $("#modal-body").innerHTML = "";
    document.body.style.overflow = ""; // Restore scrolling
  }

  var turnstileScriptCallbacks = [];
  var turnstileScriptState = "idle";

  function turnstileSiteKeyUsable() {
    var sk = (state.config.turnstileSiteKey || "").trim();
    if (!sk || sk.toLowerCase().indexOf("replace") >= 0) return false;
    return sk.length >= 10;
  }

  function ensureTurnstileScript(done) {
    if (window.turnstile) {
      done();
      return;
    }
    turnstileScriptCallbacks.push(done);
    if (turnstileScriptState === "loading") return;
    turnstileScriptState = "loading";
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.defer = true;
    function flush() {
      var cbs = turnstileScriptCallbacks.slice();
      turnstileScriptCallbacks.length = 0;
      for (var i = 0; i < cbs.length; i++) {
        try {
          cbs[i]();
        } catch (e) {}
      }
    }
    s.onload = function () {
      turnstileScriptState = "ready";
      flush();
    };
    s.onerror = function () {
      turnstileScriptState = "idle";
      flush();
    };
    document.head.appendChild(s);
  }

  function renderTurnstile(containerId, tokenHolder, onReadyState) {
    var el = document.getElementById(containerId);
    if (typeof tokenHolder === "object" && tokenHolder) tokenHolder.widgetId = null;
    if (!el) {
      if (typeof onReadyState === "function") onReadyState(false);
      return;
    }
    if (!turnstileSiteKeyUsable()) {
      el.innerHTML =
        "<p class='muted'>Sign-in security is not set up for this site yet. Please try again later or contact the team running this deployment.</p>" +
        (showOpsSecurityHint()
          ? "<p class='muted' style='font-size:0.85rem;margin-top:0.5rem'>Deployer: set the Turnstile <strong>site key</strong> in wrangler vars and the matching <strong>secret key</strong> via <code>wrangler secret put TURNSTILE_SECRET_KEY</code> (same widget; the two keys are different strings). Strip <code>REPLACE_…</code> placeholders.</p>"
          : "");
      if (typeof onReadyState === "function") onReadyState(false);
      return;
    }
    el.innerHTML = "<p class='muted' style='font-size:0.8rem'>Loading security check…</p>";
    if (typeof onReadyState === "function") onReadyState(false);
    ensureTurnstileScript(function () {
      el.innerHTML = "";
      if (!window.turnstile) {
        el.innerHTML =
          "<p class='muted'>We could not load the security check for this page. Check your network, try again, or relax strict blockers for this site." +
          (showOpsSecurityHint()
            ? " (Deployer: ensure <code>challenges.cloudflare.com</code> is not blocked.)"
            : "") +
          "</p>";
        if (typeof onReadyState === "function") onReadyState(false);
        return;
      }
      var widgetId = window.turnstile.render(el, {
        sitekey: state.config.turnstileSiteKey,
        callback: function (token) {
          tokenHolder.value = token;
          if (typeof onReadyState === "function") onReadyState(true);
        },
        "expired-callback": function () {
          tokenHolder.value = "";
          if (typeof onReadyState === "function") onReadyState(false);
        },
        "error-callback": function () {
          tokenHolder.value = "";
          if (typeof onReadyState === "function") onReadyState(false);
          var hint = document.getElementById("login-ts-hint");
          if (hint) {
            var host =
              typeof location !== "undefined" && location.hostname ? location.hostname : "this site";
            hint.textContent =
              "We could not run the security check in your browser. Try refreshing, allow this site in your privacy or ad-blocking tools, or use another network." +
              (showOpsSecurityHint()
                ? " Deployer: Cloudflare error 400020 usually means the hostname \"" +
                  host +
                  "\" is not listed on the Turnstile widget, or the site key in wrangler is wrong. Use the widget's Site key in TURNSTILE_SITE_KEY and the widget's Secret key in TURNSTILE_SECRET_KEY (they are not the same string; both must come from the same widget)."
                : "");
          }
        },
      });
      tokenHolder.widgetId = widgetId;
    });
  }

  /** Turnstile siteverify accepts a token once — call after request-otp so verify-otp gets a fresh token. */
  function resetTurnstileWidget(tokenHolder, containerId, onReadyState) {
    tokenHolder.value = "";
    if (typeof onReadyState === "function") onReadyState(false);
    if (window.turnstile && tokenHolder.widgetId != null) {
      try {
        window.turnstile.reset(tokenHolder.widgetId);
      } catch (e) {
        tokenHolder.widgetId = null;
        renderTurnstile(containerId, tokenHolder, onReadyState);
      }
    } else {
      renderTurnstile(containerId, tokenHolder, onReadyState);
    }
  }

  /** Wait for a fresh Turnstile token after the previous one was consumed by an API call. */
  function refreshTurnstileToken(tokenHolder, containerId, onReadyState) {
    if (!turnstileSiteKeyUsable()) return Promise.resolve("");
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timeoutId = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("Security check timed out. Try saving again."));
      }, 90000);
      var priorToken = tokenHolder.value;
      resetTurnstileWidget(tokenHolder, containerId, function (ready) {
        if (typeof onReadyState === "function") onReadyState(ready);
        if (settled) return;
        if (ready && tokenHolder.value && tokenHolder.value !== priorToken) {
          settled = true;
          clearTimeout(timeoutId);
          resolve(tokenHolder.value);
        }
      });
    });
  }

  function wireModalClose() {
    var root = $("#modal-root");
    root.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close")) {
        closeModal();
      }
    });
  }

  function updateFooterSpacesCount() {
    var el = $("#footer-spaces-count");
    if (el) {
      el.textContent = "Spaces: " + String(state.calendarTotalEvents || 0);
    }
  }

  function loadFooterStats() {
    return api("/api/calendar/stats")
      .catch(function () {
        return { totalEvents: 0 };
      })
      .then(function (stats) {
        state.calendarTotalEvents = Number((stats && stats.totalEvents) || 0);
        updateFooterSpacesCount();
      });
  }

  function updateAuthUi() {
    var loggedIn = !!state.user;
    $("#btn-login").classList.toggle("hidden", loggedIn);
    $("#btn-logout").classList.toggle("hidden", !loggedIn);
    var logoutNav = $("#btn-logout-nav");
    if (logoutNav) logoutNav.classList.toggle("hidden", !loggedIn);
    Array.prototype.forEach.call(document.querySelectorAll(".nav-auth-only"), function (link) {
      if (link.classList.contains("nav-checkin-desk-only")) return;
      link.classList.toggle("hidden", !loggedIn);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".nav-checkin-desk-only"), function (link) {
      link.classList.toggle("hidden", !(loggedIn && userHasCheckinDeskAccess()));
    });
    var badge = $("#user-verified-badge");
    var profileBtn = $("#btn-profile");
    var guestIcon = document.querySelector(".profile-guest-icon");
    if (badge) {
      badge.classList.toggle("hidden", !loggedIn);
      badge.setAttribute("aria-hidden", loggedIn ? "false" : "true");
      if (loggedIn) {
        var isVerified = !!(state.user && state.user.verified);
        badge.classList.toggle("verified", isVerified);
        badge.classList.toggle("unverified", !isVerified);
        badge.setAttribute("title", isVerified ? "Email verified" : "Email not verified");
        var initials = "XX";
        if (state.user && state.user.name) {
          var parts = state.user.name.trim().split(/\s+/);
          initials = parts.length >= 2
            ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
            : parts[0].slice(0, 2).toUpperCase();
        } else if (state.user && state.user.email) {
          initials = state.user.email.slice(0, 2).toUpperCase();
        }
        badge.textContent = initials;
      }
    }
    if (guestIcon) {
      guestIcon.classList.toggle("hidden", loggedIn);
    }
    if (profileBtn) {
      profileBtn.classList.toggle("header-profile-btn--guest", !loggedIn);
      profileBtn.setAttribute("aria-label", loggedIn ? "Open dashboard" : "Sign in");
    }
  }

  function loadMe() {
    return api("/api/me").then(function (data) {
      state.user = data.user;
      updateAuthUi();
    });
  }

  function userIsAdmin() {
    return !!(state.user && state.user.roles && state.user.roles.indexOf("admin") >= 0);
  }

  function userHasCheckinDeskAccess() {
    if (!state.user) return false;
    var ids = state.user.checkinOrganizationIds || [];
    return ids.length > 0;
  }

  function loadConfig() {
    return api("/api/config").then(function (data) {
      state.config.turnstileSiteKey = data.turnstileSiteKey || "";
      state.config.environment = data.environment || "";
      state.config.noticeBanner = data.noticeBanner || "";
      renderNoticeBanner();
    });
  }

  function renderNoticeBanner() {
    var existing = document.getElementById("notice-banner");
    var msg = state.config.noticeBanner || "";
    if (!msg) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElement("div");
      existing.id = "notice-banner";
      existing.className = "notice-banner";
      var main = document.getElementById("app");
      if (main && main.parentElement) {
        main.parentElement.insertBefore(existing, main);
      }
    }
    existing.textContent = msg;
  }

  function utcDayKey(iso) {
    return String(iso || "").slice(0, 10);
  }

  function calendarNavBounds() {
    var n = new Date();
    return {
      min: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 12, 1)),
      max: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 12, 1)),
    };
  }

  function calMonthStartIso(y, m) {
    return new Date(Date.UTC(y, m, 1)).toISOString();
  }

  function calMonthEndIso(y, m) {
    return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999)).toISOString();
  }

  function badgeForDay(key) {
    var list = state.calendarBadges;
    for (var i = 0; i < list.length; i++) {
      if (list[i].date === key) return list[i];
    }
    return null;
  }

  function renderCalendarStripDom() {
    var strip = $("#calendar-strip");
    if (!strip) return;
    var b = calendarNavBounds();
    var d = state.calendarMonth;
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth();
    var label = new Date(Date.UTC(y, m, 1)).toLocaleString(undefined, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    var prevD = new Date(Date.UTC(y, m - 1, 1));
    var nextD = new Date(Date.UTC(y, m + 1, 1));
    var prevDisabled = prevD < b.min ? " disabled" : "";
    var nextDisabled = nextD > b.max ? " disabled" : "";
    var firstIdx = new Date(Date.UTC(y, m, 1)).getUTCDay();
    var daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var byDay = {};
    (state.calendarItems || []).forEach(function (ev) {
      var k = utcDayKey(ev.startsAt);
      if (!byDay[k]) byDay[k] = [];
      byDay[k].push(ev);
    });
    var ym = y + "-" + (m + 1 < 10 ? "0" : "") + (m + 1) + "-";
    var html = "";
    html += "<div class='cal-toolbar'>";
    html +=
      "<button type='button' class='btn-ghost' data-cal-prev='1' aria-label='Previous month'" +
      prevDisabled +
      ">&larr;</button>";
    html += "<span class='cal-title'>" + escapeHtml(label) + "</span>";
    html +=
      "<button type='button' class='btn-ghost' data-cal-next='1' aria-label='Next month'" +
      nextDisabled +
      ">&rarr;</button>";
    html +=
      "<label class='cal-region-label'>Region <select id='cal-region' aria-label='Region filter'>";
    ["all", "americas", "emea", "apac", "mea"].forEach(function (r) {
      html +=
        "<option value='" +
        r +
        "'" +
        (state.calendarRegion === r ? " selected" : "") +
        ">" +
        r +
        "</option>";
    });
    html += "</select></label></div>";
    html +=
      "<div class='cal-weekdays'><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>";
    html += "<div class='cal-grid'>";
    var cellCount = 0;
    var i;
    for (i = 0; i < firstIdx; i++) {
      html += "<div class='cal-cell cal-cell--empty'></div>";
      cellCount++;
    }
    for (var day = 1; day <= daysInMonth; day++) {
      var key = ym + (day < 10 ? "0" : "") + day;
      var evs = byDay[key] || [];
      var bd = badgeForDay(key);
      var hasEvents = evs.length > 0;
      var cls = "cal-cell";
      if (hasEvents) cls += " cal-cell--busy";
      if (state.calendarSelectedKey === key) cls += " cal-cell--selected";
      html +=
        "<button type='button' class='" +
        cls +
        "' data-cal-day='" +
        escapeHtml(key) +
        "' aria-label='Day " +
        day +
        ", " +
        evs.length +
        " events'>";
      html += "<span class='cal-daynum'>" + day + "</span>";
      if (bd && bd.interested) {
        html += "<span class='cal-dot cal-dot--interest' title='Interested'></span>";
      }
      if (bd && bd.participated) {
        html +=
          "<span class='cal-logo-wrap' title='Participating'><img src='/assets/logo-white.svg' alt='' width='14' height='14' class='cal-logo-mark'/></span>";
      }
      if (hasEvents) {
        html += "<span class='cal-dot-count'>" + evs.length + "</span>";
      }
      html += "</button>";
      cellCount++;
    }
    while (cellCount % 7 !== 0) {
      html += "<div class='cal-cell cal-cell--empty'></div>";
      cellCount++;
    }
    while (cellCount < 42) {
      html += "<div class='cal-cell cal-cell--empty'></div>";
      cellCount++;
    }
    html += "</div>";
    html +=
      "<p class='cal-summary'>Total events created so far: <strong>" +
      String(state.calendarTotalEvents || 0) +
      "</strong></p>";
    strip.innerHTML = html;
    updateFooterSpacesCount();
  }

  function openCalendarDayPanel() {
    var panel = $("#calendar-day-panel");
    if (!panel || !state.calendarSelectedKey) return;
    var key = state.calendarSelectedKey;
    var evs = (state.calendarItems || []).filter(function (ev) {
      return utcDayKey(ev.startsAt) === key;
    });
    var lines = evs
      .map(function (ev) {
        return (
          "<article class='cal-day-ev'><h4>" +
          escapeHtml(ev.title) +
          "</h4><p class='muted'>" +
          escapeHtml(formatEventWhen(ev.startsAt, ev.endsAt)) +
          "</p><p class='muted'>" +
          escapeHtml(ev.location) +
          "</p><div class='row'>" +
          "<button type='button' class='btn-ghost' data-cal-interest='" +
          escapeHtml(ev.id) +
          "'>Interested</button>" +
          "<button type='button' class='btn-danger' data-cal-uninterest='" +
          escapeHtml(ev.id) +
          "'>Not interested</button>" +
          "<button type='button' class='btn-ghost' data-cal-contribute='" +
          escapeHtml(ev.id) +
          "'>Contribute</button>" +
          "<a class='btn-primary' href='#/event/" +
          escapeHtml(ev.id) +
          "'>Details</a></div></article>"
        );
      })
      .join("");
    panel.innerHTML =
      "<h3 class='cal-panel-title'>" +
      escapeHtml(formatEventDate(key + "T00:00:00Z", { timeZone: "UTC" })) +
      " (UTC)</h3>" +
      (lines || "<p class='muted'>No events this UTC day.</p>") +
      "<p><button type='button' class='btn-ghost' data-cal-panel-close='1'>Close</button></p>";
    panel.classList.remove("hidden");
  }

  function refreshCalendarStrip() {
    var strip = $("#calendar-strip");
    if (!strip) return Promise.resolve();
    var d = state.calendarMonth;
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth();
    var from = calMonthStartIso(y, m);
    var to = calMonthEndIso(y, m);
    var q =
      "/api/calendar?from=" +
      encodeURIComponent(from) +
      "&to=" +
      encodeURIComponent(to) +
      "&region=" +
      encodeURIComponent(state.calendarRegion);
    return Promise.all([
      api(q),
      api("/api/calendar/stats").catch(function () { return { totalEvents: 0 }; }),
    ])
      .then(function (all) {
        var data = all[0] || {};
        var stats = all[1] || {};
        state.calendarItems = data.items || [];
        state.calendarTotalEvents = Number(stats.totalEvents || 0);
      })
      .then(function () {
        if (!state.user) {
          state.calendarBadges = [];
          return;
        }
        return api("/api/me/calendar-badges").then(function (bd) {
          state.calendarBadges = (bd && bd.badges) || [];
        });
      })
      .catch(function () {
        state.calendarItems = [];
        state.calendarBadges = [];
        state.calendarTotalEvents = 0;
      })
      .then(function () {
        renderCalendarStripDom();
      });
  }

  function initCalendarStripOnce() {
    var wrap = document.querySelector(".calendar-strip-wrap");
    if (!wrap || wrap.dataset.calendarInit) return;
    wrap.dataset.calendarInit = "1";
    wrap.addEventListener("click", function (e) {
      var raw = e.target;
      var t = raw instanceof HTMLElement ? raw.closest("[data-cal-prev],[data-cal-next],[data-cal-day],[data-cal-interest],[data-cal-uninterest],[data-cal-contribute],[data-cal-panel-close]") : null;
      if (!(t instanceof HTMLElement)) return;
      if (t.hasAttribute("data-cal-panel-close")) {
        e.preventDefault();
        $("#calendar-day-panel").classList.add("hidden");
        state.calendarSelectedKey = null;
        renderCalendarStripDom();
        return;
      }
      if (t.hasAttribute("data-cal-prev") && !t.disabled) {
        e.preventDefault();
        var mm = state.calendarMonth;
        var yy = mm.getUTCFullYear();
        var mo = mm.getUTCMonth();
        var nb = calendarNavBounds();
        var nextM = new Date(Date.UTC(yy, mo - 1, 1));
        if (nextM < nb.min) return;
        state.calendarMonth = nextM;
        state.calendarSelectedKey = null;
        refreshCalendarStrip();
        return;
      }
      if (t.hasAttribute("data-cal-next") && !t.disabled) {
        e.preventDefault();
        var mm2 = state.calendarMonth;
        var yy2 = mm2.getUTCFullYear();
        var mo2 = mm2.getUTCMonth();
        var nb2 = calendarNavBounds();
        var nextM2 = new Date(Date.UTC(yy2, mo2 + 1, 1));
        if (nextM2 > nb2.max) return;
        state.calendarMonth = nextM2;
        state.calendarSelectedKey = null;
        refreshCalendarStrip();
        return;
      }
      if (t.hasAttribute("data-cal-day")) {
        e.preventDefault();
        state.calendarSelectedKey = t.getAttribute("data-cal-day");
        openCalendarDayPanel();
        return;
      }
      if (t.hasAttribute("data-cal-interest")) {
        e.preventDefault();
        var ie = t.getAttribute("data-cal-interest");
        openContributionFlow(ie, "interest");
        return;
      }
      if (t.hasAttribute("data-cal-contribute")) {
        e.preventDefault();
        var ce = t.getAttribute("data-cal-contribute");
        openContributionFlow(ce, "contribute");
        return;
      }
      if (t.hasAttribute("data-cal-uninterest")) {
        e.preventDefault();
        var uid = t.getAttribute("data-cal-uninterest");
        if (!state.user) {
          openLoginModal(function () {
            refreshCalendarStrip().then(function () {
              openCalendarDayPanel();
            });
          });
          return;
        }
        api("/api/interests/" + encodeURIComponent(uid), { method: "DELETE" })
          .then(function () {
            return refreshCalendarStrip();
          })
          .then(function () {
            openCalendarDayPanel();
          })
          .catch(function (err) {
            toast(friendlyError(err, "Could not remove interest."), "error");
          });
        return;
      }
    });
    wrap.addEventListener("change", function (e) {
      var sel = e.target;
      if (sel && sel.id === "cal-region") {
        state.calendarRegion = sel.value;
        state.calendarSelectedKey = null;
        refreshCalendarStrip();
      }
    });
  }

  function route() {
    var parts = hashSectionParts();
    var section = parts[0] || "";
    if (section !== "dashboard" && section !== "organize") {
      closeModal();
    }
    var p;
    if (section === "event" && parts[1]) {
      if (parts[2] === "contribute" && parts[3]) {
        p = renderEventDetail(parts[1]).then(function () {
          openContributionResubmit(parts[1], parts[3]);
        });
      } else {
        p = renderEventDetail(parts[1]);
      }
    } else if (section === "dashboard") {
      if (!state.user) {
        openLoginModal(function () {
          window.location.hash = "#/dashboard";
          route();
        });
        p = renderHome();
      } else {
        p = renderDashboard().then(function () {
          var hashQuery = parseHashQuery();
          if (hashQuery.contrib) {
            return api("/api/contributions/" + encodeURIComponent(hashQuery.contrib))
              .then(function (data) {
                if (data.contribution && data.contribution.status === "INFO_REQUESTED") {
                  activateDashboardTab("contribs");
                  openContributionResubmit(data.contribution.eventId, data.contribution.id);
                }
              })
              .catch(function () {});
          }
        });
      }
    } else if (section === "organize") {
      if (!state.user) {
        openLoginModal(function () {
          window.location.hash = "#/organize";
          route();
        });
        p = renderHome();
      } else {
        p = renderOrganize();
      }
    } else if (section === "admin" || section === "vetting") {
      setFlash("Admin pages are behind Zero Trust and are not exposed in this public app.", "info");
      if (window.location.hash !== "#/") window.location.hash = "#/";
      p = renderHome();
    } else if (section === "checkin") {
      p = renderCheckin();
    } else if (section === "checkin-desk") {
      if (!state.user) {
        openLoginModal(function () {
          window.location.hash = "#/checkin-desk";
          route();
        });
        p = renderHome();
      } else if (!userHasCheckinDeskAccess()) {
        setFlash("Check-in desk access is assigned by an event organizer.", "info");
        if (window.location.hash !== "#/") window.location.hash = "#/";
        p = renderHome();
      } else {
        p = renderCheckinDesk();
      }
    } else if (section === "about") {
      if ($("#about-guide-nav")) {
        mountAboutGuide(parseHashQuery().guide || "overview");
        p = Promise.resolve();
      } else {
        p = renderAbout();
      }
    } else if (section === "hemw") {
      p = renderHemw();
    } else {
      p = renderHome();
    }
    closeCalendarDrawer();
    return Promise.resolve(p);
  }

  function layout(content) {
    var flashHtml = "";
    if (state.flash) {
      flashHtml =
        '<div class="flash ' +
        (state.flashKind === "error" ? "error" : "") +
        '">' +
        escapeHtml(state.flash) +
        "</div>";
      state.flash = "";
    }
    $("#app").innerHTML = flashHtml + content;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isHttpUrl(value) {
    if (!value) return false;
    try {
      var u = new URL(String(value));
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  var EVENT_TITLE_MAX = 26;
  var PERSON_NAME_MAX = 26;
  var EVENT_DESCRIPTION_MAX_WORDS = 500;
  var BANNER_PX = 150;

  function countWords(s) {
    var t = String(s || "").trim();
    if (!t) return 0;
    return t.split(/\s+/).filter(Boolean).length;
  }

  function containsEmoji(s) {
    return /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u.test(String(s || ""));
  }

  function hasSuspiciousInput(s) {
    return /\b(union\s+select|insert\s+into|delete\s+from|drop\s+table|update\s+.+\s+set|;\s*--|or\s+1\s*=\s*1|exec\s+xp_|benchmark\s*\(|sleep\s*\()/i.test(String(s || ""));
  }

  var SPAM_URL_HOSTS = {
    "bit.ly": true,
    "tinyurl.com": true,
    "t.co": true,
    "goo.gl": true,
    "ow.ly": true,
    "adf.ly": true,
    "is.gd": true,
    "buff.ly": true,
    "cutt.ly": true,
    "rb.gy": true,
  };

  function isSafeHttpUrl(value) {
    if (!isHttpUrl(value)) return false;
    try {
      var u = new URL(String(value).trim());
      if (u.username || u.password) return false;
      if (SPAM_URL_HOSTS[u.hostname.toLowerCase()]) return false;
      if (String(value).indexOf("@") >= 0) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function rejectUnsafeText(value) {
    if (hasSuspiciousInput(value)) return "Input contains disallowed characters or patterns.";
    if (containsEmoji(value)) return "Emojis are not allowed.";
    return "";
  }

  function syncEventEndMin() {
    var startEl = $("#ev-start");
    var endEl = $("#ev-end");
    if (!startEl || !endEl) return;
    endEl.min = startEl.value || "";
  }

  function beginButtonLoading(btn, loadingText) {
    if (!btn) return;
    btn.dataset.idleLabel = btn.textContent.trim();
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML =
      '<span class="btn-spinner" aria-hidden="true"></span> ' +
      '<span class="btn-loading-label">' +
      escapeHtml(loadingText) +
      "</span>";
  }

  function endButtonLoading(btn, opts) {
    opts = opts || {};
    if (!btn) return;
    btn.classList.remove("is-loading");
    btn.removeAttribute("aria-busy");
    var idle = opts.fallbackLabel != null ? opts.fallbackLabel : btn.dataset.idleLabel || "OK";
    btn.textContent = idle;
    delete btn.dataset.idleLabel;
    if (typeof opts.disabled === "boolean") {
      btn.disabled = opts.disabled;
    } else {
      btn.disabled = false;
    }
  }

  function hashSectionParts() {
    var hash = window.location.hash || "#/";
    var path = hash.replace(/^#/, "").split("?")[0] || "/";
    return path.split("/").filter(Boolean);
  }

  function syncAboutGuideHash(tab) {
    var next = "#/about?guide=" + encodeURIComponent(tab || "overview");
    if (window.location.hash === next) return;
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", next);
    } else {
      window.location.hash = next;
    }
  }

  function aboutGuideLink(tab, label) {
    return "<a href='#/about?guide=" + encodeURIComponent(tab) + "'>" + escapeHtml(label) + "</a>";
  }

  function mountAboutGuide(initialTab) {
    var valid = { overview: true, attend: true, events: true, organizers: true, checkin: true };
    var key = valid[initialTab] ? initialTab : "overview";

    function activate(next, syncUrl) {
      if (!valid[next]) next = "overview";
      key = next;
      var nav = $("#about-guide-nav");
      if (nav) {
        Array.prototype.forEach.call(nav.querySelectorAll("[data-about-guide-tab]"), function (btn) {
          var active = btn.getAttribute("data-about-guide-tab") === next;
          btn.classList.toggle("active", active);
          btn.setAttribute("aria-selected", active ? "true" : "false");
        });
      }
      Array.prototype.forEach.call(document.querySelectorAll("[data-about-guide-panel]"), function (panel) {
        panel.classList.toggle("active", panel.getAttribute("data-about-guide-panel") === next);
      });
      if (syncUrl !== false) syncAboutGuideHash(next);
    }

    var nav = $("#about-guide-nav");
    if (nav && !nav.dataset.guideBound) {
      nav.dataset.guideBound = "1";
      nav.addEventListener("click", function (e) {
        var t = e.target;
        if (!(t instanceof HTMLElement)) return;
        var btn = t.closest("[data-about-guide-tab]");
        if (!btn) return;
        e.preventDefault();
        activate(btn.getAttribute("data-about-guide-tab") || "overview", false);
        syncAboutGuideHash(key);
      });
    }
    activate(key, true);
  }

  function renderHemw() {
    var target = "#/about?guide=overview";
    if (window.location.hash !== target) {
      window.location.hash = target;
      return Promise.resolve();
    }
    return renderAbout();
  }

  function renderCheckin() {
    var query = parseHashQuery();
    var ticketToken = (query.token || "").trim();
    var checkinTs = { value: "" };
    layout(
      "<section class='card'>" +
        "<h2>EventMark ticket check-in</h2>" +
        "<p class='muted'>Scanning opens this page on EventMark. Present the QR to event staff at the door.</p>" +
        "<div id='checkin-panel' class='muted'>" +
        (ticketToken ? "Verifying ticket…" : "Missing ticket token.") +
        "</div>" +
        "<div id='ts-checkin'></div>" +
        "<p><a href='#/'>← Back to events</a></p>" +
        "</section>"
    );
    renderTurnstile("ts-checkin", checkinTs, function () {});
    if (!ticketToken) return Promise.resolve();
    return api("/api/checkin/verify?token=" + encodeURIComponent(ticketToken))
      .then(function (data) {
        var panel = $("#checkin-panel");
        if (!panel) return;
        if (!data || !data.valid) {
          panel.innerHTML = "<p class='flash error'>This ticket QR is not valid.</p>";
          return;
        }
        var statusHtml = data.checkedIn
          ? "<p><strong>Status:</strong> Already checked in" +
            (data.checkedInAt ? " at " + escapeHtml(formatEventDateTime(data.checkedInAt)) : "") +
            ".</p>"
          : "<p><strong>Status:</strong> Valid ticket — not checked in yet.</p>";
        panel.innerHTML =
          "<p><strong>Event:</strong> " + escapeHtml(data.eventTitle || "Event") + "</p>" +
          statusHtml +
          "<p class='muted'>Ticket code: <code>" + escapeHtml(data.ticketCode || "") + "</code></p>" +
          "<div id='checkin-staff-actions'></div>";
        if (data.checkedIn || !data.eventId) return;
        var actions = $("#checkin-staff-actions");
        if (!actions) return;
        actions.innerHTML =
          "<hr />" +
          "<p class='muted'>Event staff: complete the security check above, then check in this guest.</p>" +
          "<button type='button' id='checkin-staff-btn' class='btn-primary'>Check in guest</button>" +
          "<div id='checkin-staff-result' class='muted'></div>";
        var btn = $("#checkin-staff-btn");
        if (!btn) return;
        btn.addEventListener("click", function () {
          if (!state.user) {
            openLoginModal(function () {
              route();
            });
            return;
          }
          if (!checkinTs.value) {
            toast("Complete the security check first.", "info");
            return;
          }
          btn.disabled = true;
          api("/api/checkin/scan", {
            method: "POST",
            body: JSON.stringify({
              eventId: data.eventId,
              token: ticketToken,
              turnstileToken: checkinTs.value,
            }),
          })
            .then(function (result) {
              var node = $("#checkin-staff-result");
              var guest =
                result && result.type === "ticket" && result.attendee
                  ? result.attendee.name || result.attendee.email
                  : result && result.invite
                    ? result.invite.name || result.invite.email
                    : "guest";
              if (node) node.innerHTML = "Checked in: <strong>" + escapeHtml(guest) + "</strong>";
              toast("Check-in successful.", "success");
              route();
            })
            .catch(function (err) {
              btn.disabled = false;
              toast(friendlyError(err, "Check-in failed."), "error");
            });
        });
      })
      .catch(function () {
        var panel = $("#checkin-panel");
        if (panel) panel.innerHTML = "<p class='flash error'>Could not verify this ticket.</p>";
      });
  }

  function renderCheckinDesk() {
    var deskTs = { value: "" };
    layout(
      "<section class='card'>" +
        "<h2>Check-in desk</h2>" +
        "<p class='muted'>Select your organization and event, then scan ticket QR codes or paste a check-in token.</p>" +
        "<div class='field'><label>Organization</label><select id='desk-org'><option value=''>Loading…</option></select></div>" +
        "<div class='field'><label>Event</label><select id='desk-event'><option value=''>Select organization first</option></select></div>" +
        "<div id='ts-desk'></div>" +
        "<div class='field'><label>Check-in token</label><input id='desk-token' placeholder='Paste token or scan ticket QR' /></div>" +
        "<button type='button' id='desk-checkin-btn' class='btn-primary'>Check in guest</button>" +
        "<div id='desk-checkin-result' class='muted'></div>" +
        "<div class='suite-scanner card'>" +
        "<h4>Camera QR scanner</h4>" +
        "<p class='muted'>Use your device camera to scan ticket or pass QR codes.</p>" +
        "<div id='desk-scan-permission' class='muted'>Camera permission not requested yet.</div>" +
        "<video id='desk-scan-video' playsinline muted autoplay></video>" +
        "<canvas id='desk-scan-canvas' hidden aria-hidden='true'></canvas>" +
        "<div class='row'>" +
        "<button type='button' id='desk-scan-permission-btn' class='btn-ghost'>Allow camera access</button>" +
        "<button type='button' id='desk-scan-start' class='btn-primary' disabled>Start scanner</button>" +
        "<button type='button' id='desk-scan-stop' class='btn-ghost'>Stop camera</button>" +
        "</div>" +
        "<div id='desk-scan-status' class='muted'>Request camera permission to begin scanning.</div>" +
        "</div>" +
        "</section>"
    );
    renderTurnstile("ts-desk", deskTs, function () {});

    var deskEventsById = {};
    var deskScanner = {
      stream: null,
      timer: 0,
      running: false,
      busy: false,
      detector: null,
      canvas: null,
      ctx: null,
      lastToken: "",
      lastTokenAt: 0,
    };

    function deskEventId() {
      var sel = $("#desk-event");
      return sel ? (sel.value || "") : "";
    }

    function deskSetScanStatus(msg) {
      var node = $("#desk-scan-status");
      if (node) node.textContent = msg;
    }

    function deskSetPermission(msg, kind) {
      var node = $("#desk-scan-permission");
      if (!node) return;
      node.textContent = msg;
      node.classList.remove("permission-granted", "permission-denied");
      if (kind) node.classList.add(kind);
    }

    function deskSetScanButtons(hasPermission) {
      var startBtn = $("#desk-scan-start");
      var permBtn = $("#desk-scan-permission-btn");
      if (startBtn) startBtn.disabled = !hasPermission;
      if (permBtn) permBtn.textContent = hasPermission ? "Camera allowed" : "Allow camera access";
    }

    function deskEnsureJsQr() {
      if (window.jsQR) return Promise.resolve(true);
      return new Promise(function (resolve, reject) {
        var existing = document.getElementById("jsqr-script");
        if (existing) {
          existing.addEventListener("load", function () {
            resolve(!!window.jsQR);
          });
          existing.addEventListener("error", function () {
            reject(new Error("jsqr_load_failed"));
          });
          return;
        }
        var s = document.createElement("script");
        s.id = "jsqr-script";
        s.src = "/assets/jsqr.js";
        s.async = true;
        s.onload = function () {
          resolve(!!window.jsQR);
        };
        s.onerror = function () {
          reject(new Error("jsqr_load_failed"));
        };
        document.head.appendChild(s);
      });
    }

    function deskIsEventMarkHost(hostname) {
      if (!hostname) return false;
      var h = String(hostname).toLowerCase();
      if (h === String(window.location.hostname || "").toLowerCase()) return true;
      if (h === "eventmark.org" || h === "www.eventmark.org") return true;
      if (h.slice(-13) === ".eventmark.org") return true;
      if (h.indexOf("eventmark.randomflux.online") >= 0) return true;
      return false;
    }

    function deskExtractCheckinToken(raw) {
      var s = (raw || "").trim();
      if (!s) return "";
      if (s.indexOf("http://") === 0 || s.indexOf("https://") === 0) {
        try {
          var u = new URL(s);
          if (!deskIsEventMarkHost(u.hostname)) return "";
          var token = u.searchParams.get("token");
          if (token) return token;
          if (u.hash) {
            var hashPart = u.hash.replace(/^#/, "");
            var qIdx = hashPart.indexOf("?");
            if (hashPart.split("?")[0].replace(/^\//, "") === "checkin" && qIdx >= 0) {
              var params = new URLSearchParams(hashPart.slice(qIdx + 1));
              token = params.get("token");
              if (token) return token;
            }
          }
        } catch (e) {
          return "";
        }
        return "";
      }
      return s;
    }

    function deskRunCheckin(scannedToken, fromScanner) {
      var eid = deskEventId();
      var tokenInput = (scannedToken || ($("#desk-token").value || "")).trim();
      if (!eid || !tokenInput) {
        toast("Organization, event, and token are required.", "info");
        return Promise.resolve();
      }
      if (!deskTs.value) {
        toast("Complete the security check first.", "info");
        return Promise.resolve();
      }
      return api("/api/checkin/scan", {
        method: "POST",
        body: JSON.stringify({ eventId: eid, token: tokenInput, turnstileToken: deskTs.value }),
      })
        .then(function (data) {
          var node = $("#desk-checkin-result");
          if (node) {
            var guestName = "guest";
            if (data && data.type === "ticket" && data.attendee) {
              guestName = data.attendee.name || data.attendee.email || "guest";
            } else if (data && data.invite) {
              guestName = data.invite.name || data.invite.email || "guest";
            }
            node.innerHTML = "Checked in: <strong>" + escapeHtml(guestName) + "</strong>";
          }
          if (!fromScanner) toast("Check-in successful.", "success");
        })
        .catch(function (err) {
          if (fromScanner && err && err.data && err.data.error === "already_checked_recently") return;
          toast(friendlyError(err, "Check-in failed."), "error");
        });
    }

    function deskHandleScannedToken(raw) {
      if (!raw) return;
      var token = deskExtractCheckinToken(raw);
      if (!token) {
        deskSetScanStatus("QR must link to EventMark check-in.");
        return;
      }
      var now = Date.now();
      if (deskScanner.lastToken === token && now - deskScanner.lastTokenAt < 1500) return;
      deskScanner.lastToken = token;
      deskScanner.lastTokenAt = now;
      var tokenInput = $("#desk-token");
      if (tokenInput) tokenInput.value = token;
      deskSetScanStatus("Token scanned. Checking in…");
      deskRunCheckin(token, true).then(function () {
        deskSetScanStatus("Scan next QR code.");
      });
    }

    function deskDetectFromVideo(video) {
      if (deskScanner.detector) return deskScanner.detector.detect(video);
      if (window.jsQR && deskScanner.canvas && deskScanner.ctx) {
        if (video.readyState < video.HAVE_ENOUGH_DATA) return Promise.resolve([]);
        var w = video.videoWidth;
        var h = video.videoHeight;
        if (!w || !h) return Promise.resolve([]);
        deskScanner.canvas.width = w;
        deskScanner.canvas.height = h;
        deskScanner.ctx.drawImage(video, 0, 0, w, h);
        var imageData = deskScanner.ctx.getImageData(0, 0, w, h);
        var code = window.jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) return Promise.resolve([{ rawValue: code.data }]);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }

    function deskBeginScanLoop(video) {
      deskScanner.running = true;
      deskScanner.timer = setInterval(function () {
        if (!deskScanner.running || deskScanner.busy || !video) return;
        if (!deskScanner.detector && !window.jsQR) return;
        deskScanner.busy = true;
        deskDetectFromVideo(video)
          .then(function (codes) {
            if (!codes || !codes.length) return;
            var raw = codes[0] && (codes[0].rawValue || "");
            deskHandleScannedToken(raw);
          })
          .catch(function () {})
          .finally(function () {
            deskScanner.busy = false;
          });
      }, 250);
    }

    function deskStopCamera() {
      deskScanner.running = false;
      if (deskScanner.timer) {
        clearInterval(deskScanner.timer);
        deskScanner.timer = 0;
      }
      if (deskScanner.stream) {
        deskScanner.stream.getTracks().forEach(function (t) {
          t.stop();
        });
        deskScanner.stream = null;
      }
      var video = $("#desk-scan-video");
      if (video) video.srcObject = null;
      deskSetScanStatus("Camera stopped.");
    }

    function deskOpenCameraStream() {
      var video = $("#desk-scan-video");
      if (!video) return Promise.resolve();
      var canvas = $("#desk-scan-canvas");
      if (canvas) {
        deskScanner.canvas = canvas;
        deskScanner.ctx = canvas.getContext("2d", { willReadFrequently: true });
      }
      deskSetScanStatus("Starting camera…");
      return navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "environment" } })
        .then(function (stream) {
          deskSetPermission("Camera permission granted.", "permission-granted");
          deskSetScanButtons(true);
          deskScanner.stream = stream;
          video.srcObject = stream;
          return video.play().catch(function () {});
        })
        .then(function () {
          deskSetScanStatus("Camera live. Point to QR code.");
          deskBeginScanLoop(video);
        });
    }

    function deskLoadEvents(orgId) {
      var eventSel = $("#desk-event");
      if (!eventSel) return Promise.resolve();
      if (!orgId) {
        eventSel.innerHTML = "<option value=''>Select organization first</option>";
        return Promise.resolve();
      }
      eventSel.innerHTML = "<option value=''>Loading events…</option>";
      return api("/api/checkin-desk/events?organizationId=" + encodeURIComponent(orgId))
        .then(function (data) {
          deskEventsById = {};
          var items = (data && data.items) || [];
          items.forEach(function (ev) {
            deskEventsById[ev.id] = ev;
          });
          if (!items.length) {
            eventSel.innerHTML = "<option value=''>No published events</option>";
            return;
          }
          eventSel.innerHTML =
            "<option value=''>Select event</option>" +
            items
              .map(function (ev) {
                return (
                  "<option value='" +
                  escapeHtml(ev.id) +
                  "'>" +
                  escapeHtml(ev.title || "Event") +
                  "</option>"
                );
              })
              .join("");
        })
        .catch(function () {
          eventSel.innerHTML = "<option value=''>Could not load events</option>";
        });
    }

    var checkinBtn = $("#desk-checkin-btn");
    if (checkinBtn) {
      checkinBtn.addEventListener("click", function () {
        deskRunCheckin();
      });
    }

    var orgSel = $("#desk-org");
    if (orgSel) {
      orgSel.addEventListener("change", function () {
        deskLoadEvents(orgSel.value || "");
      });
    }

    var permBtn = $("#desk-scan-permission-btn");
    if (permBtn) {
      permBtn.addEventListener("click", function () {
        deskEnsureJsQr()
          .then(function () {
            return deskOpenCameraStream();
          })
          .catch(function (err) {
            deskSetPermission("Could not access camera.", "permission-denied");
            deskSetScanStatus(err && err.message ? err.message : "Camera error.");
          });
      });
    }

    var startBtn = $("#desk-scan-start");
    if (startBtn) {
      startBtn.addEventListener("click", function () {
        deskEnsureJsQr()
          .then(function () {
            if (deskScanner.stream) {
              deskBeginScanLoop($("#desk-scan-video"));
              deskSetScanStatus("Scanner running.");
              return;
            }
            return deskOpenCameraStream();
          })
          .catch(function () {
            toast("Could not start scanner.", "error");
          });
      });
    }

    var stopBtn = $("#desk-scan-stop");
    if (stopBtn) {
      stopBtn.addEventListener("click", function () {
        deskStopCamera();
      });
    }

    if (window.BarcodeDetector) {
      try {
        deskScanner.detector = new BarcodeDetector({ formats: ["qr_code"] });
      } catch (e) {
        deskScanner.detector = null;
      }
    }

    return api("/api/me/checkin-organizations")
      .then(function (data) {
        var items = (data && data.items) || [];
        if (!orgSel) return;
        if (!items.length) {
          orgSel.innerHTML = "<option value=''>No check-in access assigned</option>";
          return;
        }
        orgSel.innerHTML =
          items.length > 1
            ? "<option value=''>Select organization</option>" +
              items
                .map(function (o) {
                  return (
                    "<option value='" + escapeHtml(o.id) + "'>" + escapeHtml(o.name || "Organization") + "</option>"
                  );
                })
                .join("")
            : items
                .map(function (o) {
                  return (
                    "<option value='" + escapeHtml(o.id) + "' selected>" +
                    escapeHtml(o.name || "Organization") +
                    "</option>"
                  );
                })
                .join("");
        if (items.length === 1) deskLoadEvents(items[0].id);
      })
      .catch(function () {
        if (orgSel) orgSel.innerHTML = "<option value=''>Could not load organizations</option>";
      });
  }

  function renderAbout() {
    var query = parseHashQuery();
    var initialTab = query.guide || "overview";
    var html =
      "<div class='about-page'>" +
      "<h2>About EventMark</h2>" +
      "<p>EventMark is an open platform to discover and join community and opensource events. Sign in with email — no password — and keep tickets, links, and your calendar in one place.</p>" +
      "<p class='muted'>Use the guide tabs below to learn what each button does, how online and in-person events differ, and how to apply as an organization.</p>" +
      "<nav id='about-guide-nav' class='about-guide-nav dashboard-tabs' role='tablist' aria-label='Help and guide'>" +
      "<button type='button' class='dash-tab' data-about-guide-tab='overview' role='tab'>Overview</button>" +
      "<button type='button' class='dash-tab' data-about-guide-tab='attend' role='tab'>Attending</button>" +
      "<button type='button' class='dash-tab' data-about-guide-tab='events' role='tab'>Event types</button>" +
      "<button type='button' class='dash-tab' data-about-guide-tab='organizers' role='tab'>Organizers</button>" +
      "<button type='button' class='dash-tab' data-about-guide-tab='checkin' role='tab'>Check-in</button>" +
      "</nav>" +
      "<div class='about-guide-panels'>" +
      "<section class='about-guide-panel card' data-about-guide-panel='overview'>" +
      "<h3>Roles at a glance</h3>" +
      "<ul class='hemw-steps'>" +
      "<li><strong>Guest</strong> — browse and search events without signing in.</li>" +
      "<li><strong>Participant</strong> — sign in, save interest, register, RSVP, and view tickets or join links on your dashboard.</li>" +
      "<li><strong>Organizer</strong> — apply as an approved organization, create draft events, publish, invite people, and run check-in.</li>" +
      "<li><strong>Check-in staff</strong> — assigned by an organizer; scan QR codes at the door with their own login (no shared password).</li>" +
      "<li><strong>Platform admin</strong> — reviews organizer applications and site settings (separate admin portal).</li>" +
      "</ul>" +
      "<p>Jump to: " + aboutGuideLink("attend", "Attending & buttons") + " · " +
      aboutGuideLink("events", "Native vs external events") + " · " +
      aboutGuideLink("organizers", "Apply & create events") + " · " +
      aboutGuideLink("checkin", "QR check-in") + "</p>" +
      "</section>" +
      "<section class='about-guide-panel card' data-about-guide-panel='attend'>" +
      "<h3>Register, Interested, and Going / Maybe / Not going</h3>" +
      "<p>On an event page under <strong>Attend</strong> you will see three different tools. They are <em>not</em> the same thing.</p>" +
      "<div class='guide-table-wrap'><table class='guide-table'>" +
      "<thead><tr><th>Button</th><th>What it does</th><th>Ticket / QR</th><th>Email</th></tr></thead>" +
      "<tbody>" +
      "<tr><td data-label='Button'><span class='guide-btn-name'>Interested</span></td><td data-label='What it does'>Bookmark the event on your dashboard and calendar. Good when you are curious but not ready to commit.</td><td data-label='Ticket / QR'><span class='guide-pill guide-pill--no'>No</span></td><td data-label='Email'><span class='guide-pill guide-pill--muted'>None</span></td></tr>" +
      "<tr class='guide-table-row--primary'><td data-label='Button'><span class='guide-btn-name'>Register</span></td><td data-label='What it does'>Official signup on EventMark. Reserves a seat when the event has a capacity limit. For in-person native events you receive a ticket code and QR by email.</td><td data-label='Ticket / QR'><span class='guide-pill guide-pill--yes'>Yes</span></td><td data-label='Email'><span class='guide-pill guide-pill--yes'>QR email</span></td></tr>" +
      "<tr><td data-label='Button'><span class='guide-btn-name'>Going</span></td><td data-label='What it does'>RSVP intent — “I plan to be there.” Used for counts and organizer reminders.</td><td data-label='Ticket / QR'><span class='guide-pill guide-pill--no'>No</span></td><td data-label='Email'><span class='guide-pill guide-pill--muted'>Reminder</span></td></tr>" +
      "<tr><td data-label='Button'><span class='guide-btn-name'>Maybe</span></td><td data-label='What it does'>RSVP — you might attend. No ticket is created.</td><td data-label='Ticket / QR'><span class='guide-pill guide-pill--no'>No</span></td><td data-label='Email'><span class='guide-pill guide-pill--no'>No</span></td></tr>" +
      "<tr><td data-label='Button'><span class='guide-btn-name'>Not going</span></td><td data-label='What it does'>RSVP — you will not attend. Helps organizers plan headcount.</td><td data-label='Ticket / QR'><span class='guide-pill guide-pill--no'>No</span></td><td data-label='Email'><span class='guide-pill guide-pill--no'>No</span></td></tr>" +
      "</tbody></table></div>" +
      "<div class='guide-callout'><strong>Important:</strong> Marking <strong>Going</strong> does <em>not</em> give you a QR code. For door check-in at in-person events you must <strong>Register</strong> and use the ticket from your dashboard or email.</div>" +
      "<h4>Typical paths</h4>" +
      "<ol class='hemw-steps'>" +
      "<li><strong>Just exploring</strong> — click <strong>Interested</strong>. The date appears on your dashboard and calendar strip.</li>" +
      "<li><strong>Ready to attend (in person)</strong> — click <strong>Register</strong>, complete the quick check, receive QR ticket by email, show QR at the door.</li>" +
      "<li><strong>Ready to attend (online)</strong> — click <strong>Register</strong>. After signup, open <strong>Dashboard → Registrations</strong> for the join link (no QR needed).</li>" +
      "<li><strong>After you register</strong> — optionally set <strong>Going / Maybe / Not going</strong> so organizers know your intent (optional; separate from registration).</li>" +
      "</ol>" +
      "<p class='muted'>Your dashboard has separate tabs: Interested, Registrations (tickets/links), and RSVP status.</p>" +
      "</section>" +
      "<section class='about-guide-panel card' data-about-guide-panel='events'>" +
      "<h3>Native, external, online, in-person, and hybrid</h3>" +
      "<div class='guide-table-wrap'><table class='guide-table'>" +
      "<thead><tr><th>Event kind</th><th>What participants see</th><th>Registration</th></tr></thead>" +
      "<tbody>" +
      "<tr class='guide-table-row--primary'><td data-label='Event kind'><span class='guide-btn-name'>Native (EventMark)</span></td><td data-label='What participants see'>Register and Interested buttons on EventMark. Organizers manage list, tickets, and check-in here.</td><td data-label='Registration'>On EventMark — ticket or waitlist</td></tr>" +
      "<tr><td data-label='Event kind'><span class='guide-btn-name'>External registration</span></td><td data-label='What participants see'>“Register on organizer site” link instead of EventMark Register. Signups happen on the organizer’s own page.</td><td data-label='Registration'>Off-site — EventMark only tracks interest if you click Interested</td></tr>" +
      "<tr><td data-label='Event kind'><span class='guide-btn-name'>In person</span></td><td data-label='What participants see'>Location/venue shown. After native registration: QR ticket for door check-in.</td><td data-label='Registration'>QR ticket email + dashboard</td></tr>" +
      "<tr><td data-label='Event kind'><span class='guide-btn-name'>Online</span></td><td data-label='What participants see'>Join link stored by organizer. After registration: link appears on your dashboard (not a QR ticket).</td><td data-label='Registration'>Dashboard join link</td></tr>" +
      "<tr><td data-label='Event kind'><span class='guide-btn-name'>Hybrid</span></td><td data-label='What participants see'>Both venue and online join link. Register on EventMark; in-person attendees get QR, online attendees use the link.</td><td data-label='Registration'>QR + join link as applicable</td></tr>" +
      "</tbody></table></div>" +
      "<div class='guide-callout'><strong>Waitlist:</strong> If an event is full, native registration adds you to a waitlist. When a seat opens, EventMark can promote you and send your ticket automatically.</div>" +
      "<p>Organizers choose format and external vs native when " + aboutGuideLink("organizers", "creating an event") + ".</p>" +
      "</section>" +
      "<section class='about-guide-panel card' data-about-guide-panel='organizers'>" +
      "<h3>Apply as an organization and create events</h3>" +
      "<ol class='hemw-steps'>" +
      "<li><strong>Sign in</strong> with your email (passwordless OTP).</li>" +
      "<li><strong>Organize → Apply</strong> — submit your organization/entity: name, website, description, directors, motto, and whether you run in-person, online, or hybrid events.</li>" +
      "<li><strong>Verify email</strong> — enter the one-time org-request code sent to your inbox.</li>" +
      "<li><strong>Admin review</strong> — EventMark admins approve, reject, or ask for more information. When approved, your account is linked to the organization.</li>" +
      "<li><strong>Create draft events</strong> — under Organize: title, banner, description, location, seats (min/max), format, speakers, native vs external registration, optional website link.</li>" +
      "<li><strong>Publish</strong> — draft events are private until published; then they appear on Discover and the calendar.</li>" +
      "<li><strong>Invitation suite</strong> — invites, email campaigns, analytics, venue layout, and assign " + aboutGuideLink("checkin", "check-in staff") + " by email.</li>" +
      "</ol>" +
      "<h4>Draft vs published</h4>" +
      "<p>Only <strong>drafts that have never been published</strong> can be fully edited. After the first publish, some fields are locked to protect attendees who already registered.</p>" +
      "<p class='muted'>Start from the top menu: <a href='#/organize'>Organize</a></p>" +
      "</section>" +
      "<section class='about-guide-panel card' data-about-guide-panel='checkin'>" +
      "<h3>QR tickets and door check-in</h3>" +
      "<ol class='hemw-steps'>" +
      "<li>Participant <strong>registers</strong> on a native in-person event.</li>" +
      "<li>EventMark emails a <strong>QR ticket</strong> and shows the same code on the participant dashboard.</li>" +
      "<li>At the door, staff open <strong>Check-in desk</strong> (or Organize → Check-in for org members).</li>" +
      "<li>Staff scan the QR or paste the token — guest is checked in once (duplicate scans are blocked).</li>" +
      "</ol>" +
      "<p>Organizers add volunteers under <strong>Organize → Check-in staff</strong>. Each person signs in with their own email; they never need the organizer’s password.</p>" +
      "<p class='muted'>RSVP “Going” alone is not valid at the door — only a registered ticket QR works for native in-person events.</p>" +
      "</section>" +
      "</div>" +
      "<h3>Who builds it</h3>" +
      "<p>EventMark is built with care by contributors who believe open communities deserve dependable event infrastructure. " +
      "It is an initiative product launch by voxon.org&reg;. " +
      '<a href="https://github.com/voxondotorg/eventmark.org" rel="noopener noreferrer" target="_blank">Contribute on GitHub</a>.</p>' +
      "<h3>Open source</h3>" +
      "<p>Released under the <a href='/license'>MIT License</a>. QR components: <a href='/third-party'>third-party notices</a>.</p>" +
      "</div>";
    layout(html);
    mountAboutGuide(initialTab);
    return Promise.resolve();
  }


  function paintHome() {
      var searchValue = escapeHtml(state.eventSearchQuery || "");
      var showClearSearch = state.eventSearchQuery && state.eventSearchQuery.trim().length >= 2;
      var cards = state.events.map(renderEventCard).join("");
      layout(
        "<section class='home-intro'>" +
          "<h2>Discover events</h2>" +
          "<p>Find opensource, funsource and community events you care about — save what looks good, sign up when you are ready.</p>" +
          "<p class='muted'><a href='#/about?guide=attend'>Help: Register vs Interested vs RSVP</a> · " +
          "<a href='#/about?guide=organizers'>Running events as an organization</a></p>" +
          "<p class='home-intro-tools'><button type='button' id='btn-calendar-inline' class='btn-ghost'>Calendar</button></p>" +
          "<div class='search-row'>" +
          "<input type='search' id='event-search' class='search-input' placeholder='Search events...' value='" +
          searchValue +
          "' />" +
          "<button type='button' id='btn-search' class='btn-ghost'>Search</button>" +
          "<button type='button' id='btn-clear-search' class='btn-ghost" +
          (showClearSearch ? "" : " hidden") +
          "'>Clear</button>" +
          "</div>" +
          "<details class='filter-details'><summary>Filters</summary>" +
          "<div class='filter-row'>" +
          "<label>Category <select id='filter-category'><option value=''>All</option><option value='open_source'>Open Source</option><option value='hybrid'>Hybrid</option></select></label>" +
          "<label>Type <select id='filter-mode'><option value=''>All</option><option value='in_person'>In Person</option><option value='online'>Online</option><option value='hybrid'>Hybrid</option></select></label>" +
          "<label>From <input type='date' id='filter-from' /></label>" +
          "<label>To <input type='date' id='filter-to' /></label>" +
          "<button type='button' id='btn-apply-filters' class='btn-primary'>Apply</button>" +
          "<button type='button' id='btn-clear-filters' class='btn-ghost'>Clear</button>" +
          "</div></details>" +
          "</section>" +
          '<div class="grid cards">' +
          cards +
          "</div>" +
          (state.eventsHasMore
            ? '<p><button type="button" id="btn-more" class="btn-ghost">Load more</button></p>'
            : "")
      );
      // Attach search handlers
      setTimeout(function () {
        var searchInput = $("#event-search");
        var searchBtn = $("#btn-search");
        var clearBtn = $("#btn-clear-search");
        var inlineCalBtn = $("#btn-calendar-inline");
        if (inlineCalBtn) {
          inlineCalBtn.addEventListener("click", function () {
            var d = $("#calendar-drawer");
            if (!d) return;
            if (d.classList.contains("open")) {
              closeCalendarDrawer();
            } else {
              openCalendarDrawer();
            }
          });
        }
        if (searchInput && searchBtn) {
          var debounceTimer = null;
          function doSearch() {
            var query = (searchInput.value || "").trim();
            if (query.length < 2) {
              state.eventSearchQuery = "";
              return api("/api/events?limit=24").then(function (page) {
                state.events = page.items || [];
                state.eventsCursor = page.cursor;
                state.eventsHasMore = page.hasMore;
                paintHome();
              });
            }
            state.eventSearchQuery = query;
            searchBtn.textContent = "Searching…";
            return api("/api/events/search?q=" + encodeURIComponent(query) + "&limit=24")
              .then(function (data) {
                state.events = data.items || [];
                state.eventsCursor = null;
                state.eventsHasMore = false;
                paintHome();
              })
              .catch(function (err) {
                toast(friendlyError(err, "Search failed"), "error");
              })
              .finally(function () {
                searchBtn.textContent = "Search";
              });
          }
          searchInput.addEventListener("input", function () {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = window.setTimeout(doSearch, 300);
          });
          searchInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
              e.preventDefault();
              if (debounceTimer) clearTimeout(debounceTimer);
              doSearch();
            }
          });
          searchBtn.addEventListener("click", doSearch);
          if (clearBtn) {
            clearBtn.addEventListener("click", function () {
              searchInput.value = "";
              state.eventSearchQuery = "";
              doSearch();
            });
          }
        }
        // Filter handlers
        var filterCategory = $("#filter-category");
        var filterMode = $("#filter-mode");
        var filterFrom = $("#filter-from");
        var filterTo = $("#filter-to");
        var applyFiltersBtn = $("#btn-apply-filters");
        var clearFiltersBtn = $("#btn-clear-filters");
        function applyFilters() {
          var params = new URLSearchParams();
          params.set("limit", "24");
          if (filterCategory && filterCategory.value) params.set("category", filterCategory.value);
          if (filterMode && filterMode.value) params.set("mode", filterMode.value);
          if (filterFrom && filterFrom.value) params.set("from", filterFrom.value + "T00:00:00.000Z");
          if (filterTo && filterTo.value) params.set("to", filterTo.value + "T23:59:59.999Z");
          state.eventSearchQuery = "";
          return api("/api/events?" + params.toString())
            .then(function (page) {
              state.events = page.items || [];
              state.eventsCursor = page.cursor;
              state.eventsHasMore = page.hasMore;
              paintHome();
            })
            .catch(function (err) {
              toast(friendlyError(err, "Could not apply filters"), "error");
            });
        }
        if (applyFiltersBtn) applyFiltersBtn.addEventListener("click", applyFilters);
        if (clearFiltersBtn) {
          clearFiltersBtn.addEventListener("click", function () {
            if (filterCategory) filterCategory.value = "";
            if (filterMode) filterMode.value = "";
            if (filterFrom) filterFrom.value = "";
            if (filterTo) filterTo.value = "";
            applyFilters();
          });
        }
      }, 0);
      return Promise.resolve();
  }

  function renderHome() {
    state.eventSearchQuery = "";
    return api("/api/events?limit=24").then(function (page) {
      state.events = page.items || [];
      state.eventsCursor = page.cursor;
      state.eventsHasMore = page.hasMore;
      return paintHome();
    });
  }

  function loadMoreEvents() {
    if (!state.eventsCursor) return Promise.resolve();
    var moreBtn = $("#btn-more");
    if (moreBtn) beginButtonLoading(moreBtn, "Loading…");
    return api("/api/events?limit=24&cursor=" + encodeURIComponent(state.eventsCursor))
      .then(function (page) {
        state.events = state.events.concat(page.items || []);
        state.eventsCursor = page.cursor;
        state.eventsHasMore = page.hasMore;
        return paintHome();
      })
      .catch(function (e) {
        setFlash(e.message || "Could not load more", "error");
        return paintHome();
      });
  }

  function parseHashQuery() {
    var hash = window.location.hash || "";
    var qIdx = hash.indexOf("?");
    if (qIdx === -1) return {};
    var out = {};
    hash
      .slice(qIdx + 1)
      .split("&")
      .forEach(function (pair) {
        var parts = pair.split("=");
        if (!parts[0]) return;
        out[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || "");
      });
    return out;
  }

  function openContributionResubmit(eventId, contributionId) {
    if (!state.user) {
      return openLoginModal(function () {
        openContributionResubmit(eventId, contributionId);
      });
    }
    return api("/api/contributions/" + encodeURIComponent(contributionId))
      .then(function (data) {
        if (!data.contribution || data.contribution.status !== "INFO_REQUESTED") {
          toast("This contribution does not need more information.", "info");
          return;
        }
        if (data.contribution.eventId !== eventId) {
          toast("Contribution does not match this event.", "error");
          return;
        }
        openContributionFlow(eventId, "contribute", {
          resubmit: true,
          contribution: data.contribution,
        });
      })
      .catch(function (err) {
        toast(friendlyError(err, "Could not load contribution."), "error");
      });
  }

  function openContributionFlow(eventId, mode, options) {
    options = options || {};
    var isResubmit = !!(options.resubmit && options.contribution);
    var existing = options.contribution || null;
    if (!state.user) {
      return openLoginModal(function () {
        openContributionFlow(eventId, mode, options);
      });
    }
    var tokenInput = { value: "" };
    var registerOnly = mode === "register";
    var html =
      "<h3>" + (isResubmit ? "Resubmit contribution" : "Event Registration") + "</h3><p class='muted'>" +
      (isResubmit
        ? "The organizer requested more information. Update the fields below and resubmit."
        : registerOnly
        ? "Complete the quick form below to register. If seats are full you will be placed on waitlist automatically."
        : "Select your role and complete the form to register for this event.") +
      (isResubmit && existing && existing.organizerNote
        ? "</p><p class='muted'><strong>Organizer note:</strong> " + escapeHtml(existing.organizerNote)
        : "") +
      "</p>" +
      '<input type="hidden" id="cf-turnstile-contrib" />' +
      '<div id="ts-contrib"></div>' +
      (registerOnly || isResubmit
        ? ""
        : '<div class="field"><label>Role</label><select id="contrib-role">' +
          '<option value="participant">Participant</option>' +
          '<option value="speaker">Speaker</option>' +
          '<option value="volunteer">Volunteer</option>' +
          '<option value="topic_proposer">Topic Proposer</option>' +
          "</select></div>") +
      '<div id="contrib-fields"></div>' +
      '<button type="button" id="contrib-submit" class="btn-primary">' +
      (isResubmit ? "Resubmit" : "Submit") +
      "</button>";
    openModal(html);
    renderTurnstile("ts-contrib", tokenInput, function(ready) {
      var b = $("#contrib-submit");
      if (b) b.disabled = !ready;
    });
    var roleSel = $("#contrib-role");
    if (isResubmit && existing && roleSel) {
      roleSel.value = existing.role;
      roleSel.disabled = true;
    }
    function renderFields() {
      var role = isResubmit && existing ? existing.role : roleSel ? roleSel.value : "participant";
      var payload = isResubmit && existing ? existing.payload || {} : {};
      var body = "";
      if (role === "participant") {
        body = "<p class='muted'>Complete your registration to receive a ticket with QR code.</p>";
      } else if (role === "speaker") {
        body =
          '<div class="field"><label>Topic Title *</label><input type="text" id="contrib-topic-title" placeholder="Your talk title" value="' + escapeHtml(payload.topicTitle || "") + '" /></div>' +
          '<div class="field"><label>Abstract *</label><textarea id="contrib-abstract" rows="4" placeholder="Brief description of your talk (100-500 words)">' + escapeHtml(payload.abstract || "") + '</textarea></div>' +
          '<div class="field"><label>Preferred Slot *</label><input type="text" id="contrib-preferred-slot" placeholder="e.g., Morning, Afternoon, or specific time" value="' + escapeHtml(payload.preferredSlot || "") + '" /></div>' +
          '<div class="field"><label>Bio *</label><textarea id="contrib-bio" rows="3" placeholder="Short bio highlighting your expertise">' + escapeHtml(payload.bio || "") + '</textarea></div>';
      } else if (role === "volunteer") {
        body =
          '<div class="field"><label>Skills *</label><textarea id="contrib-skills" rows="3" placeholder="e.g., Registration desk, AV support, Photography, Crowd management">' + escapeHtml(payload.skills || "") + '</textarea></div>' +
          '<div class="field"><label>Availability *</label><textarea id="contrib-availability" rows="3" placeholder="e.g., Full day, Morning only, Setup/Teardown">' + escapeHtml(payload.availability || "") + '</textarea></div>';
      } else if (role === "topic_proposer") {
        body =
          '<div class="field"><label>Topic Title *</label><input type="text" id="contrib-proposal-title" placeholder="Proposed topic title" value="' + escapeHtml(payload.topicTitle || "") + '" /></div>' +
          '<div class="field"><label>Description *</label><textarea id="contrib-description" rows="4" placeholder="Detailed description of the proposed topic">' + escapeHtml(payload.description || "") + '</textarea></div>' +
          '<div class="field"><label>Format *</label><select id="contrib-format">' +
          '<option value="">Select format...</option>' +
          '<option value="talk"' + (payload.format === "talk" ? " selected" : "") + '>Talk (20-30 min)</option>' +
          '<option value="lightning"' + (payload.format === "lightning" ? " selected" : "") + '>Lightning Talk (5-10 min)</option>' +
          '<option value="panel"' + (payload.format === "panel" ? " selected" : "") + '>Panel Discussion</option>' +
          '<option value="workshop"' + (payload.format === "workshop" ? " selected" : "") + '>Workshop (hands-on)</option>' +
          '<option value="demo"' + (payload.format === "demo" ? " selected" : "") + '>Demo / Showcase</option>' +
          '</select></div>';
      }
      $("#contrib-fields").innerHTML = body;
    }
    if (roleSel && !isResubmit) roleSel.addEventListener("change", renderFields);
    renderFields();
    $("#contrib-submit").addEventListener("click", function () {
      var submitBtn = $("#contrib-submit");
      var role = isResubmit && existing ? existing.role : roleSel ? roleSel.value : "participant";
      if (!tokenInput.value) {
        toast("Please complete the security check first.", "info");
        return;
      }

      if (registerOnly) {
        beginButtonLoading(submitBtn, "Registering…");
        function endRegisterBtn() {
          if (submitBtn && document.body.contains(submitBtn)) {
            endButtonLoading(submitBtn, { disabled: false });
          }
        }
        return api("/api/registrations/native", {
          method: "POST",
          body: JSON.stringify({ eventId: eventId, turnstileToken: tokenInput.value }),
        })
          .then(function (result) {
            closeModal();
            if (result && result.status === "waitlisted") {
              setFlash("Event is currently full. You are added to waitlist and will be auto-promoted when a seat opens.", "info");
            } else {
              var ticketCode = result && result.ticketCode ? result.ticketCode : "";
              setFlash(
                ticketCode
                  ? "Registered. Your ticket: " + ticketCode
                  : "Registered successfully.",
                "success"
              );
            }
            location.hash = "#/dashboard";
          })
          .catch(function (err) {
            toast(friendlyError(err, "Registration failed."), "error");
          })
          .finally(endRegisterBtn);
      }

      // Build payload with role-specific data
      var payload = {
        eventId: eventId,
        role: role,
        turnstileToken: tokenInput.value,
      };

      // Validate and add role-specific fields
      if (role === "speaker") {
        var topicTitle = $("#contrib-topic-title")?.value?.trim();
        var abstract = $("#contrib-abstract")?.value?.trim();
        var preferredSlot = $("#contrib-preferred-slot")?.value?.trim();
        var bio = $("#contrib-bio")?.value?.trim();
        if (!topicTitle || !abstract || !preferredSlot || !bio) {
          toast("Please fill in all required speaker fields.", "error");
          return;
        }
        payload.speaker = {
          topicTitle: topicTitle,
          abstract: abstract,
          preferredSlot: preferredSlot,
          bio: bio
        };
      } else if (role === "volunteer") {
        var skills = $("#contrib-skills")?.value?.trim();
        var availability = $("#contrib-availability")?.value?.trim();
        if (!skills || !availability) {
          toast("Please fill in all required volunteer fields.", "error");
          return;
        }
        payload.volunteer = {
          skills: skills,
          availability: availability
        };
      } else if (role === "topic_proposer") {
        var proposalTitle = $("#contrib-proposal-title")?.value?.trim();
        var description = $("#contrib-description")?.value?.trim();
        var format = $("#contrib-format")?.value;
        if (!proposalTitle || !description || !format) {
          toast("Please fill in all required topic proposer fields.", "error");
          return;
        }
        payload.topic_proposer = {
          topicTitle: proposalTitle,
          description: description,
          format: format
        };
      }
      beginButtonLoading(submitBtn, isResubmit ? "Resubmitting…" : "Submitting…");
      function endContribBtn() {
        if (submitBtn && document.body.contains(submitBtn)) {
          endButtonLoading(submitBtn, { disabled: false });
        }
      }

      if (isResubmit && existing) {
        var updateBody = { turnstileToken: tokenInput.value };
        if (role === "speaker") {
          updateBody.speaker = payload.speaker;
        } else if (role === "volunteer") {
          updateBody.volunteer = payload.volunteer;
        } else if (role === "topic_proposer") {
          updateBody.topic_proposer = payload.topic_proposer;
        }
        return api("/api/contributions/" + encodeURIComponent(existing.id), {
          method: "PUT",
          body: JSON.stringify(updateBody),
        })
          .then(function () {
            closeModal();
            setFlash("Contribution resubmitted. The organizer will review it again.", "success");
            location.hash = "#/dashboard?contrib=" + encodeURIComponent(existing.id);
            route();
          })
          .catch(function (err) {
            toast(friendlyError(err, "Resubmit failed."), "error");
          })
          .finally(endContribBtn);
      }

      // Add createInterest/createRegistration flags to payload for single-call submission
      if (mode !== "register") {
        payload.createInterest = true;
      }
      // Single API call with one Turnstile token handles both contribution and interest/registration
      return api("/api/contributions", { method: "POST", body: JSON.stringify(payload) })
        .then(function (result) {
          closeModal();
          var ticketCode = result && result.contribution && result.contribution.ticketCode;
          var ticketMsg = ticketCode ? "Registered! Your ticket: " + ticketCode : "Registered successfully!";
          if (mode === "register") {
            setFlash(ticketMsg + " Show this at the event.", "success");
          } else {
            setFlash("Interest saved. " + ticketMsg, "info");
          }
          location.hash = "#/dashboard";
        })
        .catch(function (err) {
          setFlash(err.message || "Failed", "error");
        })
        .finally(endContribBtn);
    });
  }

  function openLoginModal(after) {
    var tokenInput = { value: "", widgetId: null };
    var otpSendRequested = false;
    openModal(
      "<h3>Sign in</h3><p class='muted'>Email + 6-digit code. No passwords.</p>" +
        '<div id="ts-login"></div>' +
        "<p id='login-ts-hint' class='muted' style='font-size:0.8rem;margin:0 0 0.5rem'>Complete the check below, then enter your email and send the code.</p>" +
        '<div class="field"><label>Email</label><input type="email" id="login-email" autocomplete="username" disabled /></div>' +
        '<button type="button" id="login-send" class="btn-primary" disabled>Send code</button>' +
        '<div class="field"><label>Code from email</label><input id="login-code" inputmode="numeric" maxlength="6" disabled placeholder="After you send the code" /></div>' +
        '<button type="button" id="login-verify" class="btn-primary" disabled>Verify</button>'
    );
    var sendBtn = $("#login-send");
    var verifyBtn = $("#login-verify");
    function updateLoginHint() {
      var hint = $("#login-ts-hint");
      if (!hint) return;
      if (!otpSendRequested) {
        hint.textContent = tokenInput.value
          ? "You can enter your email and send the code."
          : "Complete the check below, then enter your email and send the code.";
      } else {
        hint.textContent = tokenInput.value
          ? "Complete the check below again, then click Verify (each step uses a new security check)."
          : "Complete the security check below again, then click Verify.";
      }
    }
    function syncLoginButtons() {
      var tok = !!tokenInput.value;
      var emailEl = $("#login-email");
      if (emailEl && tok) emailEl.disabled = false;
      var codeEl = $("#login-code");
      var codeOk = codeEl && /^\d{6}$/.test((codeEl.value || "").trim());
      if (sendBtn) sendBtn.disabled = !tok;
      if (verifyBtn) verifyBtn.disabled = !tok || !codeOk;
      updateLoginHint();
    }
    function setTurnstileReady(ready) {
      syncLoginButtons();
    }
    var codeInput = $("#login-code");
    if (codeInput) {
      codeInput.addEventListener("input", syncLoginButtons);
      codeInput.addEventListener("keyup", syncLoginButtons);
    }
    renderTurnstile("ts-login", tokenInput, setTurnstileReady);
    sendBtn.addEventListener("click", function () {
      clearFieldError("login-email");
      var email = ($("#login-email").value || "").trim();
      if (!email) {
        setFieldError("login-email", "Please enter your email so we can send the code.");
        $("#login-email").focus();
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setFieldError("login-email", "That email address does not look right.");
        $("#login-email").focus();
        return;
      }
      if (!tokenInput.value) {
        toast("Please finish the security check below, then send the code.", "info");
        return;
      }
      beginButtonLoading(sendBtn, "Sending code…");
      return api("/api/auth/request-otp", {
        method: "POST",
        body: JSON.stringify({ email: email, turnstileToken: tokenInput.value }),
      })
        .then(function () {
          otpSendRequested = true;
          toast("Code sent. Check your email inbox.", "success");
          var codeEl = $("#login-code");
          if (codeEl) {
            codeEl.disabled = false;
            codeEl.removeAttribute("placeholder");
            codeEl.focus();
          }
          resetTurnstileWidget(tokenInput, "ts-login", setTurnstileReady);
        })
        .catch(function (e) {
          toast(friendlyError(e, "Could not send the code."), "error");
        })
        .finally(function () {
          endButtonLoading(sendBtn, {});
          syncLoginButtons();
        });
    });
    verifyBtn.addEventListener("click", function () {
      clearFieldError("login-email");
      clearFieldError("login-code");
      var email = ($("#login-email").value || "").trim();
      var code = ($("#login-code").value || "").trim();
      if (!email) {
        setFieldError("login-email", "Enter the email you used to request the code.");
        $("#login-email").focus();
        return;
      }
      if (!/^\d{6}$/.test(code)) {
        setFieldError("login-code", "Enter the 6-digit code from the email.");
        $("#login-code").focus();
        return;
      }
      if (!tokenInput.value) {
        toast("Please finish the security check below, then verify.", "info");
        return;
      }
      beginButtonLoading(verifyBtn, "Verifying…");
      return api("/api/auth/verify-otp", {
        method: "POST",
        body: JSON.stringify({ email: email, code: code, turnstileToken: tokenInput.value }),
      })
        .then(function (data) {
          if (data && data.isNewUser) {
            openModal(
              "<h3>Welcome to EventMark!</h3>" +
              "<p class='muted'>Tell us your name so others know who you are. You can skip this for now.</p>" +
              "<div class='field'><label for='signup-name'>Your name</label><input type='text' id='signup-name' autocomplete='name' placeholder='e.g. Jane Smith' /></div>" +
              "<div style='display:flex;gap:0.5rem;margin-top:0.5rem'>" +
              "<button type='button' id='signup-name-save' class='btn-primary'>Save name</button>" +
              "<button type='button' id='signup-name-skip' class='btn-ghost'>Skip</button>" +
              "</div>"
            );
            function finishSignup() {
              closeModal();
              toast("Welcome! You are signed in.", "success");
              return loadMe().then(function () {
                route();
                if (typeof after === "function") after();
              });
            }
            var saveNameBtn = $("#signup-name-save");
            var skipBtn = $("#signup-name-skip");
            if (saveNameBtn) {
              saveNameBtn.addEventListener("click", function () {
                var nameVal = ($("#signup-name").value || "").trim();
                if (!nameVal) { finishSignup(); return; }
                saveNameBtn.disabled = true;
                api("/api/me", { method: "PATCH", body: JSON.stringify({ name: nameVal }) })
                  .then(finishSignup)
                  .catch(finishSignup);
              });
            }
            if (skipBtn) skipBtn.addEventListener("click", finishSignup);
          } else {
            closeModal();
            toast("Welcome back. You are signed in.", "success");
            return loadMe().then(function () {
              route();
              if (typeof after === "function") after();
            });
          }
        })
        .catch(function (e) {
          var d = (e && e.data) || {};
          if (d.error === "invalid_otp" || d.error === "invalid_code") {
            setFieldError("login-code", "That code is incorrect or has expired. Send a new one.");
            return;
          }
          if (d.error === "turnstile_failed") {
            toast(friendlyError(e, "Security check failed. Complete the check below again, then Verify."), "error");
            resetTurnstileWidget(tokenInput, "ts-login", setTurnstileReady);
            return;
          }
          toast(friendlyError(e, "Could not verify the code."), "error");
        })
        .finally(function () {
          if (verifyBtn && document.body.contains(verifyBtn)) {
            endButtonLoading(verifyBtn, {});
            syncLoginButtons();
          }
        });
    });
  }

  function activateDashboardTab(key) {
    var appNode = $("#app");
    if (!appNode) return;
    Array.prototype.forEach.call(appNode.querySelectorAll(".dash-tab"), function (btn) {
      var active = btn.getAttribute("data-dash-tab") === key;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    Array.prototype.forEach.call(appNode.querySelectorAll(".dashboard-tab-panel"), function (panel) {
      panel.classList.toggle("active", panel.getAttribute("data-dash-panel") === key);
    });
  }

  function renderDashboard() {
    if (!state.user) {
      setFlash("Sign in to view your dashboard.", "error");
      return Promise.resolve(renderHome());
    }
    return api("/api/me/dashboard").then(function (d) {
      state.dashboard = d;
      var saved = (d.interestedEvents || [])
        .map(function (ev) {
          return (
            "<li><a href='#/event/" + escapeHtml(ev.id) + "'>" + escapeHtml(ev.title) + "</a>" +
            " <span class='muted'>" + escapeHtml(formatEventDateTime(ev.startsAt)) + "</span></li>"
          );
        })
        .join("") || "<li class='muted'>Nothing saved yet — find something on the home page.</li>";

      var regs = (d.registrations || d.registeredEvents || [])
        .map(function (r) {
          // Backends differ — defensive shape
          var ev = r.event || r;
          var ticketCode = r.ticketCode || (ev && ev.ticketCode) || null;
          var mode = ev.mode || (ev.is_external ? "external" : "in_person");
          var joinHtml = "";
          if (mode === "online" && ev.online_url) {
            joinHtml =
              " <a class='btn-ghost' href='" + escapeHtml(ev.online_url) +
              "' target='_blank' rel='noopener'>Join online</a>";
          }
          var ticketHtml = "";
          if (ticketCode) {
            var ticketId = "ticket-" + Math.random().toString(36).substr(2, 9);
            ticketHtml =
              "<div class='ticket' id='" + ticketId + "'><div><strong>Ticket:</strong> <code>" + escapeHtml(ticketCode) + "</code></div>" +
              "<img alt='Ticket QR code' src='/api/tickets/" + encodeURIComponent(ticketCode) + "/qr.svg' loading='lazy' />" +
              "<div class='ticket-fallback' style='display:none; padding: 0.5rem; background: var(--bg-tertiary); border-radius: var(--radius); font-size: 0.875rem;'>" +
              "Show this code at check-in: <strong style='color: var(--text-primary); font-size: 1.1rem;'>" + escapeHtml(ticketCode) + "</strong>" +
              "</div></div>" +
              "<script>" +
              "(function() {" +
              "  var img = document.querySelector('#" + ticketId + " img');" +
              "  var fallback = document.querySelector('#" + ticketId + " .ticket-fallback');" +
              "  if (img) {" +
              "    img.onerror = function() {" +
              "      img.style.display = 'none';" +
              "      if (fallback) fallback.style.display = 'block';" +
              "    };" +
              "  }" +
              "})();" +
              "</script>";
          }
          return (
            "<li><a href='#/event/" + escapeHtml(ev.id) + "'>" + escapeHtml(ev.title) + "</a>" +
            " <span class='muted'>" + escapeHtml(formatEventDateTime(ev.startsAt)) + "</span>" + joinHtml +
            " <button type='button' class='btn-ghost' data-cancel-registration='" + escapeHtml(ev.id) + "'>Cancel</button>" +
            ticketHtml + "</li>"
          );
        })
        .join("") || "<li class='muted'>No registrations yet.</li>";

      var rsvps = (d.rsvps || [])
        .map(function (row) {
          var ev = row.event;
          var st = row.status || "maybe";
          return (
            "<li><a href='#/event/" + escapeHtml(ev.id) + "'>" + escapeHtml(ev.title) + "</a>" +
            " <span class='muted'>" + escapeHtml(formatEventDateTime(ev.startsAt)) + "</span>" +
            " <span class='pill'>" + escapeHtml(st.replace(/_/g, " ")) + "</span>" +
            " <button type='button' class='btn-ghost' data-dash-rsvp='going' data-dash-event='" + escapeHtml(ev.id) + "'>Going</button>" +
            " <button type='button' class='btn-ghost' data-dash-rsvp='maybe' data-dash-event='" + escapeHtml(ev.id) + "'>Maybe</button>" +
            " <button type='button' class='btn-ghost' data-dash-rsvp='not_going' data-dash-event='" + escapeHtml(ev.id) + "'>Not going</button>" +
            "</li>"
          );
        })
        .join("") || "<li class='muted'>No RSVP updates yet.</li>";

      var waitlist = (d.waitlist || [])
        .map(function (row) {
          var ev = row.event;
          return (
            "<li><a href='#/event/" + escapeHtml(ev.id) + "'>" + escapeHtml(ev.title) + "</a>" +
            " <span class='muted'>Waitlisted at " + escapeHtml(formatEventDateTime(row.createdAt)) + "</span></li>"
          );
        })
        .join("") || "<li class='muted'>No waitlist entries.</li>";

      var contribs = (d.contributions || [])
        .map(function (c) {
          var payload = c.payload || {};
          var eventTitle = c.event && c.event.title ? escapeHtml(c.event.title) : "Event";
          var detailText = "";
          if (c.role === "speaker" && payload.topicTitle) {
            detailText = " — " + escapeHtml(payload.topicTitle);
          } else if (c.role === "topic_proposer" && payload.topicTitle) {
            detailText = " — " + escapeHtml(payload.topicTitle) + " (" + escapeHtml(payload.format || "unknown format") + ")";
          } else if (c.role === "volunteer") {
            detailText = " — " + escapeHtml(payload.skills || "").substring(0, 30);
          }
          var infoRequested = c.status === "INFO_REQUESTED";
          var statusClass = c.status === "APPROVED" ? "style='color:var(--accent)'" :
                           c.status === "REJECTED" ? "style='color:var(--danger)'" :
                           infoRequested ? "style='color:var(--accent-warning,#d29922)'" :
                           "style='color:var(--muted)'";
          var noteHtml = infoRequested && c.organizerNote
            ? "<p class='muted'><strong>Organizer note:</strong> " + escapeHtml(c.organizerNote) + "</p>"
            : "";
          var resubmitBtn = infoRequested
            ? " <button type='button' class='btn-primary' data-resubmit-contrib='" + escapeHtml(c.id) + "' data-event-id='" + escapeHtml(c.eventId) + "'>Resubmit information</button>"
            : "";
          return (
            "<li" + (infoRequested ? " class='contrib-info-requested'" : "") + ">" +
            "<strong>" + escapeHtml(eventTitle) + "</strong> · " +
            "<strong>" + escapeHtml(c.role.replace(/_/g, " ")) + "</strong>" + detailText +
            " <span " + statusClass + ">" + escapeHtml(c.status.replace(/_/g, " ")) + "</span>" +
            noteHtml +
            " <a href='#/event/" + escapeHtml(c.eventId) + "'>open event</a>" +
            resubmitBtn +
            "</li>"
          );
        })
        .join("") || "<li class='muted'>No contributions yet.</li>";

      var me = d.user || state.user || {};
      var profileName = escapeHtml(me.name || "");
      var profileBio = escapeHtml(me.bio || "");
      var profileWebsite = escapeHtml(me.website || "");
      var verificationStatus = String(me.verificationRequestStatus || "none").toLowerCase();
      var verificationPill =
        verificationStatus === "pending"
          ? "<span class='pill'>Verification request pending</span>"
          : "<span class='pill'>Not submitted</span>";
      var verificationBtn =
        verificationStatus === "pending"
          ? "<button type='button' class='btn-ghost' disabled>Verification submitted</button>"
          : "<button type='button' class='btn-primary' data-apply-verification='1'>Apply for verification</button>";

      layout(
        "<h2>Your dashboard</h2>" +
          "<p class='muted'>Events you saved, signed up for, or contributed to.</p>" +
          "<div class='dashboard-tabs' role='tablist' aria-label='Dashboard sections'>" +
          "<button type='button' class='dash-tab active' data-dash-tab='saved' role='tab' aria-selected='true'>Saved</button>" +
          "<button type='button' class='dash-tab' data-dash-tab='registered' role='tab' aria-selected='false'>Registration</button>" +
          "<button type='button' class='dash-tab' data-dash-tab='rsvp' role='tab' aria-selected='false'>RSVP status</button>" +
          "<button type='button' class='dash-tab' data-dash-tab='waitlist' role='tab' aria-selected='false'>Waitlist</button>" +
          "<button type='button' class='dash-tab' data-dash-tab='contribs' role='tab' aria-selected='false'>Contributions</button>" +
          "<button type='button' class='dash-tab' data-dash-tab='profile' role='tab' aria-selected='false'>Profile</button>" +
          "</div>" +
          "<div class='dashboard-panels'>" +
          "<section class='card dashboard-tab-panel active' data-dash-panel='saved'><h3>Saved</h3><ul class='dash-list'>" + saved + "</ul></section>" +
          "<section class='card dashboard-tab-panel' data-dash-panel='registered'><h3>Registered</h3><ul class='dash-list'>" + regs + "</ul></section>" +
          "<section class='card dashboard-tab-panel' data-dash-panel='rsvp'><h3>RSVP status</h3><ul class='dash-list'>" + rsvps + "</ul></section>" +
          "<section class='card dashboard-tab-panel' data-dash-panel='waitlist'><h3>Waitlist</h3><ul class='dash-list'>" + waitlist + "</ul></section>" +
          "<section class='card dashboard-tab-panel' data-dash-panel='contribs'><h3>Your contributions</h3><ul class='dash-list'>" + contribs + "</ul></section>" +
          "<section class='card dashboard-tab-panel' data-dash-panel='profile'>" +
          "<h3>Your profile</h3>" +
          "<p class='muted'>Keep your basic details up to date, then apply for verification.</p>" +
          "<div class='field'><label for='dash-profile-name'>Full name</label><input id='dash-profile-name' type='text' value='" + profileName + "' placeholder='Your full name' /></div>" +
          "<div class='field'><label for='dash-profile-website'>Website</label><input id='dash-profile-website' type='url' value='" + profileWebsite + "' placeholder='https://example.com' /></div>" +
          "<div class='field'><label for='dash-profile-bio'>Bio</label><textarea id='dash-profile-bio' rows='4' placeholder='Tell us a bit about you'>" + profileBio + "</textarea></div>" +
          "<div class='profile-actions'><button type='button' class='btn-ghost' data-profile-save='1'>Save profile</button>" + verificationBtn + "</div>" +
          "<div class='profile-status'>" + verificationPill + "</div>" +
          "</section>" +
          "</div>" +
          "</div>"
      );

      var appNode = $("#app");
      if (appNode) {
        appNode.onclick = function (e) {
          var t = e.target;
          if (!(t instanceof HTMLElement)) return;
          var tabBtn = t.closest("[data-dash-tab]");
          if (tabBtn) {
            var key = tabBtn.getAttribute("data-dash-tab");
            if (!key) return;
            activateDashboardTab(key);
            return;
          }

          var resubmitId = t.getAttribute("data-resubmit-contrib");
          var resubmitEventId = t.getAttribute("data-event-id");
          if (resubmitId && resubmitEventId) {
            openContributionResubmit(resubmitEventId, resubmitId);
            return;
          }

          if (t.getAttribute("data-profile-save") === "1") {
            var nameEl = document.getElementById("dash-profile-name");
            var websiteEl = document.getElementById("dash-profile-website");
            var bioEl = document.getElementById("dash-profile-bio");
            var payload = {
              name: nameEl ? String(nameEl.value || "").trim() : "",
              website: websiteEl ? String(websiteEl.value || "").trim() : "",
              bio: bioEl ? String(bioEl.value || "").trim() : "",
            };
            api("/api/me", { method: "PATCH", body: JSON.stringify(payload) })
              .then(function (res) {
                state.user = res.user || state.user;
                toast("Profile saved.", "success");
                renderDashboard();
              })
              .catch(function (err) {
                toast(friendlyError(err, "Could not save profile."), "error");
              });
            return;
          }

          if (t.getAttribute("data-apply-verification") === "1") {
            var nEl = document.getElementById("dash-profile-name");
            var wEl = document.getElementById("dash-profile-website");
            var bEl = document.getElementById("dash-profile-bio");
            var reqBody = {
              name: nEl ? String(nEl.value || "").trim() : "",
              website: wEl ? String(wEl.value || "").trim() : "",
              bio: bEl ? String(bEl.value || "").trim() : "",
            };
            api("/api/me/verification-apply", {
              method: "POST",
              body: JSON.stringify(reqBody),
            })
              .then(function (res) {
                state.user = res.user || state.user;
                toast("Verification request submitted.", "success");
                renderDashboard();
              })
              .catch(function (err) {
                toast(friendlyError(err, "Could not submit verification request."), "error");
              });
            return;
          }

          var eventId = t.getAttribute("data-dash-event");
          var status = t.getAttribute("data-dash-rsvp");
          var cancelRegEvent = t.getAttribute("data-cancel-registration");
          if (eventId && status) {
            api("/api/events/" + encodeURIComponent(eventId) + "/rsvp", {
              method: "POST",
              body: JSON.stringify({ status: status }),
            })
              .then(function () {
                toast("RSVP updated.", "success");
                renderDashboard();
              })
              .catch(function (err) {
                toast(friendlyError(err, "Could not update RSVP."), "error");
              });
            return;
          }
          if (cancelRegEvent) {
            api("/api/registrations/" + encodeURIComponent(cancelRegEvent), {
              method: "DELETE",
            })
              .then(function (data) {
                if (data && data.promoted && data.promoted.promoted) {
                  toast("Registration canceled. A waitlisted attendee was auto-promoted.", "success");
                } else {
                  toast("Registration canceled.", "success");
                }
                renderDashboard();
              })
              .catch(function (err) {
                toast(friendlyError(err, "Could not cancel registration."), "error");
              });
          }
        };
      }
    });
  }

  function renderEventDetail(id) {
    var recordedViewCount = null;
    return api("/api/events/" + encodeURIComponent(id) + "/view", { method: "POST" })
      .then(function (viewData) {
        if (viewData && typeof viewData.viewCount === "number") {
          recordedViewCount = viewData.viewCount;
          syncEventViewCount(id, viewData.viewCount);
        }
      })
      .catch(function () {})
      .then(function () {
        return api("/api/events/" + encodeURIComponent(id));
      })
      .then(function (data) {
      var ev = data.event;
      if (recordedViewCount !== null) {
        ev.viewCount = recordedViewCount;
      }
      state.currentEvent = ev;
      var speakerSlots = data.speakerSlots || [];
      var booths = data.booths || [];
      var sessions = data.sessions || [];
      var approvedAgenda = ev.agenda || [];
      var agendaParts = [];

      if (speakerSlots.length) {
        agendaParts.push(
          "<h4>Speakers</h4><ul>" +
            speakerSlots
              .map(function (slot) {
                return (
                  "<li><strong>" +
                  escapeHtml(slot.topic) +
                  "</strong> — " +
                  escapeHtml(slot.name) +
                  " · " +
                  escapeHtml(slot.stage) +
                  "<br/><small class='muted'>" +
                  escapeHtml(formatAgendaWhen(slot.startsAt, slot.endsAt)) +
                  "</small></li>"
                );
              })
              .join("") +
            "</ul>"
        );
      }
      if (sessions.length) {
        agendaParts.push(
          "<h4>Sessions</h4><ul>" +
            sessions
              .map(function (slot) {
                return (
                  "<li><strong>" +
                  escapeHtml(slot.title) +
                  "</strong> — " +
                  escapeHtml(slot.room) +
                  " · " +
                  String(slot.capacity || 0) +
                  " seats<br/><small class='muted'>" +
                  escapeHtml(formatAgendaWhen(slot.startsAt, slot.endsAt)) +
                  "</small></li>"
                );
              })
              .join("") +
            "</ul>"
        );
      }
      if (booths.length) {
        agendaParts.push(
          "<h4>Booths</h4><ul>" +
            booths
              .map(function (slot) {
                return (
                  "<li><strong>" +
                  escapeHtml(slot.title) +
                  "</strong> (" +
                  escapeHtml(slot.boothCode) +
                  ") — " +
                  escapeHtml(slot.owner) +
                  (slot.locationHint
                    ? "<br/><small class='muted'>" + escapeHtml(slot.locationHint) + "</small>"
                    : "") +
                  "</li>"
                );
              })
              .join("") +
            "</ul>"
        );
      }
      if (approvedAgenda.length) {
        agendaParts.push(
          "<h4>Approved talks</h4><ul>" +
            approvedAgenda
              .map(function (slot) {
                return (
                  "<li><strong>" +
                  escapeHtml(slot.title) +
                  "</strong> — " +
                  escapeHtml(formatEventDateTime(slot.startsAt)) +
                  " (" +
                  escapeHtml(slot.abstract || "") +
                  ")</li>"
                );
              })
              .join("") +
            "</ul>"
        );
      }
      var agendaHtml = agendaParts.length
        ? agendaParts.join("")
        : "<p class='muted'>Agenda details will appear here once the organizer adds speakers, booths, or sessions.</p>";
      var categoryBadge = '';
      if (ev.category === 'open_source') {
        categoryBadge = '<span class="pill category-open">Open Source</span>';
      } else if (ev.category === 'fun_source') {
        categoryBadge = '<span class="pill category-fun">Fun Source</span>';
      }
      var statsLine = '<span class="muted">' +
        (ev.viewCount || 0) + ' views · ' +
        (ev.interestedCount || 0) + ' interested' +
        '</span>';
      var eventUrl = window.location.origin + "/#/event/" + encodeURIComponent(ev.id);
      var shareText = (ev.title || "Event") + " on EventMark";
      var shareX =
        "https://x.com/intent/tweet?text=" +
        encodeURIComponent(shareText) +
        "&url=" +
        encodeURIComponent(eventUrl);
      var shareLinkedin =
        "https://www.linkedin.com/sharing/share-offsite/?url=" +
        encodeURIComponent(eventUrl);
      var shareFacebook =
        "https://www.facebook.com/sharer/sharer.php?u=" +
        encodeURIComponent(eventUrl);
      var shareWhatsapp =
        "https://wa.me/?text=" +
        encodeURIComponent(shareText + " " + eventUrl);
      var shareEmail =
        "mailto:?subject=" +
        encodeURIComponent("Event invite: " + (ev.title || "Event")) +
        "&body=" +
        encodeURIComponent((ev.title || "Event") + "\n" + formatEventWhen(ev.startsAt, ev.endsAt) + "\n" + eventUrl);
      function toCalStamp(iso) {
        return String(iso || "").replace(/[-:]/g, "").replace(/\.\d{3}Z?$/, "Z");
      }
      var gcal =
        "https://calendar.google.com/calendar/render?action=TEMPLATE" +
        "&text=" + encodeURIComponent(ev.title || "Event") +
        "&dates=" + encodeURIComponent(toCalStamp(ev.startsAt) + "/" + toCalStamp(ev.endsAt)) +
        "&details=" + encodeURIComponent((ev.description || "") + "\n" + eventUrl) +
        "&location=" + encodeURIComponent(ev.location || "");
      var outlookWeb =
        "https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose" +
        "&subject=" + encodeURIComponent(ev.title || "Event") +
        "&startdt=" + encodeURIComponent(ev.startsAt || "") +
        "&enddt=" + encodeURIComponent(ev.endsAt || "") +
        "&body=" + encodeURIComponent((ev.description || "") + "\n" + eventUrl) +
        "&location=" + encodeURIComponent(ev.location || "");
      var websiteLink =
        ev.website_url && isHttpUrl(ev.website_url)
          ? "<p><a class='btn-ghost' href='" + escapeHtml(ev.website_url) + "' target='_blank' rel='noopener'>Visit official website</a></p>"
          : "";
      layout(
        '<figure class="event-detail-banner">' +
          '<img src="' + escapeHtml(eventBannerUrl(ev)) + '" alt="' +
          escapeHtml((ev.title || "Event") + " banner") +
          '" width="' + BANNER_PX + '" height="' + BANNER_PX + '" />' +
        "</figure>" +
        "<h2>" +
          escapeHtml(ev.title) +
          "</h2>" +
          (categoryBadge ? '<div>' + categoryBadge + '</div>' : '') +
          "<p class='muted'>" +
          escapeHtml(formatEventWhen(ev.startsAt, ev.endsAt)) +
          " · " +
          escapeHtml(ev.location) +
          "</p>" +
          "<p>" + statsLine + "</p>" +
          "<p>" +
          escapeHtml(ev.description || "") +
          "</p>" +
          "<section class='card'><h3>Attend</h3><div class='row'>" +
          '<button type="button" class="btn-primary" data-native-register="' +
          escapeHtml(ev.id) +
          '">Register</button>' +
          '<button type="button" class="btn-ghost" data-interest="' +
          escapeHtml(ev.id) +
          '">Interested</button>' +
          "</div>" +
          "<p class='muted guide-help-link'><a href='#/about?guide=attend'>How do Register, Interested, and RSVP work?</a></p>" +
          "<div id='event-rsvp-panel' class='rsvp-panel'>" +
          "<p class='muted'>RSVP loading…</p>" +
          "</div></section>" +
          websiteLink +
          "<section class='card'><h3>Share this event</h3><div class='row'>" +
          "<a class='btn-ghost' href='" + escapeHtml(shareX) + "' target='_blank' rel='noopener'>X</a>" +
          "<a class='btn-ghost' href='" + escapeHtml(shareLinkedin) + "' target='_blank' rel='noopener'>LinkedIn</a>" +
          "<a class='btn-ghost' href='" + escapeHtml(shareFacebook) + "' target='_blank' rel='noopener'>Facebook</a>" +
          "<a class='btn-ghost' href='" + escapeHtml(shareWhatsapp) + "' target='_blank' rel='noopener'>WhatsApp</a>" +
          "<a class='btn-ghost' href='" + escapeHtml(shareEmail) + "'>Email</a>" +
          "<button type='button' class='btn-ghost' id='event-native-share'>Share…</button>" +
          "<button type='button' class='btn-primary' id='event-copy-share'>Copy event link</button>" +
          "</div><div class='row'>" +
          "<a class='btn-ghost' href='/api/events/" + escapeHtml(ev.id) + "/ics.ics'>Apple / ICS</a>" +
          "<a class='btn-ghost' href='" + escapeHtml(gcal) + "' target='_blank' rel='noopener'>Google Calendar</a>" +
          "<a class='btn-ghost' href='" + escapeHtml(outlookWeb) + "' target='_blank' rel='noopener'>Outlook</a>" +
          "</div></section>" +
          "<section class='card'><h3>Agenda</h3>" +
          agendaHtml +
          "</section>" +
          '<p><a href="#/">← Back</a></p>'
      );
      var copyBtn = $("#event-copy-share");
      if (copyBtn) {
        copyBtn.addEventListener("click", function () {
          var done = function () {
            toast("Event link copied.", "success");
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(eventUrl).then(done).catch(function () {
              toast("Could not copy automatically. Please copy from the address bar.", "info");
            });
            return;
          }
          toast("Clipboard is not available in this browser.", "info");
        });
      }
      var nativeShareBtn = $("#event-native-share");
      if (nativeShareBtn) {
        nativeShareBtn.addEventListener("click", function () {
          if (!navigator.share) {
            toast("Native share is not available in this browser.", "info");
            return;
          }
          navigator.share({
            title: ev.title || "Event",
            text: shareText,
            url: eventUrl,
          }).catch(function () {});
        });
      }

      function renderRsvpPanel(data) {
        var panel = $("#event-rsvp-panel");
        if (!panel) return;
        var summary = (data && data.summary) || {};
        var mine = data && data.mine ? data.mine.status : "";
        panel.innerHTML =
          "<div class='row'>" +
          "<button type='button' class='btn-ghost" + (mine === "going" ? " active" : "") + "' data-rsvp='going'>Going</button>" +
          "<button type='button' class='btn-ghost" + (mine === "maybe" ? " active" : "") + "' data-rsvp='maybe'>Maybe</button>" +
          "<button type='button' class='btn-ghost" + (mine === "not_going" ? " active" : "") + "' data-rsvp='not_going'>Not going</button>" +
          "</div>" +
          "<p class='muted'>Going " + String(summary.going || 0) +
          " · Maybe " + String(summary.maybe || 0) +
          " · Not going " + String(summary.not_going || 0) +
          "</p>";
      }

      function loadRsvpPanel() {
        return api("/api/events/" + encodeURIComponent(ev.id) + "/rsvp")
          .then(renderRsvpPanel)
          .catch(function () {
            var panel = $("#event-rsvp-panel");
            if (panel) panel.innerHTML = "<p class='muted'>RSVP is unavailable right now.</p>";
          });
      }

      loadRsvpPanel();
      var rsvpPanel = $("#event-rsvp-panel");
      if (rsvpPanel) {
        rsvpPanel.addEventListener("click", function (e) {
          var t = e.target;
          if (!(t instanceof HTMLElement)) return;
          var status = t.getAttribute("data-rsvp");
          if (!status) return;
          if (!state.user) {
            openLoginModal(function () { loadRsvpPanel(); });
            return;
          }
          api("/api/events/" + encodeURIComponent(ev.id) + "/rsvp", {
            method: "POST",
            body: JSON.stringify({ status: status }),
          })
            .then(function () {
              toast("RSVP updated.", "success");
              loadRsvpPanel();
            })
            .catch(function (err) {
              toast(friendlyError(err, "Could not update RSVP."), "error");
            });
        });
      }
    });
  }

  /** Organize hub. Routes to one of three views depending on the user's org-request status. */
  function renderOrganize() {
    if (!state.user) {
      setFlash("Sign in to apply as an organizer.", "error");
      return Promise.resolve(renderHome());
    }
    layout(
      "<h2>Organize</h2>" +
        "<p class='muted'>Loading your organizer status…</p>"
    );
    return Promise.all([
      api("/api/org-requests/me").catch(function () { return { request: null }; }),
      api("/api/me/organizations").catch(function () { return { items: [] }; }),
    ]).then(function (results) {
      var lastReq = results[0] && results[0].request;
      var approvedOrgs = (results[1].items || []).filter(function (o) {
        return o.vettingStatus === "APPROVED";
      });
      if (approvedOrgs.length > 0) {
        return renderOrganizerWorkspace(approvedOrgs);
      }
      if (lastReq && lastReq.status === "PENDING") {
        return renderOrgRequestStatus(lastReq, "pending");
      }
      if (lastReq && lastReq.status === "INFO_REQUESTED") {
        return renderOrgRequestStatus(lastReq, "info");
      }
      // Rejected, expired, or never applied — let them start (or restart) the flow.
      return renderBecomeOrganizer(lastReq);
    });
  }

  /** Status banner for users with a request already in flight.
   * When kind === "info", show an editable form to resubmit.
   */
  function renderOrgRequestStatus(req, kind) {
    var heading =
      kind === "pending"
        ? "Application under review"
        : "More information requested";
    var lead =
      kind === "pending"
        ? "Your organization application is queued for the EventMark admin. You will receive an email when a decision is made."
        : "The EventMark admin has asked for more information. Please review the note below, update your application, and resubmit.";
    var noteText = (req && (req.latestNote || (req.decision && req.decision.note))) || "";
    var note = noteText
      ? "<blockquote class='muted'>" + escapeHtml(noteText) + "</blockquote>"
      : "";

    // For INFO_REQUESTED status, show editable form
    if (kind === "info") {
      return renderOrgRequestEditForm(req, heading, lead, note);
    }

    // For PENDING status, show read-only status
    layout(
      "<h2>Organize</h2>" +
        "<section class='card'><h3>" +
        escapeHtml(heading) +
        "</h3>" +
        "<p>" +
        escapeHtml(lead) +
        "</p>" +
        note +
        "<p class='muted'>Submitted on " +
        escapeHtml(formatEventDateTime(req.createdAt)) +
        ".</p></section>"
    );
  }

  /** Editable form for resubmitting org request when more info is requested. */
  function renderOrgRequestEditForm(req, heading, lead, note) {
    var token = { value: "" };
    var ACT = [
      ["serving_people", "Serving people"],
      ["opensource", "Opensource"],
      ["funsource", "Funsource"],
      ["profitable", "Profitable"],
      ["non_profitable", "Non-profitable"],
    ];

    // Pre-fill existing data
    var existingActivities = req.activities || [];
    var existingDirectors = req.directors || [];
    var existingMode = req.eventMode || "in_person";
    var existingVoxon = req.voxonAffiliated || false;

    var actHtml = ACT.map(function (a) {
      var checked = existingActivities.indexOf(a[0]) >= 0 ? " checked" : "";
      return (
        "<label class='checkbox'><input type='checkbox' name='org-activity' value='" +
        a[0] +
        "'" + checked + " /> " +
        escapeHtml(a[1]) +
        "</label>"
      );
    }).join("");

    // Build director rows from existing data
    var directorsHtml = existingDirectors.map(function (d, idx) {
      return (
        "<div class='director-row'>" +
        "<div class='field'><label>Name</label><input class='dir-name' value='" + escapeHtml(d.name || "") + "' /></div>" +
        "<div class='field'><label>Link</label><input class='dir-link' value='" + escapeHtml(d.url || d.link || "") + "' /></div>" +
        (idx > 0 ? "<button type='button' data-remove-director='1' class='btn-ghost'>Remove</button>" : "") +
        "</div>"
      );
    }).join("");
    if (directorsHtml === "") {
      directorsHtml = "<div class='director-row'><div class='field'><label>Name</label><input class='dir-name' /></div><div class='field'><label>Link</label><input class='dir-link' /></div></div>";
    }

    // Event mode checkboxes
    var modeInPerson = existingMode === "in_person" || existingMode === "hybrid" ? " checked" : "";
    var modeOnline = existingMode === "online" || existingMode === "hybrid" ? " checked" : "";

    // Voxon radio
    var voxonYes = existingVoxon ? " checked" : "";
    var voxonNo = !existingVoxon ? " checked" : "";

    layout(
      "<h2>Organize</h2>" +
        "<section class='card'><h3>" + escapeHtml(heading) + "</h3>" +
        "<p>" + escapeHtml(lead) + "</p>" + note + "</section>" +
        "<section class='card'><h3>Update your application</h3>" +
        "<p class='muted'>Update any fields below and click <strong>Resubmit application</strong>.</p>" +
        "<div class='field'><label for='of-name'>Organization name</label><input id='of-name' value='" + escapeHtml(req.organizationName || "") + "' /></div>" +
        "<div class='field'><label for='of-web'>Website</label><input id='of-web' value='" + escapeHtml(req.website || "") + "' placeholder='https://example.org' /></div>" +
        "<div class='field'><label for='of-desc'>Description</label><textarea id='of-desc' rows='4'>" + escapeHtml(req.description || "") + "</textarea></div>" +
        "<fieldset class='field'><legend>Activities (pick at least one)</legend>" +
        "<div class='checkbox-grid'>" + actHtml + "</div></fieldset>" +
        "<fieldset class='field'><legend>Director / leadership</legend>" +
        "<p class='muted'>At least one director with a public professional link (LinkedIn, ORCID, GitHub, personal site, etc.).</p>" +
        "<div id='of-directors'>" + directorsHtml + "</div>" +
        "<button type='button' id='of-add-director' class='btn-ghost'>Add another director</button>" +
        "</fieldset>" +
        "<fieldset class='field'><legend>How do you organize events?</legend>" +
        "<label class='checkbox'><input type='checkbox' name='org-mode' value='in_person'" + modeInPerson + " /> In person</label>" +
        "<label class='checkbox'><input type='checkbox' name='org-mode' value='online'" + modeOnline + " /> Online</label>" +
        "<p class='muted'>Tick both if you do both.</p>" +
        "</fieldset>" +
        "<div class='field'><label for='of-motto'>Motto</label><textarea id='of-motto' rows='2'>" + escapeHtml(req.motto || "") + "</textarea></div>" +
        "<fieldset class='field'><legend>Are you part of Voxon.org?</legend>" +
        "<label class='checkbox'><input type='radio' name='org-voxon' value='yes'" + voxonYes + " /> Yes</label>" +
        "<label class='checkbox'><input type='radio' name='org-voxon' value='no'" + voxonNo + " /> No</label>" +
        "</fieldset>" +
        "<div id='ts-orgreq-edit'></div>" +
        "<div class='row'>" +
        "<button type='button' id='of-resubmit' class='btn-primary' disabled>Resubmit application</button>" +
        "</div></section>"
    );

    // Add event listeners
    $("#of-add-director").addEventListener("click", function () {
      var holder = $("#of-directors");
      var row = document.createElement("div");
      row.className = "director-row";
      row.innerHTML =
        "<div class='field'><label>Name</label><input class='dir-name' /></div>" +
        "<div class='field'><label>Link</label><input class='dir-link' /></div>" +
        "<button type='button' data-remove-director='1' class='btn-ghost'>Remove</button>";
      holder.appendChild(row);
    });

    $("#of-directors").addEventListener("click", function (e) {
      var t = e.target;
      if (t instanceof HTMLElement && t.getAttribute("data-remove-director") === "1") {
        var row = t.closest(".director-row");
        if (row && row.parentElement && row.parentElement.children.length > 1) row.remove();
      }
    });

    renderTurnstile("ts-orgreq-edit", token, function (ready) {
      var b = $("#of-resubmit");
      if (b) b.disabled = !ready;
    });

    $("#of-resubmit").addEventListener("click", function () {
      var b = $("#of-resubmit");
      ["of-name", "of-web", "of-desc", "of-motto"].forEach(clearFieldError);

      var name = ($("#of-name").value || "").trim();
      var web = ($("#of-web").value || "").trim();
      var desc = ($("#of-desc").value || "").trim();
      var motto = ($("#of-motto").value || "").trim();

      var activities = Array.prototype.slice
        .call(document.querySelectorAll("input[name='org-activity']:checked"))
        .map(function (n) { return n.value; });

      var modes = Array.prototype.slice
        .call(document.querySelectorAll("input[name='org-mode']:checked"))
        .map(function (n) { return n.value; });

      var directorRows = Array.prototype.slice.call(
        document.querySelectorAll("#of-directors .director-row")
      );
      var directors = directorRows
        .map(function (row) {
          return {
            name: (row.querySelector(".dir-name").value || "").trim(),
            link: (row.querySelector(".dir-link").value || "").trim(),
          };
        })
        .filter(function (d) { return d.name && d.link; });

      var voxonRadio = document.querySelector("input[name='org-voxon']:checked");
      var voxonAffiliated = voxonRadio ? voxonRadio.value === "yes" : false;

      var hasError = false;
      if (!name) { setFieldError("of-name", "Required."); hasError = true; }
      else if (rejectUnsafeText(name)) { setFieldError("of-name", rejectUnsafeText(name)); hasError = true; }
      if (!web) { setFieldError("of-web", "Required — paste your public website URL."); hasError = true; }
      else if (!isSafeHttpUrl(web)) {
        setFieldError("of-web", "Use a valid http(s) URL from your own site. Short links are not allowed.");
        hasError = true;
      }
      if (!desc) { setFieldError("of-desc", "Required — describe what you do."); hasError = true; }
      else if (rejectUnsafeText(desc)) { setFieldError("of-desc", rejectUnsafeText(desc)); hasError = true; }
      if (!motto) { setFieldError("of-motto", "Required — even a short tagline helps."); hasError = true; }
      else if (rejectUnsafeText(motto)) { setFieldError("of-motto", rejectUnsafeText(motto)); hasError = true; }
      if (activities.length === 0) { toast("Pick at least one activity.", "info"); hasError = true; }
      if (modes.length === 0) { toast("Tell us if your events are in-person, online, or both.", "info"); hasError = true; }
      if (directors.length === 0) { toast("Add at least one director with a name and a link.", "info"); hasError = true; }
      directors.forEach(function (d, idx) {
        if (rejectUnsafeText(d.name)) {
          toast("Director name " + (idx + 1) + ": " + rejectUnsafeText(d.name), "info");
          hasError = true;
        }
        if (!isSafeHttpUrl(d.link)) {
          toast("Director link " + (idx + 1) + " must be a valid http(s) URL.", "info");
          hasError = true;
        }
      });
      if (hasError) return;
      if (!token.value) { toast("Finish the security check first.", "info"); return; }

      var eventMode =
        modes.length === 2 ? "hybrid" : modes[0] === "online" ? "online" : "in_person";
      var directorPayload = directors.map(function (d) {
        return { name: d.name, url: d.link };
      });

      beginButtonLoading(b, "Resubmitting…");
      return api("/api/org-requests/" + req.id, {
        method: "PUT",
        body: JSON.stringify({
          organizationName: name,
          website: web,
          description: desc,
          activities: activities,
          directors: directorPayload,
          eventMode: eventMode,
          motto: motto,
          voxonAffiliated: voxonAffiliated,
          turnstileToken: token.value,
        }),
      })
        .then(function () {
          toast("Application resubmitted successfully! It will be reviewed again.", "success");
          route("organize");
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not resubmit."), "error");
        })
        .finally(function () {
          if (b && document.body.contains(b)) endButtonLoading(b, { disabled: false });
        });
    });
  }

  /** Multi-step "Become an organizer" flow: contact gate → 9-digit OTP → full form. */
  function renderBecomeOrganizer(prevReq) {
    var prevNote = (prevReq && (prevReq.latestNote || (prevReq.decision && prevReq.decision.note))) || "";
    var rejectedNote =
      prevReq && prevReq.status === "REJECTED" && prevNote
        ? "<div class='card'><h3>Previous application was not approved</h3>" +
          "<blockquote class='muted'>" +
          escapeHtml(prevNote) +
          "</blockquote>" +
          "<p class='muted'>You can submit a new application below.</p></div>"
        : "";
    layout(
      "<h2>Become an organizer</h2>" +
        "<p class='muted'>Three short steps: a quick check, an email code, then your application. The EventMark admin reviews every request before you can publish events. " +
        "<a href='#/about?guide=organizers'>Read the full organizer guide</a>.</p>" +
        rejectedNote +
        "<ol class='hemw-steps'>" +
        "<li><strong>Step 1</strong> — quick check + send a verification code to your email.</li>" +
        "<li><strong>Step 2</strong> — type the 9-digit code we email you.</li>" +
        "<li><strong>Step 3</strong> — fill in your organization details and submit for review.</li>" +
        "</ol>" +
        "<section id='org-stage' class='card'></section>"
    );
    return showOrgRequestStep1();
  }

  /* Step 1 — Turnstile + send code. */
  function showOrgRequestStep1() {
    var token = { value: "" };
    var emailVal = state.user ? state.user.email : "";
    $("#org-stage").innerHTML =
      "<h3>Step 1 — Quick check</h3>" +
      "<p class='muted'>We will email a 9-digit code to <strong>" +
      escapeHtml(emailVal) +
      "</strong>. Finish the check below, then click <em>Send code</em>.</p>" +
      "<div id='ts-orgreq'></div>" +
      "<div class='row'><button type='button' id='org-send' class='btn-primary' disabled>Send code</button></div>";
    renderTurnstile("ts-orgreq", token, function (ready) {
      var b = $("#org-send");
      if (b) b.disabled = !ready;
    });
    $("#org-send").addEventListener("click", function () {
      var b = $("#org-send");
      if (!token.value) {
        toast("Finish the security check first.", "info");
        return;
      }
      beginButtonLoading(b, "Sending…");
      return api("/api/org-requests/request-otp", {
        method: "POST",
        body: JSON.stringify({ turnstileToken: token.value }),
      })
        .then(function () {
          toast("We emailed a 9-digit code. It expires in 5 minutes.", "success");
          showOrgRequestStep2();
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not send your code."), "error");
        })
        .finally(function () {
          if (b && document.body.contains(b)) endButtonLoading(b, { disabled: false });
        });
    });
  }

  /* Step 2 — verify 9-digit code (with a fresh Turnstile token). */
  function showOrgRequestStep2() {
    var token = { value: "" };
    $("#org-stage").innerHTML =
      "<h3>Step 2 — Verify your email</h3>" +
      "<p class='muted'>Enter the 9-digit code we just emailed you.</p>" +
      "<div class='field'><label for='org-code'>Code</label><input id='org-code' inputmode='numeric' autocomplete='one-time-code' maxlength='9' /></div>" +
      "<div id='ts-orgreq2'></div>" +
      "<div class='row'>" +
      "<button type='button' id='org-back' class='btn-ghost'>Resend code</button>" +
      "<button type='button' id='org-verify' class='btn-primary' disabled>Verify</button>" +
      "</div>";
    renderTurnstile("ts-orgreq2", token, function (ready) {
      var b = $("#org-verify");
      if (b) b.disabled = !ready;
    });
    $("#org-back").addEventListener("click", showOrgRequestStep1);
    $("#org-verify").addEventListener("click", function () {
      var b = $("#org-verify");
      clearFieldError("org-code");
      var code = ($("#org-code").value || "").trim();
      if (!/^\d{9}$/.test(code)) {
        setFieldError("org-code", "Enter the 9-digit code from the email.");
        return;
      }
      if (!token.value) {
        toast("Finish the security check first.", "info");
        return;
      }
      beginButtonLoading(b, "Verifying…");
      return api("/api/org-requests/verify-otp", {
        method: "POST",
        body: JSON.stringify({ code: code, turnstileToken: token.value }),
      })
        .then(function () {
          toast("Verified. Continue with your application.", "success");
          showOrgRequestStep3();
        })
        .catch(function (err) {
          toast(friendlyError(err, "Code did not verify."), "error");
        })
        .finally(function () {
          if (b && document.body.contains(b)) endButtonLoading(b, { disabled: false });
        });
    });
  }

  /* Step 3 — full org application form. */
  function showOrgRequestStep3() {
    var token = { value: "" };
    var ACT = [
      ["serving_people", "Serving people"],
      ["opensource", "Opensource"],
      ["funsource", "Funsource"],
      ["profitable", "Profitable"],
      ["non_profitable", "Non-profitable"],
    ];
    var activeStepTab = "basics";
    var actHtml = ACT.map(function (a) {
      return (
        "<label class='checkbox'><input type='checkbox' name='org-activity' value='" +
        a[0] +
        "' /> " +
        escapeHtml(a[1]) +
        "</label>"
      );
    }).join("");

    $("#org-stage").innerHTML =
      "<h3>Step 3 — Your organization</h3>" +
      "<p class='muted'>The EventMark admin reads every field before approving. Complete each tab in order.</p>" +
      "<div class='org-tabs' role='tablist' aria-label='Organization application tabs'>" +
      "<button type='button' class='org-tab active' data-org-tab='basics' role='tab' aria-selected='true'>1. Basics</button>" +
      "<button type='button' class='org-tab' data-org-tab='directors' role='tab' aria-selected='false'>2. Directors</button>" +
      "<button type='button' class='org-tab' data-org-tab='activities' role='tab' aria-selected='false'>3. Activities</button>" +
      "<button type='button' class='org-tab' data-org-tab='review' role='tab' aria-selected='false'>4. Review</button>" +
      "</div>" +
      "<section class='org-tab-panel active' data-org-panel='basics'>" +
      "<div class='field'><label for='of-name'>Organization/Entity Name</label><input id='of-name' /></div>" +
      "<div class='field'><label for='of-web'>Website or Profile URL</label><input id='of-web' placeholder='https://example.org' /></div>" +
      "<div class='field'><label for='of-desc'>Description</label><textarea id='of-desc' rows='8' placeholder='Minimum " + ORG_DESCRIPTION_MIN_WORDS + " words. Tell us who you are, who you serve, and how you run events.'></textarea><small id='of-desc-meta' class='muted'>0 words (minimum " + ORG_DESCRIPTION_MIN_WORDS + ")</small></div>" +
      "<div class='row'><button type='button' id='of-next-basics' class='btn-primary'>Next: Directors</button></div>" +
      "</section>" +
      "<section class='org-tab-panel' data-org-panel='directors'>" +
      "<fieldset class='field'><legend>Add Director/Leadership/Admin Members</legend>" +
      "<p class='muted'>Add at least one member and mark at least one as verified before continuing.</p>" +
      "<div id='of-directors'></div>" +
      "<button type='button' id='of-add-director' class='btn-ghost'>Add another member</button>" +
      "</fieldset>" +
      "<div class='row'><button type='button' id='of-prev-directors' class='btn-ghost'>Back</button><button type='button' id='of-next-directors' class='btn-primary'>Next: Activities</button></div>" +
      "</section>" +
      "<section class='org-tab-panel' data-org-panel='activities'>" +
      "<fieldset class='field'><legend>Activities (pick at least one)</legend>" +
      "<div class='checkbox-grid'>" + actHtml + "</div></fieldset>" +
      "<fieldset class='field'><legend>How do you organize events?</legend>" +
      "<label class='checkbox'><input type='checkbox' name='org-mode' value='in_person' /> In person</label>" +
      "<label class='checkbox'><input type='checkbox' name='org-mode' value='online' /> Online</label>" +
      "<p class='muted'>Tick both if you do both.</p>" +
      "</fieldset>" +
      "<div class='field'><label for='of-motto'>How do you organize events? (short summary)</label><textarea id='of-motto' rows='2' placeholder='Share your operating model in one short line.'></textarea></div>" +
      "<fieldset class='field'><legend>Are you part of Voxon.org?</legend>" +
      "<label class='checkbox'><input type='radio' name='org-voxon' value='yes' /> Yes</label>" +
      "<label class='checkbox'><input type='radio' name='org-voxon' value='no' checked /> No</label>" +
      "</fieldset>" +
      "<div class='row'><button type='button' id='of-prev-activities' class='btn-ghost'>Back</button><button type='button' id='of-next-activities' class='btn-primary'>Next: Review</button></div>" +
      "</section>" +
      "<section class='org-tab-panel' data-org-panel='review'>" +
      "<h4>Review and submit</h4>" +
      "<div id='of-review' class='muted'>Review details will appear here.</div>" +
      "<div id='ts-orgreq3'></div>" +
      "<div class='row'><button type='button' id='of-prev-review' class='btn-ghost'>Back</button><button type='button' id='of-cancel' class='btn-ghost'>Start over</button><button type='button' id='of-submit' class='btn-primary' disabled>Submit application</button></div>" +
      "</section>";

    function countWords(s) {
      var t = String(s || "").trim();
      if (!t) return 0;
      return t.split(/\s+/).filter(Boolean).length;
    }

    function collectDirectorRows() {
      return Array.prototype.slice.call(
        document.querySelectorAll("#of-directors .director-row")
      );
    }

    function collectDirectors() {
      return collectDirectorRows()
        .map(function (row) {
          return {
            name: (row.querySelector(".dir-name").value || "").trim(),
            link: (row.querySelector(".dir-link").value || "").trim(),
            verified: !!(row.querySelector(".dir-verified") && row.querySelector(".dir-verified").checked),
          };
        })
        .filter(function (d) { return d.name && d.link; });
    }

    function setOrgTab(key) {
      activeStepTab = key;
      Array.prototype.forEach.call(document.querySelectorAll(".org-tab"), function (btn) {
        var on = btn.getAttribute("data-org-tab") === key;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      Array.prototype.forEach.call(document.querySelectorAll(".org-tab-panel"), function (panel) {
        panel.classList.toggle("active", panel.getAttribute("data-org-panel") === key);
      });
      if (key === "review") renderReview();
    }

    function validateBasics() {
      ["of-name", "of-web", "of-desc"].forEach(clearFieldError);
      var name = ($("#of-name").value || "").trim();
      var web = ($("#of-web").value || "").trim();
      var desc = ($("#of-desc").value || "").trim();
      var words = countWords(desc);
      var hasError = false;
      if (!name) { setFieldError("of-name", "Required."); hasError = true; }
      else {
        var nameUnsafe = rejectUnsafeText(name);
        if (nameUnsafe) { setFieldError("of-name", nameUnsafe); hasError = true; }
      }
      if (!web) { setFieldError("of-web", "Required — paste your public website URL."); hasError = true; }
      else if (!isSafeHttpUrl(web)) {
        setFieldError("of-web", "Use a valid http(s) URL from your own site. Short links are not allowed.");
        hasError = true;
      }
      if (!desc) { setFieldError("of-desc", "Required — describe what you do."); hasError = true; }
      else {
        var descUnsafe = rejectUnsafeText(desc);
        if (descUnsafe) { setFieldError("of-desc", descUnsafe); hasError = true; }
      }
      if (words < ORG_DESCRIPTION_MIN_WORDS) { setFieldError("of-desc", "Minimum " + ORG_DESCRIPTION_MIN_WORDS + " words is required."); hasError = true; }
      return !hasError;
    }

    function validateDirectors() {
      var directors = collectDirectors();
      if (directors.length === 0) {
        toast("Add at least one member with name and profile link.", "info");
        return false;
      }
      var i;
      for (i = 0; i < directors.length; i++) {
        var d = directors[i];
        if (rejectUnsafeText(d.name)) {
          toast("Director name " + (i + 1) + ": " + rejectUnsafeText(d.name), "info");
          return false;
        }
        if (!isSafeHttpUrl(d.link)) {
          toast("Director link " + (i + 1) + " must be a valid http(s) URL.", "info");
          return false;
        }
      }
      var verifiedCount = directors.filter(function (d) { return d.verified; }).length;
      if (verifiedCount < 1) {
        toast("Mark at least one member as verified before continuing.", "info");
        return false;
      }
      return true;
    }

    function validateActivities() {
      clearFieldError("of-motto");
      var activities = Array.prototype.slice
        .call(document.querySelectorAll("input[name='org-activity']:checked"))
        .map(function (n) { return n.value; });
      var modes = Array.prototype.slice
        .call(document.querySelectorAll("input[name='org-mode']:checked"))
        .map(function (n) { return n.value; });
      var motto = ($("#of-motto").value || "").trim();
      var ok = true;
      if (activities.length === 0) { toast("Pick at least one activity.", "info"); ok = false; }
      if (modes.length === 0) { toast("Tell us if your events are in-person, online, or both.", "info"); ok = false; }
      if (!motto) { setFieldError("of-motto", "Required — this helps reviewers understand your event model."); ok = false; }
      else if (rejectUnsafeText(motto)) { setFieldError("of-motto", rejectUnsafeText(motto)); ok = false; }
      return ok;
    }

    function renderReview() {
      var review = $("#of-review");
      if (!review) return;
      var name = ($("#of-name").value || "").trim();
      var web = ($("#of-web").value || "").trim();
      var desc = ($("#of-desc").value || "").trim();
      var words = countWords(desc);
      var directors = collectDirectors();
      var activities = Array.prototype.slice
        .call(document.querySelectorAll("input[name='org-activity']:checked"))
        .map(function (n) { return n.value; });
      var modes = Array.prototype.slice
        .call(document.querySelectorAll("input[name='org-mode']:checked"))
        .map(function (n) { return n.value; });
      var voxonRadio = document.querySelector("input[name='org-voxon']:checked");
      var voxonAffiliated = voxonRadio ? voxonRadio.value === "yes" : false;
      review.innerHTML =
        "<p><strong>Organization:</strong> " + escapeHtml(name) + "</p>" +
        "<p><strong>Website:</strong> " + escapeHtml(web) + "</p>" +
        "<p><strong>Description:</strong> " + escapeHtml(words) + " words</p>" +
        "<p><strong>Members:</strong> " + escapeHtml(directors.length) + " (verified: " +
          escapeHtml(directors.filter(function (d) { return d.verified; }).length) + ")</p>" +
        "<p><strong>Activities:</strong> " + escapeHtml(activities.join(", ") || "—") + "</p>" +
        "<p><strong>Modes:</strong> " + escapeHtml(modes.join(", ") || "—") + "</p>" +
        "<p><strong>Part of Voxon.org:</strong> " + (voxonAffiliated ? "Yes" : "No") + "</p>";
    }
    addDirectorRow();


    var descEl = $("#of-desc");
    var descMeta = $("#of-desc-meta");
    if (descEl) {
      descEl.addEventListener("input", function () {
        if (descMeta) {
          var wc = countWords(descEl.value || "");
          descMeta.textContent = String(wc) + " words (minimum " + ORG_DESCRIPTION_MIN_WORDS + ")";
        }
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll(".org-tab"), function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-org-tab");
        if (!key || key === activeStepTab) return;
        if (key === "directors" && !validateBasics()) return;
        if (key === "activities" && (!validateBasics() || !validateDirectors())) return;
        if (key === "review" && (!validateBasics() || !validateDirectors() || !validateActivities())) return;
        setOrgTab(key);
      });
    });
    $("#of-add-director").addEventListener("click", function () { addDirectorRow(); });
    $("#of-directors").addEventListener("click", function (e) {
      var t = e.target;
      if (t instanceof HTMLElement && t.getAttribute("data-remove-director") === "1") {
        var row = t.closest(".director-row");
        if (row && row.parentElement && row.parentElement.children.length > 1) row.remove();
      }
    });
    $("#of-cancel").addEventListener("click", showOrgRequestStep1);

    $("#of-next-basics").addEventListener("click", function () {
      if (!validateBasics()) return;
      setOrgTab("directors");
    });
    $("#of-prev-directors").addEventListener("click", function () { setOrgTab("basics"); });
    $("#of-next-directors").addEventListener("click", function () {
      if (!validateBasics() || !validateDirectors()) return;
      setOrgTab("activities");
    });
    $("#of-prev-activities").addEventListener("click", function () { setOrgTab("directors"); });
    $("#of-next-activities").addEventListener("click", function () {
      if (!validateBasics() || !validateDirectors() || !validateActivities()) return;
      setOrgTab("review");
    });
    $("#of-prev-review").addEventListener("click", function () { setOrgTab("activities"); });

    renderTurnstile("ts-orgreq3", token, function (ready) {
      var b = $("#of-submit");
      if (b) b.disabled = !ready;
    });
    $("#of-submit").addEventListener("click", function () {
      var b = $("#of-submit");
      ["of-name", "of-web", "of-desc", "of-motto"].forEach(clearFieldError);
      var name = ($("#of-name").value || "").trim();
      var web = ($("#of-web").value || "").trim();
      var desc = ($("#of-desc").value || "").trim();
      var motto = ($("#of-motto").value || "").trim();
      var activities = Array.prototype.slice
        .call(document.querySelectorAll("input[name='org-activity']:checked"))
        .map(function (n) { return n.value; });
      var modes = Array.prototype.slice
        .call(document.querySelectorAll("input[name='org-mode']:checked"))
        .map(function (n) { return n.value; });
      var directors = collectDirectors();
      var voxonRadio = document.querySelector("input[name='org-voxon']:checked");
      var voxonAffiliated = voxonRadio ? voxonRadio.value === "yes" : false;
      var hasError = false;
      if (!name) { setFieldError("of-name", "Required."); hasError = true; }
      else if (rejectUnsafeText(name)) { setFieldError("of-name", rejectUnsafeText(name)); hasError = true; }
      if (!web) { setFieldError("of-web", "Required — paste your public website URL."); hasError = true; }
      else if (!isSafeHttpUrl(web)) {
        setFieldError("of-web", "Use a valid http(s) URL from your own site. Short links are not allowed.");
        hasError = true;
      }
      if (!desc) { setFieldError("of-desc", "Required — describe what you do."); hasError = true; }
      else if (rejectUnsafeText(desc)) { setFieldError("of-desc", rejectUnsafeText(desc)); hasError = true; }
      if (countWords(desc) < ORG_DESCRIPTION_MIN_WORDS) { setFieldError("of-desc", "Minimum " + ORG_DESCRIPTION_MIN_WORDS + " words is required."); hasError = true; }
      if (!motto) { setFieldError("of-motto", "Required — even a short tagline helps."); hasError = true; }
      else if (rejectUnsafeText(motto)) { setFieldError("of-motto", rejectUnsafeText(motto)); hasError = true; }
      if (activities.length === 0) { toast("Pick at least one activity.", "info"); hasError = true; }
      if (modes.length === 0) { toast("Tell us if your events are in-person, online, or both.", "info"); hasError = true; }
      if (directors.length === 0) { toast("Add at least one director with a name and a link.", "info"); hasError = true; }
      directors.forEach(function (d, idx) {
        if (rejectUnsafeText(d.name)) {
          toast("Director name " + (idx + 1) + ": " + rejectUnsafeText(d.name), "info");
          hasError = true;
        }
        if (!isSafeHttpUrl(d.link)) {
          toast("Director link " + (idx + 1) + " must be a valid http(s) URL.", "info");
          hasError = true;
        }
      });
      if (directors.filter(function (d) { return d.verified; }).length < 1) {
        toast("Add at least one verified member before submitting.", "info");
        hasError = true;
      }
      if (hasError) return;
      if (!token.value) { toast("Finish the security check first.", "info"); return; }
      // Backend takes a single eventMode + DirectorLink {name, url}; collapse the FE shape.
      var eventMode =
        modes.length === 2 ? "hybrid" : modes[0] === "online" ? "online" : "in_person";
      var directorPayload = directors.map(function (d) {
        return { name: d.name, url: d.link, verified: d.verified };
      });
      beginButtonLoading(b, "Submitting…");
      return api("/api/org-requests", {
        method: "POST",
        body: JSON.stringify({
          organizationName: name,
          website: web,
          description: desc,
          activities: activities,
          directors: directorPayload,
          eventMode: eventMode,
          motto: motto,
          voxonAffiliated: voxonAffiliated,
          turnstileToken: token.value,
        }),
      })
        .then(function () {
          toast("Application submitted. We will email you when the EventMark admin decides.", "success");
          renderOrganize();
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not submit your application."), "error");
        })
        .finally(function () {
          if (b && document.body.contains(b)) endButtonLoading(b, { disabled: false });
        });
    });
  }

  function addDirectorRow() {
    var holder = $("#of-directors");
    if (!holder) return;
    var row = document.createElement("div");
    row.className = "director-row";
    row.innerHTML =
      "<div class='field'><label>Name</label><input class='dir-name' /></div>" +
      "<div class='field'><label>Link (LinkedIn, ORCID, GitHub, personal)</label><input class='dir-link' placeholder='https://www.linkedin.com/in/…' /></div>" +
      "<label class='checkbox'><input type='checkbox' class='dir-verified' /> Verified member</label>" +
      "<div class='row'><button type='button' class='btn-ghost' data-remove-director='1'>Remove</button></div>";
    holder.appendChild(row);
  }

  /** Workspace shown after the user has at least one approved organization. */
  function renderOrganizerWorkspace(approvedOrgs) {
    var orgOptions = approvedOrgs
      .map(function (o) {
        return "<option value='" + escapeHtml(o.id) + "'>" + escapeHtml(o.name) + "</option>";
      })
      .join("");
    layout(
      "<h2>Organize</h2>" +
        "<p class='muted'>Welcome — your organization is approved. Create events as drafts first, publish when ready. " +
        "<a href='#/about?guide=organizers'>Organizer guide</a> · " +
        "<a href='#/about?guide=checkin'>Check-in help</a></p>" +
        "<div id='org-ws-tabs' class='dashboard-tabs' role='tablist' aria-label='Organizer workspace'>" +
        "<button type='button' class='dash-tab active' data-org-ws-tab='create' role='tab' aria-selected='true'>Create Event (Draft)</button>" +
        "<button type='button' class='dash-tab' data-org-ws-tab='events' role='tab' aria-selected='false'>Your Events</button>" +
        "<button type='button' class='dash-tab' data-org-ws-tab='suite' role='tab' aria-selected='false'>Invitation Suite</button>" +
        "<button type='button' class='dash-tab' data-org-ws-tab='checkin-staff' role='tab' aria-selected='false'>Check-in staff</button>" +
        "<button type='button' class='dash-tab' data-org-ws-tab='contributors' role='tab' aria-selected='false'>Contributor requests</button>" +
        "</div>" +
        "<div class='dashboard-panels'>" +
        "<section class='card dashboard-tab-panel active' data-org-ws-panel='create'><h3 id='ev-form-heading'>Create event (draft)</h3>" +
        "<div class='field'><label>Organization</label><select id='ev-org'>" + orgOptions + "</select></div>" +
        "<div class='field'><label for='ev-title'>Title</label><input id='ev-title' maxlength='26' /><small class='muted'>Maximum 26 characters.</small></div>" +
        "<div class='field'><label for='ev-banner'>Event banner (150×150 square, max)</label>" +
        "<input type='file' id='ev-banner' accept='image/jpeg,image/png,image/webp,image/gif' />" +
        "<div id='ev-banner-preview-wrap' class='ev-banner-preview-wrap hidden'>" +
        "<img id='ev-banner-preview' class='ev-banner-preview-img' alt='Banner preview' width='150' height='150' />" +
        "<button type='button' id='ev-banner-clear' class='btn-ghost btn-small'>Remove</button>" +
        "</div>" +
        "<small class='muted'>Square images work best. We center-crop, resize to 150×150 pixels max, and optimize automatically.</small></div>" +
        "<div class='field'><label for='ev-desc'>Description</label><textarea id='ev-desc' rows='3'></textarea><small id='ev-desc-meta' class='muted'>0 / 500 words max. Emojis not allowed.</small></div>" +
        "<div class='field'><label for='ev-loc'>City / venue</label><input id='ev-loc' placeholder='City, venue, or campus' /></div>" +
        "<div class='field' id='ev-country-field'>" +
        "<label for='ev-country-input'>Country</label>" +
        "<div id='ev-country-wrap' class='country-select-wrap'>" +
        "<input id='ev-country-input' type='text' autocomplete='off' placeholder='Search or select country…' aria-autocomplete='list' aria-controls='ev-country-list' />" +
        "<ul id='ev-country-list' class='country-select-list hidden' role='listbox'></ul>" +
        "</div></div>" +
        "<fieldset class='field'><legend>Format</legend>" +
        "<label class='checkbox'><input type='radio' name='ev-mode' value='in_person' checked /> In person</label>" +
        "<label class='checkbox'><input type='radio' name='ev-mode' value='online' /> Online</label>" +
        "<label class='checkbox'><input type='radio' name='ev-mode' value='hybrid' /> Both (hybrid)</label>" +
        "</fieldset>" +
        "<fieldset class='field'><legend>Category</legend>" +
        "<label class='checkbox'><input type='radio' name='ev-category' value='open_source' /> Open Source</label>" +
        "<label class='checkbox'><input type='radio' name='ev-category' value='hybrid' checked /> Hybrid</label>" +
        "</fieldset>" +
        "<div class='field'><label>Online link (only for online / hybrid)</label><input id='ev-online' placeholder='https://meet.example.com/…' /></div>" +
        "<div class='field'><label>Official event website (optional)</label><input id='ev-web' placeholder='https://event.example.com' /></div>" +
        "<div class='row'>" +
        "<div class='field'><label for='ev-start'>Starts</label><input type='datetime-local' id='ev-start' /></div>" +
        "<div class='field'><label for='ev-end'>Ends</label><input type='datetime-local' id='ev-end' /></div>" +
        "</div>" +
        "<small class='muted'>Use the calendar and time picker, or type date/time manually (end must be after start).</small>" +
        "<div class='row'>" +
        "<div class='field'><label for='ev-min'>Min seats</label><input id='ev-min' type='number' min='0' step='1' value='0' /></div>" +
        "<div class='field'><label for='ev-max'>Max seats (0 = unlimited)</label><input id='ev-max' type='number' min='0' step='1' value='0' /></div>" +
        "</div>" +
        "<small class='muted'>Seat counts cannot be negative.</small>" +
        "<fieldset class='field'><legend>Speakers</legend>" +
        "<p class='muted'>Optional — add speaker names with their professional / association link.</p>" +
        "<div id='ev-speakers'></div>" +
        "<button type='button' id='ev-add-speaker' class='btn-ghost'>Add speaker</button>" +
        "</fieldset>" +
        "<div class='field'><label class='checkbox'><input type='checkbox' id='ev-ext' /> Registration handled on another website</label></div>" +
        "<div class='field'><label>External registration URL</label><input id='ev-exturl' /></div>" +
        "<div id='ts-event'></div>" +
        "<div class='row'>" +
        "<button type='button' id='ev-create' class='btn-primary' disabled>Save as draft</button>" +
        "<button type='button' id='ev-cancel-edit' class='btn-ghost' style='display:none'>Cancel edit</button>" +
        "</div>" +
        "</section>" +
        "<section class='card dashboard-tab-panel' data-org-ws-panel='events'><h3>Your events</h3>" +
        "<div id='ev-list' class='muted'>Loading…</div>" +
        "</section>" +
        "<section class='card dashboard-tab-panel' data-org-ws-panel='suite'><h3>Invitation Suite</h3>" +
        "<p class='muted'>Invite guests, track RSVP, issue pass QR tokens, run check-in, and manage speaker/booth/session details.</p>" +
        "<div class='invitation-grid'>" +
        "<div class='field'><label>Event</label><select id='suite-event'></select></div>" +
        "<div id='ts-suite'></div>" +
        "<div class='field'><label>Paste guests (email,name,role)</label><textarea id='suite-guests' rows='5' placeholder='alice@example.com,Alice,vip\nbob@example.com,Bob,attendee'></textarea></div>" +
        "<div class='row'>" +
        "<button type='button' id='suite-import' class='btn-primary'>Import invites</button>" +
        "<button type='button' id='suite-load-invites' class='btn-ghost'>Load invites</button>" +
        "</div>" +
        "<div id='suite-invites' class='muted'>No invite data loaded.</div>" +
        "<hr class='suite-sep' />" +
        "<div class='field'><label>Check-in token (from QR)</label><input id='suite-checkin-token' placeholder='Paste token or scan ticket QR' /></div>" +
        "<button type='button' id='suite-checkin' class='btn-primary'>Check in guest</button>" +
        "<div id='suite-checkin-result' class='muted'></div>" +
        "<div class='suite-scanner card'>" +
        "<h4>Camera QR scanner</h4>" +
        "<p class='muted'>Use device camera to scan ticket or pass QR codes for check-in staff. Camera access is required.</p>" +
        "<div id='suite-scan-permission' class='muted'>Camera permission not requested yet.</div>" +
        "<video id='suite-scan-video' playsinline muted autoplay></video>" +
        "<canvas id='suite-scan-canvas' hidden aria-hidden='true'></canvas>" +
        "<div class='row'>" +
        "<button type='button' id='suite-scan-permission-btn' class='btn-ghost'>Allow camera access</button>" +
        "<button type='button' id='suite-scan-start' class='btn-primary' disabled>Start scanner</button>" +
        "<button type='button' id='suite-scan-stop' class='btn-ghost'>Stop camera</button>" +
        "</div>" +
        "<div id='suite-scan-status' class='muted'>Request camera permission to begin scanning.</div>" +
        "</div>" +
        "<hr class='suite-sep' />" +
        "<div class='suite-campaign card'>" +
        "<h4>Email campaigns</h4>" +
        "<div class='row'>" +
        "<div class='field'><label>Campaign type</label><select id='suite-campaign-type'><option value='invite'>Invite</option><option value='reminder'>Reminder</option><option value='pass'>Pass</option></select></div>" +
        "<div class='field'><label>Audience</label><select id='suite-campaign-audience'><option value='all'>All invites</option><option value='accepted'>Accepted only</option><option value='not_checked_in'>Not checked in</option><option value='checked_in'>Checked in</option><option value='pending_pass'>Accepted without pass</option></select></div>" +
        "</div>" +
        "<button type='button' id='suite-campaign-send' class='btn-primary'>Send campaign</button>" +
        "<div id='suite-campaign-result' class='muted'></div>" +
        "</div>" +
        "<hr class='suite-sep' />" +
        "<div class='suite-analytics card'>" +
        "<h4>Corporate analytics</h4>" +
        "<div class='row'>" +
        "<button type='button' id='suite-analytics-load' class='btn-ghost'>Load analytics</button>" +
        "<button type='button' id='suite-rsvp-reminders' class='btn-ghost'>Send RSVP reminders</button>" +
        "<a id='suite-analytics-csv' class='btn-ghost' href='#' target='_blank' rel='noopener'>Export CSV</a>" +
        "</div>" +
        "<div id='suite-analytics-cards' class='suite-analytics-cards'></div>" +
        "</div>" +
        "<hr class='suite-sep' />" +
        "<div class='suite-three'>" +
        "<div class='card'>" +
        "<h4>Speakers</h4>" +
        "<div class='field'><label>Name</label><input id='suite-sp-name' /></div>" +
        "<div class='field'><label>Topic</label><input id='suite-sp-topic' /></div>" +
        "<div class='field'><label>Stage</label><input id='suite-sp-stage' /></div>" +
        "<div class='row'><input id='suite-sp-start' type='datetime-local' /><input id='suite-sp-end' type='datetime-local' /></div>" +
        "<button type='button' id='suite-sp-add' class='btn-ghost'>Add speaker slot</button>" +
        "<div id='suite-sp-list' class='muted'></div>" +
        "</div>" +
        "<div class='card'>" +
        "<h4>Booths</h4>" +
        "<div class='field'><label>Booth code</label><input id='suite-bo-code' /></div>" +
        "<div class='field'><label>Title</label><input id='suite-bo-title' /></div>" +
        "<div class='field'><label>Owner</label><input id='suite-bo-owner' /></div>" +
        "<div class='field'><label>Location hint</label><input id='suite-bo-loc' /></div>" +
        "<button type='button' id='suite-bo-add' class='btn-ghost'>Add booth</button>" +
        "<div id='suite-bo-list' class='muted'></div>" +
        "</div>" +
        "<div class='card'>" +
        "<h4>Sessions</h4>" +
        "<div class='field'><label>Title</label><input id='suite-se-title' /></div>" +
        "<div class='field'><label>Room</label><input id='suite-se-room' /></div>" +
        "<div class='row'><input id='suite-se-start' type='datetime-local' /><input id='suite-se-end' type='datetime-local' /></div>" +
        "<div class='field'><label>Capacity</label><input id='suite-se-cap' type='number' min='1' value='50' /></div>" +
        "<button type='button' id='suite-se-add' class='btn-ghost'>Add session</button>" +
        "<div id='suite-se-list' class='muted'></div>" +
        "</div>" +
        "</div>" +
        "</div>" +
        "</section>" +
        "<section class='card dashboard-tab-panel' data-org-ws-panel='checkin-staff'><h3>Check-in staff</h3>" +
        "<p class='muted'>Assign door check-in access by email. Staff sign in with OTP and use the Check-in desk in the header — no full organizer access required.</p>" +
        "<div class='field'><label>Organization</label><select id='staff-org'>" + orgOptions + "</select></div>" +
        "<div class='field'><label>Staff email</label><input id='staff-email' type='email' placeholder='staff@example.com' autocomplete='email' /></div>" +
        "<div id='ts-staff'></div>" +
        "<button type='button' id='staff-add' class='btn-primary'>Assign check-in access</button>" +
        "<div id='staff-list' class='muted'>Loading…</div>" +
        "</section>" +
        "<section class='card dashboard-tab-panel' data-org-ws-panel='contributors'><h3>Contributor requests</h3>" +
        "<p class='muted'>Select an event to view and manage contributor requests.</p>" +
        "<div id='rev-event-list'></div>" +
        "<div id='rev-debug-info' style='margin-top:1rem;padding:0.5rem;background:var(--bg-tertiary);border-radius:4px;font-size:0.8rem;display:none;'></div>" +
        "<div id='rev-board' class='kanban'></div>" +
        "</section>" +
        "</div>"
    );
    var orgWsTabs = $("#org-ws-tabs");
    if (orgWsTabs) {
      orgWsTabs.addEventListener("click", function (e) {
        var t = e.target;
        if (!(t instanceof HTMLElement)) return;
        var tabBtn = t.closest("[data-org-ws-tab]");
        if (!tabBtn) return;
        var key = tabBtn.getAttribute("data-org-ws-tab");
        if (!key) return;
        Array.prototype.forEach.call(orgWsTabs.querySelectorAll("[data-org-ws-tab]"), function (btn) {
          var active = btn.getAttribute("data-org-ws-tab") === key;
          btn.classList.toggle("active", active);
          btn.setAttribute("aria-selected", active ? "true" : "false");
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-org-ws-panel]"), function (panel) {
          panel.classList.toggle("active", panel.getAttribute("data-org-ws-panel") === key);
        });
      });
    }
    var token = { value: "" };
    var suiteToken = { value: "" };
    var staffToken = { value: "" };
    var editingEventId = null;
    var editingEventForForm = null;
    renderTurnstile("ts-event", token, function (ready) {
      var b = $("#ev-create");
      if (b) b.disabled = !ready;
    });
    renderTurnstile("ts-suite", suiteToken, function () {});
    renderTurnstile("ts-staff", staffToken, function () {});

    function staffOrgId() {
      var sel = $("#staff-org");
      return sel ? (sel.value || "") : "";
    }

    function loadCheckinStaffList() {
      var orgId = staffOrgId();
      var node = $("#staff-list");
      if (!node) return Promise.resolve();
      if (!orgId) {
        node.textContent = "Select an organization.";
        return Promise.resolve();
      }
      node.textContent = "Loading…";
      return api("/api/organizations/" + encodeURIComponent(orgId) + "/checkin-staff")
        .then(function (data) {
          var items = (data && data.items) || [];
          if (!items.length) {
            node.innerHTML = "<p>No check-in staff assigned yet.</p>";
            return;
          }
          node.innerHTML =
            "<ul class='staff-list'>" +
            items
              .map(function (s) {
                return (
                  "<li class='row staff-row'>" +
                  "<span>" +
                  escapeHtml(s.email) +
                  "</span>" +
                  "<button type='button' class='btn-ghost btn-small' data-staff-remove='" +
                  escapeHtml(s.id) +
                  "'>Remove</button>" +
                  "</li>"
                );
              })
              .join("") +
            "</ul>";
        })
        .catch(function () {
          node.textContent = "Could not load check-in staff.";
        });
    }

    var staffOrgSel = $("#staff-org");
    if (staffOrgSel) {
      staffOrgSel.addEventListener("change", function () {
        loadCheckinStaffList();
      });
    }

    var staffListNode = $("#staff-list");
    if (staffListNode) {
      staffListNode.addEventListener("click", function (e) {
        var t = e.target;
        if (!(t instanceof HTMLElement)) return;
        var staffId = t.getAttribute("data-staff-remove");
        if (!staffId) return;
        var orgId = staffOrgId();
        if (!orgId) return;
        api("/api/organizations/" + encodeURIComponent(orgId) + "/checkin-staff/" + encodeURIComponent(staffId), {
          method: "DELETE",
        })
          .then(function () {
            toast("Check-in access removed.", "success");
            loadCheckinStaffList();
          })
          .catch(function (err) {
            toast(friendlyError(err, "Could not remove staff."), "error");
          });
      });
    }

    var staffAddBtn = $("#staff-add");
    if (staffAddBtn) {
      staffAddBtn.addEventListener("click", function () {
        var orgId = staffOrgId();
        var emailInput = $("#staff-email");
        var email = emailInput ? (emailInput.value || "").trim() : "";
        if (!orgId || !email) {
          toast("Organization and email are required.", "info");
          return;
        }
        if (!staffToken.value) {
          toast("Complete the security check first.", "info");
          return;
        }
        staffAddBtn.disabled = true;
        api("/api/organizations/" + encodeURIComponent(orgId) + "/checkin-staff", {
          method: "POST",
          body: JSON.stringify({ email: email, turnstileToken: staffToken.value }),
        })
          .then(function () {
            toast("Check-in access assigned.", "success");
            if (emailInput) emailInput.value = "";
            loadCheckinStaffList();
          })
          .catch(function (err) {
            toast(friendlyError(err, "Could not assign check-in access."), "error");
          })
          .finally(function () {
            staffAddBtn.disabled = false;
          });
      });
    }

    loadCheckinStaffList();

    var suiteEventsById = {};
    var countrySelect = wireCountrySelect();

    Array.prototype.forEach.call(document.querySelectorAll("input[name='ev-mode']"), function (radio) {
      radio.addEventListener("change", syncEventCountryFieldVisibility);
    });
    syncEventCountryFieldVisibility();

    var evStartInput = $("#ev-start");
    var evEndInput = $("#ev-end");
    if (evStartInput) {
      evStartInput.addEventListener("change", syncEventEndMin);
      evStartInput.addEventListener("input", syncEventEndMin);
    }
    if (evEndInput) {
      evEndInput.addEventListener("change", syncEventEndMin);
    }
    var evDescInput = $("#ev-desc");
    var evDescMeta = $("#ev-desc-meta");
    if (evDescInput && evDescMeta) {
      evDescInput.addEventListener("input", function () {
        evDescMeta.textContent = String(countWords(evDescInput.value || "")) + " / " + EVENT_DESCRIPTION_MAX_WORDS + " words max. Emojis not allowed.";
      });
    }

    function suiteEventId() {
      var sel = $("#suite-event");
      return sel ? (sel.value || "") : "";
    }

    function suiteTurnstileToken() {
      return suiteToken.value || token.value || "";
    }

    function suiteApplyEventDateDefaults() {
      var eid = suiteEventId();
      var ev = suiteEventsById[eid];
      var startVal = ev ? isoToDatetimeLocal(ev.startsAt) : "";
      var endVal = ev ? isoToDatetimeLocal(ev.endsAt) : "";
      var spStart = $("#suite-sp-start");
      var spEnd = $("#suite-sp-end");
      var seStart = $("#suite-se-start");
      var seEnd = $("#suite-se-end");
      if (spStart) spStart.value = startVal;
      if (spEnd) spEnd.value = endVal;
      if (seStart) seStart.value = startVal;
      if (seEnd) seEnd.value = endVal;
    }

    function suiteResetSpeakerForm() {
      var name = $("#suite-sp-name");
      var topic = $("#suite-sp-topic");
      var stage = $("#suite-sp-stage");
      if (name) name.value = "";
      if (topic) topic.value = "";
      if (stage) stage.value = "";
      suiteApplyEventDateDefaults();
    }

    function suiteResetBoothForm() {
      var code = $("#suite-bo-code");
      var title = $("#suite-bo-title");
      var owner = $("#suite-bo-owner");
      var loc = $("#suite-bo-loc");
      if (code) code.value = "";
      if (title) title.value = "";
      if (owner) owner.value = "";
      if (loc) loc.value = "";
    }

    function suiteResetSessionForm() {
      var title = $("#suite-se-title");
      var room = $("#suite-se-room");
      var cap = $("#suite-se-cap");
      if (title) title.value = "";
      if (room) room.value = "";
      if (cap) cap.value = "50";
      suiteApplyEventDateDefaults();
    }

    function refreshSuiteEventSelect() {
      return api("/api/organizer/events")
        .then(function (data) {
          var items = data.items || [];
          suiteEventsById = {};
          items.forEach(function (ev) {
            suiteEventsById[ev.id] = ev;
          });
          var sel = $("#suite-event");
          if (!sel) return;
          if (!items.length) {
            sel.innerHTML = "<option value=''>No events yet</option>";
            return;
          }
          sel.innerHTML = items
            .map(function (ev) {
              return "<option value='" + escapeHtml(ev.id) + "'>" + escapeHtml(ev.title) + "</option>";
            })
            .join("");
          suiteApplyEventDateDefaults();
        })
        .catch(function () {
          var sel = $("#suite-event");
          if (sel) sel.innerHTML = "<option value=''>Could not load events</option>";
        });
    }

    function renderInviteRows(items) {
      var holder = $("#suite-invites");
      if (!holder) return;
      if (!items || !items.length) {
        holder.innerHTML = "<p class='muted'>No invites yet for this event.</p>";
        return;
      }
      holder.innerHTML =
        "<div class='suite-table'>" +
        items
          .map(function (r) {
            var passBtn =
              "<button type='button' class='btn-ghost' data-suite-pass='" +
              escapeHtml(r.id) +
              "'>Issue pass</button>";
            var passMeta = r.passToken
              ? "<small class='muted'>pass ready</small>"
              : "<small class='muted'>no pass</small>";
            return (
              "<article class='suite-row'>" +
              "<div><strong>" +
              escapeHtml(r.name || r.email) +
              "</strong><br/><small class='muted'>" +
              escapeHtml(r.email) +
              " · " +
              escapeHtml(r.role || "attendee") +
              "</small></div>" +
              "<div><span class='pill'>" +
              escapeHtml(r.status || "invited") +
              "</span></div>" +
              "<div class='suite-actions'>" +
              passBtn +
              passMeta +
              "</div>" +
              "</article>"
            );
          })
          .join("") +
        "</div>";
    }

    function loadInvitesForSelectedEvent() {
      var eid = suiteEventId();
      if (!eid) return Promise.resolve();
      return api("/api/events/" + encodeURIComponent(eid) + "/invites")
        .then(function (data) {
          renderInviteRows(data.items || []);
        })
        .catch(function (err) {
          renderInviteRows([]);
          toast(friendlyError(err, "Could not load invites."), "error");
        });
    }

    function loadSuiteModules() {
      var eid = suiteEventId();
      if (!eid) return Promise.resolve();
      return Promise.all([
        api("/api/events/" + encodeURIComponent(eid) + "/speakers").catch(function () {
          return { items: [] };
        }),
        api("/api/events/" + encodeURIComponent(eid) + "/booths").catch(function () {
          return { items: [] };
        }),
        api("/api/events/" + encodeURIComponent(eid) + "/sessions").catch(function () {
          return { items: [] };
        }),
      ]).then(function (all) {
        var sp = all[0].items || [];
        var bo = all[1].items || [];
        var se = all[2].items || [];
        var spNode = $("#suite-sp-list");
        var boNode = $("#suite-bo-list");
        var seNode = $("#suite-se-list");
        if (spNode) {
          spNode.innerHTML = sp.length
            ? sp
                .map(function (x) {
                  return "<div class='suite-mini'>" + escapeHtml(x.name) + " · " + escapeHtml(x.topic) + "</div>";
                })
                .join("")
            : "<div class='muted'>No speaker slots.</div>";
        }
        if (boNode) {
          boNode.innerHTML = bo.length
            ? bo
                .map(function (x) {
                  return "<div class='suite-mini'>" + escapeHtml(x.boothCode) + " · " + escapeHtml(x.title) + "</div>";
                })
                .join("")
            : "<div class='muted'>No booths.</div>";
        }
        if (seNode) {
          seNode.innerHTML = se.length
            ? se
                .map(function (x) {
                  return "<div class='suite-mini'>" + escapeHtml(x.title) + " · " + escapeHtml(x.room) + "</div>";
                })
                .join("")
            : "<div class='muted'>No sessions.</div>";
        }
      });
    }

    function importInvitesFromTextarea() {
      var eid = suiteEventId();
      if (!eid) {
        toast("Choose an event first.", "info");
        return;
      }
      var raw = ($("#suite-guests").value || "").trim();
      if (!raw) {
        toast("Paste guests first.", "info");
        return;
      }
      var guests = raw
        .split(/\r?\n/)
        .map(function (line) {
          var parts = line.split(",");
          return {
            email: (parts[0] || "").trim(),
            name: (parts[1] || "").trim(),
            role: ((parts[2] || "attendee").trim() || "attendee"),
          };
        })
        .filter(function (x) {
          return x.email;
        });
      var ts = suiteTurnstileToken();
      if (!ts) {
        toast("Complete the security check first.", "info");
        return;
      }
      return api("/api/events/" + encodeURIComponent(eid) + "/invites/import", {
        method: "POST",
        body: JSON.stringify({ guests: guests, turnstileToken: ts }),
      })
        .then(function (data) {
          toast("Imported " + String(data.imported || 0) + " invites.", "success");
          loadInvitesForSelectedEvent();
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not import invites."), "error");
        });
    }

    var suiteImportBtn = $("#suite-import");
    if (suiteImportBtn) suiteImportBtn.addEventListener("click", importInvitesFromTextarea);
    var suiteLoadBtn = $("#suite-load-invites");
    if (suiteLoadBtn) suiteLoadBtn.addEventListener("click", loadInvitesForSelectedEvent);
    var suiteEventSel = $("#suite-event");
    if (suiteEventSel) {
      suiteEventSel.addEventListener("change", function () {
        suiteApplyEventDateDefaults();
        loadInvitesForSelectedEvent();
        loadSuiteModules();
        suiteLoadAnalytics();
      });
    }

    var suiteInvitesNode = $("#suite-invites");
    if (suiteInvitesNode) {
      suiteInvitesNode.addEventListener("click", function (e) {
        var t = e.target;
        if (!(t instanceof HTMLElement)) return;
        var inviteId = t.getAttribute("data-suite-pass");
        if (!inviteId) return;
        var ts = suiteTurnstileToken();
        if (!ts) {
          toast("Complete the security check first.", "info");
          return;
        }
        api("/api/invites/" + encodeURIComponent(inviteId) + "/issue-pass", {
          method: "POST",
          body: JSON.stringify({ turnstileToken: ts }),
        })
          .then(function (data) {
            var passToken = data && data.pass && data.pass.token ? data.pass.token : "";
            if (passToken) {
              toast("Pass issued. Token copied for QR generation.", "success");
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(passToken).catch(function () {});
              }
            }
            loadInvitesForSelectedEvent();
          })
          .catch(function (err) {
            toast(friendlyError(err, "Could not issue pass."), "error");
          });
      });
    }

    function suiteRunCheckin(scannedToken, fromScanner) {
      var eid = suiteEventId();
      var tokenInput = (scannedToken || ($("#suite-checkin-token").value || "")).trim();
      var ts = suiteTurnstileToken();
      if (!eid || !tokenInput) {
        toast("Event and token are required.", "info");
        return Promise.resolve();
      }
      if (!ts) {
        toast("Complete the security check first.", "info");
        return Promise.resolve();
      }
      return api("/api/checkin/scan", {
        method: "POST",
        body: JSON.stringify({ eventId: eid, token: tokenInput, turnstileToken: ts }),
      })
        .then(function (data) {
          var node = $("#suite-checkin-result");
          if (node) {
            var guestName = "guest";
            if (data && data.type === "ticket" && data.attendee) {
              guestName = data.attendee.name || data.attendee.email || "guest";
            } else if (data && data.invite) {
              guestName = data.invite.name || data.invite.email || "guest";
            }
            node.innerHTML = "Checked in: <strong>" + escapeHtml(guestName) + "</strong>";
          }
          if (!fromScanner) {
            toast("Check-in successful.", "success");
          }
          loadInvitesForSelectedEvent();
        })
        .catch(function (err) {
          if (fromScanner && err && err.data && err.data.error === "already_checked_recently") {
            return;
          }
          toast(friendlyError(err, "Check-in failed."), "error");
        });
    }

    var suiteCheckinBtn = $("#suite-checkin");
    if (suiteCheckinBtn) {
      suiteCheckinBtn.addEventListener("click", function () {
        suiteRunCheckin();
      });
    }

    var scannerState = {
      stream: null,
      timer: 0,
      running: false,
      busy: false,
      detector: null,
      canvas: null,
      ctx: null,
      lastToken: "",
      lastTokenAt: 0,
    };

    function suiteEnsureJsQr() {
      if (window.jsQR) return Promise.resolve(true);
      return new Promise(function (resolve, reject) {
        var existing = document.getElementById("jsqr-script");
        if (existing) {
          existing.addEventListener("load", function () {
            resolve(!!window.jsQR);
          });
          existing.addEventListener("error", function () {
            reject(new Error("jsqr_load_failed"));
          });
          return;
        }
        var s = document.createElement("script");
        s.id = "jsqr-script";
        s.src = "/assets/jsqr.js";
        s.async = true;
        s.onload = function () {
          resolve(!!window.jsQR);
        };
        s.onerror = function () {
          reject(new Error("jsqr_load_failed"));
        };
        document.head.appendChild(s);
      });
    }

    function suiteIsEventMarkHost(hostname) {
      if (!hostname) return false;
      var h = String(hostname).toLowerCase();
      if (h === String(window.location.hostname || "").toLowerCase()) return true;
      if (h === "eventmark.org" || h === "www.eventmark.org") return true;
      if (h.slice(-13) === ".eventmark.org") return true;
      if (h.indexOf("eventmark.randomflux.online") >= 0) return true;
      return false;
    }

    function suiteExtractCheckinToken(raw) {
      var s = (raw || "").trim();
      if (!s) return "";
      if (s.indexOf("http://") === 0 || s.indexOf("https://") === 0) {
        try {
          var u = new URL(s);
          if (!suiteIsEventMarkHost(u.hostname)) return "";
          var token = u.searchParams.get("token");
          if (token) return token;
          if (u.hash) {
            var hashPart = u.hash.replace(/^#/, "");
            var qIdx = hashPart.indexOf("?");
            if (hashPart.split("?")[0].replace(/^\//, "") === "checkin" && qIdx >= 0) {
              var params = new URLSearchParams(hashPart.slice(qIdx + 1));
              token = params.get("token");
              if (token) return token;
            }
          }
        } catch (e) {
          return "";
        }
        return "";
      }
      return s;
    }

    function suiteHandleScannedToken(raw) {
      if (!raw) return;
      var token = suiteExtractCheckinToken(raw);
      if (!token) {
        suiteSetScanStatus("QR must link to EventMark check-in.");
        return;
      }
      var now = Date.now();
      if (scannerState.lastToken === token && now - scannerState.lastTokenAt < 1500) {
        return;
      }
      scannerState.lastToken = token;
      scannerState.lastTokenAt = now;
      var tokenInput = $("#suite-checkin-token");
      if (tokenInput) tokenInput.value = token;
      suiteSetScanStatus("Token scanned. Checking in…");
      suiteRunCheckin(token, true).then(function () {
        suiteSetScanStatus("Scan next QR code.");
      });
    }

    function suiteDetectFromVideo(video) {
      if (scannerState.detector) {
        return scannerState.detector.detect(video);
      }
      if (window.jsQR && scannerState.canvas && scannerState.ctx) {
        if (video.readyState < video.HAVE_ENOUGH_DATA) return Promise.resolve([]);
        var w = video.videoWidth;
        var h = video.videoHeight;
        if (!w || !h) return Promise.resolve([]);
        scannerState.canvas.width = w;
        scannerState.canvas.height = h;
        scannerState.ctx.drawImage(video, 0, 0, w, h);
        var imageData = scannerState.ctx.getImageData(0, 0, w, h);
        var code = window.jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) return Promise.resolve([{ rawValue: code.data }]);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }

    function suiteBeginScanLoop(video) {
      scannerState.running = true;
      scannerState.timer = setInterval(function () {
        if (!scannerState.running || scannerState.busy || !video) return;
        if (!scannerState.detector && !window.jsQR) return;
        scannerState.busy = true;
        suiteDetectFromVideo(video)
          .then(function (codes) {
            if (!codes || !codes.length) return;
            var raw = codes[0] && (codes[0].rawValue || "");
            suiteHandleScannedToken(raw);
          })
          .catch(function () {})
          .finally(function () {
            scannerState.busy = false;
          });
      }, 250);
    }

    function suiteOpenCameraStream() {
      var video = $("#suite-scan-video");
      if (!video) return Promise.resolve();
      var canvas = $("#suite-scan-canvas");
      if (canvas) {
        scannerState.canvas = canvas;
        scannerState.ctx = canvas.getContext("2d", { willReadFrequently: true });
      }
      suiteSetScanStatus("Starting camera…");
      return navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "environment" } })
        .then(function (stream) {
          suiteSetPermission("Camera permission granted.", "permission-granted");
          suiteSetScanButtons(true);
          scannerState.stream = stream;
          video.srcObject = stream;
          return video.play().catch(function () {});
        })
        .then(function () {
          suiteSetScanStatus("Camera live. Point to QR code.");
          suiteBeginScanLoop(video);
        });
    }

    function suiteSetPermission(msg, kind) {
      var node = $("#suite-scan-permission");
      if (!node) return;
      node.textContent = msg;
      node.classList.remove("permission-granted", "permission-denied");
      if (kind) node.classList.add(kind);
    }

    function suiteSetScanButtons(hasPermission) {
      var startBtn = $("#suite-scan-start");
      var permBtn = $("#suite-scan-permission-btn");
      if (startBtn) startBtn.disabled = !hasPermission;
      if (permBtn) permBtn.textContent = hasPermission ? "Camera allowed" : "Allow camera access";
    }

    function suiteCameraErrorMessage(err) {
      if (!err) return "Could not access camera.";
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        return "Camera permission denied. Enable camera access in your browser settings, then try again.";
      }
      if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        return "No camera found on this device.";
      }
      if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        return "Camera is in use by another app. Close it and try again.";
      }
      return "Could not access camera. Check browser permission settings.";
    }

    function suiteQueryCameraPermission() {
      if (!navigator.permissions || !navigator.permissions.query) {
        return Promise.resolve(null);
      }
      return navigator.permissions
        .query({ name: "camera" })
        .then(function (status) {
          if (status.state === "granted") {
            suiteSetPermission("Camera permission granted.", "permission-granted");
            suiteSetScanButtons(true);
            suiteSetScanStatus("Ready to start scanner.");
          } else if (status.state === "denied") {
            suiteSetPermission("Camera permission blocked.", "permission-denied");
            suiteSetScanButtons(false);
            suiteSetScanStatus("Enable camera in browser settings, then click Allow camera access.");
          } else {
            suiteSetPermission("Camera permission not requested yet.");
            suiteSetScanButtons(false);
          }
          status.onchange = function () {
            suiteQueryCameraPermission();
          };
          return status.state;
        })
        .catch(function () {
          return null;
        });
    }

    function suiteRequestCameraPermission() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        suiteSetPermission("Camera API is not available in this browser.", "permission-denied");
        suiteSetScanStatus("Paste the token manually instead.");
        return Promise.resolve(false);
      }
      suiteSetScanStatus("Requesting camera permission…");
      return navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "environment" } })
        .then(function (stream) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          suiteSetPermission("Camera permission granted.", "permission-granted");
          suiteSetScanButtons(true);
          suiteSetScanStatus("Permission granted. Click Start scanner.");
          return true;
        })
        .catch(function (err) {
          var msg = suiteCameraErrorMessage(err);
          suiteSetPermission(msg, "permission-denied");
          suiteSetScanButtons(false);
          suiteSetScanStatus(msg);
          return false;
        });
    }

    function suiteSetScanStatus(msg) {
      var node = $("#suite-scan-status");
      if (node) node.textContent = msg;
    }

    function suiteStopScanner() {
      if (scannerState.timer) {
        clearInterval(scannerState.timer);
        scannerState.timer = 0;
      }
      if (scannerState.stream) {
        scannerState.stream.getTracks().forEach(function (t) { t.stop(); });
        scannerState.stream = null;
      }
      var video = $("#suite-scan-video");
      if (video) {
        video.srcObject = null;
      }
      scannerState.running = false;
      suiteSetScanStatus("Scanner stopped.");
    }

    function suiteStartScanner() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        suiteSetScanStatus("Camera API is not available in this browser.");
        return;
      }
      if (scannerState.running) return;

      function startWithDetector(useNativeDetector) {
        scannerState.detector = null;
        if (useNativeDetector && "BarcodeDetector" in window) {
          scannerState.detector = new window.BarcodeDetector({ formats: ["qr_code"] });
          return suiteOpenCameraStream();
        }
        suiteSetScanStatus("Loading QR decoder…");
        return suiteEnsureJsQr()
          .then(function () {
            return suiteOpenCameraStream();
          })
          .catch(function () {
            suiteSetScanStatus("Could not load QR decoder. Paste token manually.");
          });
      }

      startWithDetector(true).catch(function (err) {
        var msg = suiteCameraErrorMessage(err);
        suiteSetPermission(msg, "permission-denied");
        suiteSetScanButtons(false);
        suiteSetScanStatus(msg);
      });
    }

    suiteQueryCameraPermission();
    var suitePermBtn = $("#suite-scan-permission-btn");
    if (suitePermBtn) suitePermBtn.addEventListener("click", suiteRequestCameraPermission);
    var suiteScanStart = $("#suite-scan-start");
    if (suiteScanStart) suiteScanStart.addEventListener("click", suiteStartScanner);
    var suiteScanStop = $("#suite-scan-stop");
    if (suiteScanStop) suiteScanStop.addEventListener("click", suiteStopScanner);

    function suiteLoadAnalytics() {
      var eid = suiteEventId();
      if (!eid) return;
      var cards = $("#suite-analytics-cards");
      if (cards) cards.innerHTML = "<p class='muted'>Loading analytics…</p>";
      var csv = $("#suite-analytics-csv");
      if (csv) csv.href = "/api/events/" + encodeURIComponent(eid) + "/analytics?format=csv";
      return Promise.all([
        api("/api/events/" + encodeURIComponent(eid) + "/analytics"),
        api("/api/events/" + encodeURIComponent(eid) + "/rsvp").catch(function () { return null; }),
      ])
        .then(function (all) {
          var data = all[0] || {};
          var rsvp = all[1] || {};
          if (!cards) return;
          var m = data.metrics || {};
          var rs = rsvp.summary || {};
          cards.innerHTML =
            "<div class='suite-stat'><small>Views</small><strong>" + escapeHtml(m.views || 0) + "</strong></div>" +
            "<div class='suite-stat'><small>Interested</small><strong>" + escapeHtml(m.interested || 0) + "</strong></div>" +
            "<div class='suite-stat'><small>Registered</small><strong>" + escapeHtml(m.registered || 0) + "</strong></div>" +
            "<div class='suite-stat'><small>Waitlist</small><strong>" + escapeHtml(m.waitlist_total || 0) + "</strong></div>" +
            "<div class='suite-stat'><small>RSVP Going</small><strong>" + escapeHtml(rs.going || 0) + "</strong></div>" +
            "<div class='suite-stat'><small>RSVP Maybe</small><strong>" + escapeHtml(rs.maybe || 0) + "</strong></div>" +
            "<div class='suite-stat'><small>Invites</small><strong>" + escapeHtml(m.invites_total || 0) + "</strong></div>" +
            "<div class='suite-stat'><small>Check-ins</small><strong>" + escapeHtml(m.checkins_total || 0) + "</strong></div>";
        })
        .catch(function (err) {
          if (cards) cards.innerHTML = "<p class='muted'>Could not load analytics.</p>";
          toast(friendlyError(err, "Could not load analytics."), "error");
        });
    }

    var suiteAnalyticsLoad = $("#suite-analytics-load");
    if (suiteAnalyticsLoad) {
      suiteAnalyticsLoad.addEventListener("click", suiteLoadAnalytics);
    }

    var suiteRsvpReminders = $("#suite-rsvp-reminders");
    if (suiteRsvpReminders) {
      suiteRsvpReminders.addEventListener("click", function () {
        var eid = suiteEventId();
        var ts = suiteTurnstileToken();
        if (!eid) return toast("Choose an event first.", "info");
        if (!ts) return toast("Complete the security check first.", "info");
        beginButtonLoading(suiteRsvpReminders, "Sending…");
        api("/api/events/" + encodeURIComponent(eid) + "/rsvp/reminders", {
          method: "POST",
          body: JSON.stringify({ turnstileToken: ts }),
        })
          .then(function (res) {
            toast(
              "RSVP reminders sent: " + String(res.sent || 0) + " (failed " + String(res.failed || 0) + ")",
              "success"
            );
          })
          .catch(function (err) {
            toast(friendlyError(err, "Could not send RSVP reminders."), "error");
          })
          .finally(function () {
            if (suiteRsvpReminders && document.body.contains(suiteRsvpReminders)) {
              endButtonLoading(suiteRsvpReminders, { disabled: false });
            }
          });
      });
    }

    var suiteCampaignSend = $("#suite-campaign-send");
    if (suiteCampaignSend) {
      suiteCampaignSend.addEventListener("click", function () {
        var eid = suiteEventId();
        if (!eid) return toast("Choose an event first.", "info");
        var ts = suiteTurnstileToken();
        if (!ts) return toast("Complete the security check first.", "info");
        var typeSel = $("#suite-campaign-type");
        var audSel = $("#suite-campaign-audience");
        var campaignType = typeSel ? typeSel.value : "invite";
        var audience = audSel ? audSel.value : "all";
        beginButtonLoading(suiteCampaignSend, "Sending…");
        api("/api/events/" + encodeURIComponent(eid) + "/campaign/send", {
          method: "POST",
          body: JSON.stringify({
            campaignType: campaignType,
            audience: audience,
            turnstileToken: ts,
          }),
        })
          .then(function (res) {
            var node = $("#suite-campaign-result");
            if (node) {
              node.textContent =
                "Sent: " + String(res.sent || 0) +
                " | Failed: " + String(res.failed || 0) +
                " | Skipped: " + String(res.skipped || 0);
            }
            toast("Campaign completed.", "success");
          })
          .catch(function (err) {
            toast(friendlyError(err, "Could not send campaign."), "error");
          })
          .finally(function () {
            if (suiteCampaignSend && document.body.contains(suiteCampaignSend)) {
              endButtonLoading(suiteCampaignSend, { disabled: false });
            }
          });
      });
    }

    function suiteAddSpeaker() {
      var eid = suiteEventId();
      if (!eid) return toast("Choose an event first.", "info");
      var ts = suiteTurnstileToken();
      if (!ts) return toast("Complete the security check first.", "info");
      var name = ($("#suite-sp-name").value || "").trim();
      var topic = ($("#suite-sp-topic").value || "").trim();
      var stage = ($("#suite-sp-stage").value || "").trim();
      if (!name || !topic || !stage) return toast("Fill in name, topic, and stage.", "info");
      var sStartRaw = ($("#suite-sp-start").value || "").trim();
      var sEndRaw = ($("#suite-sp-end").value || "").trim();
      if (!sStartRaw || !sEndRaw) return toast("Speaker slot needs start and end time.", "info");
      var sStart = new Date(sStartRaw);
      var sEnd = new Date(sEndRaw);
      if (isNaN(sStart.getTime()) || isNaN(sEnd.getTime())) return toast("Invalid speaker slot time.", "error");
      return api("/api/events/" + encodeURIComponent(eid) + "/speakers", {
        method: "POST",
        body: JSON.stringify({
          name: name,
          topic: topic,
          stage: stage,
          startsAt: sStart.toISOString(),
          endsAt: sEnd.toISOString(),
          turnstileToken: ts,
        }),
      })
        .then(function () {
          suiteResetSpeakerForm();
          loadSuiteModules();
          toast("Speaker slot added.", "success");
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not add speaker slot."), "error");
        });
    }

    function suiteAddBooth() {
      var eid = suiteEventId();
      if (!eid) return toast("Choose an event first.", "info");
      var ts = suiteTurnstileToken();
      if (!ts) return toast("Complete the security check first.", "info");
      var boothCode = ($("#suite-bo-code").value || "").trim();
      var title = ($("#suite-bo-title").value || "").trim();
      var owner = ($("#suite-bo-owner").value || "").trim();
      if (!boothCode || !title || !owner) return toast("Fill in booth code, title, and owner.", "info");
      return api("/api/events/" + encodeURIComponent(eid) + "/booths", {
        method: "POST",
        body: JSON.stringify({
          boothCode: boothCode,
          title: title,
          owner: owner,
          locationHint: ($("#suite-bo-loc").value || "").trim(),
          turnstileToken: ts,
        }),
      })
        .then(function () {
          suiteResetBoothForm();
          loadSuiteModules();
          toast("Booth added.", "success");
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not add booth."), "error");
        });
    }

    function suiteAddSession() {
      var eid = suiteEventId();
      if (!eid) return toast("Choose an event first.", "info");
      var ts = suiteTurnstileToken();
      if (!ts) return toast("Complete the security check first.", "info");
      var title = ($("#suite-se-title").value || "").trim();
      var room = ($("#suite-se-room").value || "").trim();
      if (!title || !room) return toast("Fill in session title and room.", "info");
      var seStartRaw = ($("#suite-se-start").value || "").trim();
      var seEndRaw = ($("#suite-se-end").value || "").trim();
      if (!seStartRaw || !seEndRaw) return toast("Session needs start and end time.", "info");
      var seStart = new Date(seStartRaw);
      var seEnd = new Date(seEndRaw);
      if (isNaN(seStart.getTime()) || isNaN(seEnd.getTime())) return toast("Invalid session time.", "error");
      return api("/api/events/" + encodeURIComponent(eid) + "/sessions", {
        method: "POST",
        body: JSON.stringify({
          title: title,
          room: room,
          startsAt: seStart.toISOString(),
          endsAt: seEnd.toISOString(),
          capacity: Number($("#suite-se-cap").value || 1),
          turnstileToken: ts,
        }),
      })
        .then(function () {
          suiteResetSessionForm();
          loadSuiteModules();
          toast("Session added.", "success");
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not add session."), "error");
        });
    }

    var suiteSpAdd = $("#suite-sp-add");
    if (suiteSpAdd) suiteSpAdd.addEventListener("click", suiteAddSpeaker);
    var suiteBoAdd = $("#suite-bo-add");
    if (suiteBoAdd) suiteBoAdd.addEventListener("click", suiteAddBooth);
    var suiteSeAdd = $("#suite-se-add");
    if (suiteSeAdd) suiteSeAdd.addEventListener("click", suiteAddSession);

    refreshSuiteEventSelect().then(function () {
      loadInvitesForSelectedEvent();
      loadSuiteModules();
      suiteLoadAnalytics();
    });
    addSpeakerRow();
    $("#ev-add-speaker").addEventListener("click", function () { addSpeakerRow(); });
    $("#ev-speakers").addEventListener("click", function (e) {
      var t = e.target;
      if (t instanceof HTMLElement && t.getAttribute("data-remove-speaker") === "1") {
        var row = t.closest(".speaker-row");
        if (row) row.remove();
      }
    });

    function clearEventForm() {
      editingEventForForm = null;
      $("#ev-title").value = "";
      clearPendingBannerPreview();
      showExistingBannerPreview({});
      $("#ev-desc").value = "";
      var evDescMetaClear = $("#ev-desc-meta");
      if (evDescMetaClear) evDescMetaClear.textContent = "0 / " + EVENT_DESCRIPTION_MAX_WORDS + " words max. Emojis not allowed.";
      $("#ev-loc").value = "";
      if (countrySelect) countrySelect.clear();
      syncEventCountryFieldVisibility();
      $("#ev-start").value = "";
      $("#ev-end").value = "";
      syncEventEndMin();
      $("#ev-online").value = "";
      $("#ev-web").value = "";
      $("#ev-min").value = "0";
      $("#ev-max").value = "0";
      $("#ev-exturl").value = "";
      $("#ev-ext").checked = false;
      var modeInPerson = document.querySelector("input[name='ev-mode'][value='in_person']");
      if (modeInPerson) modeInPerson.checked = true;
      var categoryHybrid = document.querySelector("input[name='ev-category'][value='hybrid']");
      if (categoryHybrid) categoryHybrid.checked = true;
      var speakersContainer = $("#ev-speakers");
      if (speakersContainer) speakersContainer.innerHTML = "";
      addSpeakerRow();
    }

    function setEventFormMode(mode) {
      var heading = $("#ev-form-heading");
      var createBtn = $("#ev-create");
      var cancelBtn = $("#ev-cancel-edit");
      if (mode === "edit") {
        if (heading) heading.textContent = "Edit event (draft)";
        if (createBtn) createBtn.textContent = "Save changes";
        if (cancelBtn) cancelBtn.style.display = "";
      } else {
        editingEventId = null;
        state.organizerEventId = null;
        if (heading) heading.textContent = "Create event (draft)";
        if (createBtn) createBtn.textContent = "Save as draft";
        if (cancelBtn) cancelBtn.style.display = "none";
      }
    }

    function populateEventForm(ev) {
      editingEventForForm = ev;
      var orgSel = $("#ev-org");
      if (orgSel && ev.organizationId) orgSel.value = ev.organizationId;
      $("#ev-title").value = ev.title || "";
      $("#ev-desc").value = ev.description || "";
      var evDescMetaPop = $("#ev-desc-meta");
      if (evDescMetaPop) {
        evDescMetaPop.textContent = String(countWords(ev.description || "")) + " / " + EVENT_DESCRIPTION_MAX_WORDS + " words max. Emojis not allowed.";
      }
      var parsedLoc = parseEventLocation(ev.location || "");
      $("#ev-loc").value = parsedLoc.city;
      if (countrySelect) countrySelect.set(parsedLoc.country);
      syncEventCountryFieldVisibility();
      $("#ev-start").value = isoToDatetimeLocal(ev.startsAt);
      $("#ev-end").value = isoToDatetimeLocal(ev.endsAt);
      syncEventEndMin();
      var mode = ev.mode || "in_person";
      var modeRadio = document.querySelector("input[name='ev-mode'][value='" + mode + "']");
      if (modeRadio) modeRadio.checked = true;
      var category = ev.category || "hybrid";
      var categoryRadio = document.querySelector("input[name='ev-category'][value='" + category + "']");
      if (categoryRadio) categoryRadio.checked = true;
      $("#ev-online").value = ev.online_url || "";
      $("#ev-web").value = ev.website_url || "";
      $("#ev-min").value = String(ev.min_seats != null ? ev.min_seats : 0);
      $("#ev-max").value = String(ev.max_seats != null ? ev.max_seats : 0);
      $("#ev-ext").checked = !!ev.is_external;
      $("#ev-exturl").value = ev.external_url || "";
      var speakersContainer = $("#ev-speakers");
      if (speakersContainer) speakersContainer.innerHTML = "";
      var speakers = ev.speakers && ev.speakers.length ? ev.speakers : [null];
      speakers.forEach(function (sp) { addSpeakerRow(sp); });
      showExistingBannerPreview(ev);
    }

    function openEventEditor(ev) {
      if (!isOrganizerEventEditable(ev)) {
        toast("Move this event back to draft before editing.", "error");
        return;
      }
      editingEventId = ev.id;
      state.organizerEventId = ev.id;
      populateEventForm(ev);
      setEventFormMode("edit");
      var createTab = orgWsTabs ? orgWsTabs.querySelector("[data-org-ws-tab='create']") : null;
      if (createTab) createTab.click();
      var titleInput = $("#ev-title");
      if (titleInput) titleInput.focus();
    }

    var evCancelEdit = $("#ev-cancel-edit");
    if (evCancelEdit) {
      evCancelEdit.addEventListener("click", function () {
        clearEventForm();
        setEventFormMode("create");
      });
    }

    var evBannerInput = $("#ev-banner");
    if (evBannerInput) {
      evBannerInput.addEventListener("change", function () {
        var file = evBannerInput.files && evBannerInput.files[0];
        if (!file) return;
        optimizeEventBannerFile(file)
          .then(function (blob) {
            showPendingBannerPreview(blob);
            toast("Banner optimized to 150×150.", "success");
          })
          .catch(function (err) {
            evBannerInput.value = "";
            toast(err.message || "Could not process banner.", "error");
          });
      });
    }
    var evBannerClear = $("#ev-banner-clear");
    if (evBannerClear) {
      evBannerClear.addEventListener("click", function () {
        clearPendingBannerPreview();
        showExistingBannerPreview(editingEventForForm || {});
      });
    }

    showExistingBannerPreview({});

    $("#ev-create").addEventListener("click", function () {
      if (state.eventSaveInFlight) return;
      var b = $("#ev-create");
      ["ev-title", "ev-desc", "ev-start", "ev-end", "ev-exturl", "ev-online", "ev-web", "ev-min", "ev-max", "ev-country-input"].forEach(clearFieldError);
      var orgId = $("#ev-org").value;
      var title = ($("#ev-title").value || "").trim();
      var description = ($("#ev-desc").value || "").trim();
      // Convert datetime-local to ISO format
      var startsAtLocal = ($("#ev-start").value || "").trim();
      var endsAtLocal = ($("#ev-end").value || "").trim();
      var modeRadio = document.querySelector("input[name='ev-mode']:checked");
      var mode = modeRadio ? modeRadio.value : "in_person";
      var categoryRadio = document.querySelector("input[name='ev-category']:checked");
      var category = categoryRadio ? categoryRadio.value : "hybrid";
      var ext = $("#ev-ext").checked;
      var minSeatsRaw = parseInt($("#ev-min").value || "0", 10);
      var maxSeatsRaw = parseInt($("#ev-max").value || "0", 10);
      var minSeats = Number.isFinite(minSeatsRaw) ? minSeatsRaw : 0;
      var maxSeats = Number.isFinite(maxSeatsRaw) ? maxSeatsRaw : 0;
      var onlineUrl = ($("#ev-online").value || "").trim();
      var websiteUrl = ($("#ev-web").value || "").trim();
      var externalUrl = ($("#ev-exturl").value || "").trim();
      var hasError = false;
      if (!title) { setFieldError("ev-title", "Title is required."); hasError = true; }
      else if (title.length > EVENT_TITLE_MAX) { setFieldError("ev-title", "Maximum 26 characters allowed."); hasError = true; }
      else {
        var titleUnsafe = rejectUnsafeText(title);
        if (titleUnsafe) { setFieldError("ev-title", titleUnsafe); hasError = true; }
      }
      if (countWords(description) > EVENT_DESCRIPTION_MAX_WORDS) {
        setFieldError("ev-desc", "Maximum 500 words allowed.");
        hasError = true;
      } else {
        var descUnsafe = rejectUnsafeText(description);
        if (descUnsafe) { setFieldError("ev-desc", descUnsafe); hasError = true; }
      }
      if (!startsAtLocal) { setFieldError("ev-start", "Start date and time are required."); hasError = true; }
      if (!endsAtLocal) { setFieldError("ev-end", "End date and time are required."); hasError = true; }
      // Convert local datetime to ISO format
      var startsAt = startsAtLocal ? new Date(startsAtLocal).toISOString() : "";
      var endsAt = endsAtLocal ? new Date(endsAtLocal).toISOString() : "";
      if (startsAtLocal && isNaN(Date.parse(startsAt))) { setFieldError("ev-start", "Invalid start date."); hasError = true; }
      if (endsAtLocal && isNaN(Date.parse(endsAt))) { setFieldError("ev-end", "Invalid end date."); hasError = true; }
      if (startsAtLocal && endsAtLocal && !isNaN(Date.parse(startsAt)) && !isNaN(Date.parse(endsAt)) && Date.parse(endsAt) <= Date.parse(startsAt)) {
        setFieldError("ev-end", "End must be after the start date and time.");
        hasError = true;
      }
      if ((mode === "online" || mode === "hybrid") && !onlineUrl) {
        setFieldError("ev-online", "Online events need a link participants can join.");
        hasError = true;
      } else if (onlineUrl && !isSafeHttpUrl(onlineUrl)) {
        setFieldError("ev-online", "Use a valid http(s) URL from your own site. Short links are not allowed.");
        hasError = true;
      }
      if (websiteUrl && !isSafeHttpUrl(websiteUrl)) {
        setFieldError("ev-web", "Use a valid http(s) URL from your own site. Short links are not allowed.");
        hasError = true;
      }
      if (ext && !externalUrl) {
        setFieldError("ev-exturl", "Add the link where attendees register.");
        hasError = true;
      } else if (ext && externalUrl && !isSafeHttpUrl(externalUrl)) {
        setFieldError("ev-exturl", "Use a valid http(s) registration URL. Short links are not allowed.");
        hasError = true;
      }
      if (minSeats < 0) { setFieldError("ev-min", "Minimum seats cannot be negative."); hasError = true; }
      if (maxSeats < 0) { setFieldError("ev-max", "Maximum seats cannot be negative."); hasError = true; }
      if (maxSeats > 0 && minSeats > maxSeats) {
        setFieldError("ev-min", "Min seats cannot be greater than max.");
        hasError = true;
      }
      var cityLoc = ($("#ev-loc").value || "").trim();
      var countryLoc = countrySelect ? countrySelect.get() : "";
      if (mode !== "online") {
        if (!countryLoc) {
          setFieldError("ev-country-input", "Select a country from the list.");
          hasError = true;
        } else if (!countryNameMatches(countryLoc)) {
          setFieldError("ev-country-input", "Choose a country from the dropdown list.");
          hasError = true;
        }
      }
      var speakers = Array.prototype.slice
        .call(document.querySelectorAll("#ev-speakers .speaker-row"))
        .map(function (row) {
          return {
            name: (row.querySelector(".sp-name").value || "").trim(),
            link: (row.querySelector(".sp-link").value || "").trim(),
            org: (row.querySelector(".sp-assoc").value || "").trim(),
            orgLink: "",
          };
        })
        .filter(function (s) { return s.name; });
      speakers.forEach(function (speaker, idx) {
        if (speaker.name.length > PERSON_NAME_MAX) {
          hasError = true;
          toast("Speaker name " + (idx + 1) + " must be 26 characters or fewer.", "info");
        }
        var speakerUnsafe = rejectUnsafeText(speaker.name);
        if (speakerUnsafe) {
          hasError = true;
          toast("Speaker name " + (idx + 1) + ": " + speakerUnsafe, "info");
        }
        if (speaker.link && !isSafeHttpUrl(speaker.link)) {
          hasError = true;
          toast("Speaker link " + (idx + 1) + " must be a valid http(s) URL.", "info");
        }
        if (speaker.org) {
          var orgUnsafe = rejectUnsafeText(speaker.org);
          if (orgUnsafe) {
            hasError = true;
            toast("Speaker association " + (idx + 1) + ": " + orgUnsafe, "info");
          }
        }
      });
      if (hasError) return;
      if (!token.value) { toast("Finish the security check first.", "info"); return; }
      var payload = {
        organizationId: orgId,
        title: title,
        description: description,
        location: buildEventLocation(cityLoc, countryNameMatches(countryLoc) || countryLoc, mode),
        startsAt: startsAt,
        endsAt: endsAt,
        mode: mode,
        category: category,
        online_url: onlineUrl || null,
        website_url: websiteUrl || null,
        min_seats: minSeats,
        max_seats: maxSeats,
        speakers: speakers,
        is_external: ext,
        external_url: ext ? externalUrl : null,
        turnstileToken: token.value,
      };
      var isEdit = !!editingEventId;
      state.eventSaveInFlight = true;
      beginButtonLoading(b, isEdit ? "Saving changes…" : "Saving draft…");
      return api(isEdit ? "/api/events/" + encodeURIComponent(editingEventId) : "/api/events", {
        method: isEdit ? "PUT" : "POST",
        body: JSON.stringify(isEdit ? payload : Object.assign({ status: "draft" }, payload)),
      })
        .then(function (data) {
          var savedEvent = data && data.event ? data.event : null;
          var eventId = isEdit ? editingEventId : (savedEvent && savedEvent.id);
          var bannerBlob = state.pendingBannerBlob;
          if (eventId && bannerBlob) {
            if (b && document.body.contains(b)) {
              b.textContent = "Uploading banner…";
            }
            return uploadEventBanner(eventId, bannerBlob)
              .then(function (bannerData) {
                var updated = bannerData && bannerData.event ? bannerData.event : savedEvent;
                return { eventId: eventId, uploadedBanner: true, savedEvent: updated || savedEvent };
              });
          }
          return { eventId: eventId, uploadedBanner: false, savedEvent: savedEvent };
        })
        .then(function (result) {
          if (!isEdit && result.eventId) {
            editingEventId = result.eventId;
            state.organizerEventId = result.eventId;
            setEventFormMode("edit");
          }
          if (result.savedEvent) {
            editingEventForForm = result.savedEvent;
          }
          clearPendingBannerPreview();
          if (editingEventForForm && editingEventForForm.hasBanner) {
            showExistingBannerPreview(editingEventForForm);
          }
          resetTurnstileWidget(token, "ts-event", function (ready) {
            if (b) b.disabled = !ready;
          });
          toast(
            isEdit
              ? (result.uploadedBanner ? "Draft and banner updated." : "Draft updated.")
              : (result.uploadedBanner
                ? "Draft saved with banner. You can keep editing or publish from Your Events."
                : "Draft saved. You can keep editing or publish from Your Events."),
            "success"
          );
          loadOrganizerEvents();
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not save the event."), "error");
        })
        .finally(function () {
          state.eventSaveInFlight = false;
          if (b && document.body.contains(b)) endButtonLoading(b, { disabled: false });
        });
    });

    $("#ev-list").addEventListener("click", function (e) {
      var t = e.target;
      if (!(t instanceof HTMLElement)) return;
      var editId = t.getAttribute("data-edit");
      if (editId) {
        e.preventDefault();
        api("/api/events/" + encodeURIComponent(editId))
          .then(function (data) {
            if (data && data.event) openEventEditor(data.event);
          })
          .catch(function (err) {
            toast(friendlyError(err, "Could not load the event for editing."), "error");
          });
        return;
      }
      var pubId = t.getAttribute("data-publish");
      var unpubId = t.getAttribute("data-unpublish");
      var id = pubId || unpubId;
      if (!id) return;
      e.preventDefault();
      var nextStatus = pubId ? "published" : "draft";
      beginButtonLoading(t, nextStatus === "published" ? "Publishing…" : "Unpublishing…");
      
      // Reset any existing Turnstile widget and get a fresh token
      var pubToken = { value: "", widgetId: null };
      var tsContainer = $("#ts-event");
      if (tsContainer) tsContainer.innerHTML = "";
      
      renderTurnstile("ts-event", pubToken, function (ready) {
        if (!ready) {
          toast("Security check not ready. Please wait a moment and try again.", "info");
          endButtonLoading(t, { disabled: false });
          return;
        }
        if (!pubToken.value) {
          toast("Complete the security check first.", "info");
          endButtonLoading(t, { disabled: false });
          return;
        }
        var payload = { status: nextStatus, turnstileToken: pubToken.value };
        var payloadJson = JSON.stringify(payload);
        fetch("/api/events/" + encodeURIComponent(id) + "/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadJson,
          credentials: "same-origin"
        }).then(function(res) {
          return res.text().then(function(text) {
            if (!res.ok) {
              var data = {};
              try { data = JSON.parse(text); } catch(e) {}
              var err = new Error(data.error || "Request failed");
              err.status = res.status;
              err.data = data;
              throw err;
            }
            return text ? JSON.parse(text) : {};
          });
        }).then(function() {
          toast(nextStatus === "published" ? "Event published." : "Event moved back to draft.", "success");
          loadOrganizerEvents();
        }).catch(function (err) {
          console.error("[EventMark] Publish failed:", err);
          toast(friendlyError(err, "Could not change the event status."), "error");
          endButtonLoading(t, { disabled: false });
        });
      });
    });

    // Auto-load events with contribution counts for organizer selection
    function loadOrganizerEventsForReview() {
      var eventListContainer = $("#rev-event-list");
      if (!eventListContainer) return;
      eventListContainer.innerHTML = "<p class='muted'>Loading your events…</p>";
      return api("/api/organizer/events")
        .then(function (data) {
          var events = data.items || [];
          if (events.length === 0) {
            eventListContainer.innerHTML = "<p class='muted'>No events found. Create an event first.</p>";
            return;
          }
          // Load contribution counts for each event
          var eventHtml = events.map(function(ev) {
            return (
              "<div class='event-review-item' data-event-id='" + escapeHtml(ev.id) + "' style='padding:0.75rem;border:1px solid var(--border);border-radius:8px;margin:0.5rem 0;cursor:pointer;'>" +
              "<div style='display:flex;justify-content:space-between;align-items:center;'>" +
              "<strong>" + escapeHtml(ev.title) + "</strong>" +
              "<span class='muted'>" + escapeHtml(formatEventDateTime(ev.startsAt)) + "</span>" +
              "</div>" +
              "<div style='margin-top:0.5rem;'>" +
              "<span class='pill'>Interested: " + (ev.interestedCount || 0) + "</span> " +
              "<span class='pill'>Registered: " + (ev.registeredCount || 0) + "</span> " +
              "<span class='pill' style='background:var(--accent-warning);color:#000;'>Contributions pending</span>" +
              "</div>" +
              "</div>"
            );
          }).join("");
          eventListContainer.innerHTML = eventHtml;
          // Add click handlers to each event item
          eventListContainer.querySelectorAll(".event-review-item").forEach(function(item) {
            item.addEventListener("click", function() {
              var eid = this.getAttribute("data-event-id");
              loadContributionsForEvent(eid);
            });
          });
        })
        .catch(function(err) {
          eventListContainer.innerHTML = "<p class='muted'>Could not load events.</p>";
        });
    }

    var reviewEventId = null;

    function loadContributionsForEvent(eid) {
      reviewEventId = eid;
      state.organizerReviewEventId = eid;
      var boardContainer = $("#rev-board");
      var debugContainer = $("#rev-debug-info");
      if (!boardContainer) return;
      boardContainer.innerHTML = "<p class='muted'>Loading contributions…</p>";
      if (debugContainer) {
        debugContainer.style.display = 'none';
        debugContainer.innerHTML = '';
      }
      return api("/api/events/" + encodeURIComponent(eid) + "/contributions")
        .then(function (data) {
          var items = data.items || [];

          if (items.length === 0) {
            boardContainer.innerHTML = "<p class='muted'>No contributions found for this event.</p>";
            return;
          }

          function col(title, filterFn) {
            return (
              "<div class='kan-col'><h4>" + escapeHtml(title) + "</h4>" +
              items.filter(filterFn).map(renderContribCard).join("") +
              "</div>"
            );
          }
          boardContainer.innerHTML =
            col("Pending", function (c) { return c.status === "PENDING_APPROVAL"; }) +
            col("Approved", function (c) { return c.status === "APPROVED"; }) +
            col("Rejected / Info", function (c) {
              return c.status !== "PENDING_APPROVAL" && c.status !== "APPROVED";
            });
        })
        .catch(function (err) {
          var errorMsg = err && err.data && err.data.error ? err.data.error : (err.message || "Could not load");
          boardContainer.innerHTML = "<p class='muted'>Error: " + escapeHtml(errorMsg) + "</p>";
          toast(friendlyError(err, "Could not load contributor requests."), "error");
        });
    }

    state.reloadOrganizerContributions = function () {
      if (reviewEventId) loadContributionsForEvent(reviewEventId);
    };

    // Auto-load events when organizer workspace renders
    loadOrganizerEventsForReview();

    $("#rev-board").addEventListener("click", function (e) {
      var t = e.target;
      if (!(t instanceof HTMLElement)) return;
      var action = t.getAttribute("data-action");
      var id = t.getAttribute("data-id");
      if (!action || !id) return;
      if (action === "approve" || action === "reject" || action === "info") {
        openContribReviewModal(id, action);
      }
    });

    return loadOrganizerEvents();
  }

  function isoToDatetimeLocal(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      "T" +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  function isOrganizerEventEditable(ev) {
    return (ev.status || "draft") === "draft";
  }

  function addSpeakerRow(speaker) {
    var holder = $("#ev-speakers");
    if (!holder) return;
    var row = document.createElement("div");
    row.className = "speaker-row";
    row.innerHTML =
      "<div class='field'><label>Name</label><input class='sp-name' maxlength='26' /><small class='muted'>Maximum 26 characters.</small></div>" +
      "<div class='field'><label>Professional / website link</label><input class='sp-link' placeholder='https://…' /></div>" +
      "<div class='field'><label>Association (optional)</label><input class='sp-assoc' placeholder='Company, university, group…' /></div>" +
      "<div class='row'><button type='button' class='btn-ghost' data-remove-speaker='1'>Remove</button></div>";
    holder.appendChild(row);
    if (speaker) {
      var nameEl = row.querySelector(".sp-name");
      var linkEl = row.querySelector(".sp-link");
      var assocEl = row.querySelector(".sp-assoc");
      if (nameEl) nameEl.value = speaker.name || "";
      if (linkEl) linkEl.value = speaker.link || "";
      if (assocEl) assocEl.value = speaker.org || "";
    }
  }

  function loadOrganizerEvents() {
    var holder = $("#ev-list");
    if (!holder) return Promise.resolve();
    return api("/api/organizer/events")
      .then(function (data) {
        var items = (data.items || []).slice().sort(function (a, b) {
          return String(b.startsAt || "").localeCompare(String(a.startsAt || ""));
        });
        if (!items.length) {
          holder.innerHTML = "<p class='muted'>No events yet — create your first draft in the Create Event tab.</p>";
          return;
        }
        holder.innerHTML = items
          .map(function (ev) {
            var status = ev.status || "draft";
            var editable = isOrganizerEventEditable(ev);
            var draftHint =
              status === "published"
                ? "<p class='muted'>Move back to draft to edit, then publish again when ready.</p>"
                : ev.publishedOnce
                  ? "<p class='muted'>Previously published — edit this draft and publish again when ready.</p>"
                  : "";
            var eventUrl = window.location.origin + "/#/event/" + encodeURIComponent(ev.id);
            var shareX =
              "https://x.com/intent/tweet?text=" +
              encodeURIComponent((ev.title || "Event") + " on EventMark") +
              "&url=" +
              encodeURIComponent(eventUrl);
            var shareLinkedin =
              "https://www.linkedin.com/sharing/share-offsite/?url=" +
              encodeURIComponent(eventUrl);
            var pill =
              status === "published"
                ? "<span class='pill native'>Published</span>"
                : "<span class='pill external'>Draft</span>";
            var actionBtn =
              status === "published"
                ? "<button type='button' class='btn-ghost' data-unpublish='" + escapeHtml(ev.id) + "'>Move back to draft</button>"
                : "<button type='button' class='btn-primary' data-publish='" + escapeHtml(ev.id) + "'>Publish</button>";
            var editBtn = editable
              ? "<button type='button' class='btn-ghost' data-edit='" + escapeHtml(ev.id) + "'>Edit</button>"
              : "";
            return (
              "<article class='card'><h4>" + escapeHtml(ev.title) + "</h4>" +
              "<div>" + pill + "</div>" +
              "<p class='muted'>" + escapeHtml(formatEventWhen(ev.startsAt, ev.endsAt)) + "</p>" +
              draftHint +
              (ev.website_url && isHttpUrl(ev.website_url)
                ? "<p><a class='btn-ghost' href='" + escapeHtml(ev.website_url) + "' target='_blank' rel='noopener'>Official website</a></p>"
                : "") +
              "<div class='row'>" +
              "<a class='btn-ghost' href='#/event/" + escapeHtml(ev.id) + "'>Open</a>" +
              "<a class='btn-ghost' href='/api/events/" + escapeHtml(ev.id) + "/embed.html' target='_blank' rel='noopener'>Embed code</a>" +
              "<a class='btn-ghost' href='" + escapeHtml(shareX) + "' target='_blank' rel='noopener'>X</a>" +
              "<a class='btn-ghost' href='" + escapeHtml(shareLinkedin) + "' target='_blank' rel='noopener'>LinkedIn</a>" +
              editBtn +
              actionBtn +
              "</div></article>"
            );
          })
          .join("");
      })
      .catch(function () {
        holder.innerHTML = "<p class='muted'>Could not load your events. Refresh and try again.</p>";
      });
  }

  /** Replaces stacked window.prompt calls — proper modal with note + optional slot + Turnstile. */
  function openContribReviewModal(contribId, action) {
    var status =
      action === "approve"
        ? "APPROVED"
        : action === "reject"
          ? "REJECTED"
          : "INFO_REQUESTED";
    var verb = action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Request more info";
    var slotFields =
      action === "approve"
        ? '<div class="field"><label for="cr-slot-start">Slot start (optional, ISO)</label><input id="cr-slot-start" placeholder="2026-06-01T09:00:00.000Z" /></div>' +
          '<div class="field"><label for="cr-slot-end">Slot end (optional, ISO)</label><input id="cr-slot-end" placeholder="2026-06-01T09:30:00.000Z" /></div>'
        : "";
    var token = { value: "" };
    openModal(
      "<h3>" + escapeHtml(verb) + " contribution</h3>" +
        "<p class='muted'>Add a short note for the contributor. Slot times are optional and only used when approving.</p>" +
        '<div class="field"><label for="cr-note">Note for contributor (optional)</label><textarea id="cr-note" rows="3"></textarea></div>' +
        slotFields +
        '<div id="cr-turnstile"></div>' +
        '<div class="row"><button type="button" id="cr-cancel" class="btn-ghost">Cancel</button>' +
        '<button type="button" id="cr-submit" class="btn-primary" disabled>' +
        escapeHtml(verb) +
        "</button></div>"
    );
    function setReady(ready) {
      var b = $("#cr-submit");
      if (b) b.disabled = !ready;
    }
    renderTurnstile("cr-turnstile", token, setReady);
    $("#cr-cancel").addEventListener("click", function () {
      closeModal();
    });
    $("#cr-submit").addEventListener("click", function () {
      var b = $("#cr-submit");
      var body = {
        status: status,
        organizerNote: ($("#cr-note") ? $("#cr-note").value : "") || "",
        slotStartsAt: $("#cr-slot-start") ? $("#cr-slot-start").value || undefined : undefined,
        slotEndsAt: $("#cr-slot-end") ? $("#cr-slot-end").value || undefined : undefined,
        turnstileToken: token.value,
      };
      if (!body.turnstileToken) {
        toast("Finish the security check, then submit.", "info");
        return;
      }
      beginButtonLoading(b, "Submitting…");
      return api("/api/contributions/" + encodeURIComponent(contribId) + "/review", {
        method: "PUT",
        body: JSON.stringify(body),
      })
        .then(function () {
          closeModal();
          toast("Decision saved.", "success");
          if (typeof state.reloadOrganizerContributions === "function") {
            state.reloadOrganizerContributions();
          }
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not save the decision."), "error");
        })
        .finally(function () {
          if (b && document.body.contains(b)) endButtonLoading(b, { disabled: false });
        });
    });
  }

  function renderContribCard(c) {
    var detailsHtml = "";
    var payload = c.payload || {};

    // Display contributor email and full name
    var contributorInfo = '<div style="margin:0.5rem 0;font-size:0.8rem;">' +
      '<strong>Email:</strong> ' + escapeHtml(payload.email || "N/A") + '<br/>' +
      '<strong>Name:</strong> ' + escapeHtml(payload.fullName || "N/A") +
      '</div>';

    // Build role-specific details
    if (c.role === "speaker" && payload.kind === "speaker") {
      detailsHtml =
        '<div style="margin:0.5rem 0;font-size:0.8rem;">' +
        '<strong>Topic:</strong> ' + escapeHtml(payload.topicTitle || "N/A") + '<br/>' +
        '<strong>Slot:</strong> ' + escapeHtml(payload.preferredSlot || "N/A") + '<br/>' +
        '<strong>Abstract:</strong> ' + escapeHtml((payload.abstract || "").substring(0, 100)) +
        ((payload.abstract || "").length > 100 ? "..." : "") +
        '</div>';
    } else if (c.role === "volunteer" && payload.kind === "volunteer") {
      detailsHtml =
        '<div style="margin:0.5rem 0;font-size:0.8rem;">' +
        '<strong>Skills:</strong> ' + escapeHtml(payload.skills || "N/A") + '<br/>' +
        '<strong>Availability:</strong> ' + escapeHtml(payload.availability || "N/A") +
        '</div>';
    } else if (c.role === "topic_proposer" && payload.kind === "topic_proposer") {
      detailsHtml =
        '<div style="margin:0.5rem 0;font-size:0.8rem;">' +
        '<strong>Topic:</strong> ' + escapeHtml(payload.topicTitle || "N/A") + '<br/>' +
        '<strong>Format:</strong> ' + escapeHtml(payload.format || "N/A") + '<br/>' +
        '<strong>Description:</strong> ' + escapeHtml((payload.description || "").substring(0, 100)) +
        ((payload.description || "").length > 100 ? "..." : "") +
        '</div>';
    } else if (c.role === "participant") {
      detailsHtml = '<div style="margin:0.5rem 0;font-size:0.8rem;">General participant registration</div>';
    }

    // Add contributor info (email + name)
    detailsHtml = contributorInfo + detailsHtml;

    // Add organizer note if present
    if (c.organizerNote) {
      detailsHtml += '<div style="margin:0.5rem 0;font-size:0.8rem;color:var(--muted);"><strong>Note:</strong> ' + escapeHtml(c.organizerNote) + '</div>';
    }

    // Add approved speaker slot info if present
    if (c.approvedSpeakerSlot) {
      detailsHtml += '<div style="margin:0.5rem 0;font-size:0.8rem;color:var(--accent);"><strong>Scheduled:</strong> ' +
        escapeHtml(formatEventDateTime(c.approvedSpeakerSlot.startsAt)) + ' - ' +
        escapeHtml(c.approvedSpeakerSlot.title || payload.topicTitle || "Untitled") +
        '</div>';
    }

    return (
      '<div class="contrib-item"><div><strong>' +
      escapeHtml(c.role.replace(/_/g, " ")) +
      "</strong> · " +
      '<span class="pill ' + (c.status === "APPROVED" ? "category-open" : c.status === "REJECTED" ? "external" : "native") + '">' +
      escapeHtml(c.status.replace(/_/g, " ")) +
      '</span>' +
      "</div>" +
      detailsHtml +
      (c.status === "PENDING_APPROVAL" ?
        '<div class="row" style="margin-top:0.5rem">' +
        '<button type="button" class="btn-primary" data-action="approve" data-id="' +
        escapeHtml(c.id) +
        '">Approve</button>' +
        '<button type="button" class="btn-danger" data-action="reject" data-id="' +
        escapeHtml(c.id) +
        '">Reject</button>' +
        '<button type="button" class="btn-ghost" data-action="info" data-id="' +
        escapeHtml(c.id) +
        '">Request info</button>' +
        "</div>" :
        '<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--muted);">Reviewed</div>'
      ) +
      "</div>"
    );
  }

  /** Admin: org-request review queue. */
  function renderAdminOrgRequests() {
    if (!userIsAdmin()) {
      setFlash("Admins only.", "error");
      return Promise.resolve(renderHome());
    }
    startAdminSessionTimeout();
    layout(
      "<div class='admin-header'><h2>Org request review</h2>" +
        "<button type='button' id='admin-logout' class='btn-ghost'>Sign out</button></div>" +
        "<p class='muted'>You are the EventMark admin. Open each application and approve, reject, or ask for more info.</p>" +
        "<div class='row'><button type='button' id='or-load' class='btn-ghost'>Refresh queue</button></div>" +
        "<div id='or-list' class='muted'>Loading…</div>"
    );
    attachAdminLogoutHandler();
    function load() {
      var b = $("#or-load");
      if (b) beginButtonLoading(b, "Loading…");
      return api("/api/admin/org-requests")
        .then(function (data) {
          var items = data.items || [];
          if (!items.length) {
            $("#or-list").innerHTML = "<p class='muted'>No pending requests right now.</p>";
            return;
          }
          $("#or-list").innerHTML = items.map(renderOrgRequestCard).join("");
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not load the queue."), "error");
        })
        .finally(function () {
          if (b && document.body.contains(b)) endButtonLoading(b, { disabled: false });
        });
    }
    $("#or-load").addEventListener("click", load);
    $("#or-list").addEventListener("click", function (e) {
      var t = e.target;
      if (!(t instanceof HTMLElement)) return;
      var dec = t.getAttribute("data-dec");
      var id = t.getAttribute("data-id");
      if (!dec || !id) return;
      openOrgRequestDecisionModal(id, dec, load);
    });
    return load();
  }

  function renderOrgRequestCard(r) {
    var dirs = (r.directors || [])
      .map(function (d) {
        var link = d.url || d.link || "";
        return (
          "<li><strong>" + escapeHtml(d.name) + "</strong> — " +
          "<a href='" + escapeHtml(link) + "' target='_blank' rel='noopener'>" + escapeHtml(link) + "</a></li>"
        );
      })
      .join("");
    var modeLabel =
      r.eventMode === "hybrid"
        ? "In person + Online"
        : r.eventMode === "online"
          ? "Online"
          : r.eventMode === "in_person"
            ? "In person"
            : "—";
    var acts = (r.activities || []).map(function (a) {
      return "<span class='pill'>" + escapeHtml(a.replace(/_/g, " ")) + "</span>";
    }).join(" ");
    var name = r.organizationName || r.name || "(unnamed)";
    return (
      "<article class='card'>" +
      "<h4>" + escapeHtml(name) + "</h4>" +
      "<p>" + escapeHtml(r.description || "") + "</p>" +
      "<p><strong>Website:</strong> <a href='" + escapeHtml(r.website || "#") + "' target='_blank' rel='noopener'>" + escapeHtml(r.website || "") + "</a></p>" +
      "<p><strong>Activities:</strong> " + acts + "</p>" +
      "<p><strong>Format:</strong> " + escapeHtml(modeLabel) + "</p>" +
      "<p><strong>Motto:</strong> " + escapeHtml(r.motto || "") + "</p>" +
      "<p><strong>Voxon-affiliated:</strong> " + (r.voxonAffiliated ? "Yes" : "No") + "</p>" +
      "<p><strong>Directors:</strong></p><ul>" + dirs + "</ul>" +
      "<p class='muted'>Submitted by " + escapeHtml(r.contactEmail || "") + " on " + escapeHtml(formatEventDateTime(r.createdAt)) + ".</p>" +
      "<div class='row'>" +
      "<button type='button' class='btn-primary' data-dec='approve' data-id='" + escapeHtml(r.id) + "'>Approve</button>" +
      "<button type='button' class='btn-danger' data-dec='reject' data-id='" + escapeHtml(r.id) + "'>Reject</button>" +
      "<button type='button' class='btn-ghost' data-dec='info' data-id='" + escapeHtml(r.id) + "'>Request more info</button>" +
      "</div></article>"
    );
  }

  function openOrgRequestDecisionModal(reqId, dec, onDone) {
    var verb = dec === "approve" ? "Approve" : dec === "reject" ? "Reject" : "Request more info";
    var status = dec === "approve" ? "APPROVED" : dec === "reject" ? "REJECTED" : "INFO_REQUESTED";
    var token = { value: "" };
    var hint =
      dec === "info"
        ? "Tell the applicant exactly what you need (e.g. registration document, ID scan, alternate email)."
        : dec === "reject"
          ? "Tell the applicant why so they can fix and re-apply."
          : "An optional welcome note shown to the applicant after approval.";
    openModal(
      "<h3>" + escapeHtml(verb) + " application</h3>" +
        "<p class='muted'>" + escapeHtml(hint) + "</p>" +
        "<div class='field'><label for='ord-note'>Admin note</label><textarea id='ord-note' rows='4'></textarea></div>" +
        "<div id='ord-turnstile'></div>" +
        "<div class='row'>" +
        "<button type='button' id='ord-cancel' class='btn-ghost'>Cancel</button>" +
        "<button type='button' id='ord-submit' class='" + (dec === "reject" ? "btn-danger" : "btn-primary") + "' disabled>" +
        escapeHtml(verb) + "</button></div>"
    );
    renderTurnstile("ord-turnstile", token, function (ready) {
      var b = $("#ord-submit");
      if (b) b.disabled = !ready;
    });
    $("#ord-cancel").addEventListener("click", closeModal);
    $("#ord-submit").addEventListener("click", function () {
      var b = $("#ord-submit");
      if (!token.value) { toast("Finish the security check first.", "info"); return; }
      beginButtonLoading(b, "Saving…");
      return api("/api/admin/org-requests/" + encodeURIComponent(reqId) + "/decision", {
        method: "PUT",
        body: JSON.stringify({
          status: status,
          note: ($("#ord-note") ? $("#ord-note").value : "") || "",
          turnstileToken: token.value,
        }),
      })
        .then(function () {
          closeModal();
          toast("Decision recorded. The applicant will be notified.", "success");
          if (typeof onDone === "function") onDone();
        })
        .catch(function (err) {
          toast(friendlyError(err, "Could not save the decision."), "error");
        })
        .finally(function () {
          if (b && document.body.contains(b)) endButtonLoading(b, { disabled: false });
        });
    });
  }

  /** Admin: per-environment site settings. Each deployed worker (dev/test/production) has its own KV, so this page edits the values for the environment you are currently on. */
  function renderAdminSettings() {
    if (!userIsAdmin()) {
      setFlash("Admins only.", "error");
      return Promise.resolve(renderHome());
    }
    startAdminSessionTimeout();
    layout(
      "<div class='admin-header'><h2>Site settings</h2>" +
        "<button type='button' id='admin-logout' class='btn-ghost'>Sign out</button></div>" +
        "<p class='muted'>You are editing settings for this deployment. Each environment has its own data, so changes here only affect <strong>" +
        escapeHtml(state.config.environment || "this environment") +
        "</strong>.</p>" +
        "<section id='set-card' class='card muted'>Loading…</section>"
    );
    attachAdminLogoutHandler();
    return api("/api/admin/settings")
      .then(function (data) {
        var s = data.settings || {};
        var env = data.environment || state.config.environment || "";
        $("#set-card").classList.remove("muted");
        $("#set-card").innerHTML =
          "<h3>Environment: " + escapeHtml(env || "(unknown)") + "</h3>" +
          "<div class='field'><label for='set-admins'>Admin emails (comma-separated)</label>" +
          "<input id='set-admins' value='" + escapeHtml(s.adminEmails || "") + "' />" +
          "<small class='muted'>Anyone in this list becomes admin on next sign-in. Wins over the deploy-time ADMIN_EMAILS variable.</small></div>" +
          "<div class='field'><label for='set-banner'>Site notice (shown to everyone)</label>" +
          "<textarea id='set-banner' rows='3'>" + escapeHtml(s.noticeBanner || "") + "</textarea>" +
          "<small class='muted'>Empty = no banner shown.</small></div>" +
          "<div class='field'><label class='checkbox'><input type='checkbox' id='set-pause-orgs'" +
          (s.pauseOrgRequests ? " checked" : "") +
          " /> Pause new organizer applications</label></div>" +
          "<div class='field'><label class='checkbox'><input type='checkbox' id='set-pause-regs'" +
          (s.pauseRegistrations ? " checked" : "") +
          " /> Pause new event registrations</label></div>" +
          "<div id='set-turnstile'></div>" +
          "<div class='row'>" +
          "<button type='button' id='set-save' class='btn-primary' disabled>Save settings</button>" +
          "</div>" +
          (s.updatedAt
            ? "<p class='muted'>Last updated " + escapeHtml(s.updatedAt) + " by " + escapeHtml(s.updatedBy || "") + ".</p>"
            : "");
        var token = { value: "" };
        renderTurnstile("set-turnstile", token, function (ready) {
          var b = $("#set-save");
          if (b) b.disabled = !ready;
        });
        $("#set-save").addEventListener("click", function () {
          var b = $("#set-save");
          if (!token.value) { toast("Finish the security check first.", "info"); return; }
          beginButtonLoading(b, "Saving…");
          return api("/api/admin/settings", {
            method: "PUT",
            body: JSON.stringify({
              adminEmails: $("#set-admins").value,
              noticeBanner: $("#set-banner").value,
              pauseOrgRequests: $("#set-pause-orgs").checked,
              pauseRegistrations: $("#set-pause-regs").checked,
              turnstileToken: token.value,
            }),
          })
            .then(function () {
              toast("Settings saved for " + (env || "this environment") + ".", "success");
              renderAdminSettings();
            })
            .catch(function (err) {
              toast(friendlyError(err, "Could not save settings."), "error");
            })
            .finally(function () {
              if (b && document.body.contains(b)) endButtonLoading(b, { disabled: false });
            });
        });
      })
      .catch(function (err) {
        $("#set-card").innerHTML =
          "<p>Could not load settings: " + escapeHtml(friendlyError(err, "unknown error")) + "</p>";
      });
  }

  // Admin session timeout management
  var adminActivityTimer = null;
  var ADMIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  var ADMIN_WARNING_MS = 30 * 1000; // 30 seconds warning before logout

  function resetAdminActivityTimer() {
    if (!userIsAdmin()) return;
    
    // Clear existing timers
    if (adminActivityTimer) {
      clearTimeout(adminActivityTimer);
      adminActivityTimer = null;
    }
    
    // Set new timeout
    adminActivityTimer = setTimeout(function () {
      performAdminLogout("Session expired due to inactivity.");
    }, ADMIN_TIMEOUT_MS);
  }

  function startAdminSessionTimeout() {
    if (!userIsAdmin()) return;
    
    // Reset timer on any user activity
    var events = ["mousedown", "keydown", "touchstart", "scroll", "mousemove"];
    events.forEach(function (evt) {
      document.addEventListener(evt, resetAdminActivityTimer, { passive: true });
    });
    
    // Start initial timer
    resetAdminActivityTimer();
    
    // Show warning banner
    showAdminTimeoutBanner();
  }

  function stopAdminSessionTimeout() {
    if (adminActivityTimer) {
      clearTimeout(adminActivityTimer);
      adminActivityTimer = null;
    }
    // Remove event listeners would require storing references, skipping for simplicity
    hideAdminTimeoutBanner();
  }

  function showAdminTimeoutBanner() {
    var existing = $("#admin-timeout-banner");
    if (existing) return;
    
    var banner = document.createElement("div");
    banner.id = "admin-timeout-banner";
    banner.className = "admin-timeout-banner";
    banner.innerHTML = 
      "<span>Admin session: Auto-logout in 5 min if inactive</span>" +
      "<button id='admin-extend' class='btn-ghost btn-small'>Stay signed in</button>";
    document.body.appendChild(banner);
    
    $("#admin-extend").addEventListener("click", function () {
      resetAdminActivityTimer();
      hideAdminTimeoutBanner();
      toast("Session extended.", "success");
    });
  }

  function hideAdminTimeoutBanner() {
    var banner = $("#admin-timeout-banner");
    if (banner) banner.remove();
  }

  function performAdminLogout(reason) {
    stopAdminSessionTimeout();
    api("/api/auth/logout", { method: "POST" })
      .then(function () {
        state.user = null;
        state.calendarBadges = [];
        updateAuthUi();
        if (reason) setFlash(reason, "info");
        renderHome();
      })
      .catch(function () {
        state.user = null;
        updateAuthUi();
        renderHome();
      });
  }

  function attachAdminLogoutHandler() {
    var logoutBtn = $("#admin-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        performAdminLogout("Signed out successfully.");
      });
    }
  }

  function boot() {
    applyTheme(getTheme());
    var n = new Date();
    state.calendarMonth = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
    initCalendarStripOnce();
    wireModalClose();
    document.addEventListener("click", function (e) {
      var raw = e.target;
      var closeEl = raw instanceof HTMLElement ? raw.closest("[data-cal-drawer-close]") : null;
      if (closeEl) {
        e.preventDefault();
        closeCalendarDrawer();
        return;
      }
      var t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.id === "btn-more") {
        e.preventDefault();
        loadMoreEvents();
        return;
      }
      var rid = t.getAttribute("data-native-register");
      if (rid) {
        e.preventDefault();
        openContributionFlow(rid, "register");
        return;
      }
      var iid = t.getAttribute("data-interest");
      if (iid) {
        e.preventDefault();
        openContributionFlow(iid, "interest");
        return;
      }
      var cid = t.getAttribute("data-contribute");
      if (cid) {
        e.preventDefault();
        openContributionFlow(cid, "contribute");
        return;
      }
      var accTrigger = t.closest("[data-accordion-trigger]");
      if (accTrigger) {
        e.preventDefault();
        var acc = accTrigger.closest("[data-accordion]");
        if (acc) {
          var open = acc.classList.toggle("is-open");
          accTrigger.setAttribute("aria-expanded", open ? "true" : "false");
          var panel = acc.querySelector("[data-accordion-panel]");
          if (panel) panel.setAttribute("aria-hidden", open ? "false" : "true");
        }
        return;
      }
      var shareBtn = t.closest("[data-share-toggle]");
      if (shareBtn) {
        e.preventDefault();
        e.stopPropagation();
        var wrap = shareBtn.closest(".event-card__share");
        if (wrap) {
          var isOpen = !wrap.classList.contains("is-open");
          closeEventSharePopups(wrap);
          if (isOpen) {
            wrap.classList.add("is-open");
            shareBtn.setAttribute("aria-expanded", "true");
          }
        }
        return;
      }
      if (!t.closest(".event-card__share")) {
        closeEventSharePopups(null);
      }
    });
    $("#btn-theme").addEventListener("click", toggleTheme);
    var calBtn = $("#btn-calendar");
    if (calBtn) {
      calBtn.addEventListener("click", function () {
        var d = $("#calendar-drawer");
        if (!d) return;
        if (d.classList.contains("open")) {
          closeCalendarDrawer();
        } else {
          openCalendarDrawer();
        }
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var d = $("#calendar-drawer");
      if (d && d.classList.contains("open")) {
        e.preventDefault();
        closeCalendarDrawer();
      }
      // Close mobile nav on Escape
      var nav = $("#main-nav");
      if (nav && nav.classList.contains("open")) {
        e.preventDefault();
        closeMobileNav();
      }
    });

    // Mobile navigation toggle
    var mobileNavToggle = $("#mobile-nav-toggle");
    if (mobileNavToggle) {
      mobileNavToggle.addEventListener("click", function () {
        var nav = $("#main-nav");
        if (nav && nav.classList.contains("open")) {
          closeMobileNav();
        } else {
          openMobileNav();
        }
      });
    }

    var profileBtn = $("#btn-profile");
    if (profileBtn) {
      profileBtn.addEventListener("click", function () {
        if (state.user) {
          window.location.hash = "#/dashboard";
          route();
          closeMobileNav();
          return;
        }
        openLoginModal(function () {
          window.location.hash = "#/dashboard";
          route();
        });
      });
    }

    // Close mobile nav when clicking overlay
    var navOverlay = $("#nav-overlay");
    if (navOverlay) {
      navOverlay.addEventListener("click", closeMobileNav);
    }

    // Ensure hash routes run even when clicking the current page link (e.g. Discover on home).
    document.querySelectorAll("#main-nav a[href^='#']").forEach(function (link) {
      link.addEventListener("click", function (e) {
        var href = link.getAttribute("href") || "#/";
        var target = href.replace(/^#/, "") || "/";
        var current = (window.location.hash || "#/").replace(/^#/, "") || "/";
        if (target === current) {
          e.preventDefault();
          route();
          closeMobileNav();
        }
      });
    });

    // Close mobile nav when clicking a nav link
    var navLinks = document.querySelectorAll("#main-nav a, #main-nav button");
    navLinks.forEach(function(link) {
      link.addEventListener("click", function(e) {
        var href = link.getAttribute("href") || "";
        if ((href === "#/organize" || href === "#/dashboard") && !state.user) {
          e.preventDefault();
          openLoginModal(function () {
            window.location.hash = href;
            route();
          });
        }
        closeMobileNav();
      });
    });

    function handleLogout(btn) {
      beginButtonLoading(btn, "Signing out…");
      return api("/api/auth/logout", { method: "POST" })
        .then(function () {
          state.user = null;
          state.calendarBadges = [];
          updateAuthUi();
          closeMobileNav();
          route();
        })
        .finally(function () {
          if (btn && document.body.contains(btn)) {
            endButtonLoading(btn, { disabled: false });
          }
        });
    }

    $("#btn-login").addEventListener("click", function () {
      openLoginModal();
    });
    $("#btn-logout").addEventListener("click", function () {
      handleLogout($("#btn-logout"));
    });
    var logoutNav = $("#btn-logout-nav");
    if (logoutNav) {
      logoutNav.addEventListener("click", function () {
        handleLogout(logoutNav);
      });
    }
    return loadConfig()
      .then(loadFooterStats)
      .then(loadMe)
      .then(route)
      .catch(function (e) {
        setFlash(e.message || "Boot failed", "error");
        route();
      });
  }

  window.addEventListener("hashchange", route);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
