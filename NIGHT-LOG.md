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
