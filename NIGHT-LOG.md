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
