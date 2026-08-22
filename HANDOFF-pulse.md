# HANDOFF — Pulse (Premiere Pro CEP panel, internal id com.cutpilot.*)

Repo: `/home/user/video` · Branch: `claude/awesome-davinci-pfsryy` · PR #1 (draft) exists.
Current version: **v0.9.384** (`CutPilot/index.html`, `CutPilot/CSXS/manifest.xml`).
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

### v0.9.350 → v0.9.384 (this session)

**The preview could not have matched the render — it was structural.** The export
path is handed the full `{preset, overrides}`; the preview was handed
`carryableStyle()`, which narrows a style to what the mogrt ENGINE can express
(~20 fields, weight clamped to bold-or-regular). ~30 controls that really do
change the exported PNGs had no path into the preview at all. New
`renderableStyle()` + passing the real overrides fixed it. Search `renderableStyle`
and `previewBasis` in main.js.

**~40 controls were invisible in the mode they work in.**
`.png-only { display:none !important }` was added at v0.9.299 when EDITABLE was the
default caption type; the default became Pulse-rendered PNG later and this was never
revisited. Now scoped to `body.cap-editable`, which `setCapOut()` maintains.

Other real defects fixed:
- Frame animation followed the ENTRANCE; the pipeline uses `currentAnim()` and
  Premiere applies the entrance as CLIP motion, so the preview showed motion the
  frames never contain and hid the word sweep. Both surfaces use the pipeline's rule.
- Reveal mode was sticky across template clicks (a style looked different depending
  on what you clicked before it). Deterministic unless the user picks a mode.
- The band `pov` forced `maxLines:2` / `maxWidthPct:0.86` over each style's own values.
- The preview pinned keyword / speaker / emoji / case / censor / strip-punct OFF.
- Manual transcript edits discarded word timing (now reflows, like the AI-fix path).
- **Landscape captions all rendered at ONE size** — the legibility floor was 5% of the
  frame WIDTH, which at 1920x1080 exceeded every style's own size, so all 74 came out
  identical at 96px. Now 5% of the SHORT side; vertical/square output is byte-identical.
- The preview is now a TRUE CROP of the sequence (canvas width maps to frame width at
  the real aspect), so captions wrap into the same lines and a landscape sequence
  previews as landscape.
- **The long-video overlay (libass) disagreed with the canvas renderer** on four
  counts: it dropped the caption BOX entirely (every boxed style became bare outlined
  text on the path podcasts take), sized captions 25% larger on vertical video (no
  portrait boost), pinned the spoken-word pop at 116%, and read a DIFFERENT reveal
  control than the per-image path. All four now derive from `CPRender.styleForFrame`
  and `currentAnim()` — one resolved style, two rasterizers.
- Devanagari safety net appended to every font chain (Kohinoor/Devanagari MT/Nirmala
  UI/Mangal/Noto), so a serif chain cannot leave Hindi with no font to draw with.
- The auto-overlay decision probes `ffmpegHasLibass()` before routing, so a minimal
  ffmpeg no longer costs a failed render before falling back.

New gates (all wired into `run-tests.js`):
- `tools/preview-render-match.js` — renders the SAME frame at true output size through
  the export path's own call and compares PIXELS (dominant colour, exact line count,
  caption width as a share of the frame) across BOTH orientations.
- `tools/dead-control-audit.js` — every control the panel binds must change the
  preview. 63/64 exercised; FAILS if fewer than 45 are, because a harness that stops
  exercising things is the failure mode that hid the whole bug class.
- `tools/overlay-render-check.js` — really runs ffmpeg+libass and decodes frames:
  transparency, band position, animation alive, the BOX renders (by fill-ratio, not
  colour — a thick outline paints the same colour), and Hindi renders.
- `tools/ffmpeg-find.js` — one shared finder. The two gates disagreed and thumb-scan
  silently skipped all 14 animated previews.

Proofs added: B2 motion-parity, B3 words-per-line live, Q mode-scoped controls +
narrow-panel layout, R caption-type truth, S reveal sync, T renderer agreement,
U self-test coverage, V Hindi glyphs, W transcript editor at 1500 lines, X adversarial
text (16 inputs). 33 total.

**Testing lessons that cost real time — do not repeat them:**
- Three gates I wrote here initially COULD NOT FAIL. Mutation-test every new gate:
  break the fix on purpose and confirm the gate goes red, with real numbers.
- A skipped gate is not a passing gate. The battery used to print `overlay:ok` while
  skipping; it now prints `overlay:skip` plus a NOTE. CI had been skipping the overlay
  check, the 14 animated previews AND Hindi for the project's entire history.
- My Hindi check compared भारत vs कमलम — different cluster counts after shaping, so
  tofu boxes produce different ink and the test passed on a machine with NO Hindi font.
  Use कमल vs नमन (three spacing consonants each). A control render distinguishes
  "this machine cannot draw the script" (skip) from "this style is broken" (fail).

### BUILD — read before producing an installer
- `export CP_WHITELABEL=1 CP_GROQ_KEY="$(cat $SCRATCH/gk)" CP_SARVAM_KEY="$(cat $SCRATCH/sk)"; unset CP_TRIAL_DAYS CP_EXPIRY_DAYS; node tools/make-final.js`
- **The scratchpad keys are GONE** — a container restart wiped
  `$SCRATCH/gk` and `$SCRATCH/sk`. The build still runs and produces working
  installers, but with `bundledKey:no` / `bundledSarvam:no`, so transcription
  would need the owner to paste their own key in Settings. Ask the owner to
  re-supply the keys (and rotate them — they were pasted in chat) before
  shipping a keyed build.
- Every build now runs the SAME gates against the OBFUSCATED output
  (`CP_PANEL_DIR=CutPilot-protected`): panel proofs, dead-control audit,
  preview/render match. A build that behaves differently from the source
  fails and does not package. `CP_SKIP_BUILD_PROOFS=1` skips them while
  iterating on packaging only.
- Verified at v0.9.384: the built panel passes all 30 proofs.

### WHAT THE VISUAL GATES CANNOT SEE (read before trusting a green run)
- **The typefaces are not the owner's.** Many styles specify macOS fonts —
  Futura, Snell Roundhand, Avenir Next, Didot, Impact — that do not exist on this
  container or on the CI runner, so every visual gate renders them through
  fallbacks. What IS verified: layout, wrapping, contrast, size, position,
  clipping, animation. What is NOT: that the shipped face is the one the owner
  sees. `pack-script-glow` renders as a serif here and as real script on a Mac.
  These are Apple-licensed fonts; installing them here is not an option, so this
  gap is permanent and the self-test on their machine is the only thing that
  closes it.
- Same shape as the Hindi problem: a gate can only judge what the machine can
  draw. When a check cannot be made here, it must SKIP loudly (see the battery's
  `skip` reporting), never pass quietly.
- Verified faithful at v0.9.384: the two styles learned from the owner's own
  videos are present, in 🎬 From My Videos, and render as described —
  `pack-orange-word-pop` (white on a tight black bar, spoken word in an orange
  pill) and `pack-script-glow` (white script with a soft halo, no box).

### DONE-BUT-UNVERIFIED (no confirmation from the owner's machine)
- **Nothing after v0.9.339 has ever run on the owner's Mac.** Everything above is
  verified by automated gates here and in CI only. This is the single biggest open
  risk and the reason the self-test was rewritten (below).
- The self-test now reports the paths captions ACTUALLY take, measured on their
  machine at their sequence size with their fonts: `Caption renderer (Pulse)`,
  `Preview matches the render`, `Hindi captions (Devanagari)`, and
  `Long videos → ONE caption clip`. One paste of 📋 Copy diagnostics should now
  say what is wrong. It also runs the machine-side checks OUTSIDE Premiere.
- ffmpeg install path verified live (all three URLs serve real binaries, and the
  build is `--enable-libass --enable-fontconfig`), but not on their Mac.

### IN PROGRESS (exact task when this session ended)
- A `/loop`: audit → fix → test → commit, one theme per iteration, builds withheld
  at the owner's request. ~23 iterations complete through v0.9.384.
- No iteration is half-finished; the tree is clean and CI is green.

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
- `CutPilot/test/run-tests.js` — battery entry point + all JS unit tests. Exit code is
  the gate; it runs everything below. A SKIPPED gate now prints `skip`, not `ok`, plus a
  closing NOTE naming what guarded nothing.
- `CutPilot/test/host-tests.js` — 199 tests against a mini-Premiere VM harness
  (`makeWorld`). Models tracks, clips, QE, project bins, `overwriteClip`.
- `CutPilot/test/panel-proofs.js` — 33 proofs (A–X); boots the REAL panel in headless
  Chromium. Honours `CP_PANEL_DIR` so it can run against the BUILT panel.
- `tools/style-quality-audit.js` — renders all 74 styles at true output size in BOTH
  orientations (148 combinations) and measures them like a viewer; also checks dead
  animations and unbreakable text.
- `tools/preview-render-match.js` — preview vs a true-size render, compared as PIXELS
  across both orientations. `CP_PANEL_DIR`-aware.
- `tools/dead-control-audit.js` — every bound control must change the preview.
  `CP_PANEL_DIR`-aware.
- `tools/overlay-render-check.js` — real ffmpeg+libass render, frames decoded.
- `tools/ffmpeg-find.js` — the ONE ffmpeg finder. `CP_NO_FFMPEG=1` simulates a machine
  without ffmpeg (exercises graceful degradation and the battery's skip reporting).
- `tools/sim-preview-check.js`, `tools/thumb-scan.js` — pre-existing gates, still run.
- `tools/pipeline-contract-check.js` — runs the REAL renderFrames in Chromium and
  feeds exactly what it returns into the REAL CP_placeCaptionImages in the host
  harness. Tests the seam between the two runtimes; no fixture in between.
- `tools/mutation-check.js` — **run this before shipping and after writing any new
  gate.** Breaks one thing in the shipped code per entry and asserts the named gate
  goes red. Three gates written in one session could not fail until this habit was
  applied by hand; it is automated now. Not in the default battery (it runs whole
  gates repeatedly). `node tools/mutation-check.js [name]`. A mutation whose anchor
  has drifted reports "needs updating" rather than passing.
- `tools/make-final.js` — build → `Pulse-Mac.zip` + `Install Pulse (Windows).hta` +
  `CutPilot-protected/`. Runs the panel gates against the OBFUSCATED output before
  packaging; `CP_SKIP_BUILD_PROOFS=1` skips that while iterating on packaging.
- `.github/workflows/qa.yml` — installs `fonts-indic` + `ffmpeg` so the Hindi and
  overlay gates actually RUN there instead of skipping.

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

1. **Get a build onto the owner's Mac and read the self-test.** Nothing after v0.9.339
   has ever run there. Blocked on two things: the owner asked for no builds while the
   loop runs, and the bundled API keys were wiped by a container restart (see BUILD).
   When it happens: fresh sequence → `🧹 Remove all Pulse captions` → `✨ Add captions`
   → paste `📋 Copy diagnostics`. The four new self-test rows should localise almost
   anything that is wrong in one paste.
2. **Exercise a LONG video on their Mac.** The one-clip overlay is what a 60-minute
   podcast takes, and it has never run on macOS. It is now fully checked here (box,
   size, position, pop, Hindi, transparency) and in CI, but macOS font resolution
   through libass/fontconfig is the one part no gate here can reach.
3. **Pick up the loop.** No iteration is half-finished. Good next themes: the editable
   (.mogrt) path has had far less scrutiny than the Pulse renderer this session; and
   `assOptsFromStyle` still hardcodes `anim:'pop'` rather than following the style.
