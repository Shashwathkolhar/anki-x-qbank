const $ = (id) => document.getElementById(id);

let tab = null;
let host = "";
let builtIn = false;

function norm(h) {
  return (h || "").replace(/^www\./, "");
}

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let usable = false;
  try {
    const url = new URL(tab.url);
    usable = ["http:", "https:", "file:"].includes(url.protocol);
    host = norm(url.hostname);
  } catch {
    /* chrome:// pages etc. */
  }

  if (!usable) {
    $("host").textContent = "";
    $("btnToggle").disabled = true;
    $("pfToggle").disabled = true;
    $("find").disabled = true;
    $("na").hidden = false;
    return;
  }
  if (!host) {
    // Local file (e.g. a PDF): Find works via screenshot mode, but there is
    // no site to toggle the floating button on.
    $("host").textContent = "local file";
    $("btnToggle").disabled = true;
    $("pfToggle").disabled = true;
    return;
  }

  builtIn =
    host === "mehlmanmedical.com" || host.endsWith(".mehlmanmedical.com");
  $("host").textContent = host;
  $("builtin").hidden = !builtIn;

  const { sites = {} } = await chrome.storage.local.get({ sites: {} });
  const cfg = sites[host] || {};
  $("btnToggle").checked = cfg.button ?? builtIn;
  $("pfToggle").checked = cfg.prefetch ?? builtIn;
  syncPf();
}

function syncPf() {
  // Prefetch only makes sense where the button is on.
  $("pfToggle").disabled = !$("btnToggle").checked;
  if (!$("btnToggle").checked) $("pfToggle").checked = false;
}

async function save() {
  const { sites = {} } = await chrome.storage.local.get({ sites: {} });
  sites[host] = {
    button: $("btnToggle").checked,
    prefetch: $("pfToggle").checked,
  };
  await chrome.storage.local.set({ sites });
}

$("btnToggle").addEventListener("change", () => {
  syncPf();
  save();
});
$("pfToggle").addEventListener("change", save);

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// Fallback for pages where no content script can live (Chrome's PDF viewer,
// etc.): capture the visible page and show the matches inside the popup.
let popupShot = null;
let popupRegions = null;
let popupFacts = [];

async function popupFind() {
  const box = $("results");
  box.hidden = false;
  box.innerHTML = '<div class="muted">📸 Reading the page… (a few seconds)</div>';
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "popupFind", windowId: tab.windowId });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  if (!res?.ok) {
    box.innerHTML = `<div class="muted">⚠️ ${esc(res?.error || "Unknown error")}</div>`;
    return;
  }
  popupShot = res.shot || null;
  popupRegions = res.regions?.length ? res.regions : null;
  popupFacts = res.facts || [];
  const { answer = "", candidates = [] } = res;
  const answerHtml = answer ? `<div class="answer">🎯 ${esc(answer)}</div>` : "";
  if (!candidates.length) {
    box.innerHTML = answerHtml + '<div class="muted">No suspended cards matched this page.</div>';
    return;
  }
  box.innerHTML =
    answerHtml +
    '<div class="list">' +
    candidates
      .map((c) =>
        c.already
          ? `
      <div class="row" style="opacity:.7">
        <span style="color:#047857;font-weight:700">✓</span>
        <span class="badge ${c.confidence}">${c.confidence}</span>
        <span>${esc(c.text)}<br><span class="muted">already unsuspended — in your rotation</span></span>
      </div>`
          : `
      <label class="row">
        <input type="checkbox" data-note="${c.noteId}" ${c.confidence === "high" && c.group !== "option" ? "checked" : ""}>
        <span class="badge ${c.confidence}">${c.confidence}</span>
        <span>${esc(c.text)}<br><span class="muted">${esc(c.why)}</span></span>
      </label>`
      )
      .join("") +
    '</div><button class="unsuspend" id="popupUnsuspend">Unsuspend selected</button>';
  $("popupUnsuspend").addEventListener("click", async () => {
    const noteIds = [...box.querySelectorAll("input:checked")].map((el) => Number(el.dataset.note));
    if (!noteIds.length) return;
    $("popupUnsuspend").disabled = true;
    $("popupUnsuspend").textContent = "Unsuspending…";
    let r;
    try {
      r = await chrome.runtime.sendMessage({
        type: "unsuspend",
        noteIds,
        shot: popupShot,
        regions: popupRegions,
        facts: popupFacts,
        capture: false,
      });
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    box.innerHTML = r?.ok
      ? `<div class="muted">✅ ${r.cards} card${r.cards === 1 ? "" : "s"} unsuspended${r.pasted ? ` · 📸 screenshot added to ${esc(r.pasteField)}` : ""}</div>`
      : `<div class="muted">⚠️ ${esc(r?.error || "Unknown error")}</div>`;
  });
}

$("find").addEventListener("click", async () => {
  // If a content script lives in this page, use the on-page panel.
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ping" });
    await chrome.tabs.sendMessage(tab.id, { type: "trigger" });
    window.close();
    return;
  } catch {}
  // Not there yet — try injecting (first run after install/reload).
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "trigger" });
    window.close();
    return;
  } catch {}
  // No script can live here (PDF viewer etc.) — screenshot mode in the popup.
  popupFind();
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("ver").textContent = "v" + chrome.runtime.getManifest().version;

load();
