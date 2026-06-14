# CutPilot — auto-editing panel for Adobe Premiere Pro

CutPilot is a CEP extension panel for Premiere Pro that automates the three
most repetitive parts of talking-head and multicam editing:

1. **Silence / pause removal** — analyzes the selected clip's audio, finds
   dead air, and either cuts it in place or rebuilds a trimmed sequence.
2. **Multicam auto-switching** — assigns a camera angle to every kept
   segment (rotate / ping-pong / random / hero-cam modes) and toggles the
   stacked camera tracks accordingly.
3. **Trend-styled animated captions** — finds your transcript
   automatically (in the project, next to your footage, or next to the
   project file), then renders captions with CutPilot's **built-in
   animation engine**: every caption frame is drawn to a transparent PNG
   (any font, color, stroke, glow, highlight box) and placed on a fresh
   top track with real Premiere keyframes for the entry animation. No
   MOGRTs, no manual files. Six style presets (Hormozi Bold, Karaoke
   Highlight, Highlight Box, Clean Minimal, Neon Pop, Typewriter) ×
   eight animations (Pop, Bounce, Slide up, Fade, Glitch, Karaoke,
   Typewriter, None) — mix and match freely, Captions.ai-style.

See [`docs/RESEARCH.md`](docs/RESEARCH.md) for the market/trend research and
the feature roadmap behind this design.

---

## Requirements

- Adobe Premiere Pro 2020 (14.0) or newer. Captions API needs 22.0+.
- Windows or macOS.
- Optional but recommended: an `ffmpeg` binary for fast silence analysis on
  long files and exotic codecs (set the path in the Settings tab).

## Easy install (no technical steps)

1. Download this repository as a ZIP (green **Code** button → Download ZIP)
   and unzip it.
2. Open the `premiere-plugin` folder and run the installer:
   - **Windows:** double-click `install-windows.bat`
   - **Mac:** right-click `install-mac.command` → Open
     (or run `bash install-mac.command` in Terminal)
3. Restart Premiere Pro and open **Window → Extensions → CutPilot**.

The installer enables CEP debug mode and copies the panel into Premiere's
extensions folder for you. Prefer doing it by hand? See below.

## Manual install (development / unsigned)

CEP refuses unsigned panels unless debug mode is on:

**macOS**

```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
# Premiere 24+ may also read CSXS.12:
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

**Windows** — add a String value `PlayerDebugMode` = `1` under
`HKEY_CURRENT_USER\Software\Adobe\CSXS.11` (and `CSXS.12`).

Then copy this `premiere-plugin` folder into the CEP extensions directory:

- macOS: `~/Library/Application Support/Adobe/CEP/extensions/CutPilot`
- Windows: `C:\Users\<you>\AppData\Roaming\Adobe\CEP\extensions\CutPilot`

Restart Premiere and open **Window → Extensions → CutPilot**.

## Usage

### Silence / pause removal

1. Select the clip to analyze in the timeline (the A/V clip of your talking
   head).
2. Tune the knobs: **Threshold** (audio below this dB counts as silence),
   **Min pause** (shorter pauses survive — keeps natural breaths), **Padding**
   (safety margin kept around speech), **Min keep** (slivers shorter than
   this are cut too).
3. **Analyze selected clip** → review the list, untick silences you want to
   keep, and use **Preview as markers** to audition before cutting.
4. Apply with one of two engines:
   - **Rebuild trimmed sequence (safe)** — builds a brand-new sequence from
     only the kept segments using fully supported APIs. Your original
     sequence is untouched. *Recommended.*
   - **Cut in place (QE)** — razors every track at each boundary and deletes
     the silent pieces in the current sequence (optionally closing gaps).
     Uses the undocumented QE DOM; the panel clones your sequence first as a
     backup by default.

### Multicam

Stack each camera on its own video track (V1, V2, …), then pick **how to
switch** — no Smart Cut required:

- **🎙️ Follow the speaker** *(FireCut-style)* — you **map each camera to its
  mic** (V1 → A1, V2 → A2, …) right in the panel. CutPilot reads each mic's
  waveform to find when that person is talking and cuts to their camera. Map
  a camera to **Center / wide (no mic)** to use it during crosstalk and
  silence, and dial **Cut to the center cam every N seconds** for automatic
  cutaways that break up long shots. **Min shot length** stops flicker.
- **🗣️ Switch on speech** — for **one main or mixed audio track** (any
  layout). Pick the **Main audio track**; CutPilot cuts to a new camera at
  each new sentence / talk burst, using your switching style below.
- **⏱️ Every few seconds** — rotate/ping-pong/random/hero on a fixed interval.
- **📍 At my timeline markers** — switch on your own markers.
- **✂️ At my Smart Cut points** — switch on the silence cuts from Smart Cut.

So it works in every layout: a mic per person → *Follow the speaker*; one
mixed track or a single main mic → *Switch on speech*; or no useful audio →
the interval / markers / Smart-Cut options.

Build the plan, review the per-shot angle list, then **Apply** — CutPilot
enables the chosen camera and disables the others per shot. The edit lives in
your sequence, so you can still tweak any cut by hand.

The Captions tab is a caption template studio, like Captions.ai / Submagic.
It has two sub-views — **📚 Templates** (a browsable library) and **🎨 Editor**
(the live customizer).

### Template library

A grid of professionally designed templates (24+), each a visual card with a
looping animated preview, name, category, 🔥 popularity, and a ☆ favorite
toggle. Across ten categories: Bold Creator, Minimal Professional, Dynamic
Highlight, Social Growth, Podcast Pro, Storytelling, Gaming Stream,
Cinematic, Motivation, Education.

- **Search** by style / color / industry / animation, and **sort** by
  Popular / Recent / Favorites / A–Z.
- **Category chips** (plus All, Favorites, Recent, My Templates).
- **✨ Suggest for** — pick your niche (Podcast, Business, Finance,
  Education, Fitness, Motivation, Gaming, Tech, Vlog) and CutPilot jumps to a
  recommended template.
- **Tap a card to apply** it — loads into the Editor in one click.
- **Save / Duplicate / Export / Import** custom templates (＋ Save, ⧉, ⤴ in
  the Editor; ⤓ Import in the library). Custom templates persist locally and
  appear under **My Templates**; export/import are `.cutpilot.json` files for
  sharing.

### Editor (live customizer)

**Live preview.** A 16:9 preview at the top shows your caption with the
current style and animation, looping in real time. Everything you change
updates it instantly. Tap ▶ to replay.

**Transcript (auto).** A single status line finds your transcript by itself:
SRT/VTT already in your project, next to your footage, or next to the
project file — the best match is selected automatically. It shows
"✅ Using yourfile.srt · Change". No transcript yet? It says so and "Get
one →" gives the 1-minute steps (Premiere **Window → Text → Transcribe**,
export SRT next to your video, **Find again**). Returning to the tab
re-checks automatically.

**Quick styles.** Tap a preset (Hormozi Bold, Karaoke Highlight, Highlight
Box, Clean Minimal, Neon Pop, Typewriter, Bold Yellow, Clean White, News
Bar) to load a starting look — then tweak it.

**Customize (always visible).** Full control, just like the AI caption apps:
- **Font** (curated trending list), **Size**, **Position** sliders
- **Layout** quick buttons (Top / Center / Bottom)
- **Text**, **Highlight**, **Outline**, **Box** color swatches
- **Outline width** slider, **Box** on/off, **CAPS** on/off
- **Words at a time** (1 = word-by-word pop, 0 = full lines)
- **✨ Auto-highlight keywords** — automatically emphasizes the strongest
  word, numbers, names, or call-to-action words in your chosen highlight
  color (Smart / Longest word / Numbers / CTA / Names)
- **Animation**: Pop, Scale, Zoom, Bounce, Slide up, Wave, Shake, Fade,
  Glitch, Karaoke, Typewriter, None

Then press **✨ Add captions**. The built-in engine renders every caption
frame to a transparent PNG with your exact look and places it on a new top
track with real Premiere keyframes. No templates required.

**Advanced — Premiere templates or a plain track** (collapsed):
- **Template (.mogrt)** — use a Motion Graphics Template for the animation,
  either **Installed** (CutPilot scans the templates installed in your copy
  of Premiere — the Essential Graphics library — and lists them grouped by
  folder; note this is *not* the Effects panel, which plugins can't
  enumerate) or **From a file** (any `.mogrt` you downloaded or made).
- **Plain track** — a normal, editable caption track to style once and save
  as a Track Style.

## Project layout

```
premiere-plugin/
├── CSXS/manifest.xml      CEP manifest (panel, PPRO 14+, Node enabled)
├── index.html             Panel UI (4 tabs)
├── css/style.css          Premiere-dark theme
├── js/
│   ├── main.js            Panel controller / UI glue
│   ├── audio.js           Web Audio + ffmpeg silence detectors
│   ├── silence.js         Range math (pure, unit-tested)
│   ├── captions.js        SRT tooling, style presets, animation planners
│   ├── render.js          Built-in caption render engine (canvas → PNG)
│   ├── multicam.js        Angle planning (pure, unit-tested)
│   └── lib/cep-bridge.js  Minimal CSInterface replacement
├── jsx/host.jsx           ExtendScript: razor, ripple, rebuild, multicam,
│                          caption placement + keyframed animations, MOGRT
│                          insertion, installed-template discovery
├── install-windows.bat    One-click installer (Windows)
├── install-mac.command    One-click installer (macOS)
└── test/run-tests.js      Node unit tests (node test/run-tests.js)
```

## Tests

```bash
node test/run-tests.js
```

The pure logic modules (silence math, SRT tooling, angle planning) run in
both the CEP panel and Node, so the cutting decisions are testable without
launching Premiere.

## Packaging for distribution

Use Adobe's ZXPSignCmd to sign and package:

```bash
ZXPSignCmd -selfSignedCert US NY CutPilot cert-pass certificate.p12
ZXPSignCmd -sign premiere-plugin CutPilot.zxp certificate.p12 cert-pass -tsa http://timestamp.digicert.com
```

Distribute the `.zxp` via [aescripts](https://aescripts.com),
[ZXP Installer](https://aescripts.com/learn/zxp-installer/), or the Adobe
Exchange marketplace.

## Known limitations (v0.1)

- The Web Audio decoder loads the whole file into memory — use the ffmpeg
  engine for files over ~20 minutes.
- "Cut in place" relies on the undocumented QE DOM. It is the same
  mechanism community silence-cutters use, but Adobe doesn't guarantee it;
  the safe rebuild mode is the supported path.
- Rendered captions are images: fully styled and animated automatically,
  but editing a word means re-running (or use the native caption engine,
  whose text stays editable in Premiere).
- Word-by-word on long videos renders many PNGs (≈1 per word). The panel
  warns above 1,500 frames; karaoke phrase mode reduces the count.
- Speed-ramped or reversed clips aren't compensated in the time mapping yet.

## Why CEP and not UXP?

UXP officially arrived for Premiere in 25.6 (December 2025) and is the
future, but its editing API doesn't yet cover everything this panel needs
(QE-style razor/ripple, MOGRT parameter access). Adobe has committed to
roughly a year of continued CEP support. CutPilot keeps every business rule
in pure JS modules (`js/silence.js`, `js/captions.js`, `js/multicam.js`)
with thin CEP/ExtendScript adapters, so the UXP port is a rewrite of the
adapter layer only. See `docs/RESEARCH.md` for the migration plan.
