// Service worker: talks to the Claude API and AnkiConnect.
// The content script sends {type: "findMatches", text} and later
// {type: "unsuspend", noteIds}.

const ANKI_URL = "http://127.0.0.1:8765";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_CANDIDATES = 40;
const RANK_SKIP_THRESHOLD = 5; // few enough candidates → show all, skip the ranking call

// ---------- settings ----------

async function getSettings() {
  const defaults = {
    apiKey: "",
    mode: "api",
    model: DEFAULT_MODEL,
    deck: "",
    tag: "qbank",
    prefetch: true,
    pasteShot: true,
    pasteField: "Lecture Notes",
  };
  const stored = await chrome.storage.local.get(defaults);
  return { ...defaults, ...stored };
}

// ---------- AnkiConnect ----------

async function anki(action, params = {}) {
  let res;
  try {
    res = await fetch(ANKI_URL, {
      method: "POST",
      body: JSON.stringify({ action, version: 6, params }),
    });
  } catch (e) {
    throw new Error(
      "Could not reach Anki. Make sure Anki is open and the AnkiConnect add-on is installed."
    );
  }
  const data = await res.json();
  if (data.error) throw new Error("AnkiConnect: " + data.error);
  return data.result;
}

// ---------- Claude ----------

async function claude(settings, system, userText, maxTokens = 1500, imageB64 = null) {
  const userContent = imageB64
    ? [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: imageB64 },
        },
        { type: "text", text: userText },
      ]
    : userText;
  const res = await fetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.model || DEFAULT_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [
        { role: "user", content: userContent },
        // Prefill "{" so the reply can only continue as JSON.
        { role: "assistant", content: "{" },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return "{" + (data.content?.[0]?.text ?? "");
}

// ---------- screenshot (for video-based questions, e.g. YouTube) ----------

async function captureTab(windowId, region = null) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "jpeg",
    quality: 85,
  });
  const blob = await (await fetch(dataUrl)).blob();
  let bmp = await createImageBitmap(blob);
  // Crop to the snipped region (CSS px → capture px via the width ratio).
  if (region?.w > 5 && region?.h > 5 && region.vw) {
    const s = bmp.width / region.vw;
    const sx = Math.max(0, Math.round(region.x * s));
    const sy = Math.max(0, Math.round(region.y * s));
    const sw = Math.min(bmp.width - sx, Math.round(region.w * s));
    const sh = Math.min(bmp.height - sy, Math.round(region.h * s));
    if (sw > 10 && sh > 10) bmp = await createImageBitmap(bmp, sx, sy, sw, sh);
  }
  // Downscale to ~1568px wide (vision sweet spot) to keep requests fast.
  const scale = Math.min(1, 1568 / bmp.width);
  const canvas = new OffscreenCanvas(
    Math.round(bmp.width * scale),
    Math.round(bmp.height * scale)
  );
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function parseJson(text) {
  // Strip code fences and grab the first {...} block.
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Claude returned no JSON.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------- text utils ----------

function stripHtml(html) {
  return html
    .replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, "$1") // cloze -> answer text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function noteText(note) {
  const fields = note.fields || {};
  const preferred = fields.Text || fields.Front || Object.values(fields)[0];
  return stripHtml(preferred?.value || "").slice(0, 220);
}

// Stitch the question/options crop boxes (percent units, from stage 1) out
// of the captured frame into one clean image — faces and decorations gone.
async function composeCrops(shotB64, boxes) {
  const blob = await (await fetch("data:image/jpeg;base64," + shotB64)).blob();
  const bmp = await createImageBitmap(blob);
  const pad = 1.5; // percent padding so tight boxes don't clip letters
  const rects = boxes
    .map(([x, y, w, h]) => {
      const px = Math.max(0, ((x - pad) / 100) * bmp.width);
      const py = Math.max(0, ((y - pad) / 100) * bmp.height);
      return {
        px,
        py,
        pw: Math.min(bmp.width - px, ((w + pad * 2) / 100) * bmp.width),
        ph: Math.min(bmp.height - py, ((h + pad * 2) / 100) * bmp.height),
      };
    })
    // Degenerate boxes → distrust them and keep the full shot instead.
    .filter((r) => r.pw > bmp.width * 0.15 && r.ph > bmp.height * 0.04);
  if (!rects.length) return shotB64;

  const GAP = 14;
  const W = Math.round(Math.max(...rects.map((r) => r.pw)));
  const H = Math.round(rects.reduce((s, r) => s + r.ph, 0) + GAP * (rects.length - 1));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  let y = 0;
  for (const r of rects) {
    ctx.drawImage(bmp, r.px, r.py, r.pw, r.ph, 0, y, r.pw, r.ph);
    y += r.ph + GAP;
  }
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ---------- basic mode: keyword extraction without any API ----------

const STOPWORDS = new Set(
  ("the and for with that this from have has had been was were are is not most likely following which " +
    "patient patients history physical examination exam shows show reveals revealed presents presented brought " +
    "because year years old woman man boy girl male female normal findings finding laboratory testing tests test " +
    "blood levels level mild moderate severe acute chronic diagnosis management treatment next best step likely " +
    "unlikely denies notes noted also well been being upon after before during without within these those there " +
    "their they when what where would should could between however despite additional past medical surgical " +
    "family social medications medication known takes taking recent recently vital signs limits associated").split(/\s+/)
);

function basicSearches(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\- ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const bigrams = new Map();
  for (let i = 0; i < words.length - 1; i++) {
    const p = words[i] + " " + words[i + 1];
    bigrams.set(p, (bigrams.get(p) || 0) + 1);
  }
  // Repeated two-word phrases first (most specific), then repeated words,
  // then the longest words as a fallback for short texts.
  const phrases = [...bigrams].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
  const repeats = [...freq].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
  const longest = [...freq.keys()].sort((a, b) => b.length - a.length);
  const picked = [];
  const used = new Set();
  for (const [term] of [...phrases.slice(0, 3), ...repeats.slice(0, 5)]) {
    if (!used.has(term)) {
      used.add(term);
      picked.push([term]);
    }
  }
  for (const term of longest) {
    if (picked.length >= 6) break;
    if (!used.has(term)) {
      used.add(term);
      picked.push([term]);
    }
  }
  return picked.slice(0, 6);
}

// ---------- stage 1: extract facts + search queries ----------

const SYSTEM_EXTRACT = `You help a medical student sync their qbank with Anki (AnKing Step deck).
You are given the raw visible text of a qbank question page (question stem, answer choices, and usually the explanation). It may contain navigation junk — ignore that. You may also be given a screenshot of the page or of a video frame: if the question appears in the image, read it from there — the image is often the primary source (e.g. audio-qbank videos where the question is shown on screen).

Return {"answer": "", "facts": [], "searches": []} ONLY if the content clearly contains no medical subject matter at all (e.g. a homepage, settings page, or unrelated video). When in doubt, extract — a partial question stem is enough to work with.

First, determine the correct answer. If an explanation is present, take it from there. If only the question stem and answer choices are shown (common for video frames), answer the question yourself using your medical knowledge — commit to the single best choice.

Then identify the specific facts this question tests, based on the correct answer (the main teaching point plus important secondary facts). For each fact, produce search terms likely to appear on the matching Anki cards. Use standard medical terminology and include synonyms/alternate names (generic drug names, both eponym and descriptive names, etc.). Each term should be 1-3 words.

If given an image that contains significant non-question content (a person/webcam, channel art, decorations), also return "crop_boxes": up to two tight bounding boxes — the first around the question stem text, the second around the answer options — each as [x, y, width, height] in PERCENT (0-100) of the image dimensions. Omit "crop_boxes" or use [] when the image is already mostly question content.

Respond with ONLY this JSON, no other text:
{
  "answer": "<the correct answer choice> — <justification under 15 words>",
  "facts": ["<concise statement of each tested fact>", ...],
  "searches": [["term", "synonym", ...], ...],
  "crop_boxes": [[x, y, w, h], ...]
}
Give 3-8 searches. Each inner array is one search: its terms are OR'd together, so group synonyms for the same concept in one search. Do not include generic words like "patient", "increased", "syndrome" alone.`;

// ---------- stage 2: pick the matching cards ----------

const SYSTEM_RANK = `You help a medical student decide which suspended Anki cards to unsuspend after a qbank question.
You are given the facts the question tested and a numbered list of candidate Anki cards (cloze text with answers shown).

Select ONLY cards that directly test one of those facts. Be selective: a card that merely mentions a related topic does not count. Confidence "high" = the card tests exactly a listed fact; "medium" = closely related and probably worth unsuspending.

Respond with ONLY this JSON, no other text:
{"matches": [{"i": <card number>, "confidence": "high"|"medium", "why": "<under 10 words>"}, ...]}
If nothing matches, return {"matches": []}.`;

// ---------- main flows ----------

async function findMatches(pageText, imageB64 = null) {
  const settings = await getSettings();
  const useApi = settings.mode !== "basic";
  if (useApi && !settings.apiKey) {
    throw new Error(
      "No Claude API key set. Right-click the extension icon → Options, and paste your key (or switch to the free mode)."
    );
  }

  // Make sure Anki is reachable before spending an API call.
  await anki("version");

  let answer = "";
  let facts = [];
  let searches = [];
  let regions = [];

  if (useApi) {
    // Stage 1: extract facts and searches. If Claude lazily returns an empty
    // object for content that plainly exists, retry once with a firm nudge.
    const stage1User =
      "QBANK PAGE TEXT:\n\n" +
      (pageText || "(no text — use the screenshot)").slice(0, 6000);
    let extracted = parseJson(
      await claude(settings, SYSTEM_EXTRACT, stage1User, 800, imageB64)
    );
    if (
      (!extracted.facts?.length || !extracted.searches?.length) &&
      (pageText.length > 300 || imageB64)
    ) {
      console.warn("[Qbank→Anki] stage 1 came back empty, retrying. Raw:",
        JSON.stringify(extracted).slice(0, 300));
      extracted = parseJson(
        await claude(
          settings,
          SYSTEM_EXTRACT +
            "\n\nIMPORTANT: This content DOES contain a medical question or teaching material. Empty arrays are not an acceptable answer here — extract the facts and searches now.",
          stage1User,
          800,
          imageB64
        )
      );
    }
    answer = extracted.answer || "";
    facts = extracted.facts || [];
    searches = extracted.searches || [];
    // Crop boxes for a clean question-only paste image (percent units).
    regions = (extracted.crop_boxes || []).filter(
      (b) => Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === "number")
    );
  } else {
    // Free mode: keyword searches straight from the page text, no API.
    searches = basicSearches(pageText || "");
    facts = searches.map((s) => s[0]);
  }
  console.log("[Qbank→Anki] mode:", settings.mode, "| answer:", answer, "| facts:", facts, "| crop boxes:", regions);
  if (!searches.length)
    return { answer, facts, regions, candidates: [], debug: { notesFound: 0 } };

  // Run the Anki searches in parallel (suspended cards only, optional deck restriction).
  const termSets = searches
    .map((terms) => (terms || []).filter((t) => t && t.trim()))
    .filter((clean) => clean.length);

  async function runSearches(deckClause) {
    const queries = termSets.map(
      (clean) =>
        `is:suspended ${deckClause}(` +
        clean.map((t) => `"${t.trim().replace(/"/g, "")}"`).join(" or ") +
        ")"
    );
    const results = await Promise.all(
      queries.map((query) =>
        anki("findNotes", { query }).catch((e) => {
          // A malformed query shouldn't sink the whole run.
          console.warn("[Qbank→Anki] search failed:", query, e.message);
          return [];
        })
      )
    );
    queries.forEach((q, i) => console.log("[Qbank→Anki]", results[i].length, "hits:", q));
    const ids = [];
    const seen = new Set();
    for (const list of results) {
      for (const id of list) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    return ids;
  }

  let noteIds = await runSearches(settings.deck ? `"deck:${settings.deck}" ` : "");
  if (!noteIds.length && settings.deck) {
    // Wrong/renamed deck selected in options? Try the whole collection.
    console.warn("[Qbank→Anki] 0 hits with deck filter — retrying without it.");
    noteIds = await runSearches("");
  }
  if (!noteIds.length)
    return { answer, facts, regions, candidates: [], debug: { notesFound: 0 } };

  const notes = await anki("notesInfo", {
    notes: noteIds.slice(0, MAX_CANDIDATES),
  });
  const numbered = notes
    .map((n, i) => ({ i: i + 1, noteId: n.noteId, text: noteText(n) }))
    .filter((n) => n.text);

  // Free mode never ranks; API mode skips ranking when the list is small.
  if (!useApi || numbered.length <= RANK_SKIP_THRESHOLD) {
    return {
      answer,
      facts,
      regions,
      candidates: numbered.slice(0, 25).map((n) => ({
        noteId: n.noteId,
        text: n.text,
        confidence: "medium",
        why: useApi ? "matched search terms" : "keyword match — check me",
      })),
      debug: { notesFound: noteIds.length },
    };
  }

  // Stage 2: rank candidates against the facts.
  const rankRaw = await claude(
    settings,
    SYSTEM_RANK,
    "FACTS TESTED:\n" +
      facts.map((f) => "- " + f).join("\n") +
      "\n\nCANDIDATE CARDS:\n" +
      numbered.map((n) => `[${n.i}] ${n.text}`).join("\n"),
    1000
  );
  const { matches = [] } = parseJson(rankRaw);

  const byIndex = new Map(numbered.map((n) => [n.i, n]));
  const candidates = matches
    .filter((m) => byIndex.has(m.i))
    .map((m) => ({
      noteId: byIndex.get(m.i).noteId,
      text: byIndex.get(m.i).text,
      confidence: m.confidence === "high" ? "high" : "medium",
      why: String(m.why || "").slice(0, 80),
    }));
  candidates.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1));

  return { answer, facts, regions, candidates, debug: { notesFound: noteIds.length } };
}

async function unsuspendNotes(noteIds, shotB64, windowId, canCapture, regions) {
  const settings = await getSettings();
  if (!noteIds?.length) return { cards: 0 };
  const nidQuery = "(" + noteIds.map((id) => "nid:" + id).join(" or ") + ")";
  const cardIds = await anki("findCards", { query: nidQuery + " is:suspended" });
  if (cardIds.length) await anki("unsuspend", { cards: cardIds });
  if (settings.tag) {
    await anki("addTags", { notes: noteIds, tags: settings.tag });
  }

  // Optionally paste a screenshot of the question into a note field
  // (appended — existing field content is never overwritten). Failures are
  // reported back so they surface in the panel instead of dying silently.
  let pasted = 0;
  let pasteError = "";
  if (settings.pasteShot && settings.pasteField) {
    try {
      let shot = shotB64 || null;
      if (!shot && canCapture) shot = await captureTab(windowId);
      if (shot && regions?.length) {
        try {
          shot = await composeCrops(shot, regions);
        } catch (e) {
          console.warn("[Qbank→Anki] crop compose failed, using full shot:", e.message);
        }
      }
      if (!shot) {
        pasteError = "no screenshot could be captured";
      } else {
        const filename = `qbank-anki-${Date.now()}.jpg`;
        await anki("storeMediaFile", { filename, data: shot });
        const infos = await anki("notesInfo", { notes: noteIds });
        for (const n of infos) {
          const field = n.fields?.[settings.pasteField];
          if (field === undefined) continue; // note type lacks this field
          const img = `<img src="${filename}">`;
          const value = field.value ? field.value + "<br>" + img : img;
          await anki("updateNoteFields", {
            note: { id: n.noteId, fields: { [settings.pasteField]: value } },
          });
          pasted++;
        }
        if (!pasted)
          pasteError = `none of the notes have a "${settings.pasteField}" field`;
      }
    } catch (e) {
      pasteError = e.message;
    }
    if (pasteError) console.warn("[Qbank→Anki] paste:", pasteError);
  }
  return {
    cards: cardIds.length,
    tag: settings.tag,
    pasted,
    pasteField: settings.pasteField,
    pasteError,
  };
}

// ---------- cache + prefetch ----------
// Results are cached by a hash of the page text (chrome.storage.session),
// and in-flight runs are deduped, so a click right after a prefetch started
// attaches to the same run instead of starting over.

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return "match:" + h;
}

const inflight = new Map();

async function findMatchesCached(pageText) {
  const key = hashText(pageText);
  const stored = await chrome.storage.session.get(key);
  if (stored[key]) return stored[key];
  if (inflight.has(key)) return inflight.get(key);
  const run = findMatches(pageText)
    .then(async (res) => {
      await chrome.storage.session.set({ [key]: res });
      inflight.delete(key);
      return res;
    })
    .catch((e) => {
      inflight.delete(key);
      throw e;
    });
  inflight.set(key, run);
  return run;
}

// ---------- message routing ----------

const CACHE_TTL_MS = 15 * 60 * 1000;

// One capture+match run per video, shared between prefetch and click, cached
// (shot included) so a click after the video ends is instant.
async function runAndCacheShot(cacheKey, text, region, windowId) {
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  const run = (async () => {
    let shot = null;
    try {
      shot = await captureTab(windowId, region);
    } catch (e) {
      console.warn("[Qbank→Anki] screenshot failed, using text only:", e.message);
    }
    const result = await findMatches(text, shot);
    const entry = { result, shot, ts: Date.now() };
    await chrome.storage.session.set({ [cacheKey]: entry });
    return entry;
  })().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, run);
  return run;
}

async function freshCacheEntry(cacheKey) {
  const stored = await chrome.storage.session.get(cacheKey);
  const entry = stored[cacheKey];
  return entry && Date.now() - entry.ts < CACHE_TTL_MS ? entry : null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "findMatches") {
        if (msg.cacheKey) {
          // Video flow: serve the prefetched run if there is one.
          const cached = await freshCacheEntry(msg.cacheKey);
          const entry =
            cached ||
            (await runAndCacheShot(
              msg.cacheKey,
              msg.text,
              msg.region,
              _sender.tab?.windowId
            ));
          sendResponse({ ok: true, shot: entry.shot, ...entry.result });
        } else if (msg.screenshot) {
          // Manual snip — always a fresh capture, never cached.
          let shot = null;
          try {
            shot = await captureTab(_sender.tab?.windowId, msg.region);
          } catch (e) {
            console.warn("Screenshot failed, using text only:", e.message);
          }
          sendResponse({ ok: true, shot, ...(await findMatches(msg.text, shot)) });
        } else {
          sendResponse({ ok: true, ...(await findMatchesCached(msg.text)) });
        }
      } else if (msg.type === "prefetch") {
        const settings = await getSettings();
        if (settings.prefetch && (settings.apiKey || settings.mode === "basic")) {
          if (msg.cacheKey) {
            // Video prefetch (pause / near-end): skip if already fresh.
            freshCacheEntry(msg.cacheKey).then((hit) => {
              if (!hit)
                runAndCacheShot(
                  msg.cacheKey,
                  msg.text,
                  msg.region,
                  _sender.tab?.windowId
                ).catch((e) => console.warn("Prefetch failed:", e.message));
            });
          } else {
            findMatchesCached(msg.text).catch((e) =>
              console.warn("Prefetch failed:", e.message)
            );
          }
        }
        sendResponse({ ok: true }); // fire-and-forget; don't hold the channel
      } else if (msg.type === "unsuspend") {
        sendResponse({
          ok: true,
          ...(await unsuspendNotes(
            msg.noteIds,
            msg.shot,
            _sender.tab?.windowId,
            msg.capture,
            msg.regions
          )),
        });
      } else {
        sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the channel open for the async response
});
