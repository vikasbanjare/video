# Caption gap report — Pulse by AI-Floh vs captions.ai

Branch `claude/caption-gap-audit`. Reference: <https://captions.ai/features/add-captions-to-videos> (analysis only — nothing of theirs is copied into the repo or the plugin; the 20 sample stills were downloaded to a throw-away cloud sandbox outside the repo, looked at, and deleted).

**What could be observed.** The page shows 20 caption-style cards as **single still images** (352×626 WebP, one frame each) and prose about features. The "Try it now" flow needs sign-up. So:

- looks (font weight, case, colours, outline, boxes, layout) are read from one frame per style;
- **every animation, in/out behaviour and word timing of theirs is NOT VERIFIED** — no moving sample is public;
- their editor's controls are known only from the page's own sentences, quoted below.

**Status words.** HAVE = Pulse does it. PARTIAL = Pulse does part of it, or only in one pipeline. MISSING = Pulse does not do it. NOT VERIFIED = not observable on the public page.

---

## 0. Inventory — what Pulse already has

### 0.1 The two pipelines

| Pipeline | How it works | Where |
|---|---|---|
| **Render** ("image captions", default) | Pulse draws every caption frame itself (`CPRender.drawFrame`, canvas) — PNG clips on a track, or one transparent overlay `.mov` for long videos. Every style setting is honoured. | `js/render.js`, `js/captions.js` |
| **Editable** | One Premiere caption clip per line from a template (`.mogrt`). Since v0.10.33 the template is **Pulse Caption**, built in After Effects by `tools/ae/Pulse-Caption-Builder.jsx` (bundled `mogrts/Pulse_Caption_r3.mogrt`, 16 controls). Before that: the third-party Flux Halo template (still the fallback). | `mapPresetToPulse`, `pulseLook`, `pulseCarryStyle` in `js/main.js` |

Editable **can** do: text colour, spoken-word colour, spoken word grow (0–100 %), letter spacing (≥ 0), outline colour + width, box behind the whole line / the spoken word / both (+ colour, word-box colour, opacity, roundness), soft or offset shadow, whole-caption entrance (none / pop / fade / slide up), the style's font (font editing on, r3), size.
Editable **cannot** (template has no control): gradient text, a different font/weight on the spoken word, dimmed upcoming words, gradient / 3D / gloss / bordered / glowing boxes, weights other than bold/regular, tighter-than-normal spacing, per-letter or per-word animation, static keyword colouring.

### 0.2 Animations

| Pulse animation (`anim`) | What it does (Render) | Styles | Editable |
|---|---|---|---|
| karaoke | spoken word lights up word by word | 34 | HAVE (spoken-word colour / grow / box) |
| reveal | words appear as they are spoken | 8 | PARTIAL — highlight moves, words don't appear one by one |
| color-sweep | colour sweeps across the line | 1 | PARTIAL — word-by-word instead of a sweep |
| pop / pop-scale / scale / zoom / bounce | caption pops / scales / zooms / bounces in | 57 | PARTIAL — one caption-level Pop |
| fade | caption fades in | 17 | HAVE (Fade) |
| slide | caption rises in | 6 | HAVE (Slide up) |
| wave | letters wave in | 2 | PARTIAL — caption entrance only |
| glitch / glitch-in | glitch entrance | 3 | MISSING in Editable |
| typewriter | letters type on | 2 | MISSING in Editable |

Plus, user controls: Entrance picker (none / pop / fade / slide / "as spoken"), word-by-word highlight on/off, highlight shape (colour / box / bar / underline / marker / circle), spoken-word pop size, dim upcoming words, emphasise big words, multi-colour words.

### 0.3 Editable controls exposed to the user (Captions page, `c-*`)

| Group | Controls | Reach the Editable caption? |
|---|---|---|
| Text | font, weight, size, case / UPPERCASE, letter spacing, word spacing, line gap, lines, max width, words per caption, words per line, alignment, position (+ safe zone), sync offset | font, size, case, letter spacing (≥0), position, words, sync: **yes**; weight: bold/regular only; word spacing / line gap / max width: **no** |
| Colour | text colour, gradient text (2nd colour), spoken-word colour, 2-tone spoken word, multi-colour words, numbers colour, brand words colour | text + spoken-word colour: **yes**; the rest: **no** |
| Spoken word | word-by-word on/off, highlight shape, pop size, glow, serif-italic spoken word, dim upcoming, emphasise big words | on/off, box shape, pop size: **yes**; others: **no** |
| Outline & shadow | outline colour/width, shadow on/off, blur, X/Y offset | **yes** (blur is fixed in the template) |
| Box | on/off, colour, 2nd colour, opacity, padding, roundness, border, glow, gradient, 3D depth, gloss | colour, opacity, roundness: **yes**; padding: fixed; border / glow / gradient / 3D / gloss: **no** |
| Words | keywords (auto/manual), keyword caps, emoji, censor, strip punctuation, speaker labels, per-word style | text changes (caps, emoji, censor, punctuation): **yes**; keyword *colour*: **no** |
| Motion | entrance, reveal, two-tier | entrance: **yes** (4 kinds) |

### 0.4 Every caption style (130) — look and Editable status

"SAME" / "PARTIAL" here is what the Editable mapping is **designed** to carry. It is **not yet confirmed in real Premiere**: the owner's 🎨 Test caption styles run on v0.10.36 is that check (the v0.10.35 run exposed a 0-based menu bug, fixed in v0.10.36).

| # | Style (id) | Category | Font / weight | Case | Text | Spoken-word / highlight | Outline | Shadow / glow | Box | Pos | Animation | Editable (Pulse Caption) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Bold Statement (`hormozi`) | 💥 Bold & Viral | Avenir Next 900 | UPPER | #FFFFFF | static color #FFD400 ×1.14 | #000000 12px | — | — | bottom | pop-scale | PARTIAL: weight 900 → bold/regular |
| 2 | Karaoke Highlight (`karaoke`) | 🎤 Karaoke | Futura 600 | as typed | #FFFFFF | static color #00E676 | #000000 8px | — | — | bottom | color-sweep | PARTIAL: weight 600 → bold/regular |
| 3 | Clean Minimal (`minimal`) | ✨ Minimal & Clean | Helvetica Neue 500 | as typed | #FFFFFF | static color  | #000000 3px | — | — | bottom | fade | SAME |
| 4 | Typewriter (`typewriter`) | 🎬 Cinematic & Editorial | Menlo  | as typed | #EAEAEA | static color  | — | #000000 halo | — | center | typewriter | PARTIAL: per-letter/word animation "typewriter" → caption entrance |
| 5 | Impact II (`impact`) | 💥 Bold & Viral | Impact  | UPPER | #FFFFFF | static color #FFE53B ×1.18 | #000000 13px | — | — | bottom | pop | SAME |
| 6 | Lift (`lift`) | 🎙️ Podcast | Helvetica Neue  | as typed | #FFFFFF | static color #5CC8FF | #000000 4px | — | — | bottom | slide | SAME |
| 7 | Chalk (`chalk`) | 😂 Fun & Meme | Bradley Hand  | as typed | #FFFFFF | static color #FFE53B | #000000 5px | — | — | bottom | wave | PARTIAL: per-letter/word animation "wave" → caption entrance |
| 8 | Y2K (`y2k`) | 🌈 Neon & Glow | Verdana  | as typed | #FFFFFF | static color #00F0FF | — | — | #141414 r4 | center | glitch | PARTIAL: per-letter/word animation "glitch" → caption entrance |
| 9 | Cinema (`elevate`) | 🎬 Cinematic & Editorial | Georgia  | as typed | #F3ECE0 | static color #D9B36A | — | #000000 halo | — | center | fade | SAME |
| 10 | Quote Pill (`quotepill`) | 🎬 Cinematic & Editorial | Didot  | UPPER | #FFFFFF | static color #FFFFFF | — | — | #0B1020 r46 | center | fade | SAME |
| 11 | Hype (`cap-motiv`) | 😂 Fun & Meme | Marker Felt  | UPPER | #FFE53B | word-by-word color #FFFFFF ×1.2 | #000000 13px | — | — | center | karaoke | SAME |
| 12 | Pastel (`cap-pastel`) | 🎤 Karaoke | Trebuchet MS  | as typed | #2A2233 | word-by-word box #FF5DA2 ×1.08 | — | — | #FFFFFF r24 | bottom | karaoke | PARTIAL: dimmed upcoming words |
| 13 | Column (`cap-editorial`) | 🎬 Cinematic & Editorial | Didot  | as typed | #F6F2EA | word-by-word color #E7B45A ×1.06 | — | #000000 halo | — | center | karaoke | PARTIAL: dimmed upcoming words |
| 14 | Ticker (`cap-ticker`) | 🎙️ Podcast | Arial Narrow  | UPPER | #FFFFFF | word-by-word bar #13C2A8 | #000000 5px | — | — | bottom | karaoke | SAME |
| 15 | Clean Subtitle (`cap-clean-sub`) | ✨ Minimal & Clean | Helvetica Neue  | as typed | #8A93A3 | word-by-word color #0B0F17 | — | — | #FFFFFF r18 | bottom | karaoke | SAME |
| 16 | Bold Pop (`pro-boldpop`) | 🔥 Trending | Arial Black 900 | as typed | #FFFFFF→#D2D7DE | none | #2A1A06 5px | #000000 halo | — | center | pop | PARTIAL: gradient text; 2-tone spoken word; gloss; weight 900 → bold/regular |
| 17 | Editorial (`pro-editorial`) | 🔥 Trending | Helvetica 700 | as typed | #FFFFFF→#DDE1E6 | none | — | #000000 halo | — | center | pop | PARTIAL: gradient text; different font on spoken word; glow on box/word |
| 18 | Neon (`btn-neon`) | 🔘 Buttons | Courier New 700 | as typed | #14FF8E | static color #A8FFD2 ×1.06 | — | #14FF8E halo | #0A0A0A r18 | center | pop | PARTIAL: box border; glow on box/word |
| 19 | Green Pill (`btn-spotify`) | 🔘 Buttons | Helvetica Neue 700 | UPPER | #FFFFFF | static color #FFFFFF ×1.05 | — | — | #1DB954 r120 | center | pop | SAME |
| 20 | Pop 3D (`btn-pop3d`) | 🔘 Buttons | Trebuchet MS 800 | UPPER | #FFFFFF | static color #EAFFD0 ×1.06 | — | — | #3FA000 r120 | center | pop | PARTIAL: 3D box edge |
| 21 | 3D Red (`btn-3dred`) | 🔘 Buttons | Trebuchet MS 800 | as typed | #7A1E1E | static color #FFFFFF ×1.06 | — | — | #FF6666 r120 | center | pop | PARTIAL: 3D box edge; box border |
| 22 | Neo (`btn-neo`) | 🔘 Buttons | Trebuchet MS 700 | as typed | #6B4A33 | static color #3F2A1C | — | — | #F2C4A3 r120 | center | scale | PARTIAL: gradient box |
| 23 | Aura (`btn-aura`) | 🔘 Buttons | Helvetica Neue 800 | as typed | #111111 | static color #111111 ×1.05 | — | — | #F4C5C1 r120 | center | pop | PARTIAL: gradient box; box border |
| 24 | Candy (`btn-candy`) | 🔘 Buttons | Snell Roundhand 700 | as typed | #FFFFFF | static color #FFFFFF ×1.06 | — | — | #F75BA2 r120 | center | pop | PARTIAL: gradient box; gloss; box border |
| 25 | Gold Gloss (`btn-gold`) | 🔘 Buttons | Helvetica Neue 800 | as typed | #1B3661 | static color #1B3661 ×1.05 | — | — | #F9BC5C r120 | center | pop | PARTIAL: different font on spoken word; gradient box; gloss |
| 26 | Glass (`btn-glass`) | 🔘 Buttons | Helvetica Neue 700 | as typed | #FFFFFF | static color #FFFFFF ×1.05 | — | — | #15171C @40% r120 | center | scale | PARTIAL: box border; glow on box/word |
| 27 | Outline (`btn-outline`) | 🔘 Buttons | Helvetica Neue 800 | as typed | #FFD23F | static color #FFFFFF ×1.05 | — | #000000 halo | — | center | pop | PARTIAL: box border |
| 28 | Pixel (`btn-pixel`) | 🔘 Buttons | Courier New 700 | UPPER | #FFFFFF | static color #7CF03F | — | — | #6B4423 r2 | center | pop | PARTIAL: box border |
| 29 | Basic Blue (`btn-blue`) | 🔘 Buttons | Helvetica Neue 700 | as typed | #FFFFFF | static color #FFFFFF ×1.05 | — | — | #4363F8 r120 | center | pop | PARTIAL: gradient box |
| 30 | Paper (`btn-paper`) | 🔘 Buttons | Helvetica Neue 800 | as typed | #15171C | static color #2D7CFF | — | — | #FFFFFF r120 | center | scale | SAME |
| 31 | Sky (`btn-twitter`) | 🔘 Buttons | Helvetica Neue 700 | as typed | #FFFFFF | static color #FFFFFF ×1.05 | — | — | #1BA1F2 r120 | center | pop | SAME |
| 32 | Purple (`btn-twitch`) | 🔘 Buttons | Helvetica Neue 800 | as typed | #FFFFFF | static color #E9DDFF ×1.05 | — | — | #9147FF r16 | center | pop | SAME |
| 33 | Retro Win (`btn-win`) | 🔘 Buttons | Helvetica Neue 700 | as typed | #111111 | static color #0A0AC8 | — | — | #C8C8C8 r3 | center | pop | PARTIAL: 3D box edge; gloss; box border |
| 34 | BIOS (`btn-bios`) | 🔘 Buttons | Courier New 700 | UPPER | #FFFFFF | static color #5BFF8A | — | — | #0300E4 r2 | center | pop | PARTIAL: box border |
| 35 | Chip (`btn-figma`) | 🔘 Buttons | Helvetica Neue 700 | as typed | #FFFFFF | static color #FFFFFF ×1.05 | — | — | #18A0FB r16 | center | pop | SAME |
| 36 | De Stijl (`btn-destijl`) | 🔘 Buttons | Arial Black 800 | as typed | #111111 | static color #E64043 ×1.08 | — | — | #F1F1F1 r2 | center | pop | PARTIAL: box border |
| 37 | Slate (`btn-google`) | 🔘 Buttons | Helvetica Neue 600 | as typed | #FFFFFF | static color #8AB4F8 | — | — | #3D4043 r26 | center | scale | PARTIAL: weight 600 → bold/regular |
| 38 | Orange Word Pop (`pack-orange-word-pop`) | 🎬 From My Videos | Futura  | as typed | #FFFFFF | word-by-word box #FFA51E | — | — | #0B0B0D @92% r6 | bottom 62% | karaoke | SAME |
| 39 | Script Glow (`pack-script-glow`) | 🎬 From My Videos | Snell Roundhand  | as typed | #FFFFFF | none | — | #FFFFFF halo | — | bottom 72% | fade | SAME |
| 40 | Green Word Box (`pack-green-word-box`) | 🎬 From My Videos | Avenir Next 800 | UPPER | #FFFFFF | word-by-word box #04420E | #0A0A0A 4px | #000000 offset | — | bottom 69% | karaoke | PARTIAL: tight letter spacing |
| 41 | Maroon Label (`pack-maroon-label`) | 🎬 From My Videos | Futura 800 | UPPER | #FFFFFF | word-by-word color #FFFFFF ×1.25 | — | #000000 offset | #7A3034 @88% r0 | bottom 77% | karaoke | SAME |
| 42 | Neon Pop (`pack-neon`) | 🎥 Your Styles | Impact  | UPPER | #F8F8FF | static color #00F0FF | #7B2FFF 6px | #00F0FF halo | — | center | glitch-in | PARTIAL: per-letter/word animation "glitch-in" → caption entrance |
| 43 | Spotlight (`pro-spotlight`) | 🎥 Your Styles | Avenir Next  | as typed | #FFFFFF | word-by-word box #2D7CFF ×1.1 | — | #000000 halo | — | bottom | karaoke | SAME |
| 44 | Subs Light (`pro-subs-light`) | 🎥 Your Styles | Avenir Next  | as typed | #15181E | word-by-word color #2D7CFF | — | — | #F1F2F4 r16 | bottom | karaoke | PARTIAL: dimmed upcoming words |
| 45 | Clean Glow (`pro-clean-glow`) | 🎥 Your Styles | Avenir Next  | as typed | #FFFFFF | word-by-word color #FFFFFF ×1.12 | — | #000000 halo | — | center | karaoke | PARTIAL: dimmed upcoming words |
| 46 | Karaoke Bar (`pro-karaokebar`) | 🎥 Your Styles | Avenir Next 800 | as typed | #FFFFFF | word-by-word box #F5A623 | — | — | #0C0D11 @72% r9 | bottom | karaoke | SAME |
| 47 | Pulse (`pro-pulse`) | 🎥 Your Styles | Avenir Next  | UPPER | #FFFFFF | word-by-word box #3B5BFF ×1.1 | — | #000000 halo | — | center | reveal | SAME |
| 48 | Thuban (`pro-thuban`) | 🎥 Your Styles | Avenir Next  | UPPER | #FFFFFF | word-by-word box #FFE000 ×1.1 | — | #000000 halo | — | bottom | reveal | SAME |
| 49 | Runway (`pro-runway`) | 🎥 Your Styles | Futura  | as typed | #FFFFFF | word-by-word box #FF2D9B ×1.1 | — | #000000 halo | — | bottom | reveal | SAME |
| 50 | Evo (`pro-evo`) | 🎥 Your Styles | Futura  | as typed | #FFFFFF | word-by-word color #FFD400 ×1.1 | — | #000000 halo | — | bottom | reveal | SAME |
| 51 | Nova (`pro-nova`) | 🎥 Your Styles | Avenir Next  | UPPER | #FFFFFF | word-by-word color #FF3B6B ×1.1 | — | #000000 halo | — | bottom | reveal | SAME |
| 52 | Andromeda (`pro-andromeda`) | 🎥 Your Styles | Avenir Next  | as typed | #FFFFFF | static color #9FE7FF | — | — | #10131A r16 | bottom | slide | SAME |
| 53 | Elevate II (`pro-elevate`) | 🎥 Your Styles | Didot  | as typed | #F6F2EC | word-by-word color #E8C77A | — | #000000 halo | — | center | karaoke | SAME |
| 54 | Red Punch Caps (`v1-beast`) | 🎥 Your Styles | Arial Black  | UPPER | #FFFFFF | static color #FF2A2A ×1.18 | #000000 4px | #000000 halo | — | bottom | pop-scale | SAME |
| 55 | Prime (`prime`) | 🎥 Your Styles | Arial Black  | UPPER | #FFFFFF | static color #7C5CFF | #000000 10px | — | — | center | zoom | SAME |
| 56 | Focus (`focus`) | 🎥 Your Styles | Futura  | as typed | #FFFFFF | word-by-word box #FF3B6B | #000000 6px | — | — | bottom | karaoke | SAME |
| 57 | Volt (`volt`) | 🎥 Your Styles | Impact  | UPPER | #FFFFFF | static color #39FF14 | #000000 8px | — | — | bottom | pop | SAME |
| 58 | Rocket (`rocket`) | 🎥 Your Styles | Avenir Next  | UPPER | #FFFFFF | word-by-word box #FF2D7E | #000000 7px | — | — | bottom | karaoke | SAME |
| 59 | Mars (`mars`) | 🎥 Your Styles | Helvetica Neue  | as typed | #111111 | static color #111111 | — | — | #FFE53B r10 | bottom | pop | SAME |
| 60 | Ember (`ember`) | 🎥 Your Styles | Georgia  | as typed | #FFE9D6 | static color #FF9E5A | #1a1a1a 2px | — | — | center | fade | SAME |
| 61 | Cinematic (`pack-cinema`) | 🎥 Your Styles | Futura  | UPPER | #EDEDED | static color #EDEDED | — | #000000 halo | — | bottom | fade | SAME |
| 62 | Align (`align`) | 🎥 Your Styles | Menlo  | UPPER | #FFFFFF | static color #9AD0FF | — | #000000 halo | — | center | fade | SAME |
| 63 | Prism Pro (`prism`) | 🎥 Your Styles | Avenir Next  | as typed | #FFFFFF | static color #FFD400 | #000000 7px | — | — | bottom | pop | SAME |
| 64 | Stack (`stack`) | 🎥 Your Styles | Helvetica Neue  | as typed | #FFFFFF | static color #FF4D6D | #000000 4px | — | — | bottom | fade | SAME |
| 65 | Kai (`kai`) | 🎥 Your Styles | Arial Black  | UPPER | #FF2D9B | static color #FFFFFF | #000000 8px | — | — | bottom | pop | SAME |
| 66 | Linen (`linen`) | 🎥 Your Styles | Georgia  | as typed | #FFFFFF | static color #C9A36A | — | #000000 halo | — | bottom | fade | SAME |
| 67 | Monolith (`monolith`) | 🎥 Your Styles | Didot  | UPPER | #FFFFFF | static color #FFFFFF | — | #000000 halo | — | center | scale | SAME |
| 68 | Core (`cap-core`) | 🎥 Your Styles | Avenir Next  | as typed | #FFFFFF | word-by-word color #FFE000 ×1.14 | #000000 6px | — | — | center | karaoke | SAME |
| 69 | Crisp (`cap-clarity`) | 🎥 Your Styles | Helvetica Neue  | as typed | #FFFFFF | static color #FFFFFF | #000000 4px | — | — | center | fade | SAME |
| 70 | Surge (`cap-hype`) | 🎥 Your Styles | Avenir Next  | UPPER | #FFFFFF | word-by-word box #22C55E | #000000 6px | — | — | center | karaoke | SAME |
| 71 | Aurora (`cap-aurora`) | 🎥 Your Styles | Avenir Next  | as typed | #FFFFFF→#B9C7FF | word-by-word color #7FE7FF ×1.12 | — | #0A1030 halo | — | center | karaoke | PARTIAL: gradient text; dimmed upcoming words |
| 72 | Mono (`cap-mono`) | 🎥 Your Styles | Menlo  | as typed | #E6FBFF | word-by-word color #00F0FF ×1.05 | — | — | #0B1118 @92% r8 | bottom | karaoke | PARTIAL: dimmed upcoming words |
| 73 | Clean Card (`cap-card`) | 🎥 Your Styles | Helvetica Neue  | as typed | #11151C | word-by-word color #2D7CFF | — | — | #FFFFFF @96% r12 | bottom | karaoke | PARTIAL: dimmed upcoming words |
| 74 | Studio (`cap-studio`) | 🎥 Your Styles | Helvetica Neue  | as typed | #FFFFFF | word-by-word color #FFC857 ×1.06 | — | #000000 halo | — | bottom | karaoke | PARTIAL: dimmed upcoming words |
| 75 | Cool Pop (`pro-coolpop`) | 🎥 Your Styles | Arial Black 900 | as typed | #FFFFFF→#D2D7DE | none | #06101A 5px | #000000 halo | — | center | pop | PARTIAL: gradient text; 2-tone spoken word; gloss; weight 900 → bold/regular |
| 76 | Clean Bold (`pro-cleanbold`) | 🎥 Your Styles | Arial Black 900 | as typed | #FFFFFF→#CED2D8 | none | — | #000000 halo | — | center | pop | PARTIAL: gradient text; weight 900 → bold/regular |
| 77 | Plain Subtitle (`twin-plain-subtitle`) | ✨ Minimal & Clean | Poppins 600 | as typed | #000000 | none | — | — | #FFFFFF r30 | center | fade | PARTIAL: weight 600 → bold/regular |
| 78 | Word Highlight (`twin-word-highlight`) | 🎙️ Podcast | Arvo 400 | as typed | #FFFAFA | word-by-word color #FF0000 | — | — | #000000 @60% r2 | center | karaoke | SAME |
| 79 | Word Pop (`twin-word-pop`) | 🎤 Karaoke | Inter 600 | as typed | #FFFFFF | word-by-word color #29FF00 ×1.2 | — | — | #000000 r40 | center | karaoke | PARTIAL: weight 600 → bold/regular |
| 80 | Active-Word Box (`twin-active-box`) | 🎤 Karaoke | Space Mono 700 | as typed | #FFFFFF | word-by-word box #78FDBA | — | #000000 offset | — | center | karaoke | SAME |
| 81 | Gradient Highlight (`twin-gradient-highlight`) | 🌈 Neon & Glow | Inter 600 | as typed | #FFFFFF | word-by-word color #CC00FF | — | — | #000000 r2 | center | karaoke | PARTIAL: 2-tone spoken word; weight 600 → bold/regular |
| 82 | Halo Box (`twin-flux-halo`) | 🎤 Karaoke | Inter 600 | as typed | #FFFFFF | word-by-word color #C5FF00 | — | — | #003CFF r2 | center | karaoke | PARTIAL: weight 600 → bold/regular |
| 83 | Punch Caps Gold (`tr-punch-gold`) | 🔥 Trending | Montserrat 900 | UPPER | #FFFFFF | static color #FFD75E ×1.15 | #000000 10px | #000000 offset | — | center 62% | pop-scale | PARTIAL: 2-tone spoken word; gloss; weight 900 → bold/regular |
| 84 | Tri-Tone Caps (`tr-tritone`) | 💥 Bold & Viral | Montserrat 900 | UPPER | #FFFFFF | static color #22E55B ×1.1 | #000000 9px | — | — | center | pop | PARTIAL: weight 900 → bold/regular |
| 85 | Purple Active Plate (`tr-purple-plate`) | 🔥 Trending | Montserrat 800 | UPPER | #FFFFFF | word-by-word box #7C3AED | #000000 5px | — | — | center | karaoke | SAME |
| 86 | Comic Burst (`tr-comic-burst`) | 😂 Fun & Meme | Bangers 400 | UPPER | #FFFFFF | static color #FFD400 ×1.15 | #000000 12px | #000000 offset | — | center | bounce | SAME |
| 87 | Double-Stroke Sticker (`tr-sticker`) | 😂 Fun & Meme | Luckiest Guy 400 | UPPER | #FFFFFF | static color #3BFF6A | #000000 12px | #FFFFFF halo | — | center | zoom | SAME |
| 88 | Condensed Slam (`tr-slam`) | 🔥 Trending | Anton 400 | UPPER | #FFFFFF | static color #FF2E4D ×1.15 | #000000 8px | — | — | center | zoom | SAME |
| 89 | Tall Poster (`tr-poster`) | 💥 Bold & Viral | Bebas Neue 400 | UPPER | #FFFFFF | static color #FFE600 | — | #000000 offset | — | center | pop | SAME |
| 90 | Ghost to Solid (`tr-ghost-solid`) | 💥 Bold & Viral | Archivo Black 400 | UPPER | #FFFFFF | static color #FFFFFF | #FFFFFF 2px | #000000 offset | — | center | pop | PARTIAL: dimmed upcoming words |
| 91 | 3D Extrude (`tr-extrude`) | 💥 Bold & Viral | Archivo Black 400 | UPPER | #FFFFFF | static color #FFE600 ×1.1 | #000000 6px | #FF3B30 offset | — | center | bounce | SAME |
| 92 | Two-Tone Stack (`tr-two-tone-stack`) | 🔥 Trending | Montserrat 900 | UPPER | #FFFFFF | static color #FFD400 ×1.3 | #000000 8px | — | — | center | slide | PARTIAL: weight 900 → bold/regular |
| 93 | Kinetic Size Pop (`tr-kinetic`) | 💥 Bold & Viral | Poppins 900 | as typed | #FFFFFF | static color #00E0FF ×1.5 | — | #000000 halo | — | center | zoom | PARTIAL: weight 900 → bold/regular |
| 94 | Sunset Gradient (`tr-sunset`) | 💥 Bold & Viral | Poppins 900 | UPPER | #FF7A18→#FF3D77 | static color #FFFFFF | #1A0B2E 7px | — | — | center | pop-scale | PARTIAL: gradient text; weight 900 → bold/regular |
| 95 | Dim-to-Bright (`tr-dim-bright`) | 🔥 Trending | Montserrat 800 | as typed | #FFFFFF | word-by-word color #FFFFFF ×1.06 | #000000 5px | — | — | bottom 70% | karaoke | PARTIAL: dimmed upcoming words |
| 96 | Yellow Wipe (`tr-yellow-wipe`) | 🎤 Karaoke | Poppins 800 | as typed | #FFFFFF | word-by-word color #FFD60A | #000000 6px | #000000 offset | — | bottom 72% | karaoke | SAME |
| 97 | Highlighter Swipe (`tr-highlighter`) | 🔥 Trending | Inter 800 | as typed | #FFFFFF | word-by-word bar #FFE14D | #000000 5px | — | — | bottom 72% | karaoke | SAME |
| 98 | Acid Lime Box (`tr-acid-lime`) | 🔥 Trending | Space Grotesk 700 | as typed | #FFFFFF | word-by-word box #C6FF00 | #000000 4px | — | — | bottom 72% | karaoke | SAME |
| 99 | Underline Sweep (`tr-underline`) | 🎤 Karaoke | Space Grotesk 700 | as typed | #FFFFFF | word-by-word underline #FF5C39 | #000000 4px | — | — | bottom 74% | reveal | PARTIAL: underline → colour |
| 100 | Podcast Dark Bar (`tr-podcast-bar`) | 🎙️ Podcast | Inter 700 | as typed | #FFFFFF | static color #FFC940 | — | — | #000000 @60% r16 | bottom 78% | fade | SAME |
| 101 | Two-Speaker Talk (`tr-two-speaker`) | 🎙️ Podcast | Montserrat 800 | as typed | #FFFFFF | static color #FFD60A ×1.1 | #000000 6px | — | — | bottom 74% | pop | SAME |
| 102 | News Lower-Third (`tr-news-bar`) | 🎙️ Podcast | Inter 800 | UPPER | #FFFFFF | static color #FFFFFF | — | — | #E10600 r2 | bottom 80% | slide | SAME |
| 103 | Smoked Glass Card (`tr-frosted`) | ✨ Minimal & Clean | Inter 600 | as typed | #FFFFFF | static color #A7F3D0 | — | — | #0B0B0B @45% r22 | bottom 76% | slide | PARTIAL: box border; weight 600 → bold/regular |
| 104 | Quiet Lowercase (`tr-quiet-lower`) | ✨ Minimal & Clean | Inter 500 | as typed | #FFFFFF | static color #DCE8FF | — | #000000 halo | — | center | fade | PARTIAL: dimmed upcoming words |
| 105 | Soft Explainer (`tr-soft-explainer`) | ✨ Minimal & Clean | Poppins 700 | as typed | #FFFFFF | static color #7DD3FC | #000000 4px | #000000 halo | — | bottom 76% | pop | SAME |
| 106 | Explainer Clean Lower (`tr-explainer-lower`) | ✨ Minimal & Clean | Poppins 600 | as typed | #FFFFFF | static underline #FFB703 | — | #000000 halo | — | bottom 80% | fade | PARTIAL: weight 600 → bold/regular; underline → colour |
| 107 | Editorial Serif (`tr-editorial-serif`) | 🎬 Cinematic & Editorial | Playfair Display 600 | as typed | #FFFFFF | word-by-word color #F5D9A8 | — | #000000 halo | — | center | reveal | PARTIAL: different font on spoken word; weight 600 → bold/regular |
| 108 | Serif Keyword Mix (`tr-serif-mix`) | 🔥 Trending | Inter 700 | as typed | #FFFFFF | static color #FFD8A8 ×1.2 | — | #000000 halo | — | center | slide | PARTIAL: different font on spoken word |
| 109 | Cinema Subtitle (`tr-cinema-sub`) | 🎬 Cinematic & Editorial | EB Garamond 500 | as typed | #E6E6E6 | static color #FFFFFF | — | #000000 halo | — | bottom 80% | fade | PARTIAL: dimmed upcoming words |
| 110 | Luxe Wide (`tr-luxe-wide`) | 🎬 Cinematic & Editorial | Syne 700 | UPPER | #FFFFFF | static color #D9C9A3 | — | #000000 halo | — | center | fade | SAME |
| 111 | Neon Ignite (`tr-neon-ignite`) | 🔥 Trending | Montserrat 800 | as typed | #E6FFFB | word-by-word color #00F0FF | — | #00F0FF halo | — | center | karaoke | PARTIAL: glow on box/word |
| 112 | Magenta Night (`tr-magenta-night`) | 🌈 Neon & Glow | Poppins 800 | UPPER | #FFFFFF | static color #FF2BD6 | — | #FF2BD6 halo | — | center | pop | PARTIAL: glow on box/word |
| 113 | Chrome Y2K (`tr-chrome`) | 🌈 Neon & Glow | Unbounded 800 | UPPER | #FFFFFF→#9AA4B2 | static color #7DF9FF | #0B0B0B 5px | #7DF9FF halo | — | center | zoom | PARTIAL: gradient text |
| 114 | Terminal Typewriter (`tr-terminal`) | 🌈 Neon & Glow | Space Mono 700 | as typed | #EDEDED | static color #39FF14 | — | — | #000000 @75% r6 | bottom 78% | typewriter | PARTIAL: per-letter/word animation "typewriter" → caption entrance |
| 115 | RGB Glitch (`tr-rgb-glitch`) | 🌈 Neon & Glow | Space Grotesk 700 | UPPER | #FFFFFF | static color #FFFFFF | #FF0040 3px | #00E5FF offset | — | center | glitch | PARTIAL: per-letter/word animation "glitch" → caption entrance |
| 116 | Hard Shadow Sticker (`tr-hard-sticker`) | 😂 Fun & Meme | Rubik 900 | UPPER | #FFFFFF | static color #FFB800 | #000000 6px | #000000 offset | — | center | pop | PARTIAL: weight 900 → bold/regular |
| 117 | Marker Scribble (`tr-marker`) | 😂 Fun & Meme | Permanent Marker 400 | as typed | #FFFFFF | static underline #FF4D4D | #000000 4px | — | — | center | pop | PARTIAL: underline → colour |
| 118 | Top Text Meme (`tr-meme`) | 😂 Fun & Meme | Anton 400 | UPPER | #FFFFFF | static color #FFFFFF | #000000 10px | — | — | top | pop | SAME |
| 119 | Comic Speech Bubble (`tr-speech-bubble`) | 😂 Fun & Meme | Bangers 400 | UPPER | #111111 | static color #E4002B | — | — | #FFFFFF r28 | top | bounce | PARTIAL: box border |
| 120 | Letter Wave (`tr-letter-wave`) | 😂 Fun & Meme | Rubik 800 | as typed | #FFFFFF | static color #7CF3FF | #0B1A3A 7px | — | — | center | wave | PARTIAL: per-letter/word animation "wave" → caption entrance |
| 121 | 3D Push Button (`tr-push-button`) | 🔘 Buttons | Poppins 800 | as typed | #111111 | static color #111111 ×1.12 | — | — | #FFE600 r18 | center | pop-scale | PARTIAL: 3D box edge |
| 122 | Desi Punch (`tr-desi-punch`) | 🇮🇳 Hindi (हिंदी) | Baloo 2 800 | as typed | #FFFFFF | static color #FFD000 ×1.12 | #000000 6px | — | — | center | pop-scale | SAME |
| 123 | Bubble Pop Rounded (`tr-bubble-pop`) | 🇮🇳 Hindi (हिंदी) | Baloo 2 800 | as typed | #FFFFFF | static color #FF6FB5 | #3A0CA3 7px | — | — | center | bounce | SAME |
| 124 | Hindi Podcast Bar (`tr-hindi-podcast`) | 🇮🇳 Hindi (हिंदी) | Mukta 700 | as typed | #FFFFFF | word-by-word color #FFC940 | — | — | #000000 @55% r14 | bottom 74% | karaoke | PARTIAL: dimmed upcoming words |
| 125 | Hinglish Flip (`tr-hinglish-flip`) | 🇮🇳 Hindi (हिंदी) | Hind 700 | as typed | #FFFFFF | static color #FFD60A ×1.1 | #000000 6px | — | — | center | pop | SAME |
| 126 | Saffron Title (`tr-rozha-saffron`) | 🇮🇳 Hindi (हिंदी) | Rozha One 400 | as typed | #FFF4E0 | word-by-word color #FF9933 | — | #000000 offset | — | center | reveal | SAME |
| 127 | Handwritten Hindi (`tr-kalam`) | 🇮🇳 Hindi (हिंदी) | Kalam 700 | as typed | #FFFFFF | static color #FF5C8A | #000000 4px | — | — | center | pop | SAME |
| 128 | Tall Hype (`tr-teko-hype`) | 🇮🇳 Hindi (हिंदी) | Teko 600 | UPPER | #FFFFFF | static color #00E676 | #000000 6px | — | — | center | zoom | PARTIAL: weight 600 → bold/regular |
| 129 | Documentary Serif (`tr-tiro-doc`) | 🇮🇳 Hindi (हिंदी) | Tiro Devanagari Hindi 400 | as typed | #E6E6E6 | static color #FFFFFF | — | #000000 halo | — | bottom 80% | fade | PARTIAL: dimmed upcoming words |
| 130 | Warm Word Box (`tr-anek-box`) | 🇮🇳 Hindi (हिंदी) | Anek Devanagari 700 | as typed | #FFFFFF | word-by-word box #FF6B00 | #000000 4px | — | — | bottom 74% | karaoke | SAME |


Summary: 65 styles carry over fully by design, 65 lose something in Editable mode — weight (20), dimmed upcoming words (14), box border (12), gradient text (7), per-letter/word animation (7), gloss (6), box/word glow (5), gradient box (5), 2-tone spoken word (4), different spoken-word font (4), 3D box (4), underline → colour (3), tight spacing (1).

---

## 1. The reference (captions.ai)

### 1.1 Their 20 style cards (labels as shown — for reference only)

From one still frame each. Animation: **NOT VERIFIED** for all.

| Their label | Case | Weight / face | Colours | Outline / shadow | Box | Spoken / emphasis | Lines | Pulse has a close look? |
|---|---|---|---|---|---|---|---|---|
| Cove | mixed | sans regular + **serif italic** on some words | white | soft shadow | — | some words in serif italic | 2 | PARTIAL — `tr-serif-mix`, `pro-editorial`, `tr-editorial-serif` (spoken word only, not chosen words) |
| Energy | lower | sans, bold on one word | dark on light grey | — | rounded light pill | one word bolder | 1 | PARTIAL — pill styles yes; bolder-word NOT in presets |
| M81 | UPPER | heavy sans | white; one word green on purple box | — | box behind one word | word box | 1 | HAVE — word-box styles (`tr-purple-plate` etc.) |
| Arion Pink | mixed | bold sans, **mixed word sizes** | white | — | pink rounded box **per line, tilted** | small/big words | 2 | MISSING — no tilt, no per-line boxes, no size mix preset |
| Quintessence | Title | **condensed serif**, huge | yellow | — | — | **one word per screen** | 1 | MISSING preset (control exists: words per caption = 1) |
| Bellatrix | UPPER | heavy | white; one word yellow-green on purple box | dark outline | word box, slight tilt | word box | 1 | PARTIAL — no tilt |
| Prism | mixed | light sans + **bold italic** words | white | — | — | chosen words heavier italic | 1 | PARTIAL — as Cove |
| Freshly | sentence | **light** weight | white | — | translucent grey pill | — | 1 | HAVE — `cap-clean-sub` family (Editable: weight → regular) |
| Thuban | UPPER | heavy | black | — | yellow box **tilted** | — | 1 | PARTIAL — `pro-thuban` look without tilt |
| Mars | sentence | bold small | white | — | black rectangle | — | 1 | HAVE — `mars` |
| Runway | lower | bold | white, one word pink | — | black box **tilted** | keyword colour | 1 | PARTIAL — `pro-runway` without tilt |
| Grace | UPPER | heavy, huge | neon green | thick black outline | — | **one word per screen** | 1 | MISSING preset |
| Copernicus | UPPER | heavy | white, one word green | — | purple box behind one word | word box | 1 | HAVE |
| Aldebaran | UPPER | heavy | white | — | purple rounded box behind spoken word | word box | 1 | HAVE |
| Nova | UPPER | heavy, **first word big, rest small** | white | shadow | — | size contrast | 1 | PARTIAL — `pro-nova`; emphasise-words control exists, unused by presets |
| Alycone Blue | UPPER | heavy | white; outlined word on teal box | outline | word box | word box | 1 | HAVE (gradient box: Render only) |
| Travel | UPPER | heavy condensed | yellow→white **gradient text** | dark outline | — | — | 1 | HAVE in Render (`fill2`), MISSING in Editable |
| Andromeda | UPPER | bold | white | — | black rectangle | — | 1 | HAVE — `pro-andromeda` |
| Cassiopeia | lower | light, large | white, others **dimmed** | — | — | dim upcoming | 1 | HAVE in Render (15 styles), MISSING in Editable |
| Citadelle | UPPER | heavy | white; one word green on purple box | outline | word box | word box | 1 | HAVE |

**Name clash (needs your decision).** Pulse already ships styles named **Mars, Prism, Thuban (Pro), Runway (Pro), Nova (Pro), Andromeda (Pro)** — the same names as their cards. Your rules say "don't rename existing styles" *and* "never their names". I have not renamed anything.

### 1.2 Editing capabilities and features the page states (quoted)

| What they say | Quote |
|---|---|
| Transcription in 100+ languages, auto-sync | "Choose from 100+ languages and 100+ caption styles." · "automatically syncs captions to your video" |
| Translation, 100+ languages | "add translated subtitles in more than 100 languages" · "translate your video with one click" |
| Auto emoji | "enable auto emojis for extra emphasis" |
| Animations, transitions, effects | "Add animations, transitions, and effects for extra impact." (which ones: NOT VERIFIED) |
| Brand customisation | "Adjust fonts, colors or layouts" · "build your own style to match custom fonts and colors" |
| Style families | "animated word-by-word captions, highlights or bold stacks" |
| Edit text | "Edit or restyle to fit your brand." · "review and edit any line before exporting" |
| Accents / speakers | "handle accents, fast speech, technical vocabulary and even multiple speakers" |
| Export sizes | "Just pick a different export size to export another version." |
| Other products linked (not on this page's feature list) | Edit with AI, AI avatars, clips, translate videos, eye-contact correction, B-roll generator, text-based video editor, transition editor — details NOT VERIFIED |

---

## 2. Gap matrix

Effort S/M/L · Impact H/M/L · Mode = where it can be built given Premiere / .mogrt limits.

### 2.1 Styles

| Look | Pulse | Effort | Impact | Mode | Note |
|---|---|---|---|---|---|
| Word box behind one word (M81, Copernicus, Aldebaran, Citadelle, Alycone Blue) | HAVE | — | — | Both | Editable since Pulse Caption |
| Plain rectangle / pill box (Mars, Andromeda, Energy, Freshly) | HAVE | — | — | Both | light weights → regular in Editable |
| Gradient text (Travel) | PARTIAL | M | M | Render now; Editable needs a template control | AE gradient on the text layer |
| Dimmed upcoming words (Cassiopeia) | PARTIAL | S | M | Render now; Editable: S (one text animator) | template change |
| Serif-italic / bold on chosen words (Cove, Prism) | PARTIAL | M | H | Render: S (preset with keyword font); Editable: L — needs per-word fonts in Premiere's text runs, **NOT VERIFIED** that Premiere honours them | |
| **Tilted box** (Thuban, Runway, Bellatrix, Arion Pink) | MISSING | S | H | Both: render rotate + a "Tilt" template control | |
| **Box per line** (Arion Pink) | MISSING | M | M | Both: render per-line box; template needs per-line measuring | |
| **Mixed word sizes / first-word big** (Nova, Arion Pink) | PARTIAL | S | M | Render: preset on existing `emphasizeWords`; Editable: L (per-word size) — **Render-only for now** | |
| **One word per screen, huge** (Grace, Quintessence) | MISSING preset | S | H | Both (words per caption = 1) | |
| Condensed display serif (Quintessence) | PARTIAL | S | L | Both, if an OFL face is used (e.g. a Google condensed serif) | font check needed |

### 2.2 Animations

| Animation | Pulse | Effort | Impact | Mode |
|---|---|---|---|---|
| Word-by-word highlight | HAVE | — | — | Both |
| Pop / fade / slide entrance | HAVE | — | — | Both |
| Their specific animations (in/out, transitions) | NOT VERIFIED | — | — | — |
| Exit animation (out) | MISSING | M | M | Both (template: protected end region) |
| Per-word pop-in as spoken | PARTIAL (Render) | M | H | Render HAVE; Editable M (text animator by spoken index) |
| Typewriter / glitch in Editable | MISSING | M | L | Editable via text animators |

### 2.3 Editable controls (Editable mode)

| Control | Pulse Editable | Effort | Impact |
|---|---|---|---|
| Font, size, colours, outline, shadow, box, spacing, entrance | HAVE (16 template controls) | — | — |
| Tilt | MISSING | S | H |
| Dim upcoming words | MISSING | S | M |
| Gradient text | MISSING | M | M |
| Box border / glow | MISSING | S | L |
| Weight beyond bold/regular | MISSING | M | M — needs the exact font face name per weight |
| Keyword colour (static) | MISSING | L | M — the template cannot know which words are keywords without a hidden control or text runs (NOT VERIFIED) |
| Exit animation | MISSING | M | M |

### 2.4 Product features

| Feature (theirs) | Pulse | Effort | Impact | Note |
|---|---|---|---|---|
| Transcription, many languages, auto-sync | HAVE (Hindi / Hinglish focus; cloud + on-device) | — | — | language count differs: NOT VERIFIED which 100 |
| Translation | PARTIAL — 20 languages | S | M | add languages to the list |
| Auto emoji | HAVE | — | — | |
| Multiple speakers | HAVE (Detect speakers, mic-based camera switching) | — | — | |
| Edit any line before export | HAVE (caption text editor) | — | — | |
| Brand fonts/colours, own styles | HAVE (Your Styles, any installed font, Install caption fonts) | — | — | |
| Clips from long video | HAVE (Shorts) | — | — | |
| B-roll | PARTIAL — Pulse suggests B-roll ideas; their generator: NOT VERIFIED | L | M | |
| Export sizes / reformat | PARTIAL — 9:16 shorts | M | M | |
| Transitions editor | MISSING | L | L | outside captions |
| AI avatars, eye-contact correction | MISSING | L | L | outside a Premiere caption tool |

---

## 3. Proposed new styles — **waiting for your OK on names and scope**

Original AI-Floh names (proposals — please approve or change):

| Proposed name | Look (original, not a copy) | Fills gap | Render | Editable |
|---|---|---|---|---|
| **Tilt Tag** | heavy caps, solid tag box rotated ~-4°, spoken word coloured | tilted box | new: box rotation | needs template v4: **Tilt** control |
| **Line Ribbons** | each line on its own rounded ribbon, alternating ±3° | box per line + tilt | new: per-line boxes | template v4: per-line boxes |
| **One Word Shout** | one word per screen, huge heavy caps, thick outline | one word per screen | preset only | preset only |
| **Headliner** | first word large, rest small caps under it | mixed sizes | preset on `emphasizeWords` | **Render-only** (no per-word size in Premiere) |
| **Soft Focus** | light lowercase, upcoming words dimmed | dim upcoming in Editable | have | template v4: **Dim Upcoming** control |
| **Sunset Fade** | heavy caps, warm gradient text, dark outline | gradient text in Editable | have (`fill2`) | template v4: **Gradient** control |

Template v4 (one more run of the After Effects builder by you) would add: Tilt, Dim Upcoming, Text Gradient (2nd colour), Exit animation. Each is a standard Premiere-style control.

---

## 4. Product features — ranked, not built (waiting for approval)

1. Translation: more languages (S / M).
2. Export sizes: 1:1 and 16:9 versions of a captioned sequence (M / M).
3. Exit animations (M / M) — styles phase, listed here for ranking.
4. B-roll placement from the suggestions (L / M).
5. Transitions, avatars, eye contact — out of scope for a caption tool (L / L).

---

## 5. Open risks

- **Fonts.** Editable needs the font installed; 🔤 Install caption fonts installs the 26 Google (OFL) families the styles use. Styles on Mac system faces (Avenir Next, Futura, Impact…) depend on the Mac. A Windows installer is not done.
- **MOGRT limits.** No per-word font or size; menus are 0-based in Premiere (fixed); the template must be rebuilt in After Effects for any new control (needs you to run the script).
- **Long sequences.** Editable = one clip per caption line; a 2-hour podcast is ~1,500 clips (slow to insert). Render's one-clip overlay is the long-video path.
- **Real-Premiere parity** is measured only by 🎨 Test caption styles on your Mac.

## 6. Questions for you

1. **Names:** keep Pulse's existing Mars / Prism / Thuban / Runway / Nova / Andromeda as they are, or rename them to original names?
2. **New styles:** approve the six names above (or give your own)?
3. **Template v4:** OK to add Tilt, Dim Upcoming, Text Gradient and Exit animation (you run the builder once more)?
