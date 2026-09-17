# Pulse — Technical Brief (hand-off)

Pulse is an AI captioning + auto-edit tool. This repo is the **Adobe Premiere Pro plugin** version
(CEP panel). This document explains how it works, the exact techniques and calibration numbers,
and the hard-won rules — so a web version (or any other port) doesn't have to rediscover them.

---

## 1. Architecture (plugin)

Two worlds, talking over `evalScript`:

| Layer | File(s) | Runtime | Notes |
|---|---|---|---|
| Panel UI | `CutPilot/index.html`, `CutPilot/js/main.js`, `css/style.css` | Chromium (CEP, `--enable-nodejs --mixed-context`) | All UI, previews, transcription, style mapping |
| Timeline engine | `CutPilot/jsx/host.jsx` | **ExtendScript (ES3!)** | Everything that touches the Premiere timeline. No `let/const/arrow/Array.find` — ES3 only |
| Pure logic | `CutPilot/js/captions.js`, `render.js`, `align.js`, `silence.js`, `takes.js`, `ass.js`, `transcript.js`, `multicam.js`, `fonts.js` | Plain JS, no DOM/Premiere | **Fully portable — reuse these on the web as-is** |

Data flow for captions:
`audio → ASR (word timestamps) → regroup into caption cues → per-style mapping → insert one
graphic per cue on the timeline (plugin) / render frames or burn subtitles (web)`.

---

## 2. The caption engine (the core trick)

**All ~37 gallery styles ride ONE Motion Graphics Template**: `mogrts/Flux_Halo2.mogrt`
(a 1080×1920 After Effects comp with word-by-word highlight built in). A style is just a
**parameter set** applied to that engine — never a separate template. This is what makes every
style behave identically (timing, word sweep, editability).

### 2.1 Exact-name parameter mapping — never guess

`mapPresetToFlux(preset, liveProps)` in `main.js` matches the template's controls **by exact
display name** (normalized: lowercase, collapse spaces). Guess-mapping by index or fuzzy name was
the #1 source of "setting does nothing" bugs. Key controls of the engine:

- `Text Color`, `Highlighted Word Color 1`, `Highlighted Word Color 2` (colour1→colour2 gradient; send the same hex twice for solid)
- `Text Opacity` (always force 100), `Text Scale` (clamp 25–250)
- `BG Color`, `BG Opacity` (0–100; **0 hides the box** for box-less styles), `BG Roundness` (clamp 0–60), `BG Box Padding` (point, scales with size)
- `Shadow On/Off`, `Shadow Color`, `Shadow Opacity`, `Shadow Distance`, `Shadow Softness`
  — **glow = shadow with Distance 0 + Softness 100** (opacity = glow strength × 100)
- `Type` = highlight mode → set **2 = Duration-based**; `Start Time, Duration (Automated)` = `[0, cueDurationSeconds]` → the highlight sweeps the words over exactly the caption's visible length (this IS the word-by-word sync); `Word Index` = fallback if Type refuses (point it at word 1)
  — the live name sometimes has an extra space (`Duration (Automated)`) → **match normalized names, never byte-exact**
- `Text Position` (point, x=540): portrait `y = 1920·yPct`; landscape `y = 420 + 1080·yPct`
  (comp is 1080×1920 centered on a 1920×1080 sequence — only the middle band is visible)
- `Gradient FG Text Position` + `Start/End of Gradient` must follow the same y or the highlight drifts off the words
- `Gradient FG Text (Change font only)` = a mirror text layer: write **only its font**, its words are expression-driven
- `Note` = author instructions — **never write to it**

### 2.2 Rich source-text writes (font/bold) — the dangerous part

Premiere text params hold an AE "source text" JSON blob (`textEditValue`, `fontEditValue`,
`capPropTextRunLength`, …). Rules that prevent project corruption:

1. **Never `JSON.parse`/`stringify` the blob** — edit the raw string with balanced-span regex
   rewrites only (see `CP_setMgrtText`, `CP_rewriteBlobField`).
2. Every `*RunLength` field **must equal the new text's `.length`** or Premiere throws
   "bad any cast" / renders nothing.
3. Escape `\ " \n \r \t` when injecting text into the blob.
4. **Probe first**: insert ONE throwaway instance, attempt the write, read it back, delete it
   (`CP_probeRichText`). Only enable rich writes if the round-trip verified clean.
5. Ownership split (prevents double-application): **colours/size/position/opacity = params;
   font + bold = rich write; CAPS = uppercase the text string itself; sizeScale pinned to 1 on
   the rich path** (size only via `Text Scale`) — applying size in both places double-scaled.
6. Text writes can clobber param colours on some templates → **re-apply all params AFTER the
   text write** (idempotent second pass).

### 2.3 Timeline insertion (host.jsx `CP_insertMogrtCaptions`)

- One fresh graphic import **per cue** (sharing a project item made all clips share one text).
- Sort cues on entry; clamp each caption's end to the next caption's start (never two on screen).
- Duration fitting is 3-stage because `clip.end = …` is **silently refused on some Premiere
  builds**: (1) assign `clip.end`; (2) QE `setSpeed` stretch; (3) **razor at the wanted end and
  delete the tail** (`CP_razorTrimTail`). Without stage 3 the *last* caption ran the template's
  full 30 s (earlier ones only looked right because the next import overwrote them).
- Entrance animations = real Motion/Opacity keyframes (`CP_animateClip`); `animSpeed` is a
  **multiplier where 1 = natural pace** (passing 100 compressed entrances into ~1 ms = invisible).
- Track safety (the "captions don't appear" class): captions always go to a **fresh top track**;
  a remembered "replace" track is reused only if (a) every clip on it is one of our caption
  graphics (name signature), (b) it is still the top track — otherwise the new set moves above
  the b-roll; (c) old set cleared only **after** an import probe proves the template imports;
  (d) if Premiere refuses to add a track, abort loudly (never overwrite the top track).
  Reuse is sequence-scoped (a track index from another sequence is never applied).

---

## 3. Preview = output (calibration, not guessing)

The previews are drawn by our own canvas renderer (`render.js: styleForFrame + drawFrame`) and are
**calibrated to the engine's authored numbers extracted from inside the .mogrt** (a .mogrt is a
zip: `definition.json` + `project.aegraphic`; the .aep inside holds `fontSizeEditValue`):

- Authored face: **Inter-SemiBold 75 px in a 1920-tall comp** (≈3.9% of frame height), positioned at (540, 960).
- Tiles/editor show a **caption band** = the ~22% slice of frame around the caption →
  `fontSize ≈ 191` in 1080-canvas units (`75 / (1920·0.22) · 1080`), scaled by the user's Size ÷ 90.
- `styleForFrame` scales by frame **width** relative to 1920 when a width is given (portrait
  captions overflowed when scaled by height).
- Blank-media detection: an image/video frame is "blank" when its **luminance range
  (max−min) < 60** (real caption renders floor at ~175; black frame-0 renders ≈ 0). Content-%
  cannot separate them (a thin caption covers <0.3% of frame). Videos are sampled ~⅓ in
  (title reveals legitimately start black) and across several frames (ffmpeg `-ss` on
  non-keyframes is imprecise → single-frame checks flake).

---

## 4. Transcription & word timing

- ASR: Groq Whisper (default) or Sarvam (Indic) → **word-level timestamps**. API keys are injected
  at build time from env, never committed; on the web keep them **server-side only**.
- `sanitizeWordCues` — never drop a word; force strictly-increasing starts with a minimum window.
- `regroupWords(words, perCue, {sentenceBreak, maxChars, maxGap})` — flows words across ASR line
  boundaries, breaks at sentence ends and long pauses, caps width so text can't overflow the box.
- `fillFrameGaps` — hold each caption into a short pause (no blinking), clear it on long silence.
- Karaoke/reveal frames ride **real word cues** (`buildCaptionFrames(..., {wordCues})`), never an
  even split — that's why the highlight follows the voice.
- Hinglish: `devanagariToLatin` romanizer.

---

## 5. Bug → rule table (what the other chat must not re-learn)

| Symptom we shipped and fixed | Root cause | Rule |
|---|---|---|
| Preview ≠ timeline output | Guessed 90 px face; authored was 75 px | Extract ground truth from the artifact itself; never eyeball |
| Settings "do nothing" | Fuzzy/index param mapping | Exact-name mapping against enumerated controls |
| Chosen colours ignored (white text) | Text write clobbers colour params | Re-apply params after every text write |
| Entrances invisible | `animSpeed` used as divider | It's a multiplier; 1 = natural |
| Text double-sized | Size applied via param AND rich blob | One owner per property |
| Last caption 30 s long | `clip.end` silently refused | 3-stage trim ending in razor+delete |
| Captions "don't appear" | Stale reuse track / hidden under b-roll / silent save-gate | 4 track guards + persistent (not toast) error banners |
| Blank template previews | Frame-0 renders are black | Luma-range < 60 = blank → fall back to live-drawn swatch; gate the build on it |
| Word highlight frozen | `Type` not set to 2; spaced control name | Normalized name match; set `[0, cueDur]` sweep |
| Corrupted project text | Blob re-serialized / run-length mismatch | Raw-string edits; RunLength == text.length; probe first |
| Saved templates lose settings | Save/restore drifted from what the renderer reads | One field list; roundtrip test asserting every field |
| Stale panel after update | CEP webview caches JS/CSS | `?v=<version>` cache-buster on every local asset |
| Random crashes on odd input | Empty/None text, null preset, emoji | Fuzz every pure module; guard, don't assume |

---

## 6. Verification system (port this idea, not just the code)

Everything above is enforced by an automated battery (`CutPilot/test/run-tests.js`, exit-gated,
also on GitHub Actions cron):

1. **464 unit tests** over the pure modules.
2. **119 host tests** — the real `host.jsx` executed against a **mini-Premiere mock** (DOM + QE
   objects over one geometry model, incl. hostile variants: refused `end` setter, failing
   `importMGT`, dead `addTracks`).
3. **Ground-truth simulation** — headless Chromium renders the real panel, pixel-measures every
   style tile against the authored numbers from inside the .mogrt.
4. **Panel proofs** — headless Chromium drives the real UI: style→param mapping for all 37,
   tile==preview parity, every visible control has an observable effect, saved-template
   roundtrip (17 fields), random-combo fuzz, blank-preview detector.
5. **Blank-preview scan** — no shipped still/video may be blank (ffmpeg multi-frame + luma range).

Web equivalent: unit tests on the shared modules + a headless-browser pixel test that renders a
caption frame and compares against the same authored constants.

---

## 7. Porting notes for the WEB version

**Reuse unchanged** (no DOM/Premiere deps): `captions.js`, `render.js`, `align.js`, `silence.js`,
`takes.js`, `ass.js`, `transcript.js`, `fonts.js`. They already run in Node (that's how the test
battery works), so they run in a browser or serverless function too.

- **Preview**: `buildCaptionFrames(cues, opts)` → `styleForFrame(preset, frameH, overrides, frameW)`
  → `drawFrame(canvas, frame, style)` on a `<canvas>` over the `<video>` element, driven by
  `video.currentTime`. Because the plugin's previews were calibrated to the engine, using the same
  renderer on the web gives you preview == export **by construction**.
- **Export (burned captions)**: two proven paths —
  1) `ass.js: buildAss(cues, opts)` → burn with ffmpeg (`ffmpegBurnArgs`; server-side ffmpeg or
     ffmpeg.wasm). ASS quirks already handled: colours are `&HBBGGRR&` (BGR!), text braces must be
     neutralized (`{}`→`()`), newlines → `\N`, one Dialogue per spoken word for karaoke.
  2) Frame-by-frame: `drawFrame` onto canvas → WebCodecs/MediaRecorder mux.
- **No MOGRT on the web** — `host.jsx`, the .mogrt files and everything in §2 are Premiere-only.
  The canvas renderer is the web's engine; it is already visually matched to the plugin's output.
- **ASR**: same Whisper call with word timestamps; keep keys server-side; then reuse
  `sanitizeWordCues → regroupWords → buildCaptionFrames` exactly as the plugin does.
- **Fonts**: styles assume the FONT list in `captions.js`; on the web load them as webfonts
  (Google Fonts) and keep `fallbackFonts` **as an array** (a string here once broke every tile).
- Wait for `document.fonts.ready` before first paint, then repaint (the plugin repaints tiles on
  font load for the same reason).

## 8. Repo pointers

- Style catalogue + all caption logic: `CutPilot/js/captions.js` (TEMPLATES, FONT_SAFE, regroup, frames, animations)
- Canvas renderer: `CutPilot/js/render.js`
- Style→engine mapping + UI: `CutPilot/js/main.js` (`mapPresetToFlux`, `carryableStyle`, `styledPreset`, `readOverrides`)
- Timeline engine: `CutPilot/jsx/host.jsx` (`CP_insertMogrtCaptions`, `CP_setMgrtText`, `CP_setWordSweep`, `CP_animateClip`, `CP_razorTrimTail`)
- Tests: `CutPilot/test/` (run `node CutPilot/test/run-tests.js`) · gates: `tools/sim-preview-check.js`, `tools/thumb-scan.js`
- Build/protect/installers: `tools/make-final.js` (keys via env: `CP_GROQ_KEY`, `CP_SARVAM_KEY`; trial via `CP_TRIAL_DAYS`, default 7)
