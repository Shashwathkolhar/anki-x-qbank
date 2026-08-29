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
    usable = url.protocol === "http:" || url.protocol === "https:";
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

$("find").addEventListener("click", async () => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "trigger" });
  } catch {
    // Content script not there yet (extension just installed/reloaded):
    // inject on demand, then trigger.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "trigger" });
    } catch (e) {
      $("na").textContent = "Couldn't run on this page: " + e.message;
      $("na").hidden = false;
      return;
    }
  }
  window.close();
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("ver").textContent = "v" + chrome.runtime.getManifest().version;

load();
