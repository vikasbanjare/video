# CutPilot → Web SaaS — Architecture & Build Plan

A plan to turn the CutPilot caption engine into a web product (like captik.in /
Submagic): upload a video → auto-transcribe → style animated captions → export a
video with the captions burned in.

Status: planning. Written 2026-06. Target: server-backed SaaS that scales to
long videos and many users.

---

## 1. What we already have that ports (the moat)

The hard, differentiated part — the caption "brain" — is already pure browser
JavaScript and moves over with little change:

- **`captions.js`** — SRT parse/serialize, word-by-word splitting, regrouping,
  animation frame timing, keyword highlighting, style preset catalog, and
  **Hinglish (Devanagari→Latin) romanization**.
- **`render.js`** — `<canvas>` renderer that draws each animated caption frame.
- **Style/format knowledge** — fonts, colors, layouts, per-style presets.

KEY ADVANTAGE: the SAME `captions.js` + `render.js` can run in the **browser**
(live preview) AND on the **server** (final burn-in render). One source of truth
for how captions look — the preview matches the export exactly.

## 2. What Premiere does for us today that the web must replace

1. Transcription (we shell out to local `whisper.cpp`).
2. Audio extraction (local `ffmpeg`).
3. The video itself (timeline, playback, final render/encode).

On the web these become backend services. Rough split: **reuse ~35%**
(engine + UI), **build ~65%** (upload, transcription, render/export, accounts,
infra).

---

## 3. Target architecture (server-backed)

```
            ┌──────────────────────────────────────────────┐
  Browser   │  Web editor (React/Next.js)                   │
            │  • upload UI + video <video> player + timeline │
            │  • EDITABLE transcript panel                   │
            │  • style panel  (reuse captions.js presets)    │
            │  • LIVE preview  (reuse render.js on canvas    │
            │     overlaid on the playing video)             │
            └───────────────┬──────────────────────────────┘
                            │ HTTPS (REST/websocket)
            ┌───────────────▼──────────────────────────────┐
   API      │  Node.js API (matches our JS)                 │
            │  auth · projects · presigned uploads ·         │
            │  enqueue jobs · save edits · status/progress   │
            └───────┬───────────────────────┬──────────────┘
                    │                        │
        ┌───────────▼─────────┐   ┌──────────▼───────────────┐
 Queue  │ Transcription worker│   │ Render/Export worker      │
 (Redis │ (GPU)               │   │ (GPU/CPU)                 │
  /SQS) │ WhisperX → word-    │   │ render.js → caption frames │
        │ level SRT + align   │   │ → ffmpeg overlay+encode    │
        │ + Hinglish romanize │   │ → MP4                      │
        └───────────┬─────────┘   └──────────┬───────────────┘
                    │                        │
            ┌───────▼────────────────────────▼──────────────┐
 Storage    │ Object storage (S3 / Cloudflare R2)            │
            │ source videos · transcripts · rendered MP4s     │
            └────────────────────────────────────────────────┘
```

---

## 4. Components

### 4.1 Frontend (web editor)
- **Stack:** Next.js + React + TypeScript. Tailwind for UI.
- **Editor:** `<video>` player + a timeline; transcript list that's **editable**
  (fix words, merge/split, delete) — this is the #1 quality feature competitors
  have and our panel doesn't yet.
- **Preview:** overlay a `<canvas>` on the video, driven by `render.js`, synced to
  `currentTime`. Reuse `captions.js` for word timing/animation. Instant, exact.
- **Styling:** port the existing color picker, font dropdown, animation rail,
  presets straight from the panel.

### 4.2 API
- Node.js (Fastify/Nest) so the caption libs are shared with frontend + workers.
- Endpoints: auth, project CRUD, `POST /uploads` (presigned URL), `POST
  /transcribe`, `PATCH /project` (save transcript+style), `POST /export`,
  `GET /jobs/:id` (progress), `GET /download`.

### 4.3 Transcription worker (the accuracy bar)
Two viable engines — this single choice is why competitors feel "every word
perfect, instantly":
- **Commercial API (fastest path to top accuracy):** Deepgram Nova-3
  (~5.3% WER), AssemblyAI Universal-2, or GPT-4o-transcribe — sub-7% WER, very
  fast, no GPU to run. Best for launch; per-minute cost.
- **Self-hosted Whisper large-v3 / large-v3-turbo on GPU** (turbo ≈ large-v3
  accuracy at ~4–6× speed). Cheaper at scale; you run the GPUs. Use **WhisperX**
  for word-level timestamps + alignment (karaoke sync).
- Either way: language selection + **Hinglish** (transcribe `hi` → our
  `devanagariToLatin()`). Runs as an async job.
- NOTE: our local panel defaulted to `base.en` (smallest, least accurate) — the
  web product must use large/commercial to match the competition.

### 4.4 Render / export worker (the heavy part)
- Re-run `captions.js` to build frames, `render.js` to rasterize them. Two ways:
  - **node-canvas / skia-canvas** server-side (fast, headless), or
  - **headless Chromium** rendering the same canvas (pixel-identical to preview).
- Composite onto the source video with **ffmpeg** (overlay PNG sequence or draw
  per-segment), encode MP4 (NVENC if GPU). Output to storage.
- Long videos → chunk + parallelize.

### 4.5 Auth, billing, data
- Auth: Clerk / Supabase Auth.
- Billing: **Stripe** subscriptions + **credit metering by video-minutes**
  (transcription + render are the metered costs).
- DB: Postgres (users, projects, jobs, usage).

### 4.6 Infra
- App/API: Render / Railway / Fly.io (or AWS ECS).
- GPU workers: **Modal / RunPod / Replicate** (serverless GPU — pay per second,
  no idle cost) to start; dedicated GPUs later for scale.
- Storage/CDN: Cloudflare R2 (cheap egress) + CDN for downloads.

---

## 5. Data model (sketch)
- `users` (id, email, plan, credits)
- `projects` (id, user_id, source_video_url, duration, lang, status)
- `transcripts` (project_id, cues JSON [{start,end,text,words[]}])
- `styles` (project_id, preset, colors, font, animation, wordsPerCue …)
- `jobs` (id, project_id, type[transcribe|export], status, progress, output_url)

---

## 6. Phased roadmap

**Phase 0 — decisions (½ wk):** stack, GPU provider, storage, auth/billing
vendors. Lock the cue/style JSON schema shared by browser + server.

**Phase 1 — editor MVP (2–3 wk):** Next.js editor reusing `captions.js` +
`render.js`. Upload to storage; transcription via a cloud API stub first; manual
SRT import; editable transcript; live styled preview. *No export yet.*

**Phase 2 — transcription service (1–2 wk):** WhisperX on a GPU worker + queue +
progress; language + Hinglish. Replace the Phase-1 stub.

**Phase 3 — export service (2–3 wk):** server render (render.js) + ffmpeg
burn-in → MP4 download. The make-or-break pipeline.

**Phase 4 — accounts & projects (1–2 wk):** auth, dashboard, saved projects,
storage lifecycle.

**Phase 5 — billing (1 wk):** Stripe + credit metering + plan limits.

**Phase 6 — polish/scale:** more templates, emoji/keyword auto-highlight,
team/sharing, render queue autoscaling, observability.

**MVP to launch = Phases 1–4** (usable, paid can come right after).

---

## 7. Cost model (the thing to watch)
Per processed video you pay for: **GPU transcription** + **GPU/CPU render** +
**storage** + **egress**. Meter users in **video-minutes / credits** so price
tracks cost. Serverless GPU (Modal/RunPod) keeps idle cost ~0 at the start.

## 8. Top risks & mitigations
- **Render fidelity (preview ≠ export):** mitigate by running the *same*
  render.js on both sides (ideally headless Chromium server-side).
- **Render time on long videos:** chunk + parallel + NVENC; show progress.
- **GPU cost runaway:** credit limits, per-plan model sizes, serverless GPU.
- **Font licensing for burn-in:** ship only properly-licensed/Google fonts.
- **Transcription accuracy:** WhisperX large-v3 on higher plans; editable
  transcript covers the rest.

## 9. Honest summary
The caption engine is a real head start and de-risks the "does it look good?"
question. The genuine new build is the **backend spine** (transcribe + render +
storage + auth + billing) and **DevOps around GPUs**. It's a standard,
well-trodden SaaS shape — no research risk, mostly execution. MVP (Phases 1–4)
is the goal; everything in §1 carries straight over.
