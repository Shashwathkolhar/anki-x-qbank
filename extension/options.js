const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  apiKey: "",
  mode: "api",
  model: "claude-haiku-4-5-20251001",
  deck: "",
  tag: "qbank",
  prefetch: true,
  pasteShot: true,
  pasteField: "Lecture Notes",
};

function setStatus(text, ok) {
  const el = $("status");
  el.textContent = text;
  el.className = ok ? "ok" : "err";
  if (text) setTimeout(() => (el.textContent = ""), 4000);
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("tag").value = s.tag;
  $("prefetch").checked = !!s.prefetch;
  $("pasteShot").checked = !!s.pasteShot;
  $("pasteField").value = s.pasteField;
  const radio = document.querySelector(`input[name=mode][value="${s.mode}"]`);
  if (radio) radio.checked = true;
  // Keep the saved deck selectable even before decks are loaded from Anki.
  if (s.deck) {
    const opt = document.createElement("option");
    opt.value = s.deck;
    opt.textContent = s.deck;
    $("deck").appendChild(opt);
    $("deck").value = s.deck;
  }
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    mode: document.querySelector("input[name=mode]:checked")?.value || "api",
    model: $("model").value,
    deck: $("deck").value,
    tag: $("tag").value.trim(),
    prefetch: $("prefetch").checked,
    pasteShot: $("pasteShot").checked,
    pasteField: $("pasteField").value,
  });
  setStatus("Saved ✓", true);
});

$("loadDecks").addEventListener("click", async () => {
  try {
    const res = await fetch("http://127.0.0.1:8765", {
      method: "POST",
      body: JSON.stringify({ action: "deckNames", version: 6 }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const current = $("deck").value;
    $("deck").innerHTML = '<option value="">All decks</option>';
    for (const name of data.result.sort()) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      $("deck").appendChild(opt);
    }
    $("deck").value = data.result.includes(current) ? current : "";
    setStatus(`Loaded ${data.result.length} decks ✓`, true);
  } catch (e) {
    setStatus("Couldn't reach Anki — is it open with AnkiConnect installed?", false);
  }
});

load();
