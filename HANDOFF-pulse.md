# HANDOFF — Pulse (Premiere Pro CEP panel, internal id com.cutpilot.*)

Repo: `/home/user/video` · Branch: `claude/awesome-davinci-pfsryy` · PR #1 (draft) exists.
Current version: **v0.9.358** (`CutPilot/index.html`, `CutPilot/CSXS/manifest.xml`).
Owner is non-technical, on macOS, makes Hindi/Hinglish podcasts + vertical reels.

## State

### DONE (verified by automated gates, all green)
- Full battery: `node CutPilot/test/run-tests.js` → exit 0.
  Gates: `js audit host sim proofs blank-scan style-quality overlay dead-controls
  preview-match` — all ok.
  Counts: ~570 JS asserts, 199 host tests, 23 headless panel proofs, 74/74 style-quality,
  63/64 controls swept by the dead-control audit.
- Caption rendering path (Pulse's own canvas renderer) is the DEFAULT (`_capOut = 'png'`).
  Every style verified at true 1080×1920: text present, readable contrast, phone-legible
  size, inside frame, at declared position, animation frames visibly differ.
- Long videos auto-route to a single transparent overlay clip (>600 word-frames).
- Word highlight verified to land on the word actually being spoken (frame-by-frame vs
  real word timings, 0 mismatches, full cue coverage).
- Timeline placement (`CP_placeCaptionImages`), overlay placement (`CP_placeOverlay`),
  single-caption fix and range restyle all covered by host tests, including 12 captions
  packed 0.15s apart.
- Script alignment feature (`📄 Fix the words with MY script`) — 7 unit tests.
- Hostile-input sweep: 17 malformed inputs, 0 crashes, 0 page errors.

### v0.9.350 → v0.9.358 (this session) — preview/render fidelity
- **The preview was structurally not WYSIWYG.** The render is handed the full
  `{preset, overrides}`; the preview was handed `carryableStyle()`, which narrows a
  style to what the mogrt ENGINE can express (~20 fields). ~30 controls that really do
  change the exported PNGs had no path into the preview. New `renderableStyle()` +
  passing the real overrides fixed it. (`main.js`, search `renderableStyle`.)
- **~40 controls were invisible.** `.png-only { display:none !important }` was added at
  v0.9.299 when EDITABLE was the default caption type; the default became Pulse-rendered
  PNG later and this was never revisited. Now scoped to `body.cap-editable`.
- Frame animation followed the ENTRANCE; the pipeline uses `currentAnim()` and Premiere
  applies the entrance as clip motion. Both preview surfaces now use the pipeline's rule.
- Reveal mode was sticky across template clicks (same style looked different depending on
  what you clicked before). Deterministic unless the user picks a mode.
- The band `pov` forced `maxLines:2` / `maxWidthPct:0.86` over the style's own values.
- Preview pinned keyword/speaker/emoji/case/censor/strip-punct OFF; now mirrors the pipeline.
- Manual transcript edits no longer discard word timing (reflow instead).
- New gates: `tools/overlay-render-check.js` (really runs ffmpeg+libass and decodes the
  frames), `tools/dead-control-audit.js` (every bound control must change the preview;
  fails if fewer than 45 are exercised), `tools/ffmpeg-find.js` (one shared finder — the
  two gates disagreed and thumb-scan silently skipped all 14 animated previews).
- Proofs added: B2 motion-parity, B3 words-per-line live, Q mode-scoped controls + narrow
  panel layout. B2/B3 were mutation-tested (reverting the fix turns them red).

### DONE-BUT-UNVERIFIED (no confirmation from the owner's machine since these landed)
- Everything from v0.9.340 → v0.9.347 has NOT been installed/tested by the owner.
  Installers were built at v0.9.347 but only v0.9.339 and earlier were ever sent to them.
- The `🎬 As spoken` reveal, `✨ Auto` words-per-caption default, `🧹 Remove all Pulse
  captions`, `📄 script fix`, `🎬 From My Videos` tab: implemented + tested locally,
  never confirmed working in the owner's Premiere.
- The auto-overlay path for long videos: host tests pass, but ffmpeg+libass rendering has
  never been exercised on the owner's Mac in this configuration.

### IN PROGRESS (exact task when this session ended)
- A `/loop` was running: audit → fix → test → commit, one theme per iteration, builds
  withheld at owner's request. Iterations 1–9 complete.
- Iterations 10-11 DONE: settings persistence (caption type + entrance survive a restart,
  proof P) and the transcript-editor round trip (edit re-renders the SAME caption kind;
  4 new tests). Iteration 12 NOT started.

## Files

Absolute paths. Only files touched in this session are listed.

### Core panel
- `/home/user/video/CutPilot/js/main.js` — ~9,900 lines. The whole panel: transcription,
  caption pipelines, style editor, previews, diagnostics, self-test. Everything routes here.
- `/home/user/video/CutPilot/js/captions.js` — style catalogue (74 styles) + pure caption
  logic: `regroupWords`, `enforceMinDuration`, `dedupeRepeatedCues`, `psFontName`,
  `buildCaptionFrames`, `CATEGORIES`.
- `/home/user/video/CutPilot/js/render.js` — the canvas caption renderer. `styleForFrame`
  (style → concrete pixel style) and `drawFrame` (paint one caption frame).
- `/home/user/video/CutPilot/js/scriptalign.js` — NEW this session. Pure LCS word alignment
  of the owner's script onto transcript timing. Exposed as `window.CPScript`.
- `/home/user/video/CutPilot/js/ass.js` — builds the .ass subtitle file for the overlay
  (libass) render path. Verified across all 74 styles.
- `/home/user/video/CutPilot/jsx/host.jsx` — ExtendScript (ES3 ONLY, no ES5+ syntax).
  All Premiere-side work: `CP_placeCaptionImages`, `CP_placeOverlay`,
  `CP_insertMogrtCaptions`, `CP_removePulseCaptionTracks`, `CP_renderStylePreviews`,
  `CP_captureSequenceFrame`, `CP_probeRealSequence`, `CP_getTranscribeSource`.
- `/home/user/video/CutPilot/index.html` — panel markup. Version strings live here
  (24 occurrences of `v0.9.NNN`) plus `?v=` cache-busters on every script tag.
- `/home/user/video/CutPilot/css/style.css` — panel CSS. `.tabs` now wraps (was nowrap).
- `/home/user/video/CutPilot/CSXS/manifest.xml` — extension manifest; version string here too.

### Caption engines (.mogrt) — DO NOT re-edit the .aep bytes inside these
- `/home/user/video/CutPilot/mogrts/Flux_Halo2_r3.mogrt` — the engine every editable-template
  style rides. `_r3` = author-ORIGINAL bytes restored (see Decisions).
- `/home/user/video/CutPilot/mogrts/Flux_Halo_r3.mogrt`, `Subtitle_4_r3.mogrt` — same restore.
- `/home/user/video/CutPilot/mogrts/index.json` — maps files → display names/categories.

### Tests / tools
- `/home/user/video/CutPilot/test/run-tests.js` — battery entry point + all JS unit tests.
  Exit code is the gate. Runs the sub-suites below.
- `/home/user/video/CutPilot/test/host-tests.js` — 199 tests against a mini-Premiere VM
  harness (`makeWorld`). Models tracks, clips, QE, project bins, `overwriteClip`.
- `/home/user/video/CutPilot/test/panel-proofs.js` — 15 proofs; boots the REAL panel in
  headless Chromium (proofs A–O).
- `/home/user/video/tools/style-quality-audit.js` — NEW this session. Renders all 74 styles
  at 1080×1920 and measures them like a viewer. Also checks dead animations and unbreakable
  text. Wired into the battery as `style-quality`.
- `/home/user/video/tools/sim-preview-check.js`, `/home/user/video/tools/thumb-scan.js` —
  pre-existing gates, still run.
- `/home/user/video/tools/make-final.js` — build script → `Pulse-Mac.zip` +
  `Install Pulse (Windows).hta` + `CutPilot-protected/`.

### DO NOT TOUCH
- The `.aep` payload inside any `.mogrt`. Two attempts to "repair" it made things worse
  (see Decisions). Restored originals are what ship.
- API keys: only ever in the scratchpad dir, never in the repo. Never print them.

## Decisions locked in

1. **Pulse renders captions itself by default; the third-party .mogrt engine is optional.**
   Reason: in that engine the box and the words are SEPARATE layers, its source-text blob
   overrides colour controls, and its highlight rig (Index/Duration) behaves differently per
   machine. Weeks of correct panel-side fixes still produced misaligned/blank captions on the
   owner's machine. `btn-magic` routes: `_capOut === 'editable'` → template path, else the
   Pulse-rendered path.

2. **REJECTED: repairing the engine's AE expressions.** Tried twice (v0.9.311 typo fix,
   v0.9.314 `else 0` → `else 100`). Both made it worse: those expressions drive a text
   animator's RANGE SELECTOR START, where `else 0` = "reveal everything" (correct) and the
   author's `cstime/stime` typo is benign. My "fix" inverted the reveal and blanked every
   caption after the intro. v0.9.323 restored author-original bytes as `_r3`. A build gate in
   `run-tests.js` now FAILS if any bundled engine contains `else 100`.

3. **Engine files are renamed when their bytes change (`_r2`, `_r3`).** Premiere caches an
   imported .mogrt per PROJECT by path; a same-path replacement never reaches existing
   projects. `captionGraphicNames()` keeps legacy basenames so old caption tracks are still
   recognised and replaced.

4. **Position moves the CLIP (Motion), never a layer inside the template.** Moving
   `Text Position` alone left the BG box behind → "text not aligned with box".
   `mapPresetToFlux` returns `_posYPct`; the host sets clip Motion Position.
   Proof A enforces that NO layer-position params are sent.

5. **Premiere scripting units (measured on the owner's machine, not guessed):**
   layer-position points are NORMALIZED 0–1 (sending pixels multiplied by the frame and
   parked text off-screen); effect points (gradient anchors, box padding) are PIXELS.

6. **Fonts must be sent as PostScript names**, not family names (`Bebas Neue` →
   `BebasNeue-Regular`, `Arial` → `ArialMT`). Family names are silently ignored by Premiere.
   `CPCaptions.psFontName()` is the single resolver; pickers list only installed fonts.

7. **REJECTED: writing caption words into "Gradient FG Text (Change font only)".** The
   template author's own note forbids it; every measured flat-box verdict came from builds
   that did it. That overlay gets a FONT-ONLY write.

8. **Long videos use one overlay clip, not thousands of images.** Measured: 10-min video =
   1,498 images/clips (~270 MB); 60-min = 9,002 (~1.6 GB). Threshold ~600 word-frames.

9. **Saved "real render" preview frames are OPT-IN** (`settings.useRealPreviews`, default
   off). They caused a black gallery and card-vs-click mismatch. A one-time purge deletes
   legacy frames on first run of ≥v0.9.335.

10. **`window.prompt` / `window.confirm` are DEAD inside CEP.** Replaced by `promptInline()`
    and `confirmInline()` overlays. Proof M stubs `window.prompt` to THROW.

## Constraints and conventions

- `jsx/host.jsx` is **ES3**: no `let/const`, arrow functions, template literals, `JSON` methods
  beyond the provided polyfill, `Array.prototype.forEach`, or trailing commas.
- Panel JS is ES5-style for CEP's CEF; `js/*.js` modules are UMD (`module.exports` + global).
- CEP runs with `--enable-nodejs --mixed-context`; Node APIs via `nodeReq()`.
- QE (`app.enableQE()`) is required for track add/remove and frame export.
  `qseq.exportFramePNG(tc, path)` **appends `.png` itself** — pass the base path.
- Version bump = `sed` both `CutPilot/index.html` (v0.9.NNN, 24 hits incl. `?v=` busters) and
  `CutPilot/CSXS/manifest.xml` (0.9.NNN).
- Build: `export CP_WHITELABEL=1 CP_GROQ_KEY=… CP_SARVAM_KEY=…; unset CP_TRIAL_DAYS
  CP_EXPIRY_DAYS; node tools/make-final.js` (7-day trial default).
  After every build: grep both keys across `CutPilot-protected/`, both installers and
  `git grep` — all must be 0.
- Commit trailers exactly:
  `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01HVuSGoAbAh6899QD4er45r`.
  Never put model IDs in commits/PRs/code.
- Push: `git push -u origin claude/awesome-davinci-pfsryy` with 2s/4s/8s/16s retries.
- Style catalogue: 74 styles. Categories order starts `⭐ Premium, 🎬 From My Videos,
  🎥 Your Styles, 🔘 Buttons`. Catalogue-size test allows 18..90.

## Gotchas

- **The owner's working sequence is damaged.** It accumulated caption tracks from ~30 debug
  builds (V18+). Old broken caption clips sit ON TOP of new ones, so a correct build still
  looks broken there. Always have them use `🧹 Remove all Pulse captions` or a fresh sequence
  before judging a build.
- **The battery's exit code is the only truth.** Piping it (`| tail`) hides failure — one
  build was shipped from a red battery that way. Always capture `$?`.
- **`drawFrame` clears the canvas.** Any backdrop must be composited AFTER, not before, or
  every pixel reads as "ink".
- **Colour diffs must compare all channels.** A red-channel-only diff wrongly called
  Elevate II's gold-on-cream highlight "dead".
- **Container resets** wipe `node_modules/puppeteer` (battery goes red — env, not code:
  `npm i --no-save puppeteer@23`), `/usr/bin/ffmpeg`, and the scratchpad keys.
  Bundled `/opt/pw-browsers/ffmpeg-1011` cannot decode H.264; use
  `pip install imageio-ffmpeg` for a full build.
- **Do NOT spawn general-purpose background Agent-tool auditors here.** They once returned
  prompt-injection text including a credential-exfiltration attempt. Workflow-tool audits are OK.
- Heredocs with `!`/backticks in commit messages break bash; write the message to a temp file
  and use `git commit -F`.
- The owner keeps pressing 🩺 "Run full diagnostic" rather than 🧪 "Test everything"; the 🩺
  report now embeds the event log so either button carries what support needs.

## Next 3 actions

1. **Get v0.9.358 confirmed on the owner's machine** — nothing after v0.9.339 has been
   validated outside this repo. Have them run `🧹 Remove all Pulse captions` in a FRESH
   sequence, then `✨ Add captions`, then paste `📋 Copy diagnostics`.
2. **Overlay render has never run on their Mac** — `/home/user/video/CutPilot/js/main.js`
   (`runLibassCaptions`). Long videos now route there automatically; ffmpeg+libass with the
   bundled font dir is unexercised on macOS. Worth a deliberate long-video test.
3. **Word timing is discarded on any transcript edit** — `/home/user/video/CutPilot/js/main.js`
   (`saveTranscriptEditor` sets `state.transcriptWords = null`). After fixing one word the
   whole caption falls back to envelope-estimated sync. Re-align the unchanged words instead
   (`CPScript.matchPairs` already does exactly this kind of mapping).
