# HANDOFF — Pulse (Premiere Pro CEP panel, internal id com.cutpilot.*)

Repo: `/home/user/video` · Branch: `claude/awesome-davinci-pfsryy` · PR #1 (draft) exists.
Current version: **v0.10.6** (`CutPilot/index.html`, `CutPilot/CSXS/manifest.xml`).
Owner is non-technical, on macOS, makes Hindi/Hinglish podcasts + vertical reels.

## State

### v0.10.6 — multicam cuts at Premiere's own playhead timecode when the razor ignores Pulse's
The owner's Mac, v0.10.5: the script loads now (Podcast cameras read the
tracks and built 12 cuts), but Apply said "Premiere didn’t make any of the 12
camera cuts" — the QE razor took every timecode WITHOUT an error and cut
nothing. Unknown which of: QE ignoring Pulse's timecode text (e.g. a timeline
whose time display is Frames), or a stale read of the timeline.
- CP_applyMulticamPlan: verify from a fresh sequence; if nothing landed, look
  again after $.sleep(300); then cut at the timecode the QE playhead writes
  (setPlayerPosition + qe…CTI.timecode — the pymiere-documented pattern),
  probing one cut first, then all; playhead restored.
- If still nothing: CP_failInfo carries fps, dropFrame, timebase,
  displayFormat, zeroPoint, timecodeSent, playheadTimecode, triedPlayhead,
  QE clip counts before/after, DOM clip counts, razorErrors, qeProblem — shown
  under the message ("What Premiere answered: …") and in 📋 diagnostics.
  **The owner's next report names the cause.** Success logs "(by playhead)".
- Gate multicam-razor-fallback (fake: razor 'own-text' + ctiFormat 'frames');
  2 mutations.
- host.jsx: CP_renderMogrtFrames (Premium template rendered by Premiere with
  the owner's words, frame by frame) — for the next release's Premium
  previews ("flux preview is very bad, not accurate": the template authors'
  own clips are low-resolution with their sample text). Not called yet.

### v0.10.5 — Pulse's Premiere script loads (or says exactly why not); real Premium previews
The owner's first run of v0.10.4 on the Mac: "ExtendScript error while calling
CP_getAudioTracks (check the host script loaded)", and Settings → Run the full
check stopped at "ERROR: ExtendScript error while calling CP_getEnv". Every
call into Premiere failed: Premiere had not loaded jsx/host.jsx.
- **Likely cause:** since v0.9.345 the protected build minified host.jsx with
  terser onto ONE line of 86,355 characters with renamed locals; the last
  version confirmed on the owner's Mac is v0.9.339. Both forms parse as ES3
  (acorn, ecmaVersion 3, allowReserved "never"), have no control characters
  or BOM, and the source's load-time code is ES3-safe — so the exact
  ExtendScript failure is not proven here (ExtendScript can't run on Linux).
  The build now ships jsx/*.jsx byte for byte as tested and refuses otherwise.
- **Self-repair + exact cause (cep-bridge.js):** on "EvalScript error." the
  bridge asks ExtendScript once; if CP_getEnv is missing it loads host.jsx
  with $.evalFile and retries; if that throws, ExtendScript's own message and
  line go into the error, the full check and 📋 diagnostics ("Premiere
  script: ok | loaded | failed — …"). **If the owner still sees a failure,
  that line names the cause — ask for 📋 Copy diagnostics first.**
  Organize already loads its organize.jsx with $.evalFile the same way.
- Gate host-load-recovery (8 checks; an imitation ExtendScript engine: the
  fake Premiere in its own vm context, $.evalFile, File, "EvalScript error."
  for a throw); 4 mutations.
- **Premium (Flux) previews were imitations:** tools/gen-preview-clips.js had
  replaced each template's own preview with a clip drawn by Pulse's caption
  engine (Apex, Surge and Vortex shared one). tools/real-mogrt-previews.js
  now cuts each card's preview from the template's own thumb.mp4 (cropped
  2:1 to the caption, ≤ 6 s loop, no sound) with the author's still as the
  poster (a frame of the preview where that still is black: Echo, Pulse,
  Surge). The old generator is deleted. Gate gallery-real-previews (fails on
  the old clips). Orbit and Vector's own previews really are glossy pills
  whose text reads only in the first moment — that is the template.

### v0.10.4 — one-mic podcasts follow each voice, free offline transcription, a better camera edit
Everything below is gated and mutation-verified (the mutation entries are in
tools/mutation-check.js). None of it has run on the owner's Mac yet.
- **Podcast cameras edit** (commit 1657511):
  - Redo with nothing to change said "applied — 0 cuts". It now says the
    timeline already has this edit, and what to change.
  - The three paces really differ (CPMulticam.PACES; longest shot Calm 45 s,
    Balanced 20 s, Snappy 10 s). Calm and Balanced used to make the same
    edit, because no real answer reached their 5 and 2 minute limits.
  - A long answer gets reaction shots of the listener. They leave and come
    back on a breath (reactionSpan pairs pauses of 0.2 s or more) and last
    2–9 s. At Balanced they are 6–17% of an interview (more the longer the
    answers run); Snappy runs 14–22%.
  - Gate multicam-edit-quality (13 checks). multicam-follow now judges
    reaction shots by those limits instead of as "wrong person": it had
    failed since 1657511, caught only when the whole multicam set was re-run.
- **Who's talking (one mic, several people)**, js/voices.js + main.js
  mcOneMicPlan / mcVoicesPlan:
  - Engine: sherpa-onnx 1.13.8's diarization program from its PyPI wheels
    (sherpa-onnx-bin + sherpa-onnx-core), with pyannote segmentation-3.0
    (MIT) and NVIDIA NeMo TitaNet-small (CC-BY-4.0; credited behind the ⓘ of
    Settings → Who's talking). URLs and SHA-256 pinned for Apple silicon (69 MB), Intel
    Mac (72 MB), Windows (82 MB) and Linux.
  - Install into ~/.cutpilot/voices/1.13.8: every download checked, wheels
    unzipped by Pulse (zipMember), the model's .tar.bz2 by the system tar,
    the program moved in last. A failed install leaves nothing. The Mac
    program needs only libonnxruntime.dylib next to it (@loader_path) and is
    code-signed (checked from its Mach-O). **Windows: whether its tar.exe
    reads .bz2 is untested** (it would fall back to talk bursts, saying why).
  - Flow: follow mode with one audio track, or a Left/Right that sound the
    same → Pulse asks once ("Download (69 MB)"). Then it mixes that track to
    a 16 kHz WAV and runs the engine (4 threads, about 0.1× real time here).
    Voice k goes to the k-th camera; cameras the owner set to "No mic
    (wide)" stay wides. ⇄ Swap and per-voice pickers work as in transcript
    mode. Declined or failed → the old talk-burst plan, with the reason.
  - How many people: two person-cameras → exactly 2 voices. With 3+ the
    engine decides (threshold 0.8), and "👥 How many people talk?" in the
    plan lets the owner say; it listens again once. Measured: 0.8 finds 4
    of 4 (sherpa's test recording) and 3 of 3 (Hindi TTS), but split one
    voice of a spliced test conversation in two; 0.85+ merged the two male
    Hindi TTS voices. No single threshold is right, hence the picker.
  - The split is cached per recording with a razor-proof key, so Swap, Redo,
    a pace change or Apply's razor cuts never listen again.
  - Gates: voices-engine (6, real downloads), multicam-voices (12, the real
    panel + host.jsx + ffmpeg + engine on a conversation with known turns:
    100% right camera), 19 voices.js unit tests; 16 mutations.
- **Transcribe on this computer** (free, no key, no Homebrew):
  - The owner's (white-label) build offers "💻 On this computer — free, no
    key (about 600 MB, once)" = large-v3-turbo-q5_0. Auto with no key still
    asks for the key (cloud stays the default), and that message names it.
  - No whisper.cpp found → Pulse fetches whisper.cpp-cli 0.0.3 from PyPI
    (Charlie Marsh's packaging of whisper.cpp of spring 2024, MIT; ~1 MB,
    pinned) into ~/.cutpilot/whisper/0.0.3/whisper-cli. Homebrew or a
    Settings path still wins. On a Mac it uses Accelerate but **runs on the
    CPU** (its Metal shaders are not bundled). whisper.cpp publishes no Mac
    program itself yet (v1.8.3 has Windows zips and an xcframework; a PR for
    Mac CLI builds, #4029, was open) — switch when it does.
  - Pulse asks before the 574 MB model download (every build). Cancel reads
    "Not transcribed — nothing was downloaded", not "failed".
  - The owner's build names no engine or model anywhere (the transcript bar
    said "Cloud · Groq (large-v3)"). A Deepgram transcript no longer claims
    "wanted ggml-cloud-deepgram.bin … used a fallback".
  - **This 2024 engine loads large-v3-turbo — proven in CI** (run 274):
    whisper-transcribe.js (tiny + large-v3-turbo on JFK's sample, Pulse's
    exact options, Pulse's SRT reader, language on Auto) passed there; it
    skips in this container, where Hugging Face is blocked. On CI's CPU
    turbo took 89 s for the 11 s clip (one 30 s window) — speed on the
    owner's Mac is unmeasured; Pulse Cloud stays the fast default.
  - Gates: whisper-engine (3), whisper-transcribe (3, CI),
    transcribe-on-this-computer (8, the white-label panel); 9 mutations.
- Test plumbing: the multicam harness answers the voice-engine question
  (ui.voices), runs real programs (opts.bins/files/settings) and clears the
  old plan before each build. CI caches engine and model downloads
  (/tmp/pulse-engines via CP_VOICES_CACHE).
- Lesson: never `require()` tools/mutation-check.js to syntax-check it — it
  runs the whole mutation pass and edits files in place. Use `node --check`.
- The BUILT panel (CutPilot-protected) can't be `require()`d under Node: the
  obfuscated modules hang at load outside the panel's browser. Test a build
  with the browser gates: `MC_PANEL_DIR=…/CutPilot-protected node
  CutPilot/test/gates/multicam-voices.js` and `PANEL_DIR=…/CutPilot-protected
  node CutPilot/test/gates/transcribe-on-this-computer.js` both passed on the
  v0.10.4 build (the gates take their own helpers from the source).

### v0.10.3 — the five open problems from the owner's status list
Each is gated, and each fix was broken on purpose to see its gate go red (12
mutations; 10 are in tools/mutation-check.js).
- **Hindi chip**: 🇮🇳 Hindi sits right after 🔥 Trending, in CATEGORIES and
  the chip row (galleryChips). It had been 603–694 px into a 236 px row. At
  260 px it is now on screen without scrolling (gallery-categories measures
  it). The gate's REQUIRED creator order changed with it.
- **Caption language on the Captions page**: a "Words in" picker (#cap-lang,
  a third synced copy of WHISPER_LANGS). captionScriptFollow(): Hindi letters
  → Hinglish converts in place (hinglishify; times untouched; nothing
  uploaded). English letters → Hindi asks first, then listens again with
  language=hi. Gate captions-language-picker.
- **Clean up remembers** settings.cleanStrength / takeStrength. Never picked:
  a vertical sequence starts on ⚡ Reel (cleanDefaultForSequence, on opening
  the page). Gate silence-remember-choice.
- **Multicam second Apply**: CP_mcRestoreAudio(seq, before, nCams) now also
  switches the owner's own switched-off sound back OFF when switching a
  camera piece on brought it on (keptOff). For links that work both ways, the
  picture wins over sound kept off (linkedOn) and the sound wins over a
  picture (pictureOn, reported as partly applied). The panel names Unlink.
  multicam-apply gained both cases; fakehost gained linkedBothWays.
- **After Pulse's own cuts** Auto-transcribe reuses the saved (v3) transcript
  laid onto the cut pieces: resyncTranscripts no longer sets
  _forceRetranscribe. An exact-key miss falls back to a saved transcript of
  the recording that covers the span (a cut head or tail). Messages now name
  the "↻ Redo" button the owner sees (they said "↻ Re-transcribe", which
  isn't on screen); the gates read the label from the DOM.

### Research (October 2026): what Pulse could add next
Sources were web search results, since this environment's proxy blocks most
vendor sites. Treat the details as secondary until the owner confirms them.
- **Adobe's CEP timeline** (Adobe developer blog, Sept 2026, via search) for
  Premiere: no new CEP Marketplace submissions after Dec 2027; CEP disabled
  by default Dec 2028; removed Dec 2029. UXP has been GA in Premiere since
  25.6. → The UXP port is a 2027 project, not an emergency.
- **Premiere now does natively**, so don't build: bulk bleep or mute words
  (26.0), Translate Captions, single-word captions (26.3), the Generative
  Media Tool for prompted video and sound effects (26.5), Enhance Speech,
  Auto-ducking, Auto Reframe, text-based editing.
- **Gaps against AutoCut, FireCut, Submagic, Opus Clip, Descript and Indian
  caption apps**, best first:
  1. AI hook title for the first ~3 s.
  2. Post kit: titles, description, hashtags and chapter timestamps.
  3. Real auto B-roll from Pexels or Pixabay (free keys); today it is ideas
     only.
  4. A smarter Auto-zoom (Viral Edit's punches are basic).
  5. Reel progress bar.
  6. Beat markers.
  7. Sarvam Saaras v3 batch API: word-level times, diarization, 22 Indian
     languages, codemix/translit for Hinglish.
  8. Regional-language captions (fonts per script).
  9. Hindi AI voiceover (Sarvam Bulbul).
  10. Chapter title cards.
- **Found while researching**: Pulse calls Sarvam's sync speech-to-text
  (saarika:v2.5). Its timestamps are reportedly phrase-level, not word-level,
  so on "Indian Voices" transcripts the word highlight may step phrase by
  phrase. Not verified (no Sarvam key here); item 7 fixes it.

### Free local voice tools — tested here (October 2026)
The owner asked for free alternatives to Sarvam (paid), including NVIDIA's
multi-speaker model. Everything below ran in this container, except where
marked "not testable here". Hugging Face, OpenAI's model host and most
vendor sites are blocked by this environment's proxy; PyPI and GitHub
release downloads work.
- **Engine: sherpa-onnx 1.13.8 (Apache-2.0).** The PyPI wheels
  `sherpa-onnx-bin` + `sherpa-onnx-core` are plain zips holding ready-built
  programs, no Python needed: Mac arm64 12 + 9.5 MB, Windows x64 18 + 17 MB.
  Pulse could download them like it downloads ffmpeg. They hold speaker
  diarization, offline ASR, Silero VAD, a denoiser, source separation,
  punctuation and TTS. CoreML is a provider on Mac.
- **Who spoke when (diarization) — WORKS.** pyannote segmentation-3.0 (MIT)
  plus NVIDIA NeMo TitaNet-small embeddings (CC-BY-4.0: credit NVIDIA), both
  from sherpa-onnx's GitHub releases (6.9 MB + 40 MB).
  - A real 4-speaker recording (sherpa's 0-four-speakers-zh.wav), told 4:
    TitaNet and ERes2Net give the identical answer. As far as I recall, that
    matches sherpa's documented output.
  - A Hindi 3-person conversation built with Piper hi_IN voices (two male,
    one female, 10 turns, one 0.8 s interjection): DER 5.9%.
  - With threshold 0.75–0.8 and the count NOT given, it found 4 and 3 on
    those two files. CAM++ embeddings failed (DER 45–51%; collapsed when told
    4).
  - On a harder 7-voice joined file it found 9, so ask "how many people?"
    and fall back to auto.
  - Speed here: 11× real time on 4 threads, so a 60-minute podcast takes
    about 5.6 min.
  - Scripts: scratchpad/bench (make_convo.py, score.py) — not in the repo.
- **NVIDIA Nemotron 3 Diarization** (open weights, OpenMDW-1.1 licence,
  commercial use OK, up to 8 speakers, top of a public leaderboard): the
  community ONNX exports need Python/numpy preprocessing, and sherpa's
  diarization program does not offer it (pyannote only). Not testable here
  (Hugging Face blocked). A later upgrade, not needed now.
- **Hindi speech-to-text, free:**
  - Whisper through sherpa-onnx is NOT usable for Hindi. It cuts at 30 s, and
    its byte-token joining drops Devanagari letters ("मस्ते ोस्तों"; CER 76%
    even split at pauses). Use whisper.cpp (Pulse's local engine) for Whisper
    instead.
  - Dolphin small (Apache-2.0): WER 80% on the Hindi conversation.
  - Meta Omnilingual 300M (Apache-2.0): writes Hindi in Urdu script, with no
    language hint. Both unusable for Hindi captions.
  - AI4Bharat IndicConformer (MIT; 22 languages; published Hindi WER better
    than Whisper; sherpa-onnx exports exist on Hugging Face): the best local
    candidate, not testable here.
  - Groq's free tier (whisper-large-v3/turbo: 28,800 audio-seconds a day, no
    card) is already Pulse's "Pulse Cloud" — free with the owner's own key.
- **Found:** the white-label build hides every local engine (WHISPER_QUALITIES
  is cloud-only), and the local install needs Homebrew. To offer free
  offline transcription, show the local option and download a ready-built
  engine instead. → Done in v0.10.4 (see above).

### v0.10.2 — caption sync (the owner's "sync problem with pulse rendering with voice")
Found in the code, without waiting for the owner's early/late answer. Four
ways a caption's time left the voice, all fixed and gated
(`test/gates/caption-sync-placement.js`, 26 checks; host-tests "counts clip
speed", 9 checks; mediaToTimeline/timelineToMedia unit tests). Each fix was
mutation-verified: breaking it turns its checks red.
- **Speed.** `CP_getTranscribeSource` read every clip as 1:1. A reel at 120%
  plays 1.2 s of recording per timeline second, so the last sixth was never
  transcribed and every caption drifted later (1.5 s late by the 9th second).
  The host now gives each piece `speed` (CP_clipSpeed, the same as the dead-air
  listing, composed through nests). The panel places words with
  `CPCaptions.mediaToTimeline`: timeline = seqStart + (recording − in) / speed.
  Reversed voice clips get a plain "plays in reverse" answer.
- **Saved transcripts.** The cache (`~/.cutpilot/transcripts`) held TIMELINE
  times but was keyed by the recording alone. After the clip was moved, cut by
  hand, or used in another sequence, a reused transcript put every caption
  where the words used to be. That happened both when Auto-transcribe reloaded
  it and when selecting the clip auto-loaded it. Store v3 keeps RECORDING
  time (`{v:3, lines, words, wordLevel, dedupeWords, minIn, maxOut}` JSON) and
  `placeTranscript()` lays it onto the pieces the timeline shows NOW, through
  the same steps a fresh transcription takes. v2 files are ignored, so each
  clip is heard once more.
- **Word timing.** `refineWordCues` measured every word against the SELECTED
  clip's offset. After a clean-up it snapped the words of other pieces to the
  wrong audio. Each word now goes through its own piece (`transcriptPieces()`
  asks Premiere with `onlyMediaPath` = `state.transcriptMedia`), is refined
  per piece, and is clamped to what the piece shows. The fallback for a picked
  .srt read the first audio track's in point and ignored where the clip
  starts on the timeline. It now uses the same pieces.
- **Words made before the clip moved.** A transcript already in the panel kept
  the times of the placement it was made for: trimming 2 s off the head
  AFTER transcribing put every caption 2 s late. The transcript now remembers
  its placement (`state.transcriptPlacement`). Before a caption action runs,
  `ensureTranscriptThen` asks Premiere where the recording sits now. If it
  moved, `followMovedRecording` moves every copy (the .srt, the words, the
  template-editor cues) through the recording (`retimeThroughRecording`),
  says so, and runs the action again. Pulse's own cuts clear the placement:
  `resyncTranscripts` has already re-timed those copies.
- The selection scan (findTranscript, on every panel focus while nothing is
  loaded) asks Premiere for the recording's pieces ONLY when something is
  saved for that recording and the scan may adopt it. The call walks the
  whole timeline, which is slow on a long podcast.
- Diagnostics: the `asr source` line names any speed that isn't 100%.
- Not changed: after Pulse's OWN cuts, Auto-transcribe still listens again
  (`_forceRetranscribe`). With v3 a reload would be correct, but that is a
  separate decision.

### v0.9.388 → v0.10.0 — the owner's "make everything work" release
The owner (4 months in, not shipped) asked for: every caption editable, a
beginner UI, a panel that works at any size/scaling, 40+ trending styles, and
auto-edit that really removes dead air, retakes and fillers on Hindi/Hinglish
podcasts. Worked as an audit → build → review → fix → verify pipeline of
parallel agents, each change proven by a gate that fails without it.

What changed for the owner:
- **UI**: Home with three tasks (Add captions · Clean up · Podcast cameras);
  Captions opens on the style GALLERY with Add captions pinned; plain words,
  one-line hints (rest behind ⓘ), Text size S/M/L; follows Premiere's theme;
  fits 260–1600 px wide, 400 px tall, any display scaling (16 ui-* gates, incl.
  a layout gate over 924 size/scaling combinations and ui-dialogs).
- **Captions**: 128 styles (54 researched trending looks, 9 Devanagari-first),
  creator categories of 10–26 styles; .mogrt templates moved to their own
  "Premiere templates" section so every gallery card opens the full editor.
  Long videos (podcasts) are drawn by the SAME renderer as the preview
  (0 px difference over 24 styles) instead of libass.
- **Clean up / silence**: listens to EVERY mic; cuts only where all are quiet;
  adaptive room-noise detection; Reel/YouTube/Podcast presets. A track leaves
  the vote as music ONLY by its Premiere track name or the owner's one-tap
  answer — never by its sound (a noisy remote guest was being cut entirely).
- **Retakes/fillers**: Unicode (Devanagari) matching; a guest's echo never cuts
  the host's line; keeps the last complete take; Hindi fillers only when
  pause-bounded; Deepgram gets language=multi; the verbatim mix follows the
  same music rule as Clean up.
- **Multicam**: follows the speaker in interviews, per-mic gain, L/R split,
  honest Apply, muted-lav pairing fixed.
- **Fonts**: fonts that can't draw English/Hindi are hidden (the owner's Mac
  sent "NotoSansCoptic-Bold" → blank captions); every font piece a job needs
  is loaded before the first frame (Hindi/₹ drew in a stand-in font).

Harness: test/gates/*.js are discovered automatically (126 gates as of v0.10.2);
tools/doctor.js says what a machine is missing — including whether headless
Chromium can load Google Fonts (without it every caption gate silently tests
stand-in fonts; the proxy CA must be in ~/.pki/nssdb).

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

### v0.9.350 → v0.9.387 (this session)

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

**v0.9.373 → v0.9.387 — the two-halves theme, and coverage holes**

Nearly every defect found after v0.9.372 was the SAME shape: two code paths
answering the same question separately. Worth checking first whenever something
"works sometimes":
- The long-video overlay disagreed with the canvas renderer on FIVE counts — it
  dropped the caption BOX, sized captions 25% larger on vertical video, pinned
  the spoken-word pop at 116%, read a DIFFERENT reveal control, and kept
  sweeping when word-by-word was turned OFF. All five now derive from
  `styleForFrame` / `currentAnim()`. Proof T fails if they diverge again.
- `CP_removePulseCaptionTracks` could not remove its own long-video overlay: the
  clip was named `captions.mov` and the pattern matched none of it. New jobs
  render to `pulse-captions.mov`; the cleanup also matches an anchored legacy
  name. Five host tests, mutation-tested.
- `escFilterPath` escaped only ':'. Measured against real ffmpeg, folder names
  "Reels, Final", "take [1]", "semi;colon" and "a=b" all failed. ffmpeg parses at
  TWO levels — the filtergraph splits on , and ; the filter parser splits on '='
  — so quoting alone is not enough; the option must be named
  (`subtitles=filename=…`). An apostrophe cannot be escaped at all (five
  strategies tried), so Pulse writes to a clean directory instead.
- Script-fix reported "0 words corrected" after correcting four, because it
  counted matched-but-DIFFERENT pairs and the matcher only pairs EQUAL words.
  A silent success that reports failure is indistinguishable from a failure.
- Gallery tiles sat on half-built phrases ("Make", "HEAT"). Only complete-phrase
  frames are DISPLAYED now; the frame list is unchanged so parity holds.

**Coverage sweep — run this again; it pays.** "Which shipped functions does no
test ever call?" found `renderFrames` (the function that writes every caption
file — no coverage at all), `escFilterPath` (broken), `CP_removePulseCaptionTracks`
(broken), and cleared `srtTimeToSeconds`/`secondsToSrtTime` and
`framesKeywordBuild`. `CP_getEnv` had nine call sites and no test.

**New gates:** `pipeline-contract-check.js` (the panel↔Premiere seam: real
producer output fed to the real consumer, no fixture between them) and
`mutation-check.js` (below).

**v0.9.388 — the transcription key was unenterable (owner-reported)**
The first real bug report from the owner's Mac, and the gates had all been green
through it. The panel said *"Add your free Cloud account in Settings →
Auto-transcribe"* after a Deepgram key was added; diagnostics read
`Transcribe key: none · Verbatim: deepgram`. Three faults compounded:
- **A control referenced into the void.** `set-groq-key` — six `$()` call sites
  in `main.js`, zero definitions in `index.html`. Every call site was guarded
  (`if ($('set-groq-key')) …`), so nothing threw and nothing logged. The message
  pointed at a field that did not exist.
- **The one real key box appeared only after it was needed.** With no key,
  `resolveQuality()` fell back to a local whisper model → `usingCloud` false →
  `tr-groq-wrap` stayed `hidden`. The box showed up only once a key was set. A
  cloud-only (white-label) build ships no local-engine UI, so that fallback
  selected an engine the user could never configure.
- **The copy said there was nothing to do.** `"Cloud transcription is built in"`
  printed on a build bundling no key, and the white-label table rewrote the
  Groq signup URL to `cutpilot.app` — naming neither the service nor where to
  get a key. That is what sent the owner to a different provider.

Fixed by adding the three key inputs to Settings, making `resolveQuality()`
follow whichever key exists (and never leave cloud on a cloud-only build),
promoting **Deepgram to a full transcription engine** (it already returned
word-level timings; `wordsToCues()` gives the same cue shape the other engines
produce, and a key in either box feeds both transcription and retake-finding),
and keeping white-label branding while leaving the *how to get a key* strings
truthful on a keyless build.

**New gate:** `dom-id-check.js` — every id the JS reaches for must exist in the
DOM or be created at runtime. It is the exact mirror of the dead-control audit:
that gate proves every control **in** the DOM does something, and is structurally
blind to a control the code calls for that the DOM no longer has. 13 known-dead
ids are listed with reasons; the gate also fails if one silently comes back.
Five new panel proofs stand in the reported state, all mutation-verified.

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
- Verified at v0.9.388: the built panel passes all 37 proofs.

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
- Verified faithful at v0.9.387: the two styles learned from the owner's own
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
- v0.10.4 was built (keyless, white-label), key-scanned (0 hits in the
  protected folder, Pulse-Mac.zip, the Windows .hta and git) and sent to the
  owner as Pulse-Mac.zip. Local battery: nothing failed, 1 of 134 skipped
  (whisper-transcribe — no Hugging Face here; it passed in CI run 274).
- Nothing half-finished. The highest-value next step is the owner's Mac run
  (Next 3 actions).

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

0. **v0.10.6 first**: Settings → Run the full check must reach "2) sequence";
   Podcast cameras → Apply must cut. If Apply still fails, the box under the
   message ("What Premiere answered: …") names the cause.
   (v0.10.5: Settings → Run the full check must reach "2) sequence".)
   If it doesn't, the "Premiere script:" line in 📋 Copy diagnostics names the
   ExtendScript error and line — fix that before anything else.
1. **Owner installs v0.10.5 on the Mac and runs the real flows**: Podcast
   cameras on a ONE-mic episode (say yes to Who's talking; check Voice 1 /
   Voice 2 are on the right cameras, try ⇄ Swap and "How many people
   talk?"); Transcribe with "💻 On this computer" on a Hindi clip (time it
   against Pulse Cloud — it runs on the CPU); Hindi captions on a reel;
   Clean up on a 2-mic podcast. Then 📋 Copy diagnostics (the voice engine
   logs "split … into N voices" there). Everything above is proven against
   a fake Premiere and headless Chromium; the QE razor, undo grouping,
   linked-audio behaviour and CEP timer throttling are only provable on the
   Mac.
2. **Caption SYNC — fixed in v0.10.2, confirm on the Mac**: the four causes
   found in the code (clip speed ignored; saved transcripts in timeline time
   reused after a move or cut; word snapping against the selected clip; words
   made before the clip was trimmed or moved) are fixed and gated (see State). If captions are still off on the owner's 43 s
   ElevenLabs clip, ask: early or late, and constant or growing? Constant
   points at the recording's own start (MP3 encoder delay, a timecode start),
   growing at a rate mismatch. Also get the diagnostics line `asr source …`,
   which now names any speed that isn't 100%.
3. **Strategic**: Adobe's September 2026 timeline (see Research) supersedes
   the Nov 2025 README. For Premiere, CEP is disabled by default in Dec 2028
   and removed in Dec 2029, so the UXP port is a 2027 project. The pure-JS
   cores (silence, takes, render, captions) carry over to UXP; host.jsx (QE
   razor) and Node child_process (ffmpeg) do not. Plan it with the owner.
