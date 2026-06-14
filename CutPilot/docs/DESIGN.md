# CutPilot — UI / UX Design Spec

A reference for redesigning the CutPilot Premiere Pro panel. Hand this to a
design tool, mark it up, and send the result back to implement.

The live UI is `premiere-plugin/index.html` + `premiere-plugin/css/style.css`.
You can **open `index.html` directly in Chrome** to see/screenshot every
screen (it runs in "browser preview" mode; only the Premiere actions are
inert). Resize the window narrow (~380–460 px) — it's a docked side panel.

---

## 1. Product

A single docked panel inside Premiere Pro with four tools:
**Captions**, **Smart Cut** (silence removal), **Multicam** (auto angle
switching), **Settings**. Target user: solo creators / podcast editors who
want Captions.ai / FireCut results without manual work.

Panel width: ~360–460 px, tall and scrollable. Everything is one column.

---

## 2. Design tokens (current)

Light, premium, Captions.ai-like.

| Token | Value | Use |
|------|-------|-----|
| `--bg` | `#f4f5f8` | panel background |
| `--card` | `#ffffff` | cards, bars |
| `--card2` | `#f1f2f6` | insets, segmented tracks |
| `--line` | `#e6e7ee` | borders |
| `--fg` | `#0b0c10` | text |
| `--dim` | `#7c8190` | secondary text |
| `--ink` | `#0b0c10` | primary (black) pill buttons |
| `--accent` | `#7c5cff` | focus, selected, links |
| `--grad` | `linear-gradient(135deg,#7c5cff,#b14bf4 55%,#ec4899)` | logo, step badges, chips |
| `--ok` | `#16a36a` | success |
| `--danger` | `#e5484d` | errors |
| radius | 10–16 px (pills 99px) | — |
| shadow | `0 6px 22px rgba(17,19,27,.06)` | cards |
| font | Inter / system sans | UI |

Buttons: **primary** = solid black pill, white text; **secondary** = white
pill, 1.5px border; **chip** = small white pill border. **Segmented control**
= grey track, selected segment solid black.

---

## 3. Global chrome

- **Header**: `✦ CutPilot` (gradient logo) · version badge pill (e.g. `v0.6.13`) ·
  right-aligned env status ("Sequence 01 · 1920×1080", green when connected).
- **Tab bar**: 4 equal pill tabs with icon over label (💬 Captions, ⚡ Smart Cut,
  🎥 Multicam, ⚙ Settings). Active tab = solid black.
- **Footer**: tiny live log strip (last action / errors).
- **Toast**: bottom floating black pill for confirmations; red for errors.

---

## 4. Screen: Captions

Two sub-views toggled by a segmented control at top: **📚 Templates** and **🎨 Editor**.

### 4a. Templates (gallery)
- Toolbar: search field + sort dropdown (Popular / Recent / Favorites / A–Z).
- "✨ Suggest for" niche dropdown (Podcast, Business, Finance, … → jumps to a template).
- Category chips row: All, Favorites, Recent, My Templates, Premiere (.mogrt),
  + the 10 style categories (Bold Creator, Minimal Professional, Dynamic
  Highlight, Social Growth, Podcast Pro, Storytelling, Gaming Stream,
  Cinematic, Motivation, Education).
- **Grid** (2 columns): each card = a dark 16:9-ish thumb with the caption
  style rendered + looping CSS animation, a 🔥 popularity badge, a ☆ favorite
  toggle, name + category. ~36 built-in styles. MOGRT cards show a 🎬 thumb.
- Bottom: "➕ Add .mogrt file", "⤓ Import style".
- Tapping a style card → loads it into the Editor. Tapping a MOGRT card →
  opens a bottom **action sheet** (Words per graphic, ▶ Preview on timeline,
  ✨ Caption with this template, 🔍 Inspect fields).

### 4b. Editor (the main caption design surface)
Top-to-bottom:
1. **Editor head**: ‹ Library · template name · ＋ Save · ⧉ Duplicate · ⤴ Export.
2. **Live preview**: a dark 16:9 frame showing the caption with the current
   style + animation, looping. ▶ replay button.
3. **Words per caption bar** (prominent, white): label + `[ − ] N [ + ]` stepper
   + "Full line" button.
4. **🎯 Sync each word to the spoken audio** checkbox + status (ready / needs ffmpeg / off).
5. **Transcript bar**: ✅ Using file.srt · Change  (or ⚠️ No transcript · Get one →).
6. **Customize** card:
   - Font dropdown
   - Size + Position sliders
   - Layout segmented (Top / Center / Bottom)
   - 4 color swatches: Text / Highlight / Outline / Box
   - Highlight look segmented (Colour / Box pill)
   - Outline width slider + Box & CAPS toggles
   - ✨ Auto-highlight keywords (+ which-words dropdown + keyword pop-size slider)
   - 🎙️ Show speaker names toggle
   - **Animation** chips: Pop, Scale, Zoom, Bounce, Slide up, Wave, Shake, Fade,
     Glitch, Karaoke, Typewriter, None
7. **✨ Add captions** (big black primary button).
8. **Other ways to caption** (collapsed): MOGRT (installed / from file) and a
   plain editable caption track.

---

## 5. Screen: Smart Cut
- Card 1: "Your clip" — select clip in timeline; badge shows clip name.
  Advanced (collapsed): Threshold dB / Min pause / Padding / Min keep.
- Big button: "⚡ Find the silences".
- Results: stat line ("Removing 0:42 of dead air — 18%"), a checklist of
  detected silences (toggle each), Preview-as-markers chips.
- "✂ Remove silences (safe copy)" primary; advanced "Cut in place" option.

---

## 6. Screen: Multicam
- ffmpeg banner (orange if missing, green if ready).
- "How to switch angle" dropdown: 🎙️ Follow the speaker · 🗣️ Switch on speech ·
  ⏱️ Every few seconds · 📍 Markers · ✂️ Smart Cut points.
- Camera tracks number.
- **Follow the speaker**: per-camera mic map rows (V1 → A1 dropdowns), Center-cam
  cutaway slider, Min shot length slider.
- Pattern modes: rotate / ping-pong / random / hero + "switch every N cuts".
- "🎬 Build angle plan" → per-shot list (V-chips + timecodes) → "Apply".
- "🔧 Test audio engine" + diagnostics box.

---

## 7. Screen: Settings
- ffmpeg status + path field.
- Drop-frame toggle.
- 🔧 Diagnostics: "🩺 Run full diagnostic" + 4 probe buttons + output box + copy.

---

## 8. Known UX problems to improve (designer focus)
1. The Editor is a long scroll — prioritize the most-used controls; consider
   grouping/accordions or a compact "essentials vs advanced" split.
2. Two places set caption styling (gallery vs editor) — clarify the mental model.
3. MOGRT vs built-in Animated is confusing — make the distinction obvious
   (one is fully previewable & per-word; the other is a Premiere graphic).
4. Multicam has many modes — could be a guided "what's your setup?" flow.
5. Transcript dependency (must export an SRT first) needs a clearer first-run
   explanation.

## 9. What to keep
- The live animated preview.
- The black-pill / light aesthetic (reads premium, matches Captions.ai).
- One-screen-per-tool simplicity.
