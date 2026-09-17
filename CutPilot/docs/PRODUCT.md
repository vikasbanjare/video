# CutPilot — Product Brief & Roadmap

*Owner: product/design/eng. Last updated: June 2026 (v0.9). Companion to
[`RESEARCH.md`](RESEARCH.md) (market) and [`DESIGN.md`](DESIGN.md) (UI spec).*

---

## 1. The one-liner

**CutPilot turns a raw multicam/talking-head recording into a finished short in
three clicks — silence removed, cameras cut to the speaker, trend-styled
captions burned in — without leaving Premiere Pro.**

It is the Premiere-native answer to AutoCut / TimeBolt / Submagic / Firecut: the
automation creators pay monthly web tools for, living *inside* the timeline they
already trust, with every edit still hand-tweakable.

## 2. Who it's for (and the job)

- **Primary:** solo creators, podcast editors, agency editors on Premiere who
  cut long-form talking-head/podcast/multicam content into shorts.
- **Job to be done:** *"I shot good footage; do the repetitive editing for me,
  but leave me in control and don't make me learn a new app or upload my media
  to a website."*
- **Why us over web tools:** no re-upload, no per-export fees, works on the real
  sequence, results are native Premiere clips/keyframes they can still adjust.

## 3. North star & guardrails

- **North star:** *finished shorts shipped per editor per week.*
- **Activation:** first session ends with captions or a cut applied to a real
  sequence.
- **Quality guardrails:** never destroy the user's sequence (safe-rebuild
  default, auto-backup before QE cuts); never produce an unreadable caption
  (legibility check, v0.8); always show a preview/checklist before applying.

## 4. Product principles

1. **One screen per job; one hero action per screen.** (Captions / Smart Cut /
   Multicam / Settings.)
2. **Progressive disclosure.** Defaults that work on the first click; power
   under "Advanced".
3. **Preview before commit.** Markers, checklists, live caption preview.
4. **Non-destructive by default.** The supported, reversible path is the
   default; the risky one is opt-in and backs up first.
5. **Readable anywhere.** Captions must survive any background on a muted phone
   (drives the v0.8 legibility checker).
6. **Stay native.** Output is real Premiere clips/keyframes/tracks, never a
   black box.

## 5. What shipped recently

- **v0.6** FireCut-style "cut to whoever's talking" multicam.
- **v0.7** Caption template studio (24+ templates) + built-in PNG render engine.
- **v0.3 line** Transcript intelligence: **filler-word removal** + **TF-IDF
  keyword auto-highlight** (pure, tested).
- **v0.8 — product polish:**
  - **Fonts done right:** the picker now lists **every font installed on the
    user's machine** (parsed from the OS font folders) + a curated web-font
    catalog that renders even when not installed + **Custom font…**, with a
    **search/filter** box because the list is long.
  - **Legibility checker:** inline warning when a caption style would be hard to
    read over video (no outline/box/glow, or low text-vs-box contrast).
  - **Remembers your look:** the Customize panel (preset, animation, colors,
    font, size, position…) persists between sessions.
  - **MOGRT fixes:** dedicated track, overlap-safe timing, duration-clamp
    reporting; section promoted out of the hidden drawer.
  - **Release hygiene:** one version number (v0.8.0) across manifest, UI,
    installers, and docs.
- **v0.9 — productivity + a new tool (this release):**
  - **⌘K command palette** — fuzzy quick-action launcher (jump to any tab or
    action by typing); **1–5** keyboard tab switching. Speed for power users.
  - **Chapters tool** — transcript → timestamped YouTube/podcast chapters,
    copy to description or drop as named timeline markers (pure, tested).

## 6. Roadmap (prioritized)

Ranked by impact ÷ effort, with the platform reality (CEP now, UXP within a
year) in mind.

### v0.9 — "finish the short" (next)
- **Caption re-time after Smart Cut.** `remapCuesToKeeps` is already built and
  tested — wire it so captions follow a trimmed sequence. *(High impact, low
  effort — the logic exists.)*
- **Auto-zoom punch-ins** (alternate 100%/110% scale per segment) — the standard
  retention trick; trivial via clip Motion keyframes (host already keyframes
  scale for the `pop` caption animation).
- **Font search → MOGRT text-field picker** parity: let users pick which MOGRT
  field gets the text (kills the "words won't fill" class of issues).
- **Filler-removal stats & undo affordance** ("removed 14 ums · 0:09").

### v1.0 — packaging & trust
- **UXP port of the adapter layer** (panel logic is already framework-free and
  pure-tested; only the CEP/ExtendScript adapters change).
- **Sign & ship** `.zxp` to Adobe Exchange / aescripts; auto-update channel.
- **Onboarding:** a 60-second first-run tour + a "what's your setup?" guided
  multicam flow (DESIGN.md §8 calls this out).
- **Telemetry (opt-in)** for activation/north-star, error reporting.

### v1.x — intelligence & breadth
- **Contextual silence (VAD)** that keeps laughter/intentional pauses (ONNX in
  Node).
- **Local Whisper** transcripts (no dependence on Premiere STT).
- **AI B-roll / SFX / emoji** suggestions from transcript keywords.
- **Auto-reframe** presets for 9:16 / 1:1.

## 7. Pricing & GTM (working thesis)

- **Model:** one-time license with a year of updates (≈ **$129**, in TimeBolt's
  $97–197 band), *not* a subscription — the anti-subscription stance is a
  wedge against the web tools, and CEP runs locally so there's no per-export
  cost to recoup.
- **Free tier / trial:** watermark-free but capped (e.g. captions limited to N
  per project) for 7 days, or a permanent "Smart Cut only" free tier.
- **Channels:** aescripts + Adobe Exchange (distribution & trust), creator
  YouTube/TikTok demos (the output *is* the ad), template marketplace later.
- **Moat:** native Premiere integration + pure, testable edit-logic that ports
  cleanly to UXP while web competitors can't enter the timeline at all.

## 8. Backlog — "what a pro would change next" (beyond the roadmap)

Smaller craft and quality items, roughly ordered:

- **Searchable everything:** the template gallery and installed-font list both
  deserve the same filter pattern (done for fonts in v0.8).
- **Accessibility:** focus-visible states, ARIA labels, full keyboard nav,
  larger hit targets — table stakes for a pro tool.
- **Empty/again states:** friendlier first-run and "no transcript / no audio
  tracks" guidance (partially there; make it consistent).
- **Error taxonomy:** turn raw host errors into plain-language fixes with a
  one-tap "copy diagnostics".
- **Performance:** stream Web-Audio decode for >20-min files; cap or chunk the
  installed-font scan if a machine has thousands of fonts.

- **Caption editing without re-render:** offer the native editable caption track
  as a first-class output (currently advanced), since rendered PNGs aren't
  editable after the fact.
- **Project-level presets:** team-shareable style/cut presets (the
  `.cutpilot.json` schema already exists for templates).
- **Localization:** the caption/transcript pipeline is language-agnostic; the UI
  isn't yet.

## 9. How we keep quality high

Every cutting/caption/font decision lives in **pure JS modules**
(`silence`, `captions`, `multicam`, `transcript`, `fonts`, `render`) with
Node unit tests (`node test/run-tests.js`), so the logic is verifiable without
launching Premiere and the eventual UXP port is an adapter swap, not a rewrite.
