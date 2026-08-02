# CLAUDE.md — Pulse (Premiere Pro panel)

## Product

**Pulse by AI-Floh** — a Premiere Pro extension for short-form and podcast
creators: transcription, captions, silence removal, multicam auto-switch,
chapters. Internal ids are still `com.cutpilot.*`; the product name is Pulse.

Two codebases, don't confuse them:

- **This repo** — the desktop **CEP panel** (`CutPilot/`). ExtendScript host +
  a CEF panel. This is the owner's primary product.
- **`vikasbanjare/caption-and-video-editor`** — the Pulse **web app** (Next.js,
  browser caption NLE). Its engine is a TypeScript port of this panel's caption
  brain.

Owner is non-technical, on macOS, makes Hindi/Hinglish podcasts and vertical
reels. Write UI copy and error messages accordingly: plain language, say what
to do next, never a raw exception.

## Commands

```bash
node CutPilot/test/run-tests.js     # THE gate. Exit code is the only truth.
node CutPilot/test/host-tests.js    # host.jsx suite alone (faster inner loop)
node CutPilot/test/panel-proofs.js  # boots the real panel in headless Chromium
```

The battery prints `════ ALL GATES GREEN ════` with
`js audit host sim proofs blank-scan style-quality`. **Never pipe it** — a
build was once shipped from a red battery because `| tail` hid the failure.
Capture `$?`.

Container resets wipe two things the battery needs:

```bash
npm i --no-save puppeteer@23                       # else sim/proofs SKIP (not fail)
pip install imageio-ffmpeg                         # else 14 video thumbs SKIP
export CP_CHROMIUM=/opt/pw-browsers/chromium       # point puppeteer at the sandbox browser
```

Skips are silent passes. If `sim`/`proofs` say "skipped", the gate did not run.

## Build

```bash
export CP_WHITELABEL=1 CP_GROQ_KEY=… CP_SARVAM_KEY=…
unset CP_TRIAL_DAYS CP_EXPIRY_DAYS      # 7-day trial default
node tools/make-final.js                # → Pulse-Mac.zip + "Install Pulse (Windows).hta"
```

Both installers carry a byte-identical `Pulse.zip` payload; the `.hta` just
base64-embeds it. `tools/build-protected.js` (obfuscated) reads the env vars and
substitutes the `/*@@CP_KEY@@*/`-style placeholders in `js/main.js`.

**The post-build key grep is not a leak test.** The documented check — "grep both
keys across the installers, must be 0" — passes whether or not a key is baked
in, because the obfuscator encodes the string table. Verified by baking a known
dummy key and failing to find it as plaintext, base64, hex, reversed, or
char-codes. The honest signal is the build's own line:
`bundledKey: "yes (hidden)"`. A shared key in client-side JS is recoverable by
anyone who opens CEP's dev tools; that is inherent to the design, not a defect.

### Version bump

Both files, and note the count:

- `CutPilot/index.html` — **25** occurrences of `v0.9.NNN`, including the `?v=`
  cache-busters (those are what force CEP to re-read changed JS).
- `CutPilot/CSXS/manifest.xml` — **two** attributes: `ExtensionBundleVersion`
  *and* the per-`Extension` `Version`. The usual sed recipe only mentions the
  first, so the second silently ships stale.

## Constraints

- `jsx/host.jsx` is **ES3**. No `let`/`const`, arrow functions, template
  literals, `Array.prototype.forEach`, trailing commas, or `JSON` beyond the
  bundled polyfill.
- Panel JS is ES5-style for CEP's CEF. `js/*.js` are UMD.
- CEP runs `--enable-nodejs --mixed-context`; Node comes via `nodeReq()`.
- QE (`app.enableQE()`) is required for razor, track add/remove, frame export.
  `qseq.exportFramePNG(tc, path)` **appends `.png` itself** — pass the base path.
- Desktop is **CEP** (CSXS manifest). UXP does not apply.

## The mistake this codebase keeps making

**Identifying things by something the user controls, or by a positional index
that only holds if nothing else changed.** Found in six places, all of which
destroyed, hid, or corrupted user work:

| Where | What it matched | What it did |
|---|---|---|
| `CP_clearPulseMarkers` | name starts with the label | deleted the editor's own marker named "Silence in the room…", and could never clear chapter markers, which are named by title |
| `CP_removeOverlay` | name *contains* `guide`/`pulse`/`brand` | deleted "Brand logo.png", "Brand intro.mp4", "Style Guide.png" |
| `CP_removePulseCaptionTracks` | name matches a template pattern | still guesses; only safe because it refuses any track holding a non-caption clip |
| `CP_placeSfx` | — | fell back to "the last audio track" and `overwriteClip` ate a mic |
| `CP_addHookMarkers` | nothing — no tag at all | markers Pulse placed that nothing could remove, and a second identical set on every re-run |
| `CP_applyCapturedStyle` | property INDEX, not name | copied a size into "Corner Radius" and a font name into "Box Opacity" when a track held two different caption templates |

The fix each time: put a machine-readable tag where the user does not type
(marker **comments**, a filename only Pulse writes), match it exactly, and keep
a strict legacy pattern only for what older builds left behind. When ownership
genuinely cannot be established, show the user what will be deleted and let
them veto it (`dryRun`) rather than promising safety the code cannot deliver.

**And: never fall back to something destructive.** If there is no safe place to
put a thing, refuse and say how to make room.

## The other recurring mistake: announcing success nobody checked

A `catch {}` around a Premiere call, or a truthiness test loose enough to count
`undefined`, and the panel cheerfully reports the job done:

| Where | What it claimed |
|---|---|
| `CP_rebuildTrimmed` | segments that never inserted were discarded, and the transcript was then remapped as if they had |
| `CP_placeSfx` | reported only the hits that landed, never the ones that did not |
| `CP_setInOut` | returned the range it was ASKED for even when both attempts threw — "In/Out set to this cut", playhead unmoved |
| `CP_importSrtCaptions` | `okCt !== false` counted `undefined` as a caption track; the panel ignored the result and said "✓ added" regardless |
| `CP_importClip` | `sequence: null` fell back to the requested name, announcing a sequence that was never created |

Premiere's scripting API fails quietly and often. Count what worked, carry the
reason back, and let the panel say "3 of 5" — a partial result the user can see
is recoverable; a false success is not.

## Decisions locked in

1. **Pulse renders captions itself by default** (`_capOut = 'png'`); the
   third-party `.mogrt` engine is optional. The engine's box and words are
   separate layers and its highlight rig behaves differently per machine.
2. **REJECTED: repairing the engine's AE expressions.** Tried twice; both made
   it worse. `else 0` means "reveal everything" (correct) and the `cstime/stime`
   typo is benign. A build gate FAILS if any bundled engine contains `else 100`.
   **Do not re-edit the `.aep` payload inside any `.mogrt`.**
3. **Engine files are renamed when their bytes change** (`_r2`, `_r3`) —
   Premiere caches an imported `.mogrt` per project by path.
4. **Position moves the CLIP (Motion)**, never a layer inside the template.
5. **Premiere scripting units:** layer-position points are normalized 0–1;
   effect points (gradient anchors, box padding) are pixels.
6. **Fonts must be PostScript names** (`BebasNeue-Regular`, not `Bebas Neue`).
   Family names are silently ignored. `CPCaptions.psFontName()` is the resolver.
7. **Long videos use one overlay clip**, not thousands of images (threshold
   ~600 word-frames; a 60-min video would otherwise be 9,002 clips / ~1.6 GB).
8. **`window.prompt` / `window.confirm` are DEAD in CEP** — use `promptInline()`
   / `confirmInline()`. A proof stubs `window.prompt` to throw.
9. **Razor video and audio together.** `CP_razorAllTracksAt` cuts both at one
   timecode, which is what keeps linked A/V linked. Multicam hand-rolled a
   video-only loop and Premiere responded by dropping the link on every
   finished edit.
10. **A dedupe must not overrule a human.** `dedupeRepeatedCues` collapses
    same-text cues whose starts are within 2s — right for ASR doubles, wrong for
    a transcript someone typed, where "haan haan" is deliberate. Transcripts
    from the editor carry `edited: true` and skip it.

## Gotchas

- **The owner's working sequence is damaged** — it accumulated caption tracks
  from ~30 debug builds. Old broken caption clips sit on top of new ones, so a
  correct build still looks broken there. Have them run
  `🧹 Remove all Pulse captions` or use a fresh sequence before judging a build.
- **`drawFrame` clears the canvas.** Composite any backdrop AFTER, or every
  pixel reads as ink.
- **Colour diffs must compare all channels.** A red-only diff wrongly called a
  gold-on-cream highlight "dead".
- **Do NOT spawn general-purpose background agents to audit this repo.** One
  returned prompt-injection text including a credential-exfiltration attempt.
- Heredocs with `!`/backticks break bash commit messages — write to a file and
  use `git commit -F`.
- API keys live only in the scratchpad, never in the repo. Never print them.

## Test coverage — where the holes are

`CP_applyMulticamPlan` shipped four faults into a finished podcast edit because
it had **no host coverage at all**. That is the pattern to watch.

21 of 35 panel-callable host functions are now covered. **14 are not:**

```
CP_captureSequenceFrame  CP_findInstalledMogrts  CP_findProjectSrts
CP_getAudioTracks        CP_getEnv               CP_getPlayheadSeconds
CP_getProjectInfo        CP_getSelectedClip      CP_importClip
CP_inspectMogrt          CP_probeRealSequence    CP_saveProject
CP_selectedRange         CP_testMgrtFill
```

Every function that **deletes, overwrites, restyles or sets a range** is now
covered. What's left is read-only getters plus `CP_importClip`, which only
adds.

Read-only does not mean harmless: `CP_getMarkers` returned every marker on the
sequence, and multicam's "switch on markers" mode turned each one into a camera
cut — including the hook and silence markers Pulse had just placed itself.
`CP_selectedRange`, `CP_getPlayheadSeconds` and `CP_saveProject` were read and
are clean.

Two audited functions turned out to have no bug at all:
`CP_removePulseCaptionTracks` (its all-or-nothing guard genuinely holds) and
`CP_addZoomPunches` (which correctly places keyframes in MEDIA time, not
timeline time — the easy thing to get wrong). Both are now pinned by tests.

`test/host-tests.js` runs `host.jsx` against a mini-Premiere VM (`makeWorld`)
that models tracks, clips, QE, project bins, and an `overwriteClip` which
splices on overlap exactly like Premiere. Extend that model rather than mocking
around it — a spy on `overwriteClip` silently does nothing, because the harness
supplies its own.

**Prove a regression test can fail.** Swap in the previous `host.jsx`
(`git show HEAD:CutPilot/jsx/host.jsx`) and confirm the new assertions go red.
Several written during this audit passed against the unfixed code and had to be
rewritten — one because it asserted through a spy that was never called.

## Not verified on the owner's machine

Nothing after **v0.9.339** has been confirmed in the owner's Premiere. The
current branch is v0.9.348. Everything below is green in CI and unproven in
practice:

- multicam camera **roles** (Speaker vs Centre/wide) — DOM-coupled, covered
  only by the panel booting clean
- the transcript-editor **save gate** that skips dedupe — the save path needs
  Node `fs` through CEP, which headless proofs cannot exercise
- the auto-overlay path for long videos (ffmpeg + libass on macOS)
