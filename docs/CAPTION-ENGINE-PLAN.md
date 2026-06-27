# Pulse — Caption Engine: Root-Cause Diagnosis & Product Plan

_Synthesized from a 7-track deep research run (Premiere APIs, GitHub plugins, commercial
tools, word-sync/segmentation, ASS/libass karaoke, MOGRT internals, burn-in & parity),
plus deep-reads of 8 open-source projects and adversarial feasibility checks._

---

## TL;DR

- **The captions have been unreliable because of one structural decision, not a list of bugs:** rendering captions through **two different engines** (an HTML5-canvas preview vs. an After Effects/MOGRT output) and placing **one timeline item per caption**. Those two choices generate *every* symptom you've seen.
- **The fix the whole industry uses: one engine, one file, one clip.** Generate a single **`.ass` subtitle file** with per-word karaoke timing and burn it in with the **`ffmpeg` + `libass`** you already bundle. The on-panel preview renders the *same* `.ass` — so **preview == output by construction.**
- This removes MOGRT-per-cue entirely (so no V13/V17 stacking, no `clip.end` failures), bakes the highlight into pixels (so it can **never** "show in preview but vanish in render"), and fixes portrait overflow deterministically.
- **MOGRT/Flux stays as an optional "premium look,"** clearly labeled "render to confirm," and is hardened — not relied on for word-accuracy.
- Already shipped this week (committed): **sentence-cohesive grouping** (no more "What is | your name") and **looping animated previews**. These match two of the research's quick-wins exactly.

---

## 1. Root-cause diagnosis

Confirmed by reading our own `js/render.js`, `js/captions.js`, `jsx/host.jsx`:

### 1a. Two renderers, one-truth problem  → "highlight shows in preview but not in the render"
The on-panel preview and the gallery both draw via `CPRender.drawFrame` (HTML5 canvas).
- **Burned-in mode** re-uses that *same* canvas → preview == output. Good.
- **MOGRT/Flux mode** renders through After Effects' compositor — a **different rasterizer the panel never runs.** Parity is therefore *impossible by construction*. Worse, the MOGRT word-sweep is driven by AE **Responsive Design – Time / "Duration-Based"** highlight, a documented class of Premiere export bug (protected regions skip, pinned layers drop on export). So the MOGRT can diverge even from *its own* preview.

### 1b. Per-cue timeline placement is inherently fragile  → V13/V17 stacking, overlong clips
Both modes place **one timeline item per caption**.
- Burned-in places one PNG still per cue on a fresh top track (QE `addTracks`).
- MOGRT imports **one `.mogrt` per cue**.
- Setting `clip.end` on an imported MOGRT hits Adobe bug **DVAPR-4224243** ("works but throws," silently fails on graphic/MOGRT clips) → forces the QE speed-hacks you've seen → drift and stacking.
- MOGRT text-set also needs the `fontTextRunLength = [text.length]` run-table collapse, or AE animates only the *placeholder's* original character count → highlight lands on the wrong characters.

### 1c. Upstream timing + grouping were weak, independent of the renderer
- "What is | your name" mid-phrase splits and 1080×1920 side-overflow are **cue-grouping/layout** problems in `captions.js`, not API problems. **(Fixed this week.)**
- Raw Whisper word timestamps (Groq large-v3, Sarvam) drift ≈ ±0.5 s, so even a perfect renderer highlights slightly the wrong word.
- The gallery looked identical because cards were static. **(Fixed this week — now looping animation.)**

**Net:** the MOGRT-per-cue path is the single biggest source of fragility and is *structurally unwinnable* for word-accurate animated highlight inside CEP/ExtendScript today. We already bundle `ffmpeg` (with `libass`) and Node — the reliable path is within reach but currently **unused**.

---

## 2. Recommended architecture — ONE engine, ONE file, ONE clip

> **Make `ffmpeg` + `libass` ASS-karaoke burn-in the single source of truth for animated captions, and render the on-panel preview from the EXACT SAME `.ass`.**

```
 Groq/Sarvam word timestamps
        │
        ▼
 ① snap + clamp pass        ← monotonic; optional ffmpeg silencedetect edge-snap (±80–120ms)
        │
        ▼
 ② sentence/pause/char-budget grouping   ← DONE (captions.js), + Indic grapheme profile
        │
        ▼
 ③ emit ONE .ass file       ← PlayResX/Y = exact sequence dims; MarginL/R; per-word
        │                      highlight = \1c color + \t(…) pop, or \kf sweep
        ├─► ④a ffmpeg burns it in ONE pass  → ONE overlay clip on ONE track (no importMGT)
        └─► ④b libass-WASM renders the SAME .ass in the panel  → preview == output
```

**Why ASS/libass over the alternatives** (all checked in the research):

| Option | Verdict |
|---|---|
| **ffmpeg + libass ASS** ✅ | One battle-tested engine (powers VLC/mpv/ffmpeg). Correct Indic/RTL shaping via HarfBuzz+FriBidi. Auto-wraps within margins. One encode, one clip. Deterministic → preview==output. |
| Canvas-PNG (current burned-in) | Keeps preview==output but emits *hundreds* of PNG stills + per-clip placement, and the canvas likely mishandles Devanagari/Tamil shaping. Keep as fallback only. |
| One-long-MOGRT (AE 25 `setFillColor`) | Needs re-authoring every template, AE 25+, renders **20–40× slower** (~10–12 min vs ~40 s in benchmarks), and *still* can't reach preview==output (AE ≠ panel rasterizer). |
| Native captions (`createCaptionTrack`) | Render-safe + editable, but **cannot** do per-word animated highlight pre-UXP. Keep ONLY as a separate "export editable captions" feature. |

**Secondary (editable) path:** offer native captions via Adobe's official word-level `transcript_format_spec.json` + `createCaptionTrack` for users who want restyleable, non-burned captions. **Demote MOGRT/Flux** to an optional "premium look," explicitly labeled "styled — render to confirm" (not WYSIWYG), and harden it rather than depend on it.

---

## 3. Concrete fix for each long-standing bug

| Bug | Fix | Backing source |
|---|---|---|
| **Highlight in preview, not in render** | Bake highlight into pixels via libass burn; render preview from the same `.ass`. Removes the second rasterizer entirely. | nicolaigaina/ai-video-captions, unconv/captacity, libass |
| **MOGRT clips too long / V13-V17 stacking** | Drop MOGRT-per-cue. Place ONE burned overlay clip on ONE track via existing `setInPoint/setOutPoint(...,4)` + `overwriteClip`. | OpenCut (one-track pattern), Editor-Pro `_setMogrtClipEnd` |
| **`clip.end` silently fails** | No longer trim per-cue at all. (If MOGRT kept: set length by *extending* via ticks with read-back verify, never trim below keyframed span.) | Adobe bug DVAPR-4224243; Editor-Pro / Subsper |
| **Portrait 1080×1920 side-overflow** | `.ass` `PlayResX/Y` = exact sequence dims + `MarginL/R` ≈ 80–120 px + measured wrapping ≤ ~86% width. Deterministic, template-independent. | libass docs; OpenCut line-break rules |
| **"What is \| your name" split** | **DONE.** Sentence/pause/char-budget grouping in `captions.js` (break at punctuation + gap, balanced splits, never orphan). | tmoroney/auto-subs `formatting.rs` |
| **Preview ≠ output** | Single `.ass` → single libass engine for both preview (WASM) and burn (ffmpeg). | JavascriptSubtitlesOctopus |
| **Static, identical gallery previews** | **DONE** (looping animation). Next: pre-render each style to a short looping mp4 via the same ffmpeg. | research area 7 |
| **"Doesn't follow the exact words"** | Monotonic clamp (present) + optional `ffmpeg silencedetect` edge-snap; optional WhisperX/stable-ts forced-alignment "precision mode." | m-bain/whisperX, stable-ts |

---

## 4. Open-source we can adopt / study (with licenses)

| Repo | Verdict | What to take |
|---|---|---|
| **libass/libass** (ISC) — via ffmpeg's `subtitles` filter | **Adopt** | Reuse the **format + ffmpeg filter**, not the C source. Our bundled ffmpeg already links it. |
| **JavascriptSubtitlesOctopus** (ISC) | **Adopt** | libass-in-WASM → render the same `.ass` in the CEP Chromium panel for true preview parity. |
| **tmoroney/auto-subs** (MIT) | Study | `formatting.rs` gap-based segment breaks (validates our grouping fix). |
| **SysAdminDoc/OpenCut** | Study | ONE native caption track via `addCaptionTrack` instead of stacking clips. |
| **DanielGutierrezB/Editor-Pro** | Study | `_setMogrtClipEnd` + reliable MOGRT text-set ExtendScript (if MOGRT kept). |
| **mertrusen/whisper-studio-premiere (Subsper)** | Study | `importMGT` robustness (re-find clip; never trust the return value). |
| **glenwrhodes/KillerSubtitles** | Study | Word-by-word highlight algorithms mapping onto our canvas engine. |
| **m-bain/whisperX** (BSD-2) | Study | Forced-alignment *principle* for an optional precision mode. |

---

## 5. Roadmap

### Quick wins (days) — low risk, mostly pure JS
1. ✅ **Sentence-cohesive grouping** — done & committed (v0.9.217).
2. ✅ **Looping animated previews** — done & committed.
3. **libass capability check at startup** — `ffmpeg -filters | grep ass`; if absent, swap the ffmpeg download for a full GPL build (gyan / Van Sickle / evermeet, all `--enable-libass`). *This one check de-risks the whole plan.*
4. **ASS generator module (`js/ass.js`)** — pure JS, unit-tested: word cues → `.ass` with per-word highlight + pop. *(Starting now — see §7.)*
5. **Word-time snap + clamp** — monotonic (present) + optional silencedetect edge-snap.

### Bigger bets (weeks) — need in-Premiere testing
6. **New "Reliable (burned-in)" mode**: `.ass` → one ffmpeg pass → ONE clip on ONE track. Becomes the default animated path.
7. **libass-WASM preview** (JavascriptSubtitlesOctopus) → kills the preview≠output bug class for good.
8. **ASS style-preset library** (JSON → ASS) → replaces most Flux looks with deterministic, fast, WYSIWYG styles; new looks without After Effects.
9. **Pre-rendered looping mp4 gallery previews** via the same ffmpeg.
10. **Optional forced-alignment precision mode** (esp. Indian-language audio) + **native editable-captions** export path.

---

## 6. Risks & mitigations (from adversarial verification)

- **"Bundled ffmpeg has libass"** — *Verify before building anything* (quick-win #3). If not, swap to a full GPL build. This is the load-bearing assumption.
- **libass determinism across machines** — verified *true* for same `.ass` + pinned font + light hinting. **Mitigation:** bundle the exact caption `.ttf` and pass `fontsdir`; pin `hinting`.
- **Indic/RTL shaping** — ensure ffmpeg/libass has HarfBuzz + FriBidi; render each cue as one shaped line (don't chop words into per-character tokens). Add Hindi/Tamil/Telugu/Arabic golden tests.
- **Windows path escaping** in the `subtitles=` filter — escape `:` and `\` (well-documented).

---

## 7. What to verify in Premiere before committing the big bet

1. `ffmpeg -hide_banner -filters | findstr ass` → the `subtitles`/`ass` filter exists.
2. Burn a hand-written 5-line karaoke `.ass` onto a clip → highlight + pop appear in the **exported** file.
3. Place that burned overlay as ONE clip on ONE track on a **1080×1920** sequence → no side overflow, correct position.
4. Same `.ass` in JavascriptSubtitlesOctopus in the panel → matches the burn.
5. One Hindi + one Tamil cue → shaping correct (no broken conjuncts).

> Down-payment on this plan starts now: a pure-JS, unit-tested `.ass` generator (`js/ass.js`) — the heart of the new engine — which is fully verifiable here without Premiere. The ffmpeg-burn, one-clip placement, and WASM preview are the steps that need the in-Premiere checklist above.
