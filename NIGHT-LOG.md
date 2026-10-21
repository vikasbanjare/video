# Night shift log — Pulse (started 2026-10-21, owner asleep)

What I do all night: retest every Pulse feature in the owner's real Premiere
(QA copies only, deleted afterwards), fix what is wrong with a gate that fails
on the old code, build, install, verify, commit and push. Newest entries on top.

## Queue
1. Full test battery on this Mac — triage every failure (machine vs real bug).
2. Captions — the styles still 7–10% apart; word timing on line-only
   transcripts; Premiere captions (.srt track); Exact look on a long video.
3. Transcribe — word-level timing from the local engine; Translate; Detect
   speakers; Review & edit; Viral hooks; B-roll ideas.
4. Clean up — fillers, Smart Cleanup (AI), retakes finder.
5. Shorts — layouts (split screen, blurred background), hook title, second short.
6. Chapters, Organize, Safe zone.
7. Viral edit — zoom punch-ins, sound effects.

## Done
- 07:45 Round 11 (v0.10.98 → v0.10.99):
  · v0.10.97's retake change broke a unit test (a trailing "no" — the
    speaker stopping a take — read as a negative line); fixed in v0.10.98,
    and my quick-check script now fails loudly on any ✗.
  · 🎥 Follow the speaker failed in Premiere ("[0:v] matches no streams"):
    it reframed "the recording Transcribe hears", which is a SOUND file on a
    podcast with separate mics (or after Studio sound). It now takes the
    video. Verified in Premiere. New gate speaker-reframe-video.
  · One-button Clean up dry run on the untouched backup: 21 sections, 16.5 s
    (cancelled — nothing changed). No script errors on any page.
- 07:05 Round 10 (v0.10.97): 🔁 Find repeated takes on the webinar listed 6
  cuts; 3+ were real content: "AI isn't coming to take your job." (before
  "Someone using AI will be coming to take your job."), "The tool changed."
  (before "And because the tool changed, …"), and agenda lines 26 s apart.
  Now a line and its opposite, a short line the next one builds on, and
  loosely-alike lines far apart are kept; real retakes are still found.
  Gate retakes-conversation (4 new cases). Publish kit ✓ in Premiere.
- 06:40 Round 9 (v0.10.95 → v0.10.96), in Premiere:
  · ⤴ Export all with Media Encoder failed on the owner's Premiere 2026:
    "Match Source preset not found" (2026 renamed it; and ExtendScript gives
    file names URI-encoded, so a name with a space never matched). Fixed —
    two shorts exported to Movies › Pulse Shorts, real 1080×1920 H.264+AAC.
    Gate shorts-make-all E.
  · 🎞 B-roll on keywords placed 6 clips on the right words, but on a new top
    track that hid Pulse's captions. It now goes under them. Verified with
    a frame. Gate broll-keywords C2.
- 06:15 Round 8 (v0.10.92 → v0.10.94), self-review of the night's code +
  Premiere:
  · Viral edit's zoom could have keyed Pulse's own long-video caption
    overlay (a .mov on a top track) — now skipped; verified: 12 punches on
    the footage, overlay untouched. Gate zoom-punch-top-clip.
  · After 🎚 Studio sound the saved words were lost and the whole video was
    transcribed again (the cleaned copy had no saved words). The copy now
    uses the original's — verified: "Using your saved transcript", 1,429
    words. Gate caption-sync-placement.
  · ⚡ Viral edit with no words yet: a background scan saying "no
    transcript" cancelled it mid-transcription (words came, captions never
    did). Fixed. Gate caption-sync-placement.
  · Add captions stacked a second overlay (V9 over V4) when the remembered
    job was another sequence's. It now finds this sequence's Pulse caption
    track and replaces it — verified in Premiere. Gate caption-track-found.
- 05:50 v0.10.91: Pulse's own "Test everything" in Premiere: every row ✅
  (36 checks incl. multicam, razor, captions, Premium, shorts, cleanup).
  It now also removes its test short's folder from Pulse Media. Studio
  sound ✓ (saved in ~/Documents/Pulse/Studio Sound). Freed 690 MB more of
  my own test downloads (disk ~1.4 GB free).
- 05:25 Round 7 (v0.10.89 → v0.10.90), in Premiere:
  · Translate on the webinar: 201 of 201 lines in Hindi (was 121 English
    at the start of the night, then 6) — the last few are asked one by one.
  · Found Translate stuck for 10+ min on "part 4 of 4": the AI provider
    said "try again in 1h5m" and Pulse waited silently. AI text steps
    (Translate, Detect speakers, AI fix) now stop past 90 s, keep what came
    back and say when to try again. Gate translate-long C2.
- 04:55 Round 6 (v0.10.86 → v0.10.88), tested in Premiere:
  · ⚠️ Found the hard way: everything Pulse puts in a project that is not a
    caption image lived in the OS temp folder, which macOS clears — a
    short's hook title + frame clip, the one-file short, speaker reframe,
    the Safe zone guide (and branding), sound effects, the Premiere-captions
    .srt, B-roll copies. The project then opens with a Link Media dialog
    (it did tonight, after I cleared my test temp folders — one guide from
    Oct 17 was among them; I put plain stand-ins at every missing path so
    the project opens clean). Now all of it goes to "Pulse Media" beside
    the project, like the captions. Gates shorts-editable-timeline E,
    safezone-guide-kept, broll-keywords E.
  · Safe zone never showed a message (it called a toast it could not
    reach) — "Guide on V6…" and failures show now.
  · Make all shorts: 6 of 6 in 69 s ✓. Shorts made again from the same
    moment got the same name, so Export all would send the older one, all
    to one .mp4 — names are unique now ("… 2"). Gate short-names-unique.
- 04:20 Checked in Premiere (v0.10.85), no bugs found: Review & edit (a
  word fixed, timing kept), Chapters → markers (3 AI-titled), caption style
  test 125/136 (unchanged; the 11 left are thin serif/script strokes the Mac
  browser draws a hair heavier than Premiere — no fake-bold issue).
- 03:55 ⚠️ DISK FULL: the Mac's drive hit 117 MB free (437 of 460 GB is the
  owner's own data). I deleted only my own test leftovers (657 MB of test
  temp folders + my scratch frames) → ~0.8 GB free. NOT touched: Premiere's
  Media Cache in ~/Library/Caches/Adobe (25 GB) — the owner can clear it in
  Premiere › Settings › Media Cache › Delete (safe, Premiere rebuilds it).
- 03:52 Round 5 (v0.10.85): Fit shorts' blurred backdrop was never blurred
  in Premiere 2026 (its Gaussian Blur names the strength "Amount", Pulse set
  "Blurriness") and every Fit short warned. Fixed, verified (blurred 1/1, no
  warning). Gate shorts-editable-timeline fit-2026. Safe zone (Reels guide)
  verified on a short; Crop's controls unchanged in 2026.
- 04:15 Round 4 (v0.10.82 → v0.10.84), tested in Premiere:
  · Premiere captions (.srt) on the 7:50 webinar: "And you know happened?"
    + "what" (a 0 s word sorted after its neighbour) and a 12-word line shown
    0.5 s (the speech engine crushed it after stretching the one before).
    Now in order and readable (4.4 s); nothing past the sequence end; a
    second run says both caption tracks show and how to delete the old one.
    Gates word-timing-repair, native-captions-twice.
  · Exact look on the whole 7:50: one overlay clip in 15 s, the words on
    screen are the words said (checked at 1:00, 2:59, 4:48). ✓
  · Viral edit on a made short: zoom punches keyed V1 from 100% — the
    short's blurred backdrop shrank and the frame went bare; and its captions
    were stacked as a second set on V5, on the shot. Now the punch goes on
    the picture the viewer sees, from its own size; captions replace the set;
    a Fit short keeps its captions under the shot. Gates zoom-punch-top-clip,
    captions-viral-visible A2.
- 03:20 Round 3 (v0.10.79 → v0.10.81), tested in Premiere:
  · Clean up (one button) on the webinar copy: 21 sections / 16.6 s cut,
    the words followed the cut exactly (last word 470.42 → 453.79 s), backup
    "QA Webinar Copy" made. ✓
  · Smart Cleanup (AI) offered "there" for an "oh" (index one off) and
    "know" out of "you know what?". Now each cut lands on the words the AI
    names (else it is not offered), and "you know what" / "like 10 people"
    are never fillers. Gate retakes-ai-parser.
  · Fillers "Also cut like / so / actually" cut "I like it". Now only where
    the word stands apart. Gate retakes-fillers.
  · Shorts: a moment opening "Because…" now starts on the claim (hook 45 →
    95). Gate hook-check C2.
  · Shorts Fit layout: captions sat ON the slide. Now under the shot (73%),
    verified on a made short. Gate shorts-fit-captions.
  · Gates fixed to run right on a Mac: retakes-panel (never ran), Premium
    measure (Linux-only fonts), punchy line break (measured unlike drawn).
- 02:20 Round 2 (v0.10.75 → v0.10.78) — tested in Premiere through the panel's
  local debug port (no clicks needed; the port is only in the installed copy):
  · Detect speakers: the AI's one-number-per-line answer was cut off on 150
    lines ("malformed"). Now only the turns come back → works in Premiere
    (209 lines, 1 speaker). Gate translate-long D.
  · Reopening the project said "No transcript for this video" over its own
    saved transcript (only a SELECTED clip was looked up). Now the
    sequence's recording is used when nothing is selected → "Using your
    saved transcript" with 1,461 timed words. Gate caption-sync-placement.
  · Translate left 121 of 209 lines English (parts came back short and were
    laid off by a line). Numbered lines per request, emptied "…" lines and
    missing lines asked again → 6 of 209 left. Gate translate-long A–B3.
  · A slow transcript scan replaced a translation finished meanwhile. Gate F.
  · B-roll ideas: local list drops "launched/launch/world/person"; with the
    AI key, real shots with times ("Jensen Huang speaking (2:24)").
    Gate broll-ai-shots.
  · Chapters with AI titles verified ("AI Threat To Jobs / Jensen Wong On AI
    Adoption / Learning To Think With AI").
- 01:30 Round 1 (v0.10.67) — tested in Premiere on an 8-min webinar copy:
  · Viral hooks added NO markers (knew 10 fixed phrases). Now also marks the
    lines the Shorts finder would open on (question / bold claim / number /
    "you", Hindi too), 20 s apart, best 10. Gate viral-hooks-markers.
  · B-roll ideas were "like, people, think, know, going". Now filmable words
    ("intern, workshop, chatbot, statue, liberty"). Battery unit test.
  · Detect speakers failed "malformed": AI answers are now read in any
    wrapping (parseAiJson, also Translate + AI fix); the bar no longer says
    "failed · Get one" when the words are fine. Gate ai-answer-parse.
  · Chapters: a 7:50 talk got 2 chapters titled "That's Talking / Cloud
    We're". Now ≥3 when the talk changes topic (YouTube's minimum), no
    contraction titles, and AI-written titles when the key is set.
    Gate chapters-topics F.
- 00:00 Night shift started. Display + system kept awake (caffeinate).
  ⚠️ The Mac was on BATTERY (77%, ~5.5 h), not on the charger — if it runs
  low I save, commit, push and stop cleanly.
