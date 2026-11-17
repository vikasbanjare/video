# CutPilot — Complete Product & Website Specification

> A single source of truth for building the CutPilot website. It explains, in
> detail, **what the product does**, **how the website version works** (for
> people who don't own Premiere Pro or any editing software), and **how the
> Premiere Pro extension works** (the pro tier you'll promote on the same site).
>
> Nothing is left out — hand this file to a web designer/developer and they can
> build every page from it.

---

## Table of contents

1. [One-line pitch & positioning](#1-one-line-pitch--positioning)
2. [Who it's for](#2-who-its-for)
3. [The two products on one site](#3-the-two-products-on-one-site)
4. [The Website app — full user journey](#4-the-website-app--full-user-journey)
5. [The Premiere Pro extension — full user journey](#5-the-premiere-pro-extension--full-user-journey)
6. [Feature deep-dive: AI Transcription & Voices](#6-feature-deep-dive-ai-transcription--voices)
7. [Feature deep-dive: Captions & Subtitles](#7-feature-deep-dive-captions--subtitles)
8. [Feature deep-dive: Auto-Edit (silence, fillers, retakes)](#8-feature-deep-dive-auto-edit)
9. [Feature deep-dive: Multicam](#9-feature-deep-dive-multicam)
10. [Feature deep-dive: Chapters](#10-feature-deep-dive-chapters)
11. [Languages supported (full list)](#11-languages-supported-full-list)
12. [Caption templates & styles catalogue](#12-caption-templates--styles-catalogue)
13. [Website vs Premiere — feature comparison table](#13-website-vs-premiere--feature-comparison-table)
14. [How it works under the hood (for the "How it works" page)](#14-how-it-works-under-the-hood)
15. [Privacy & data handling](#15-privacy--data-handling)
16. [Suggested website structure & page map](#16-suggested-website-structure--page-map)
17. [Ready-to-use marketing copy](#17-ready-to-use-marketing-copy)
18. [FAQ](#18-faq)
19. [Glossary](#19-glossary)

---

## 1. One-line pitch & positioning

**CutPilot turns raw talking videos into finished, captioned, ready-to-post
content — automatically.**

- **Website:** upload a video → get perfectly-timed, beautifully-styled captions
  burned into your video → download. No software, no editing skills, works in any
  browser.
- **Premiere Pro extension (pro tier):** the same caption engine **plus** silence
  removal, multicam switching, and chapters — working directly on your Premiere
  timeline, with captions that stay **fully editable** in Essential Graphics.

**Tagline options:**
- "Captions, cuts, and multicam — done for you."
- "From raw footage to ready-to-post, automatically."
- "The fastest way to caption a video — in your browser or in Premiere."

---

## 2. Who it's for

| Audience | What they get |
|---|---|
| **Creators with no editing software** | Caption any video in the browser — TikTok, Reels, Shorts, YouTube — and download it ready to post. |
| **Indian creators & regional content** | Transcribe and caption in **23 Indian languages** plus **Hinglish** (Hindi written in English letters) — almost nobody else does this well. |
| **Podcasters & interviewers** | Auto-remove silences and filler words, auto-switch between camera angles, generate YouTube chapters. |
| **Video editors / agencies** | The Premiere Pro panel automates the boring 80% (captions, cuts, multicam) and keeps everything editable. |
| **Non-English speakers** | Auto-detect the spoken language, caption in that language, or translate to English (or 18 other languages). |

---

## 3. The two products on one site

You are selling **one brand, two surfaces**:

### A) CutPilot Web (the website app) — the on-ramp
A browser-based caption studio. **Anyone** can use it with zero install. This is
your top-of-funnel: free/freemium, shareable, SEO-friendly ("add captions to
video online", "Hindi subtitle generator", etc.).

### B) CutPilot for Premiere Pro (the extension) — the pro upgrade
A panel that installs into Adobe Premiere Pro. Everything the website does **plus**
timeline-only superpowers (auto-cut, multicam, editable captions). This is your
paid/pro tier and the thing you "promote on the website."

> **Key message for the site:** *Start free in your browser. When you outgrow it,
> bring the same engine into Premiere Pro.*

---

## 4. The Website app — full user journey

This is the core of the website. Describe it as a simple **4-step flow**.

### Step 1 — Upload your video
- Drag-and-drop or pick a file (MP4, MOV, etc.), or paste a link.
- Works for vertical (9:16 Reels/Shorts/TikTok), square (1:1), and horizontal
  (16:9 YouTube) — CutPilot **auto-detects the shape** and sizes captions to fit.
- Audio-only files (MP3, WAV, M4A) are supported for transcript/subtitle export.

### Step 2 — Auto-transcribe (the AI does the listening)
- CutPilot listens to the video and writes out every word **with exact timing**.
- Pick the language or let it **auto-detect**. Full Indian-language support and
  Hinglish (see [§6](#6-feature-deep-dive-ai-transcription--voices) and
  [§11](#11-languages-supported-full-list)).
- Optionally **translate** the captions to English (or another language) while
  keeping the original timing.
- The transcript is editable — fix any word before captioning.

### Step 3 — Pick a style & customize
- Choose from **100+ caption templates** across 13 style families (Cinematic,
  Bold Creator, Minimal Professional, Social Growth, Gaming, Podcast, etc.) — see
  [§12](#12-caption-templates--styles-catalogue).
- Live preview updates instantly. Customize anything:
  - **Font** (any web/Google font), **size**, **bold/caps**.
  - **Text colour** + optional **gradient text**.
  - **Word-by-word highlight / karaoke** — the active word lights up as it's
    spoken (the "viral captions" look).
  - **Background box**: colour, opacity, padding, rounded corners, gradient,
    glow, border/stroke, 3D depth, gloss.
  - **Shadow**: blur and offset.
  - **Animation**: pop, fade, slide, bounce, typewriter, wave, karaoke — with an
    **animation-speed** control.
  - **Words per caption / per line** and **word spacing** — control how much text
    shows at once (great for short-form pacing).
- Captions auto-fit the video format, so vertical videos never overflow.

### Step 4 — Download
- **Download the captioned video** with captions burned in, ready to post.
- Or **export an `.srt` subtitle file** (for YouTube, Vimeo, etc.).
- Optionally **download chapters** (timestamped, YouTube-ready) — see
  [§10](#10-feature-deep-dive-chapters).

> **Website tagline for this section:** *"Upload → Caption → Download. Under two
> minutes, no editing skills needed."*

### What the website version does NOT need
- No Premiere Pro. No download/install. No account required to try.
- Runs in any modern browser on desktop (and works on mobile for short clips).

---

## 5. The Premiere Pro extension — full user journey

This is the **pro tier** you promote. It's a panel inside Premiere Pro
(`Window → Extensions → CutPilot`). It has **six tabs**:

> 💬 **Captions** · 🎙️ **Transcribe** · ✂️ **Auto-Edit** · 🎥 **Multicam** ·
> 🔖 **Chapters** · ⚙️ **Settings**

### Install (one-time)
- Download the CutPilot installer (Windows `.exe` / Mac `.app`), run it, restart
  Premiere. The panel appears under the CutPilot menu.
- A **7-day free trial** is built in; after that it asks for a licence.

### Captions tab (the headline feature)
- One click reads the talking clip **straight from your timeline** (it finds the
  clip automatically — no manual selection), transcribes it, and lays captions
  onto the sequence **timed to the words**.
- Three output modes:
  1. **Editable captions (default)** — placed as native **Essential Graphics**
     text. You can restyle, retype, move, and animate them in Premiere afterwards.
     They **track** word-by-word.
  2. **Burned-in** — pixel-perfect rendered captions (for styles too rich for
     live text).
  3. **Animated templates (MOGRT / "Flux")** — drop-in Motion Graphics Templates
     that stay editable in Essential Graphics. Includes a gallery with **real
     preview thumbnails** and **19 animated templates** (9 core + a premium
     **Flux** set of 10).
- Captions **auto-fit the sequence format** (vertical vs horizontal) so they're
  sized correctly inside the sequence — no manual resizing.
- Full styling controls identical to the website (font, colour, box, shadow,
  animation, karaoke, words-per-caption).

### Transcribe tab
- Same AI engines and the full language list (see [§6](#6-feature-deep-dive-ai-transcription--voices)/[§11](#11-languages-supported-full-list)).
- Auto-detect, Hinglish, translate-to-English, speaker detection.
- The transcript feeds Captions, Auto-Edit (filler words), and Chapters.

### Auto-Edit tab — two tools
1. **Remove silences** — listens to the clip (auto-found from the timeline),
   finds every pause/dead moment, and cuts them. Advanced controls: threshold
   (dB), minimum pause length, padding, minimum keep. Optionally **also remove
   filler words** (um, uh, "you know"…). Output as a **safe copy** or **cut in
   place** (with backup + gap-closing).
2. **Remove repeated takes** — reads the transcript, finds where you restarted a
   line, and keeps the best take.

### Multicam tab
- **Pick how many cameras you have (2–8, or more)** — a prominent first step — then
  CutPilot builds one setup row per camera.
- Stack each camera on its own video track (V1, V2, V3…). Three switching modes:
  - **Follow the speaker** — one mic per person; whoever's talking is shown
    (AutoPod/FireCut-style).
  - **Switch on speech** — one shared mic; cut on each talk burst.
  - **Interval** — change camera every few seconds.
- Director controls: minimum shot length, monologue cutaways, wide/centre-cam
  frequency, cut lead-in, audio auto-sync (for angles recorded out of sync).
- Builds a reviewable cut plan, then applies razor cuts + angle toggles on the
  timeline. One-click "Redo all cuts."

### Chapters tab
- Generates timestamped chapters from the transcript, labelled by topic,
  formatted for **YouTube** (paste straight into the description).

### Settings tab
- Choose the transcription engine, manage licence/trial, and advanced options
  (tucked away so the panel stays simple).

---

## 6. Feature deep-dive: AI Transcription & Voices

CutPilot's transcription is the foundation of captions, auto-edit, and chapters.

### Engines
| Engine | Best for | Notes |
|---|---|---|
| **Cloud (fast)** | Most videos, 90+ world languages | Powered by a Whisper-class model (`whisper-large-v3`) via the cloud. Very fast, very accurate. |
| **Indian Voices** | 23 Indian languages + Hinglish | Powered by **Sarvam AI** (`saaras`/`saarika`) — purpose-built for Indian languages and accents. |
| **Local / offline** *(desktop/Premiere)* | Privacy-sensitive work | Runs Whisper on the user's own machine — nothing leaves the computer. |

### Smart options (available on website and in Premiere)
- **Auto-detect language** — don't know the language? CutPilot figures it out.
- **Hinglish** — Hindi spoken, written in **English (Roman) letters** — e.g.
  "aaj hum baat karenge" instead of Devanagari. Done with an LLM so it reads
  naturally (not a mechanical letter-swap).
- **Translate to English** — speak any language, get English captions.
- **Translate to another language** — 18 target languages (Spanish, French,
  German, Japanese, Arabic, etc. — see [§11](#11-languages-supported-full-list)).
- **Speaker detection** — tags who said what (drives multicam & readable
  transcripts).
- **Word-level timing** — every word has a start/end time, which is what makes
  karaoke highlighting and precise filler-cutting possible.

> **SEO/marketing angle:** "Hindi subtitle generator", "Hinglish captions",
> "Tamil/Telugu/Bengali subtitles", "translate video to English captions".

---

## 7. Feature deep-dive: Captions & Subtitles

### What you get
- Captions **timed to the spoken words** (not rough blocks).
- **100+ ready-made templates** + deep customization.
- **Word-by-word karaoke highlighting** — the signature short-form look.
- Auto-fit to **any aspect ratio** (vertical / square / horizontal).

### Every customization control
| Group | Controls |
|---|---|
| **Text** | Font (any installed/web font), size, bold, ALL-CAPS, text colour, **gradient text** (two-colour) |
| **Layout** | Words per caption, words per line, word spacing, on-screen position |
| **Highlight / karaoke** | Active-word highlight colour, word-by-word reveal |
| **Background box** | On/off, colour, opacity, padding, corner radius, **gradient box**, **glow**, **border/stroke** (with width), **3D depth**, **gloss** |
| **Shadow** | On/off, blur, X offset, Y offset |
| **Animation** | Pop, fade, slide, bounce, typewriter, wave, karaoke — plus **animation speed** |

### Output options
- **Website:** captioned video download (burned-in) **or** `.srt` subtitle file.
- **Premiere:** editable Essential Graphics text, burned-in render, or animated
  MOGRT templates — all auto-sized to the sequence.

---

## 8. Feature deep-dive: Auto-Edit
*(Premiere Pro extension; a strong "upgrade" story for the website.)*

### Remove silences
- Auto-finds the talking clip on the timeline (one tap).
- Detects every pause/dead air and cuts it.
- Tunable: silence threshold (dB), minimum pause, padding around cuts, minimum
  keep length.
- **Protects quiet speech** — soft sentence endings that read as "silence" but
  contain real words are kept, using the transcript as a guide.
- Output: non-destructive **safe copy** or **cut-in-place** (auto-backup + close
  gaps).
- **Preview as markers** before committing.

### Remove filler words
- Cuts "um, uh, er, hmm…" automatically (conservative by default).
- Optional aggressive list ("like", "so", "actually"…).

### Remove repeated takes
- Reads the transcript, finds restarted lines, keeps the best take.

---

## 9. Feature deep-dive: Multicam
*(Premiere Pro extension.)*

- **Choose how many cameras (2–8+).** One setup row per camera.
- Stack each camera on its own track; no nesting required.
- Switching modes: **follow the speaker** (mic per person), **switch on speech**
  (one mic), **interval** (every N seconds).
- **Audio auto-sync** for angles recorded out of sync.
- Director controls: minimum shot length, long-monologue cutaways, wide/centre-cam
  cadence, cut lead-in (land the cut just before the line).
- Produces a reviewable plan, then applies razor cuts + per-segment angle toggles.
- Coverage check warns if your mics don't reach the whole timeline.

---

## 10. Feature deep-dive: Chapters

- Auto-generates **timestamped chapters** from the transcript.
- Each chapter is **labelled by its main topic**.
- Formatted for **YouTube** (`0:00 Intro`, `1:24 Topic`…) — paste into the
  description for clickable chapters.
- Available on both website and Premiere (transcript-driven).

---

## 11. Languages supported (full list)

### Transcription — Indian Voices (23 Indian languages + smart modes)
Auto-detect · Hinglish (Hindi in English letters) · Translate-to-English, **plus:**

> Hindi · Bengali · Tamil · Telugu · Marathi · Gujarati · Kannada · Malayalam ·
> Punjabi · Odia · Assamese · Urdu · Nepali · English (Indian) · Konkani ·
> Maithili · Santali · Dogri · Kashmiri · Manipuri · Bodo · Sindhi · Sanskrit

### Transcription — Cloud engine
90+ world languages (Whisper-class), with auto-detect.

### Translation targets (caption in a different language than spoken)
> English · Spanish · French · German · Hindi · Portuguese · Italian · Japanese ·
> Korean · Chinese · Arabic · Russian · Indonesian · Turkish · Dutch · Polish ·
> Vietnamese · Thai

> **This is a major differentiator — feature the Indian-language list prominently.**

---

## 12. Caption templates & styles catalogue

**100+ text caption templates** across these families:

| Family | Examples / vibe | Count |
|---|---|---|
| ⭐ Premium | Polished, high-end looks | 26 |
| 🔘 Buttons | Pill/CTA-style call-outs | 20 |
| Storytelling | Narrative, documentary | 7 |
| Minimal Professional | Clean, corporate | 6 |
| Cinematic | Film-style, letterboxed | 6 |
| Bold Creator | Loud, high-contrast, viral | 6 |
| Social Growth | Reels/TikTok/Shorts optimized | 5 |
| Trending | Current popular looks | 4 |
| Gaming Stream | Stream/overlay style | 4 |
| Podcast Pro | Interview/podcast | 3 |
| Motivation | Quote/inspirational | 3 |
| Education | Explainer/teaching | 3 |
| Dynamic Highlight | Heavy word-by-word emphasis | 3 |

**Plus 19 animated MOGRT templates** (Premiere): 9 core + a premium **Flux** pack
of 10 (Echo, Halo, Halo Pro, Prism, Pulse, Surge, etc.) — animated, editable
Essential Graphics, each with a real preview thumbnail.

> Every template is verified to have a loadable font, valid colours, and to stay
> legible over footage (automated quality audit on each build).

---

## 13. Website vs Premiere — feature comparison table

Use this verbatim as a pricing/comparison section.

| Capability | CutPilot Web (browser) | CutPilot for Premiere Pro |
|---|---|---|
| Works with no software installed | ✅ | ❌ (needs Premiere) |
| Auto-transcription (all engines) | ✅ | ✅ |
| 23 Indian languages + Hinglish | ✅ | ✅ |
| Auto-detect & translate | ✅ | ✅ |
| 100+ caption templates & full styling | ✅ | ✅ |
| Word-by-word karaoke highlight | ✅ | ✅ |
| Auto-fit vertical / square / horizontal | ✅ | ✅ |
| Download captioned video (burned-in) | ✅ | ✅ |
| Export `.srt` subtitles | ✅ | ✅ |
| Captions as **editable Essential Graphics** | — | ✅ |
| Animated MOGRT / Flux templates | — | ✅ |
| **Auto-remove silences** | — | ✅ |
| **Remove filler words & repeated takes** | — | ✅ |
| **Multicam auto-switching (2–8+ cams)** | — | ✅ |
| YouTube chapters | ✅ | ✅ |
| Offline / local processing | — | ✅ (local Whisper) |

> **Upsell line:** *"Love the captions? In Premiere Pro you also get auto-cut,
> multicam, and captions you can keep editing."*

---

## 14. How it works under the hood
*(For a "How it works" / technical-trust page.)*

1. **Listen** — the audio is transcribed to text with **word-level timestamps**
   by an AI speech model (cloud Whisper-class, Sarvam for Indian languages, or
   local Whisper on desktop).
2. **Understand** — optional steps run on the transcript: language auto-detect,
   translation, Hinglish romanization, speaker detection, filler-word detection,
   and keyword ranking (TF-IDF) for highlights and chapter labels.
3. **Style** — a built-in render engine draws each caption frame from your chosen
   template + customizations, scaled to the exact video dimensions.
4. **Deliver** —
   - *Website:* captions are composited into the video (burned-in) for download,
     or exported as `.srt`.
   - *Premiere:* captions are placed on the timeline as editable Essential
     Graphics, burned-in renders, or MOGRT templates; auto-edit and multicam
     apply razor cuts and angle toggles directly to the sequence.

The styling/render engine and templates are the **same** across both products —
that's why the browser preview matches what Premiere produces.

---

## 15. Privacy & data handling

State this clearly on the site — it builds trust:

- **Website:** video/audio is processed to generate captions; transcription uses
  a cloud AI provider. State your retention policy explicitly (e.g. "files are
  processed and deleted after N hours").
- **Premiere (local mode):** with the **local Whisper** engine, transcription runs
  entirely on the user's computer — **nothing is uploaded**. Highlight this for
  privacy-sensitive customers.
- No API keys or credentials are exposed to end users; the desktop build stores
  them in protected/obfuscated form.

> ⚠️ **Fill in your actual provider names, retention windows, and regions before
> publishing** — these are legal/trust commitments.

---

## 16. Suggested website structure & page map

| Page | Purpose | Key content to pull from this doc |
|---|---|---|
| **Home / Landing** | Hook + primary CTA ("Caption your video free") | §1, §4 (4-step flow), §13 comparison, §17 copy |
| **The Web App** | The actual tool (upload → caption → download) | §4 |
| **Features** | Everything it does | §6–§10 |
| **Languages** | Big Indian-language list (SEO gold) | §11 |
| **Templates / Styles** | Visual gallery | §12 |
| **For Premiere Pro** | Promote the pro extension | §5, §8, §9, §13 |
| **Pricing** | Free web vs Pro extension | §13 |
| **How it works** | Trust/technical | §14, §15 |
| **FAQ** | Objection handling | §18 |
| **Download** | Get the Premiere installer | §5 install |

### Primary CTAs
- Top of funnel: **"Caption a video free →"** (opens the web app).
- Pro: **"Get CutPilot for Premiere Pro →"** (download, 7-day free trial).

---

## 17. Ready-to-use marketing copy

### Hero
> **Caption any video in seconds.**
> Upload your video, and CutPilot writes perfectly-timed captions, styles them to
> match your brand, and gives it back ready to post. No editing software. No
> skills required. 23 Indian languages + Hinglish supported.
>
> `[ Caption a video free → ]`

### Three-up feature blurbs
- **🎙️ It listens for you.** AI transcribes your video word-for-word, in the
  language you speak — including 23 Indian languages, Hinglish, and auto-detect.
- **✨ Captions that pop.** 100+ templates with word-by-word karaoke highlights,
  gradients, glow, and animation — auto-sized for Reels, Shorts, and YouTube.
- **⬇️ Post in two minutes.** Download your captioned video or an `.srt` file.
  Done.

### Premiere upsell band
> **Editing in Premiere Pro?**
> Get the CutPilot panel: the same captions **plus** auto-silence-removal,
> multicam switching for 2–8+ cameras, and YouTube chapters — right on your
> timeline, fully editable. `[ Try free for 7 days → ]`

### Indian-market band
> **Finally, captions that speak your language.**
> Hindi, Tamil, Telugu, Bengali, Marathi, Gujarati, Punjabi, Malayalam, Kannada,
> Urdu and more — plus **Hinglish** (Hindi in English letters) and instant
> **translate-to-English**.

---

## 18. FAQ

**Do I need Premiere Pro or any editing software to use the website?**
No. The website works entirely in your browser — upload, caption, download.

**What video formats can I upload?**
Common formats like MP4 and MOV, plus audio files (MP3, WAV, M4A) for subtitle
export.

**Which languages are supported?**
90+ world languages on the cloud engine, **23 Indian languages** plus **Hinglish**
on Indian Voices, auto-detect, and translation to 18 languages. (See [§11](#11-languages-supported-full-list).)

**What is Hinglish?**
Hindi speech written in English (Roman) letters — e.g. "aaj hum baat karenge." Read
naturally by AI, not a mechanical transliteration.

**Can I edit the captions after generating?**
On the website you can edit text and styling before downloading. In Premiere Pro,
captions are placed as **editable Essential Graphics** you can keep changing.

**Will captions fit vertical (Reels/Shorts) videos?**
Yes — CutPilot auto-detects your video's shape and sizes captions to fit; they
never overflow.

**Can I get a plain subtitle file?**
Yes — export `.srt` for YouTube, Vimeo, and other platforms.

**Is my video private?**
The website uses a cloud AI to transcribe. In Premiere's **local mode**,
processing happens entirely on your computer. *(State your exact retention policy
here.)*

**What does the Premiere extension add over the website?**
Auto-remove silences and filler words, remove repeated takes, multicam
auto-switching (2–8+ cameras), animated MOGRT templates, editable Essential
Graphics captions, and offline transcription.

**Is there a free trial for the Premiere extension?**
Yes — 7 days.

---

## 19. Glossary

| Term | Meaning |
|---|---|
| **Burned-in captions** | Captions baked into the video pixels (can't be turned off). |
| **`.srt`** | A standard subtitle file; platforms like YouTube display it as toggleable captions. |
| **Essential Graphics** | Premiere Pro's native text/graphics system — CutPilot can place captions here so they stay editable. |
| **MOGRT** | Motion Graphics Template — a pre-animated, editable graphic you drop onto a Premiere timeline. |
| **Karaoke / word-by-word highlight** | The active word changes colour as it's spoken — the popular short-form caption look. |
| **Hinglish** | Hindi spoken, written in English/Roman letters. |
| **Multicam** | Editing multiple camera angles of the same moment; CutPilot auto-picks which angle to show. |
| **Auto-detect** | CutPilot identifies the spoken language automatically. |

---

*Document generated for the CutPilot website build. Feature set reflects CutPilot
v0.9.200. Update provider names, pricing, and data-retention policy before
publishing.*
