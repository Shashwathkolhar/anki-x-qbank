# Anki x Qbank

A free Chrome extension for med students. While you do practice questions, it
finds the matching **suspended cards in your Anki deck** (built for the AnKing
Step Deck) and unsuspends them in one click — so the exact facts you just got
tested on show up in your reviews.

Works with **any qbank** you use in the browser — and with **questions in
YouTube videos** too: it reads the question straight off the video frame.

## What it does

- **One click while doing a question** — a small star button sits on the page.
  Click it and a panel shows the Anki cards that test the same facts as the
  question, with the best matches pre-selected. Click *Unsuspend selected* and
  you're done.
- **Reads questions inside YouTube videos.** For video qbanks, it captures the
  video frame and reads the question straight off the screen — pause on the
  question, click the star.
- **Snip mode.** Right-click the star to get a crosshair, drag a box around
  just the question and options, and it reads only that. Useful for cluttered
  pages, x-rays, or video frames.
- **Shows the answer.** In Claude mode, the panel tells you the correct answer
  with a one-line reason — a quick self-check before you reveal it.
- **Puts a screenshot on the card.** When you unsuspend, a clean picture of
  the question (webcam faces and page clutter cropped out) is added to the
  Lecture Notes field (or Missed Questions / Extra — your choice) of each
  unsuspended note. Nothing already on the note is overwritten.
- **Tags everything it touches** (default tag: `qbank`), so over time you
  build a filtered deck of exactly what your questions exposed as your weak
  points.
- **Ready before you ask.** It can start matching in the background while you
  read (or while a video plays), so the panel opens instantly.
- **Works per-site.** Open the extension popup on your qbank site (or on
  YouTube) and flip one toggle to enable the button there. Everywhere else it
  stays completely dormant.

## Two modes

| | **With AI (recommended)** | **Without AI (free)** |
|---|---|---|
| How it matches | Claude or ChatGPT reads the question, works out the answer, and picks only the cards that truly match | Searches your deck for keywords taken from the page text |
| Reads video questions | Yes | No |
| Shows the answer | Yes | No |
| Cost | Cents per question, on your own API key (Anthropic or OpenAI — pick either in Options) | Nothing |
| Accuracy | High — few wrong matches | Rougher — expect to untick some wrong matches yourself |

## What you need

1. **Google Chrome** (or any Chromium browser that loads unpacked extensions).
2. **Anki** (the desktop app), kept open while you do questions.
3. **The AnkiConnect add-on** for Anki — free, install code `2055492159`.
4. **An Anki deck to unsuspend from** — built and tested with the AnKing Step
   Deck; any deck works for matching, but the screenshot-on-card feature
   expects AnKing-style fields (Lecture Notes / Missed Questions / Extra).
5. *(Only for AI mode)* **An API key from either provider** — Anthropic
   ([console.anthropic.com](https://console.anthropic.com)) or OpenAI
   ([platform.openai.com](https://platform.openai.com)). The free mode needs
   no key at all.

## Installation

**1. Install AnkiConnect in Anki**

1. Open Anki → **Tools → Add-ons → Get Add-ons…**
2. Paste the code `2055492159` and click OK.
3. Restart Anki. Keep Anki open whenever you use the extension.

**2. Get the extension**

1. Click the green **Code** button at the top of this page → **Download ZIP**,
   and unzip it somewhere you won't delete (or `git clone` the repo).

**3. Load it into Chrome**

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `extension` folder from the download.
4. Pin it: click the puzzle-piece icon in Chrome's toolbar and pin
   **Anki x Qbank**.

**4. Set it up**

1. Right-click the extension's icon → **Options**.
2. Pick your mode — **With Claude** (paste your API key) or **Without Claude**.
3. Click **Load decks from Anki** and choose your deck (Anki must be open).
4. Click **Save**.

**5. If Anki calls fail with a permission or origin error**

Anki → Tools → Add-ons → select AnkiConnect → **Config**, and add the origin
shown in the error to `webCorsOriginList`, for example:

```json
"webCorsOriginList": ["http://localhost", "chrome-extension://YOUR-EXTENSION-ID"]
```

(Your extension's ID is shown on `chrome://extensions`.) Restart Anki.

## Daily use

1. Do a question. Read the explanation.
2. Click the blue star (bottom-right of the page) — or right-click it to snip
   just the question area.
3. Review the matches, tick or untick, hit **Unsuspend selected**.
4. The cards are unsuspended, tagged, and stamped with a screenshot of the
   question. They'll be in your next Anki session.

On YouTube: enable the site once via the extension popup, pause on the
question, click the star. For the best reading accuracy use theater mode and
1080p.

## Good to know

- **Privacy:** your API key and settings live only in your browser. In Claude
  mode, the question text/screenshot is sent to Anthropic's API to be read —
  nothing else, nowhere else. In free mode nothing leaves your computer except
  local calls to Anki.
- **The suggested answer can be wrong.** It's an AI reading a screenshot —
  treat it as a study buddy's guess, not an answer key.
- **Check your qbank's terms of service** regarding screenshots before using
  the screenshot-on-card feature with a commercial qbank.
- This is a personal project shared as-is, with no affiliation to Anki,
  Ankitects, AnKing, AnkiHub, any qbank provider, or Anthropic.

## License

MIT — free to use, copy, and modify. See [LICENSE](LICENSE).
