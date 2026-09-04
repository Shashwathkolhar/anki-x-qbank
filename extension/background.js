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
    provider: "anthropic",
    openaiKey: "",
    openaiModel: "gpt-4o-mini",
    githubKey: "",
    githubModel: "openai/gpt-4o",
    model: DEFAULT_MODEL,
    customModel: "",
    deck: "",
    tag: "qbank",
    prefetch: true,
    pasteShot: true,
    pasteField: "Lecture Notes",
    newCardDeck: "AnkixQbank",
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

// Haiku 4.5 still accepts an assistant "{" prefill to force JSON; Sonnet 5 /
// Opus 5 reject prefill entirely, so they get a plain request instead and we
// rely on the JSON-only instruction + tolerant parsing.
function supportsPrefill(model) {
  return model.includes("haiku");
}

async function claude(settings, system, userText, maxTokens = 1500, imageB64 = null, modelOverride = null) {
  const model = modelOverride || settings.customModel || settings.model || DEFAULT_MODEL;
  const prefill = supportsPrefill(model);
  const userContent = imageB64
    ? [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: imageB64 },
        },
        { type: "text", text: userText },
      ]
    : userText;
  const messages = [{ role: "user", content: userContent }];
  if (prefill) messages.push({ role: "assistant", content: "{" });
  const res = await fetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      // Thinking-enabled models (Sonnet/Opus) spend output tokens on
      // reasoning before the JSON, so give them room.
      max_tokens: prefill ? maxTokens : Math.max(maxTokens, 6000),
      // Sonnet/Opus: reason before answering. Opus 5 does this by default,
      // but 4.7/4.8 run thinking-off unless asked — ask explicitly.
      ...(prefill ? {} : { thinking: { type: "adaptive" } }),
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // Thinking models emit thinking blocks before the text block — take only text.
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return (prefill ? "{" : "") + text;
}

// ---------- OpenAI (ChatGPT) provider ----------

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_CHEAP_MODEL = "gpt-4o-mini";
// GitHub Models: free, rate-limited, OpenAI-compatible; auth is a GitHub PAT.
const GITHUB_URL = "https://models.github.ai/inference/chat/completions";
const GITHUB_CHEAP_MODEL = "openai/gpt-4o-mini";

async function openaiStyle(settings, system, userText, maxTokens, imageB64 = null, cheap = false) {
  const gh = settings.provider === "github";
  const model = cheap
    ? (gh ? GITHUB_CHEAP_MODEL : OPENAI_CHEAP_MODEL)
    : (gh ? settings.githubModel || "openai/gpt-4o" : settings.openaiModel || OPENAI_CHEAP_MODEL);
  const content = imageB64
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + imageB64 } },
      ]
    : userText;
  const cap = Math.max(maxTokens, 4000);
  const res = await fetch(gh ? GITHUB_URL : OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + (gh ? settings.githubKey : settings.openaiKey),
    },
    body: JSON.stringify({
      model,
      ...(gh ? { max_tokens: cap } : { max_completion_tokens: cap }),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `${gh ? "GitHub Models" : "OpenAI"} API error ${res.status}: ${body.slice(0, 300)}`
    );
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// Route to the configured provider. cheap=true pins the ranking step to the
// provider's fast model so a smarter answering model doesn't multiply cost.
function llm(settings, system, userText, maxTokens, imageB64 = null, cheap = false) {
  if (settings.provider === "openai" || settings.provider === "github") {
    return openaiStyle(settings, system, userText, maxTokens, imageB64, cheap);
  }
  return claude(settings, system, userText, maxTokens, imageB64, cheap ? DEFAULT_MODEL : null);
}

// Cache tag: which provider/model produced a stored result.
function modelCacheTag(s) {
  if (s.mode === "basic") return "basic";
  if (s.provider === "github") return "gh:" + s.githubModel;
  if (s.provider === "openai") return "oa:" + s.openaiModel;
  return s.customModel || s.model;
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

First, work through the differential. If the question includes an image (x-ray, CT, ECG, photo), make the FIRST entry of "differential" a one-line description of what the image actually shows. Then write one short line per answer choice, weighing it against the specific clinical details (age, timeline, exam, labs, imaging). QUOTE the stem's exact words for key findings (rash character, lab values, imaging) — never substitute the classic textbook finding for what the stem actually says; a reworded finding is how the wrong answer wins.

Patient AGE (and sex) is a first-class discriminator: state the patient's age explicitly and check it against each choice's typical age range. When findings conflict, epidemiology usually outweighs one absent classic risk factor — e.g. a 13-year-old with hip/knee pain is SCFE-age even with normal BMI, while Legg-Calvé-Perthes belongs to ages 4-8. Board questions are built on exactly this trap. Only after weighing every choice, commit to the single best answer. If an explanation is present in the text, it settles the answer — use it.

Then identify the specific facts this question tests, using exact board-exam terminology (NBME / First Aid phrasing) for disease and finding names — never loose synonyms. Put facts about the CORRECT answer and the main teaching point first, then one or two facts about the most important distractor choices. For each fact, produce search terms likely to appear on the matching Anki cards — correct-answer terms first. Use standard medical terminology and include synonyms/alternate names (generic drug names, both eponym and descriptive names, etc.). Each term should be 1-3 words.

If given an image that contains significant non-question content (a person/webcam, channel art, decorations), also return "crop_boxes": up to two tight bounding boxes — the first around the question stem text, the second around the answer options — each as [x, y, width, height] in PERCENT (0-100) of the image dimensions. Omit "crop_boxes" or use [] when the image is already mostly question content.

Also fill "why_wrong": one entry per INCORRECT answer choice — a concise, high-yield line on why it does not fit THIS stem, citing the stem's specifics (age, timing, labs, imaging), e.g. "Kostmann syndrome — neutropenia would be persistent from infancy, not cycling every 21 days". When the choice is a test, procedure, or management step, ALSO name the classic NBME scenario where it WOULD be the correct answer, e.g. "Upper GI series — the test for suspected midgut volvulus (bilious vomiting in a neonate); nothing here points to the esophagus or gut". For disease/diagnosis distractors, the why-it-doesn't-fit alone is enough. These are the facts a student should retain about the distractors.

Respond with ONLY this JSON, no other text (differential MUST come first):
{
  "differential": ["<choice> — <one-line for/against>", ...],
  "answer": "<the correct answer choice> — <justification under 15 words>",
  "why_wrong": ["<wrong choice> — <why it fails this stem>", ...],
  "facts": ["<concise statement of each tested fact>", ...],
  "searches": [["term", "synonym", ...], ...],
  "crop_boxes": [[x, y, w, h], ...]
}
Give 3-8 searches. Each inner array is one search: its terms are OR'd together, so group synonyms for the same concept in one search. Do not include generic words like "patient", "increased", "syndrome" alone.`;

// ---------- stage 2: pick the matching cards ----------

const SYSTEM_RANK = `You help a medical student decide which suspended Anki cards to unsuspend after a qbank question.
You are given the facts the question tested and a numbered list of candidate Anki cards (cloze text with answers shown).

Select cards that directly test one of those facts. Confidence "high" = the card tests exactly a listed fact; "medium" = closely related and probably worth unsuspending.

If NO card directly tests the facts, do not return an empty list — instead return the 3-5 closest adjacent cards a student reviewing this question would still benefit from (e.g. general infant feeding guidelines when the question is about a formula switch), marked confidence "related". You may also add up to 3 such "related" cards alongside direct matches when they are genuinely useful.

Also label each match's "group": "answer" if the card relates to the correct answer or the question's main teaching point; "option" if it instead relates to one of the other answer choices (the differential).

Respond with ONLY this JSON, no other text:
{"matches": [{"i": <card number>, "confidence": "high"|"medium"|"related", "group": "answer"|"option", "why": "<under 10 words>"}, ...]}
Return {"matches": []} only when nothing is even loosely relevant.`;

// ---------- make a new card from the question ----------

const SYSTEM_CARD = `You write ONE high-yield Anki cloze card from a practice question a medical student just did, in the style of the AnKing deck.

Rules:
- One concise sentence stating the fact the question tested, with the key answer as the cloze deletion: {{c1::answer}}. Exactly one cloze.
- Build it from the question's SPECIFIC clues and buzzwords — the exact clinical clue → the diagnosis/mechanism/next step (e.g. "A to-and-fro (continuous machinery) murmur with bounding pulses and wide pulse pressure in an infant indicates {{c1::patent ductus arteriosus (PDA)}}"). Not a generic textbook line.
- Under 35 words. Plain text, no HTML.
- Use EXACT board-exam terminology (NBME / First Aid phrasing) for every disease and finding name — never a loose synonym or a mixed label. Example: post-streptococcal GN is "acute proliferative glomerulonephritis" on boards, while "diffuse proliferative glomerulonephritis" signals lupus nephritis; conflating them makes a harmful card. If unsure of the exam's standard term, use the plain clinical name (e.g. "post-streptococcal glomerulonephritis") rather than guessing a histology label.
- Also write "extra": 1-2 sentences of explanation (why, or the mechanism).

Respond with ONLY this JSON, no other text:
{"text": "<sentence containing {{c1::...}}>", "extra": "<short explanation>"}`;

async function makeCard({ text, shot, answer, facts }) {
  const settings = await getSettings();
  if (settings.mode === "basic") throw new Error("Making cards needs an AI provider (see Options).");
  const key =
    settings.provider === "github" ? settings.githubKey
    : settings.provider === "openai" ? settings.openaiKey
    : settings.apiKey;
  if (!key) throw new Error("No API key set for the selected provider (see Options).");
  const user =
    "QUESTION (page text):\n" + (text || "(no text — see screenshot)").slice(0, 4000) +
    "\n\nCORRECT ANSWER: " + (answer || "not determined") +
    "\n\nFACTS TESTED:\n" + (facts || []).map((f) => "- " + f).join("\n");
  const raw = await llm(settings, SYSTEM_CARD, user, 600, shot || null);
  const parsed = parseJson(raw);
  if (!parsed.text) throw new Error("Couldn't write a card from this question.");
  return { text: String(parsed.text), extra: String(parsed.extra || "") };
}

async function addCard({ text, extra, shot, regions, facts, windowId, capture }) {
  const settings = await getSettings();
  if (!/\{\{c\d+::/.test(text || "")) {
    throw new Error("The card text needs a cloze like {{c1::answer}} — edit it and try again.");
  }
  const deck = settings.newCardDeck || "AnkixQbank";
  await anki("createDeck", { deck }); // no-op if it exists
  const models = await anki("modelNames");
  const model =
    models.find((m) => m.includes("AnKingOverhaul")) ||
    models.find((m) => m === "Cloze") ||
    models.find((m) => /cloze/i.test(m));
  if (!model) throw new Error("No cloze note type found in Anki.");
  const fieldNames = await anki("modelFieldNames", { modelName: model });
  const fields = { [fieldNames[0]]: text };
  const extraField = ["Extra", "Back Extra"].find((f) => fieldNames.includes(f));
  if (extraField && extra) fields[extraField] = extra;

  // Same screenshot + facts paste as an unsuspend.
  if (settings.pasteShot) {
    let addition = "";
    try {
      addition = await buildNoteAddition({ shot, regions, facts, windowId, canCapture: capture });
    } catch (e) {
      console.warn("[Qbank→Anki] new-card paste skipped:", e.message);
    }
    if (addition) {
      const target = [settings.pasteField, "Lecture Notes", "Missed Questions", "Extra", "Back Extra"]
        .find((f) => fieldNames.includes(f));
      if (target) fields[target] = fields[target] ? fields[target] + "<br>" + addition : addition;
    }
  }

  const tags = ["AnkixQbank", "AnkixQbank::created"];
  if (settings.tag) tags.push(settings.tag);
  const noteId = await anki("addNote", {
    note: { deckName: deck, modelName: model, fields, tags, options: { allowDuplicate: true } },
  });
  return { noteId, deck, model };
}

// ---------- main flows ----------

async function findMatches(pageText, imageB64 = null) {
  const settings = await getSettings();
  const useApi = settings.mode !== "basic";
  const provider = settings.provider;
  const modelUsed = !useApi
    ? "basic"
    : provider === "github"
      ? settings.githubModel || "openai/gpt-4o"
      : provider === "openai"
        ? settings.openaiModel || OPENAI_CHEAP_MODEL
        : settings.customModel || settings.model || DEFAULT_MODEL;
  const keyForProvider =
    provider === "github" ? settings.githubKey : provider === "openai" ? settings.openaiKey : settings.apiKey;
  if (useApi && !keyForProvider) {
    const name = provider === "github" ? "GitHub token" : provider === "openai" ? "OpenAI API key" : "Claude API key";
    throw new Error(
      `No ${name} set. Right-click the extension icon → Options, and paste it (or switch to the free keyword mode).`
    );
  }

  // Make sure Anki is reachable before spending an API call.
  await anki("version");

  let answer = "";
  let facts = [];
  let searches = [];
  let regions = [];
  let whyWrong = [];

  if (useApi) {
    // Stage 1: extract facts and searches. If Claude lazily returns an empty
    // object for content that plainly exists, retry once with a firm nudge.
    const stage1User =
      "QBANK PAGE TEXT:\n\n" +
      (pageText || "(no text — use the screenshot)").slice(0, 6000);
    let extracted = parseJson(
      await llm(settings, SYSTEM_EXTRACT, stage1User, 1100, imageB64)
    );
    if (
      (!extracted.facts?.length || !extracted.searches?.length) &&
      (pageText.length > 300 || imageB64)
    ) {
      console.warn("[Qbank→Anki] stage 1 came back empty, retrying. Raw:",
        JSON.stringify(extracted).slice(0, 300));
      extracted = parseJson(
        await llm(
          settings,
          SYSTEM_EXTRACT +
            "\n\nIMPORTANT: This content DOES contain a medical question or teaching material. Empty arrays are not an acceptable answer here — extract the facts and searches now.",
          stage1User,
          1100,
          imageB64
        )
      );
    }
    answer = extracted.answer || "";
    facts = extracted.facts || [];
    searches = extracted.searches || [];
    whyWrong = extracted.why_wrong || [];
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
    return { answer, facts, whyWrong, regions, model: modelUsed, candidates: [], debug: { notesFound: 0 } };

  // Run the Anki searches in parallel (suspended cards only, optional deck restriction).
  const termSets = searches
    .map((terms) => (terms || []).filter((t) => t && t.trim()))
    .filter((clean) => clean.length);

  async function runSearches(statePrefix, deckClause) {
    const queries = termSets.map(
      (clean) =>
        `${statePrefix} ${deckClause}(` +
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

  const deckClause = settings.deck ? `"deck:${settings.deck}" ` : "";
  let noteIds = await runSearches("is:suspended", deckClause);
  if (!noteIds.length && settings.deck) {
    // Wrong/renamed deck selected in options? Try the whole collection.
    console.warn("[Qbank→Anki] 0 hits with deck filter — retrying without it.");
    noteIds = await runSearches("is:suspended", "");
  }
  // Also surface matching cards that are ALREADY unsuspended, so "no matches"
  // can't be mistaken for "the deck missed this topic".
  const awakeIds = (await runSearches("-is:suspended", deckClause)).slice(0, 15);
  if (!noteIds.length && !awakeIds.length)
    return { answer, facts, whyWrong, regions, model: modelUsed, candidates: [], debug: { notesFound: 0 } };

  const suspendedSlice = noteIds.slice(0, MAX_CANDIDATES);
  const awakeSet = new Set(awakeIds);
  const notes = await anki("notesInfo", {
    notes: [...suspendedSlice, ...awakeIds],
  });
  const numbered = notes
    .map((n, i) => ({ i: i + 1, noteId: n.noteId, text: noteText(n) }))
    .filter((n) => n.text);

  // Free mode never ranks; API mode skips ranking when the list is small.
  if (!useApi || numbered.length <= RANK_SKIP_THRESHOLD) {
    return {
      answer,
      facts,
      whyWrong,
      regions,
      model: modelUsed,
      candidates: numbered
        .slice(0, 25)
        .map((n) => ({
          noteId: n.noteId,
          text: n.text,
          confidence: "medium",
          already: awakeSet.has(n.noteId),
          why: useApi ? "matched search terms" : "keyword match — check me",
        }))
        .sort((a, b) => (a.already ? 1 : 0) - (b.already ? 1 : 0)),
      debug: { notesFound: noteIds.length },
    };
  }

  // Stage 2: rank candidates against the facts.
  const rankRaw = await llm(
    settings,
    SYSTEM_RANK,
    "CORRECT ANSWER: " +
      (answer || "(not determined)") +
      "\n\nFACTS TESTED:\n" +
      facts.map((f) => "- " + f).join("\n") +
      "\n\nCANDIDATE CARDS:\n" +
      numbered.map((n) => `[${n.i}] ${n.text}`).join("\n"),
    1000,
    null,
    // Ranking is mechanical — run it on the provider's cheap model so a
    // smarter answering model doesn't multiply the cost.
    true
  );
  const { matches = [] } = parseJson(rankRaw);

  const byIndex = new Map(numbered.map((n) => [n.i, n]));
  const candidates = matches
    .filter((m) => byIndex.has(m.i))
    .map((m) => ({
      noteId: byIndex.get(m.i).noteId,
      text: byIndex.get(m.i).text,
      confidence: m.confidence === "high" ? "high" : m.confidence === "related" ? "related" : "medium",
      group: m.group === "option" ? "option" : "answer",
      already: awakeSet.has(byIndex.get(m.i).noteId),
      why: String(m.why || "").slice(0, 80),
    }));
  // Correct-answer cards first, then other options; within each group the
  // tickable (still-suspended) cards come before already-unsuspended ones,
  // and high > medium > related.
  const confRank = { high: 0, medium: 1, related: 2 };
  const rank = (c) =>
    (c.group === "answer" ? 0 : 12) + (c.already ? 4 : 0) + (confRank[c.confidence] ?? 1);
  candidates.sort((a, b) => rank(a) - rank(b));

  return { answer, facts, whyWrong, regions, model: modelUsed, candidates, debug: { notesFound: noteIds.length } };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Builds the HTML pasted into a note: the (cropped) question screenshot as a
// stored media file, followed by the tested facts as a bullet list.
// Returns "" when there is nothing to paste.
async function buildNoteAddition({ shot, regions, facts, windowId, canCapture }) {
  let s = shot || null;
  if (!s && canCapture) s = await captureTab(windowId);
  if (s && regions?.length) {
    try {
      s = await composeCrops(s, regions);
    } catch (e) {
      console.warn("[Qbank→Anki] crop compose failed, using full shot:", e.message);
    }
  }
  const factsBlock = facts?.length
    ? "<ul>" + facts.map((f) => `<li>${escapeHtml(f)}</li>`).join("") + "</ul>"
    : "";
  let imgHtml = "";
  if (s) {
    const filename = `qbank-anki-${Date.now()}.jpg`;
    await anki("storeMediaFile", { filename, data: s });
    imgHtml = `<img src="${filename}">`;
  }
  return imgHtml + factsBlock;
}

async function unsuspendNotes(noteIds, shotB64, windowId, canCapture, regions, facts) {
  const settings = await getSettings();
  if (!noteIds?.length) return { cards: 0 };
  const nidQuery = "(" + noteIds.map((id) => "nid:" + id).join(" or ") + ")";
  const cardIds = await anki("findCards", { query: nidQuery + " is:suspended" });
  if (cardIds.length) await anki("unsuspend", { cards: cardIds });
  // Always stamp AnkixQbank so the extension's cards are findable in Anki
  // (tag:AnkixQbank), plus the user's own tag if set.
  const tags = "AnkixQbank" + (settings.tag ? " " + settings.tag : "");
  await anki("addTags", { notes: noteIds, tags });

  // Optionally paste a screenshot of the question into a note field
  // (appended — existing field content is never overwritten). Failures are
  // reported back so they surface in the panel instead of dying silently.
  let pasted = 0;
  let pasteError = "";
  if (settings.pasteShot && settings.pasteField) {
    try {
      const addition = await buildNoteAddition({
        shot: shotB64,
        regions,
        facts,
        windowId,
        canCapture,
      });
      if (!addition) {
        pasteError = "no screenshot could be captured";
      } else {
        const infos = await anki("notesInfo", { notes: noteIds });
        const FALLBACK_FIELDS = ["Lecture Notes", "Missed Questions", "Extra", "Back"];
        const fieldCreatedOn = new Set(); // models we added the field to this run
        for (const n of infos) {
          let target = settings.pasteField;
          if (n.fields?.[target] === undefined && !fieldCreatedOn.has(n.modelName)) {
            // Note type lacks the chosen field — use one it does have, or
            // create the field on that note type.
            const fallback = FALLBACK_FIELDS.find((f) => n.fields?.[f] !== undefined);
            if (fallback) {
              target = fallback;
            } else {
              try {
                await anki("modelFieldAdd", {
                  modelName: n.modelName,
                  fieldName: settings.pasteField,
                });
                fieldCreatedOn.add(n.modelName);
              } catch (e) {
                console.warn("[Qbank→Anki] couldn't add field to", n.modelName, e.message);
                continue;
              }
            }
          }
          const existing = n.fields?.[target]?.value || "";
          const value = existing ? existing + "<br>" + addition : addition;
          try {
            await anki("updateNoteFields", {
              note: { id: n.noteId, fields: { [target]: value } },
            });
            pasted++;
          } catch (e) {
            console.warn("[Qbank→Anki] paste failed on note", n.noteId, e.message);
          }
        }
        if (!pasted)
          pasteError = `couldn't paste into any note (see the extension's console for details)`;
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

async function findMatchesCached(pageText, force = false) {
  const key = hashText(pageText);
  if (!force) {
    const stored = await chrome.storage.session.get(key);
    if (stored[key]) return stored[key];
    if (inflight.has(key)) return inflight.get(key);
  }
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

// Re-check each candidate's live suspend state right before showing results —
// a cached result may predate an unsuspend, and a stale checkbox invites
// double-unsuspending or hides that a card is already in rotation.
async function refreshAlready(result) {
  const c = result?.candidates;
  if (!c?.length) return result;
  try {
    const q =
      "is:suspended (" + c.map((x) => "nid:" + x.noteId).join(" or ") + ")";
    const stillSuspended = new Set(await anki("findNotes", { query: q }));
    for (const x of c) x.already = !stillSuspended.has(x.noteId);
    const confRank = { high: 0, medium: 1, related: 2 };
    const rank = (x) =>
      (x.group === "option" ? 12 : 0) + (x.already ? 4 : 0) + (confRank[x.confidence] ?? 1);
    c.sort((a, b) => rank(a) - rank(b));
  } catch (e) {
    console.warn("[Qbank→Anki] suspend-state refresh failed:", e.message);
  }
  return result;
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
          // Video flow: serve the prefetched run if there is one. The key
          // includes the model/mode so changing settings invalidates stale
          // results instead of serving them.
          const s = await getSettings();
          const key = msg.cacheKey + "|" + modelCacheTag(s);
          const cached = msg.force ? null : await freshCacheEntry(key);
          const entry =
            cached ||
            (await runAndCacheShot(
              key,
              msg.text,
              msg.region,
              _sender.tab?.windowId
            ));
          sendResponse({ ok: true, shot: entry.shot, ...(await refreshAlready(entry.result)) });
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
          sendResponse({
            ok: true,
            ...(await refreshAlready(await findMatchesCached(msg.text, msg.force))),
          });
        }
      } else if (msg.type === "prefetch") {
        const settings = await getSettings();
        const hasKey =
          settings.mode === "basic" ||
          (settings.provider === "github"
            ? settings.githubKey
            : settings.provider === "openai"
              ? settings.openaiKey
              : settings.apiKey);
        if (settings.prefetch && hasKey) {
          if (msg.cacheKey) {
            // Video prefetch (pause / near-end): skip if already fresh.
            const key = msg.cacheKey + "|" + modelCacheTag(settings);
            freshCacheEntry(key).then((hit) => {
              if (!hit)
                runAndCacheShot(
                  key,
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
      } else if (msg.type === "popupFind") {
        // PDF viewer and other pages where no content script can live:
        // the popup asks us to capture the visible tab and run the pipeline.
        let shot = null;
        try {
          shot = await captureTab(msg.windowId);
        } catch (e) {
          console.warn("[Qbank→Anki] popup capture failed:", e.message);
        }
        sendResponse({ ok: true, shot, ...(await findMatches(msg.text || "", shot)) });
      } else if (msg.type === "manualSearch") {
        // User-typed deck search from the panel's 🔍 — no AI involved.
        const settings = await getSettings();
        const q = String(msg.query || "").trim().replace(/"/g, "");
        const deckClause = settings.deck ? `"deck:${settings.deck}" ` : "";
        const run = async (clause) => ({
          susp: (await anki("findNotes", { query: `is:suspended ${clause}"${q}"` })).slice(0, 20),
          awake: (await anki("findNotes", { query: `-is:suspended ${clause}"${q}"` })).slice(0, 10),
        });
        let { susp, awake } = await run(deckClause);
        if (!susp.length && !awake.length && deckClause) ({ susp, awake } = await run(""));
        const infos = susp.length || awake.length
          ? await anki("notesInfo", { notes: [...susp, ...awake] })
          : [];
        const awakeSet = new Set(awake);
        sendResponse({
          ok: true,
          candidates: infos
            .map((n) => ({ noteId: n.noteId, text: noteText(n), already: awakeSet.has(n.noteId) }))
            .filter((c) => c.text),
        });
      } else if (msg.type === "makeCard") {
        sendResponse({ ok: true, ...(await makeCard(msg)) });
      } else if (msg.type === "addCard") {
        sendResponse({
          ok: true,
          ...(await addCard({ ...msg, windowId: _sender.tab?.windowId })),
        });
      } else if (msg.type === "unsuspend") {
        sendResponse({
          ok: true,
          ...(await unsuspendNotes(
            msg.noteIds,
            msg.shot,
            _sender.tab?.windowId,
            msg.capture,
            msg.regions,
            msg.facts
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
