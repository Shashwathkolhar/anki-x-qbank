// Runs on every page but stays dormant unless this site is enabled.
// Mehlman is enabled by default; other sites (YouTube, other qbanks) are
// toggled per-site from the extension popup. The popup's "Find Anki cards"
// button works everywhere via a "trigger" message, enabled or not.

(() => {
  if (window.__qbankAnkiLoaded) return;
  window.__qbankAnkiLoaded = true;

  const HOST = location.hostname.replace(/^www\./, "");
  const IS_DEFAULT_SITE =
    HOST === "mehlmanmedical.com" || HOST.endsWith(".mehlmanmedical.com");
  const IS_YOUTUBE = HOST === "youtube.com" || HOST.endsWith(".youtube.com");
  // Google Docs draws the document on canvas — no DOM text, so always send a
  // screenshot there, like on YouTube.
  const IS_GDOCS = HOST === "docs.google.com";

  let siteButton = false;
  let sitePrefetch = false;
  let btn = null;
  let lastShot = null; // screenshot the current match was based on (if any)
  let lastRegions = null; // crop boxes (question/options) for that screenshot
  let lastRunRegion = null; // snip region of the current run, for the ↻ button
  let lastFacts = []; // facts of the current run, pasted as text into the note
  let running = false;

  function getVideoId() {
    try {
      return new URLSearchParams(location.search).get("v") || location.pathname;
    } catch {
      return location.href;
    }
  }

  // ---------- floating button (created only when the site is enabled) ----------

  function ensureFab() {
    if (btn) return;
    btn = document.createElement("button");
    btn.id = "qa-fab";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="#fff" d="M12 1.8c.35 0 .67.21.81.53l2.29 5.2 5.66.55c.72.07 1.01.96.47 1.44l-4.26 3.79 1.24 5.55c.16.7-.6 1.25-1.22.89L12 16.85l-4.99 2.9c-.62.36-1.38-.19-1.22-.89l1.24-5.55-4.26-3.79c-.54-.48-.25-1.37.47-1.44l5.66-.55 2.29-5.2c.14-.32.46-.53.81-.53z"/>
      </svg>`;
    btn.title =
      "Find Anki cards: matches this content against your suspended AnKing cards.\nRight-click: snip a region (e.g. the question in a video) for Claude to read.\nTip: select text first to search just that.";
    btn.addEventListener("click", () => findMatches());
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      startSnip();
    });
    document.documentElement.appendChild(btn);
  }

  function removeFab() {
    btn?.remove();
    btn = null;
  }

  async function applySiteSettings() {
    try {
      const { sites = {} } = await chrome.storage.local.get({ sites: {} });
      const cfg = sites[HOST] || {};
      siteButton = cfg.button ?? IS_DEFAULT_SITE;
      sitePrefetch = cfg.prefetch ?? IS_DEFAULT_SITE;
    } catch {
      siteButton = IS_DEFAULT_SITE;
      sitePrefetch = IS_DEFAULT_SITE;
    }
    if (siteButton) ensureFab();
    else removeFab();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.sites) applySiteSettings();
  });

  // ---------- overlay ----------

  const overlay = document.createElement("div");
  overlay.id = "qa-overlay";
  overlay.hidden = true;
  document.documentElement.appendChild(overlay);

  function render(html) {
    overlay.innerHTML = html;
    overlay.hidden = false;
  }

  function close() {
    overlay.hidden = true;
    overlay.innerHTML = "";
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function modelLabel(m) {
    if (!m) return "";
    if (m === "basic") return "keyword mode (no AI)";
    if (m.includes("opus")) return "Opus";
    if (m.includes("sonnet")) return "Sonnet";
    if (m.includes("haiku")) return "Haiku";
    return m;
  }

  // ---------- page text extraction ----------

  function getYouTubeText() {
    const parts = [];
    const title =
      document.querySelector("ytd-watch-metadata h1")?.innerText ||
      document.title.replace(/ - YouTube$/, "");
    if (title) parts.push("VIDEO TITLE: " + title.trim());
    const desc = document.querySelector("ytd-watch-metadata #description")?.innerText;
    if (desc) parts.push("DESCRIPTION: " + desc.trim().slice(0, 1500));
    const transcript = [...document.querySelectorAll("ytd-transcript-segment-renderer")]
      .map((el) => el.innerText.replace(/^\s*[\d:]+\s*/, "").trim())
      .filter(Boolean)
      .join(" ");
    if (transcript) parts.push("TRANSCRIPT: " + transcript.slice(0, 6000));
    return parts.join("\n\n");
  }

  // The on-screen bounds of the playing video (viewport-clamped), so YouTube
  // captures crop to just the frame — no sidebar/comments noise.
  function videoRegion() {
    const v = document.querySelector("video");
    if (!v) return null;
    const r = v.getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const w = Math.min(window.innerWidth, r.right) - x;
    const h = Math.min(window.innerHeight, r.bottom) - y;
    if (w < 200 || h < 120) return null; // mini-player/offscreen — use full tab
    return { x, y, w, h, vw: window.innerWidth };
  }

  function getPageText() {
    const sel = window.getSelection()?.toString().trim();
    if (sel && sel.length > 40) return sel;
    if (IS_GDOCS) return "GOOGLE DOC TITLE: " + document.title.replace(/ - Google Docs$/, "");
    if (IS_YOUTUBE) return getYouTubeText();
    const main =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.querySelector("#content") ||
      document.body;
    return main.innerText.trim();
  }

  // ---------- snip mode (right-click the star) ----------

  function startSnip() {
    if (document.getElementById("qa-snip")) return;
    close();
    const snip = document.createElement("div");
    snip.id = "qa-snip";
    const box = document.createElement("div");
    box.id = "qa-snip-box";
    const hint = document.createElement("div");
    hint.id = "qa-snip-hint";
    hint.textContent = "Drag a box around the question + options — Esc to cancel";
    snip.append(box, hint);
    document.documentElement.appendChild(snip);

    let sx = 0, sy = 0, dragging = false;

    const cleanup = () => {
      snip.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
      }
    };
    document.addEventListener("keydown", onKey, true);

    snip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      box.style.display = "block";
      box.style.left = sx + "px";
      box.style.top = sy + "px";
      box.style.width = "0px";
      box.style.height = "0px";
    });
    snip.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      box.style.left = Math.min(sx, e.clientX) + "px";
      box.style.top = Math.min(sy, e.clientY) + "px";
      box.style.width = Math.abs(e.clientX - sx) + "px";
      box.style.height = Math.abs(e.clientY - sy) + "px";
    });
    snip.addEventListener("mouseup", (e) => {
      if (!dragging) return;
      const region = {
        x: Math.min(sx, e.clientX),
        y: Math.min(sy, e.clientY),
        w: Math.abs(e.clientX - sx),
        h: Math.abs(e.clientY - sy),
        vw: window.innerWidth,
      };
      cleanup();
      if (region.w < 20 || region.h < 20) return; // accidental click
      // Hide our UI, let the page repaint, then capture-and-match.
      if (btn) btn.style.visibility = "hidden";
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          findMatches(region);
          setTimeout(() => {
            if (btn) btn.style.visibility = "";
          }, 400);
        })
      );
    });
  }

  // ---------- flows ----------

  async function findMatches(region = null, force = false) {
    lastShot = null;
    lastRegions = null;
    lastRunRegion = region;
    running = true;
    try {
    let settled = false;
    const showSpinner = () => {
      if (settled) return;
      render(`
        <div class="qa-head"><span>Qbank → Anki</span>
          <button class="qa-x" id="qa-close">✕</button></div>
        <div class="qa-body qa-center">
          <div class="qa-spinner"></div>
          <p>Matching cards…<br><small>instant if prefetched, otherwise a few seconds</small></p>
        </div>`);
      wireClose();
    };
    // While searching, the star button itself spins instead of opening a
    // panel — the panel only appears with results, errors, or confirmations.
    // (Fallback to the panel spinner when there's no button, e.g. a
    // popup-triggered run on a site without the floating star.)
    if (btn) {
      close();
      btn.classList.add("qa-loading");
    } else if (region) {
      // Delay so the spinner can't sneak into the screenshot being captured.
      setTimeout(showSpinner, 350);
    } else {
      showSpinner();
    }

    const text = getPageText();
    // A screenshot is sent for snips and on YouTube, so thin page text is
    // fine there — elsewhere we need real text to work with.
    if (!region && !IS_YOUTUBE && !IS_GDOCS && (!text || text.length < 60)) {
      renderError(
        "Couldn't find enough question text on this page. Try selecting the question + explanation text first, then click the button again."
      );
      return;
    }

    // On YouTube with no manual snip, auto-crop the capture to the video
    // element's on-screen bounds.
    const sendRegion = region || (IS_YOUTUBE ? videoRegion() : null);
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: "findMatches",
        text,
        screenshot: IS_YOUTUBE || IS_GDOCS || !!sendRegion,
        region: sendRegion,
        force,
        // Auto flow on YouTube shares one cached run per video with the
        // prefetcher; a manual snip always runs fresh.
        cacheKey: IS_YOUTUBE && !region ? "yt:" + getVideoId() : undefined,
      });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    settled = true;
    lastShot = res?.shot || null;
    lastRegions = res?.regions?.length ? res.regions : null;
    if (!res?.ok) {
      const msg = res?.error || "Unknown error.";
      renderError(
        /context invalidated/i.test(msg)
          ? "The extension was updated. Refresh this page (⌘R) to reconnect, then click again."
          : msg
      );
      return;
    }

    const { facts = [], candidates = [], answer = "" } = res;
    lastFacts = facts;
    const answerHtml = answer
      ? `<div class="qa-answer">🎯 ${esc(answer)}</div>`
      : "";
    if (!candidates.length) {
      const noQuestion = !facts.length;
      const searched = res.debug?.notesFound ?? 0;
      render(`
        <div class="qa-head"><span>Qbank → Anki</span>
          <button class="qa-x" id="qa-close">✕</button></div>
        <div class="qa-body">
          ${answerHtml}
          <p><strong>${noQuestion ? "Couldn't read a question here." : "No suspended cards matched."}</strong></p>
          <p class="qa-muted">${
            noQuestion
              ? "Claude didn't identify question content. Try right-clicking the star to snip the question area, or select the question text and click again."
              : "Either these cards are already unsuspended, or the deck doesn't cover this fact."
          }</p>
          ${factsHtml(facts)}
          <p class="qa-muted" style="font-size:11px">${facts.length} facts · ${searched} candidate notes searched${res.model ? " · answered by " + esc(modelLabel(res.model)) : ""}</p>
          ${MAKE_HTML}
        </div>`);
      wireClose();
      wireMake(answer, facts);
      return;
    }

    const row = (c, checked) =>
      c.already
        ? `
        <div class="qa-row qa-already-row">
          <span class="qa-done">✓</span>
          <span class="qa-badge qa-${c.confidence}">${c.confidence}</span>
          <span class="qa-card-text">${esc(c.text)}
            <small class="qa-muted">already unsuspended — in your rotation</small></span>
        </div>`
        : `
        <label class="qa-row">
          <input type="checkbox" data-note="${c.noteId}" ${checked ? "checked" : ""}>
          <span class="qa-badge qa-${c.confidence}">${c.confidence}</span>
          <span class="qa-card-text">${esc(c.text)}
            <small class="qa-muted">${esc(c.why)}</small></span>
        </label>`;
    // Correct-answer cards first (pre-checked when high confidence); cards
    // about the other answer choices in their own section, unchecked.
    const answerCards = candidates.filter((c) => c.group !== "option");
    const optionCards = candidates.filter((c) => c.group === "option");
    const rows =
      answerCards.length && optionCards.length
        ? `<div class="qa-sect">Correct answer</div>` +
          answerCards.map((c) => row(c, c.confidence === "high")).join("") +
          `<div class="qa-sect">Other options</div>` +
          optionCards.map((c) => row(c, false)).join("")
        : candidates.map((c) => row(c, c.confidence === "high")).join("");

    render(`
      <div class="qa-head"><span>Qbank → Anki — ${candidates.length} match${candidates.length === 1 ? "" : "es"}</span>
        <button class="qa-x" id="qa-close">✕</button></div>
      <div class="qa-body">
        ${answerHtml}
        ${factsHtml(facts)}
        <label class="qa-selectall">
          <input type="checkbox" id="qa-select-all">
          Select everything
        </label>
        <div class="qa-list">${rows}</div>
        ${res.model ? `<p class="qa-muted" style="font-size:11px;margin:8px 0 0">answered by ${esc(modelLabel(res.model))}</p>` : ""}
        ${MAKE_HTML}
      </div>
      <div class="qa-foot">
        <button id="qa-unsuspend" class="qa-primary">Unsuspend selected</button>
        <button id="qa-cancel">Cancel</button>
      </div>`);
    wireClose();
    wireMake(answer, facts);
    const selectAll = overlay.querySelector("#qa-select-all");
    const rowBoxes = () => [...overlay.querySelectorAll(".qa-list input[type=checkbox]")];
    selectAll.checked = rowBoxes().every((b) => b.checked);
    selectAll.onchange = () => rowBoxes().forEach((b) => (b.checked = selectAll.checked));
    // Keep the master checkbox honest when individual rows are toggled.
    rowBoxes().forEach((b) => {
      b.addEventListener("change", () => {
        selectAll.checked = rowBoxes().every((x) => x.checked);
      });
    });
    overlay.querySelector("#qa-cancel").onclick = close;
    overlay.querySelector("#qa-unsuspend").onclick = async () => {
      const noteIds = [...overlay.querySelectorAll(".qa-list input:checked")]
        .map((el) => Number(el.dataset.note))
        .filter(Number.isFinite);
      if (!noteIds.length) return close();
      overlay.querySelector("#qa-unsuspend").disabled = true;
      overlay.querySelector("#qa-unsuspend").textContent = "Unsuspending…";
      // No stored screenshot (text-based match)? The background may capture
      // the viewport for the Lecture Notes paste — hide our UI first so it
      // doesn't photobomb the note.
      if (!lastShot) {
        overlay.style.visibility = "hidden";
        if (btn) btn.style.visibility = "hidden";
        await new Promise((r2) =>
          requestAnimationFrame(() => requestAnimationFrame(r2))
        );
      }
      let r;
      try {
        r = await chrome.runtime.sendMessage({
          type: "unsuspend",
          noteIds,
          shot: lastShot,
          capture: !lastShot,
          regions: lastRegions,
          facts: lastFacts,
        });
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      overlay.style.visibility = "";
      if (btn) btn.style.visibility = "";
      if (!r?.ok) {
        const m = r?.error || "Unknown error.";
        return renderError(
          /context invalidated/i.test(m)
            ? "The extension was updated. Refresh this page (⌘R) to reconnect, then click again."
            : m
        );
      }
      render(`
        <div class="qa-head"><span>Qbank → Anki</span>
          <button class="qa-x" id="qa-close">✕</button></div>
        <div class="qa-body qa-center">
          <p style="font-size:28px;margin:8px 0">✅</p>
          <p><strong>${r.cards} card${r.cards === 1 ? "" : "s"} unsuspended</strong>${
            r.tag ? `<br><small class="qa-muted">tagged <code>${esc(r.tag)}</code></small>` : ""
          }${
            r.pasted
              ? `<br><small class="qa-muted">📸 screenshot added to ${esc(r.pasteField)} on ${r.pasted} note${r.pasted === 1 ? "" : "s"}</small>`
              : r.pasteError
                ? `<br><small class="qa-muted">⚠️ screenshot not pasted: ${esc(r.pasteError)}</small>`
                : ""
          }</p>
        </div>`);
      wireClose();
      setTimeout(close, 2500);
    };
    } finally {
      running = false;
      btn?.classList.remove("qa-loading");
    }
  }

  const MAKE_HTML = `
    <div class="qa-make">
      <button id="qa-make" class="qa-make-btn">Make a card from this question</button>
      <div id="qa-make-area"></div>
    </div>`;

  // "Make a card": the AI drafts one cloze card from this question's clues;
  // you can edit it, then it's added to Anki with the usual screenshot+facts.
  function wireMake(answer, facts) {
    const makeBtn = overlay.querySelector("#qa-make");
    const area = overlay.querySelector("#qa-make-area");
    if (!makeBtn || !area) return;
    makeBtn.onclick = async () => {
      makeBtn.disabled = true;
      area.innerHTML = `<p class="qa-muted">Writing a card…</p>`;
      let r;
      try {
        r = await chrome.runtime.sendMessage({
          type: "makeCard",
          text: getPageText(),
          shot: lastShot,
          answer,
          facts,
        });
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      if (!r?.ok) {
        area.innerHTML = `<p class="qa-muted">⚠️ ${esc(r?.error || "Unknown error")}</p>`;
        makeBtn.disabled = false;
        return;
      }
      area.innerHTML = `
        <label class="qa-mk-label">Card (cloze)</label>
        <textarea id="qa-mk-text" rows="3">${esc(r.text)}</textarea>
        <label class="qa-mk-label">Extra</label>
        <textarea id="qa-mk-extra" rows="2">${esc(r.extra || "")}</textarea>
        <div class="qa-mk-actions">
          <button id="qa-mk-add" class="qa-primary">Add to Anki</button>
          <button id="qa-mk-cancel">Cancel</button>
        </div>`;
      overlay.querySelector("#qa-mk-cancel").onclick = () => {
        area.innerHTML = "";
        makeBtn.disabled = false;
      };
      overlay.querySelector("#qa-mk-add").onclick = async () => {
        const addBtn = overlay.querySelector("#qa-mk-add");
        addBtn.disabled = true;
        addBtn.textContent = "Adding…";
        const payload = {
          type: "addCard",
          text: overlay.querySelector("#qa-mk-text").value,
          extra: overlay.querySelector("#qa-mk-extra").value,
          shot: lastShot,
          regions: lastRegions,
          facts: lastFacts,
          capture: !lastShot,
        };
        // No stored screenshot? Hide our UI so a fresh capture stays clean.
        if (!lastShot) {
          overlay.style.visibility = "hidden";
          if (btn) btn.style.visibility = "hidden";
          await new Promise((r2) => requestAnimationFrame(() => requestAnimationFrame(r2)));
        }
        let a;
        try {
          a = await chrome.runtime.sendMessage(payload);
        } catch (e) {
          a = { ok: false, error: e.message };
        }
        overlay.style.visibility = "";
        if (btn) btn.style.visibility = "";
        if (a?.ok) {
          area.innerHTML = `<p class="qa-muted">✅ Card added to "${esc(a.deck)}"</p>`;
        } else {
          area.innerHTML = `<p class="qa-muted">⚠️ ${esc(a?.error || "Unknown error")}</p>`;
          makeBtn.disabled = false;
        }
      };
    };
  }

  function factsHtml(facts) {
    if (!facts.length) return "";
    return `<details class="qa-facts"><summary>Facts detected (${facts.length})</summary>
      <ul>${facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>`;
  }

  function renderError(message) {
    render(`
      <div class="qa-head"><span>Qbank → Anki</span>
        <button class="qa-x" id="qa-close">✕</button></div>
      <div class="qa-body">
        <p><strong>⚠️ Something went wrong</strong></p>
        <p class="qa-muted">${esc(message)}</p>
      </div>`);
    wireClose();
  }

  function wireClose() {
    const x = overlay.querySelector("#qa-close");
    if (x) x.onclick = close;
    // Add the ↻ fresh-run button to whatever header just rendered.
    const head = overlay.querySelector(".qa-head");
    if (head && x && !overlay.querySelector("#qa-refresh")) {
      const r = document.createElement("button");
      r.className = "qa-x";
      r.id = "qa-refresh";
      r.title = "Re-check this question (fresh run, ignores cache)";
      r.textContent = "↻";
      head.insertBefore(r, x);
      r.onclick = () => {
        if (!running) findMatches(lastRunRegion, true);
      };
    }
  }

  // ---------- prefetch: warm the cache while you read ----------
  // Only on sites where the button is enabled AND per-site prefetch is on.

  let lastPrefetched = "";
  function maybePrefetch() {
    if (!siteButton || !sitePrefetch) return;
    if (IS_YOUTUBE) return; // YouTube prefetch is video-event driven below
    const text = getPageText();
    if (!text || text.length < 200 || text === lastPrefetched) return;
    lastPrefetched = text;
    try {
      chrome.runtime.sendMessage({ type: "prefetch", text }, () => void chrome.runtime.lastError);
    } catch {
      /* extension reloaded; ignore */
    }
  }

  let prefetchTimer;
  new MutationObserver(() => {
    if (!siteButton || !sitePrefetch) return;
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(maybePrefetch, 1500);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // ---------- YouTube prefetch: pause / near-end / ended ----------
  // Captures the frame and runs the whole match while you're still watching,
  // so the click at the end of the video is instant.

  if (IS_YOUTUBE) {
    let lastYtPrefetch = 0;
    const ytPrefetch = () => {
      if (!siteButton || !sitePrefetch) return;
      if (document.visibilityState !== "visible") return; // wrong-tab captures
      const now = Date.now();
      if (now - lastYtPrefetch < 10000) return;
      lastYtPrefetch = now;
      try {
        chrome.runtime.sendMessage(
          {
            type: "prefetch",
            text: getPageText(),
            screenshot: true,
            region: videoRegion(),
            cacheKey: "yt:" + getVideoId(),
          },
          () => void chrome.runtime.lastError
        );
      } catch {
        /* extension reloaded; ignore */
      }
    };
    // Media events don't bubble, but they do reach capture-phase listeners.
    document.addEventListener(
      "pause",
      (e) => e.target.tagName === "VIDEO" && ytPrefetch(),
      true
    );
    document.addEventListener(
      "ended",
      (e) => e.target.tagName === "VIDEO" && ytPrefetch(),
      true
    );
    let fired90For = "";
    document.addEventListener(
      "timeupdate",
      (e) => {
        const v = e.target;
        if (v.tagName !== "VIDEO" || !v.duration) return;
        if (v.currentTime / v.duration >= 0.9 && fired90For !== getVideoId()) {
          fired90For = getVideoId();
          ytPrefetch();
        }
      },
      true
    );
  }

  // ---------- boot + popup trigger ----------

  applySiteSettings().then(() => setTimeout(maybePrefetch, 1200));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "trigger") {
      findMatches();
      sendResponse({ ok: true });
    } else if (msg?.type === "ping") {
      sendResponse({ ok: true });
    }
  });
})();
