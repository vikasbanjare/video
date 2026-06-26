/*
 * Pulse — caption tooling.
 * SRT parse/serialize, word-by-word "karaoke" exploding, and the style
 * preset catalog used by both the native-caption and MOGRT pipelines.
 * Pure functions, unit-testable in Node.
 */
(function (root, factory) {
  var lib = factory();
  // CEP panels with --enable-nodejs have BOTH `module` and `window` — register in both.
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPCaptions = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* "00:01:02,345" -> seconds */
  function srtTimeToSeconds(t) {
    var m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t.trim());
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  }

  function secondsToSrtTime(sec) {
    if (sec < 0) sec = 0;
    var ms = Math.round(sec * 1000);
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var min = Math.floor(ms / 60000); ms -= min * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    function p(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    return p(h, 2) + ':' + p(min, 2) + ':' + p(s, 2) + ',' + p(ms, 3);
  }

  /* Parse SRT text into [{start, end, text}] */
  function parseSRT(text) {
    var blocks = text.replace(/\r/g, '').split(/\n\n+/);
    var cues = [];
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) continue;
      if (/^\d+$/.test(lines[0].trim())) lines.shift(); // optional index line
      if (!lines.length) continue;
      var tm = /([\d:,.]+)\s*-->\s*([\d:,.]+)/.exec(lines[0]);
      if (!tm) continue;
      cues.push({
        start: srtTimeToSeconds(tm[1]),
        end: srtTimeToSeconds(tm[2]),
        text: lines.slice(1).join('\n').trim()
      });
    }
    return cues;
  }

  function toSRT(cues) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      out.push(String(i + 1));
      out.push(secondsToSrtTime(cues[i].start) + ' --> ' + secondsToSrtTime(cues[i].end));
      out.push(cues[i].text);
      out.push('');
    }
    return out.join('\n');
  }

  /* Phonetic Devanagari -> Latin (for "Hinglish" captions: Hindi spoken, written
     in English letters). Not linguistically perfect (no full schwa-deletion) but
     produces the readable romanized style Indian creators use. English text and
     punctuation pass through untouched. */
  var _DEV_C = {
    'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'ny',
    'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n',
    'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v','श':'sh','ष':'sh',
    'स':'s','ह':'h','क़':'q','ख़':'kh','ग़':'gh','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f','ळ':'l'
  };
  var _DEV_V = { 'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au','ऑ':'o','ॐ':'om' };
  var _DEV_M = { 'ा':'aa','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ॉ':'o','ॅ':'e' };
  var _DEV_VIRAMA = '्', _DEV_ANUSVARA = 'ं', _DEV_CHANDRA = 'ँ', _DEV_VISARGA = 'ः';
  function devanagariToLatin(input) {
    if (!input || !/[ऀ-ॿ]/.test(input)) return input;   // no Devanagari → leave as-is
    var chars = String(input).split(''), out = '';
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i], nxt = chars[i + 1];
      if (_DEV_C[ch] != null) {
        var base = _DEV_C[ch];
        if (nxt === _DEV_VIRAMA) { out += base; i++; }                 // halant: bare consonant
        else if (_DEV_M[nxt] != null) { out += base + _DEV_M[nxt]; i++; }
        else {
          // inherent 'a', but drop it when the consonant ends the word
          // (Hindi schwa-deletion: आज -> "aaj" not "aaja").
          var wordFinal = (nxt == null) || !/[ऀ-ॿ]/.test(nxt);
          out += base + (wordFinal ? '' : 'a');
        }
      } else if (_DEV_V[ch] != null) { out += _DEV_V[ch]; }
      else if (ch === _DEV_ANUSVARA || ch === _DEV_CHANDRA) { out += 'n'; }
      else if (ch === _DEV_VISARGA) { out += 'h'; }
      else if (ch === '।' || ch === '॥') { out += '.'; }
      else if (ch >= '०' && ch <= '९') { out += String(ch.charCodeAt(0) - 0x0966); }
      else { out += ch; }
    }
    return out;
  }

  /* Strip surrounding punctuation from a word for the clean, modern caption look
     (keeps apostrophes/hyphens inside the word, e.g. don't, well-known). */
  function stripWordPunct(w) {
    return String(w)
      .replace(/^[\s"'“”‘’(\[{¿¡]+/, '')
      .replace(/[\s"'“”‘’.,!?;:)\]}…—–]+$/, '');
  }

  /* Apply a display case to a word. 'title' caps each word; 'lower' lowercases;
     'sentence' lowercases (caller caps the first word of the line). */
  function caseWord(w, mode) {
    var s = String(w);
    if (mode === 'lower' || mode === 'sentence') return s.toLowerCase();
    if (mode === 'title') return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    return s;
  }
  function caseWords(words, mode) {
    var out = words.map(function (w) { return caseWord(w, mode); });
    if (mode === 'sentence') for (var i = 0; i < out.length; i++) {
      if (/[a-z]/i.test(out[i])) { out[i] = out[i].charAt(0).toUpperCase() + out[i].slice(1); break; }
    }
    return out;
  }

  /* Light profanity censor — keep the first letter, star the rest, preserving
     the original word's length so timing/animation is unaffected. */
  var PROFANITY = {
    fuck: 1, shit: 1, bitch: 1, asshole: 1, bastard: 1, dick: 1, cunt: 1,
    pussy: 1, slut: 1, whore: 1, damn: 1, crap: 1, fucking: 1, motherfucker: 1
  };
  function censorWord(w) {
    var bare = String(w).toLowerCase().replace(/[^a-z]/g, '');
    if (!PROFANITY[bare]) return w;
    return String(w).replace(/[A-Za-z]/g, function (ch, idx) { return idx === 0 ? ch : '*'; });
  }

  /*
   * Explode sentence-level cues into word-by-word (or N-words-per-cue) cues
   * with timing interpolated by word length. This is what turns plain
   * captions into the trending "karaoke pop" style using Premiere's own
   * caption engine — no MOGRT required.
   * opts: { wordsPerCue (default 1), uppercase (default false), minCueDur }
   */
  function explodeWords(cues, opts) {
    opts = opts || {};
    var per = Math.max(1, opts.wordsPerCue || 1);
    var minDur = opts.minCueDur != null ? opts.minCueDur : 0.08;
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var words = cue.text.replace(/\s+/g, ' ').trim().split(' ');
      if (!words.length || words[0] === '') continue;

      var groups = [];
      for (var g = 0; g < words.length; g += per) {
        groups.push(words.slice(g, g + per).join(' '));
      }
      // Weight timing by character count so long words get more screen time.
      var weights = [], totalW = 0;
      for (var w = 0; w < groups.length; w++) {
        var weight = Math.max(2, groups[w].replace(/\s/g, '').length);
        weights.push(weight);
        totalW += weight;
      }
      var dur = cue.end - cue.start;
      var t = cue.start;
      for (var k = 0; k < groups.length; k++) {
        var d = Math.max(minDur, dur * weights[k] / totalW);
        var end = (k === groups.length - 1) ? cue.end : Math.min(cue.end, t + d);
        var txt = opts.uppercase ? groups[k].toUpperCase() : groups[k];
        out.push({ start: t, end: end, text: txt });
        t = end;
      }
    }
    return out;
  }

  /*
   * Shift cue timings to follow silence removal: given keep-segments in
   * source time, remap each cue into the trimmed timeline. Cues that fall
   * entirely inside removed ranges are dropped.
   */
  function remapCuesToKeeps(cues, keeps) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      var offset = 0; // accumulated kept duration before current segment
      for (var k = 0; k < keeps.length; k++) {
        var seg = keeps[k];
        var s = Math.max(c.start, seg.start);
        var e = Math.min(c.end, seg.end);
        if (e > s) {
          out.push({
            start: offset + (s - seg.start),
            end: offset + (e - seg.start),
            text: c.text
          });
          break; // keep the first overlapping segment's portion
        }
        offset += seg.end - seg.start;
      }
    }
    return out;
  }

  /*
   * Regroup a transcript into captions of `perCue` words EACH, flowing ACROSS
   * the original line boundaries (unlike explodeWords, which only splits within
   * a line and so can never reduce the caption count). A new caption also
   * starts when the gap to the next word exceeds opts.maxGap, so a caption
   * never spans a long pause. Returns [{start, end, text}]. Pure + tested.
   */
  function regroupWords(cues, perCue, opts) {
    opts = opts || {};
    var per = Math.max(1, perCue || 1);
    var maxGap = opts.maxGap != null ? opts.maxGap : 1.5;
    var maxChars = opts.maxChars || 0;            // 0 = no width limit (legacy / tests)
    var sentenceBreak = !!opts.sentenceBreak;     // close a caption after . ! ? so a sentence is never split across frames
    var words = explodeWords(cues, { wordsPerCue: 1, uppercase: !!opts.uppercase });
    var out = [], group = [], groupChars = 0;
    function flush() {
      if (!group.length) return;
      out.push({
        start: group[0].start,
        end: group[group.length - 1].end,
        text: group.map(function (w) { return w.text; }).join(' ')
      });
      group = []; groupChars = 0;
    }
    for (var i = 0; i < words.length; i++) {
      var wt = words[i].text, wlen = wt.length;
      var projected = group.length ? (groupChars + 1 + wlen) : wlen;   // +1 for the joining space
      if (group.length && (
            group.length >= per ||                                      // word-count cap
            (maxChars && projected > maxChars) ||                       // WIDTH cap → text can't overflow the box
            (words[i].start - group[group.length - 1].end) > maxGap     // long pause
         )) flush();
      group.push(words[i]);
      groupChars = (group.length === 1) ? wlen : (groupChars + 1 + wlen);
      // A word that ENDS a sentence closes the caption, so the next sentence starts
      // fresh in its own frame — fixes a word like "my" being stranded on the prior
      // sentence's last frame (e.g. "…ozone. My" → "…ozone." | "My name is Victor").
      if (sentenceBreak && /[.!?]["'»)\]]?$/.test(wt)) flush();
    }
    flush();
    return out;
  }

  /*
   * Style presets — the catalog the panel UI shows. Each preset carries:
   *  - native:  recommended settings for Premiere's built-in caption styling
   *  - mogrt:   parameter hints applied when inserting a .mogrt per cue
   *  - anim:    the animation concept (used by MOGRT templates / docs)
   * Based on 2026 short-form trends: word-by-word karaoke, bold statement,
   * highlight-box, clean minimal, neon, typewriter.
   */
  var STYLE_PRESETS = [
    {
      id: 'hormozi',
      name: 'Bold Statement',
      description: 'Confident ALL-CAPS word-by-word in a clean heavy sans, with a crisp outline and a single accent colour on the spoken word.',
      font: 'Montserrat', weight: 900, fallbackFonts: ['Anton', 'Bebas Neue', 'Arial Black'],
      fontSize: 90, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 12,
      uppercase: true, wordsPerCue: 1, anim: 'pop-scale',
      animNotes: 'Each word scales 0%→110%→100% over ~120ms with ease-out.'
    },
    {
      id: 'karaoke',
      name: 'Karaoke Highlight',
      description: 'Full phrase visible, the spoken word lights up in a highlight color as it is said. Best retention for educational content (~+15% engagement).',
      font: 'Poppins', weight: 600, fallbackFonts: ['Inter', 'Arial'],
      fontSize: 70, fill: '#FFFFFF', highlight: '#00E676', stroke: '#000000', strokeWidth: 8,
      uppercase: false, wordsPerCue: 3, anim: 'color-sweep',
      animNotes: 'Active word fill animates white→highlight; others stay white.'
    },
    {
      id: 'highlight-box',
      name: 'Highlight Box',
      description: 'The spoken word sits on a solid rounded pill that snaps word to word (Submagic/CapCut style).',
      font: 'Inter', weight: 700, fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FF3B6B', stroke: '#000000', strokeWidth: 6,
      boxRadius: 14, highlightStyle: 'box',
      uppercase: false, wordsPerCue: 3, anim: 'box-snap',
      animNotes: 'Background box width-animates to each new word in ~80ms.'
    },
    {
      id: 'minimal',
      name: 'Clean Minimal',
      description: 'Lower-third sentence captions, soft shadow, no gimmicks. For long-form YouTube and corporate.',
      font: 'Inter', weight: 500, fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: null, stroke: '#000000', strokeWidth: 3,
      uppercase: false, wordsPerCue: 0 /* keep full sentences */, anim: 'fade',
      animNotes: 'Simple 150ms opacity fade in/out.'
    },
    {
      id: 'neon',
      name: 'Neon Pop',
      description: 'Glowing neon text with chromatic flicker on entry. Gaming / music content.',
      font: 'Bebas Neue', fallbackFonts: ['Anton', 'Impact'],
      fontSize: 80, fill: '#F8F8FF', highlight: '#00F0FF', stroke: '#7B2FFF', strokeWidth: 6,
      glow: '#00F0FF',
      uppercase: true, wordsPerCue: 1, anim: 'glitch-in',
      animNotes: '2-frame RGB-split glitch on entry, outer glow pulses with audio.'
    },
    {
      id: 'typewriter',
      name: 'Typewriter',
      description: 'Characters type on with a blinking caret. Storytelling and documentary openers.',
      font: 'JetBrains Mono', fallbackFonts: ['Courier New'],
      fontSize: 54, fill: '#EAEAEA', highlight: null, stroke: null, strokeWidth: 0, glow: '#000000',
      uppercase: false, wordsPerCue: 0, anim: 'typewriter',
      animNotes: 'Per-character reveal at ~30 chars/sec with caret.'
    },
    {
      id: 'boldyellow',
      name: 'Bold Yellow',
      description: 'Solid yellow ALL-CAPS with a heavy black stroke — high energy, very legible.',
      font: 'Anton', fallbackFonts: ['Bebas Neue', 'Impact', 'Arial Black'],
      fontSize: 88, fill: '#FFD400', highlight: '#FFFFFF', stroke: '#000000', strokeWidth: 12,
      uppercase: true, wordsPerCue: 1, anim: 'pop-scale',
      animNotes: 'Punchy scale-in; emphasized words flip to white.'
    },
    {
      id: 'cleanwhite',
      name: 'Clean White',
      description: 'White words with a crisp thin outline and a soft scale-in. Goes with anything.',
      font: 'Poppins', weight: 600, fallbackFonts: ['Inter', 'Helvetica', 'Arial'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 5,
      uppercase: false, wordsPerCue: 2, anim: 'fade',
      animNotes: 'Gentle scale + fade.'
    },
    {
      id: 'tvnews',
      name: 'News Bar',
      description: 'White text on a translucent dark bar, lower third. Interviews and explainers.',
      font: 'Inter', weight: 500, fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#33C1FF', stroke: null, strokeWidth: 0,
      boxColor: '#000000', boxRadius: 6,
      uppercase: false, wordsPerCue: 0, anim: 'fade',
      animNotes: 'Bar slides/fades in along the lower third.'
    }
  ];

  function uc(s) { return String(s).toUpperCase(); }

  /* The ten library categories the browser groups templates into. */
  var CATEGORIES = [
    '⭐ Premium',
    '🔘 Buttons',
    'Trending',
    'Bold Creator', 'Minimal Professional', 'Dynamic Highlight', 'Social Growth',
    'Podcast Pro', 'Storytelling', 'Gaming Stream', 'Cinematic', 'Motivation', 'Education'
  ];

  /* Library metadata for the nine base presets (category / popularity /
     layout / keyword-highlight default). */
  var _baseMeta = {
    hormozi:        { category: 'Bold Creator',          popularity: 99, layout: 'bottom', keyword: true, highlightScale: 1.14 },
    karaoke:        { category: 'Dynamic Highlight',     popularity: 95, layout: 'bottom', keyword: false },
    'highlight-box':{ category: 'Social Growth',         popularity: 92, layout: 'bottom', keyword: true },
    minimal:        { category: 'Minimal Professional',  popularity: 80, layout: 'bottom', keyword: false },
    neon:           { category: 'Gaming Stream',         popularity: 88, layout: 'center', keyword: true },
    typewriter:     { category: 'Storytelling',          popularity: 70, layout: 'center', keyword: false },
    boldyellow:     { category: 'Motivation',            popularity: 90, layout: 'bottom', keyword: true, highlightScale: 1.14 },
    cleanwhite:     { category: 'Minimal Professional',  popularity: 78, layout: 'bottom', keyword: false },
    tvnews:         { category: 'Podcast Pro',           popularity: 65, layout: 'bottom', keyword: false, speaker: true }
  };
  for (var _i = 0; _i < STYLE_PRESETS.length; _i++) {
    var _m = _baseMeta[STYLE_PRESETS[_i].id] || {};
    STYLE_PRESETS[_i].category = _m.category || 'Bold Creator';
    STYLE_PRESETS[_i].popularity = _m.popularity || 60;
    STYLE_PRESETS[_i].layout = _m.layout || 'bottom';
    STYLE_PRESETS[_i].keyword = !!_m.keyword;
    STYLE_PRESETS[_i].speaker = !!_m.speaker;
    if (_m.highlightScale) STYLE_PRESETS[_i].highlightScale = _m.highlightScale;
  }

  /* Extra professionally-designed templates fleshing out every category.
     Names echo the short-form template aesthetic (Impact, Volt, Chalk…). */
  var MORE_TEMPLATES = [
    { id: 'impact', name: 'Impact II', category: 'Bold Creator', popularity: 97, layout: 'bottom', keyword: true, highlightScale: 1.18,
      font: 'Anton', fallbackFonts: ['Bebas Neue', 'Impact', 'Arial Black'],
      fontSize: 92, fill: '#FFFFFF', highlight: '#FFE53B', stroke: '#000000', strokeWidth: 13,
      uppercase: true, wordsPerCue: 1, anim: 'pop' },
    { id: 'prime', name: 'Prime', category: 'Bold Creator', popularity: 94, layout: 'center', keyword: true,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Arial Black'],
      fontSize: 86, fill: '#FFFFFF', highlight: '#7C5CFF', stroke: '#000000', strokeWidth: 10,
      uppercase: true, wordsPerCue: 2, anim: 'zoom' },
    { id: 'byline', name: 'Byline', category: 'Minimal Professional', popularity: 82, layout: 'bottom', keyword: false,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 50, fill: '#FFFFFF', highlight: '#9AD0FF', stroke: '#000000', strokeWidth: 3,
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'magazine', name: 'Magazine', category: 'Minimal Professional', popularity: 74, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 58, fill: '#F5F1E8', highlight: '#D9B36A', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'focus', name: 'Focus', category: 'Dynamic Highlight', popularity: 93, layout: 'bottom', keyword: true,
      font: 'Poppins', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 66, fill: '#FFFFFF', highlight: '#FF3B6B', boxRadius: 14, highlightStyle: 'box', stroke: '#000000', strokeWidth: 6,
      uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    { id: 'volt', name: 'Volt', category: 'Dynamic Highlight', popularity: 91, layout: 'bottom', keyword: true,
      font: 'Bebas Neue', fallbackFonts: ['Anton', 'Impact'],
      fontSize: 82, fill: '#FFFFFF', highlight: '#39FF14', stroke: '#000000', strokeWidth: 8,
      uppercase: true, wordsPerCue: 3, anim: 'pop' },
    { id: 'rocket', name: 'Rocket', category: 'Social Growth', popularity: 90, layout: 'bottom', keyword: true,
      font: 'Montserrat', fallbackFonts: ['Inter', 'Arial Black'],
      fontSize: 70, fill: '#FFFFFF', highlight: '#FF2D7E', boxRadius: 16, highlightStyle: 'box', stroke: '#000000', strokeWidth: 7,
      uppercase: true, wordsPerCue: 3, anim: 'karaoke' },
    { id: 'mars', name: 'Mars', category: 'Social Growth', popularity: 87, layout: 'bottom', keyword: true,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 64, fill: '#111111', highlight: '#111111', boxColor: '#FFE53B', boxRadius: 10, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 2, anim: 'pop' },
    { id: 'lift', name: 'Lift', category: 'Podcast Pro', popularity: 76, layout: 'bottom', keyword: false, speaker: true,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 52, fill: '#FFFFFF', highlight: '#5CC8FF', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 0, anim: 'slide' },
    { id: 'lumen', name: 'Lumen', category: 'Storytelling', popularity: 72, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 56, fill: '#F3EEE6', highlight: '#E0C189', stroke: null, strokeWidth: 0, glow: '#000000',
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'ember', name: 'Ember', category: 'Storytelling', popularity: 68, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['serif'],
      fontSize: 54, fill: '#FFE9D6', highlight: '#FF9E5A', stroke: '#1a1a1a', strokeWidth: 2,
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'rebel', name: 'Rebel', category: 'Gaming Stream', popularity: 85, layout: 'center', keyword: true,
      font: 'Bebas Neue', fallbackFonts: ['Anton', 'Impact'],
      fontSize: 84, fill: '#C6FF00', highlight: '#FFFFFF', stroke: '#000000', strokeWidth: 9, glow: '#C6FF00',
      uppercase: true, wordsPerCue: 1, anim: 'shake' },
    { id: 'cinema', name: 'Cinematic', category: 'Cinematic', popularity: 79, layout: 'bottom', keyword: false,
      font: 'Futura', fallbackFonts: ['Oswald', 'Helvetica'],
      fontSize: 44, fill: '#EDEDED', highlight: '#EDEDED', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 4, uppercase: true, wordsPerCue: 0, anim: 'fade' },
    { id: 'align', name: 'Align', category: 'Cinematic', popularity: 71, layout: 'center', keyword: false,
      font: 'JetBrains Mono', fallbackFonts: ['Courier New', 'monospace'],
      fontSize: 40, fill: '#FFFFFF', highlight: '#9AD0FF', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 6, uppercase: true, wordsPerCue: 0, anim: 'fade' },
    { id: 'grind', name: 'Grind', category: 'Motivation', popularity: 89, layout: 'bottom', keyword: true, highlightScale: 1.16,
      font: 'Anton', fallbackFonts: ['Bebas Neue', 'Impact'],
      fontSize: 90, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 12,
      uppercase: true, wordsPerCue: 1, anim: 'scale' },
    { id: 'chalk', name: 'Chalk', category: 'Education', popularity: 73, layout: 'bottom', keyword: true,
      font: 'Bradley Hand', fallbackFonts: ['Comic Sans MS', 'cursive'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFE53B', stroke: '#000000', strokeWidth: 5,
      uppercase: false, wordsPerCue: 2, anim: 'wave' },
    { id: 'paper', name: 'Paper II', category: 'Education', popularity: 75, layout: 'bottom', keyword: true,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 58, fill: '#1A1A1A', highlight: '#1A1A1A', boxColor: '#FFFFFF', boxRadius: 8, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 2, anim: 'pop' },

    // --- Captions.ai signature looks (recreated from the gallery) ---
    { id: 'prism', name: 'Prism Pro', category: 'Bold Creator', popularity: 96, layout: 'bottom', keyword: true,
      font: 'Montserrat', fallbackFonts: ['Inter', 'Arial Black'],
      fontSize: 74, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 7,
      uppercase: false, wordsPerCue: 0, anim: 'pop' },
    { id: 'evo', name: 'Evo', category: 'Bold Creator', popularity: 88, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Poppins', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 66, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 5,
      uppercase: false, wordsPerCue: 0, anim: 'pop' },
    { id: 'stack', name: 'Stack', category: 'Bold Creator', popularity: 84, layout: 'bottom', keyword: true,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 60, fill: '#FFFFFF', highlight: '#FF4D6D', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'kai', name: 'Kai', category: 'Social Growth', popularity: 86, layout: 'bottom', keyword: false,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Arial Black'],
      fontSize: 80, fill: '#FF2D9B', highlight: '#FFFFFF', stroke: '#000000', strokeWidth: 8,
      uppercase: true, wordsPerCue: 1, anim: 'pop' },
    { id: 'y2k', name: 'Y2K', category: 'Gaming Stream', popularity: 81, layout: 'center', keyword: false,
      font: 'Verdana', fallbackFonts: ['Tahoma', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#00F0FF', boxColor: '#141414', boxRadius: 4, stroke: null, strokeWidth: 0,
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'glitch' },
    { id: 'elevate', name: 'Cinema', category: 'Cinematic', popularity: 77, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 60, fill: '#F3ECE0', highlight: '#D9B36A', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'sketch', name: 'Sketch', category: 'Storytelling', popularity: 74, layout: 'center', keyword: false,
      font: 'Bradley Hand', fallbackFonts: ['Comic Sans MS', 'cursive'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFE53B', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'bloom', name: 'Bloom', category: 'Storytelling', popularity: 71, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['serif'],
      fontSize: 58, fill: '#FFF3E9', highlight: '#E6A0B0', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'linen', name: 'Linen', category: 'Minimal Professional', popularity: 73, layout: 'bottom', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#C9A36A', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'sonnet', name: 'Sonnet', category: 'Storytelling', popularity: 67, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 48, fill: '#EFE8DF', highlight: '#CBB68B', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },

    // --- Cinematic serif quote looks (recreated from a reference reel:
    //     elegant Playfair serif, white ALL-CAPS, centered, short phrases.
    //     "Monolith" = clean hero word; "Quote Pill" sits the phrase on a
    //     dark rounded pill like the reel's highlighted lines.) ---
    { id: 'monolith', name: 'Monolith', category: 'Cinematic', popularity: 83, layout: 'center', keyword: false,
      font: 'Playfair Display', fallbackFonts: ['Georgia', 'Times New Roman', 'serif'],
      fontSize: 78, fill: '#FFFFFF', highlight: '#FFFFFF', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: true, wordsPerCue: 2, anim: 'scale' },
    { id: 'quotepill', name: 'Quote Pill', category: 'Cinematic', popularity: 81, layout: 'center', keyword: false,
      font: 'Playfair Display', fallbackFonts: ['Georgia', 'Times New Roman', 'serif'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#FFFFFF', boxColor: '#0B1020', boxRadius: 46, stroke: null, strokeWidth: 0,
      letterSpacing: 1, uppercase: true, wordsPerCue: 3, anim: 'fade' },

    // --- Trending creator styles: word-by-word reveal of a short centered
    //     phrase with the SPOKEN word emphasized — 'karaoke' lights up + scales
    //     the active word, highlightStyle:'box' sits it on a colored pill. ---
    { id: 'cap-core', name: 'Core', category: 'Trending', popularity: 99, layout: 'center', keyword: false,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 68, fill: '#FFFFFF', highlight: '#FFE000', highlightScale: 1.14, stroke: '#000000', strokeWidth: 6,
      uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    { id: 'cap-clarity', name: 'Crisp', category: 'Trending', popularity: 92, layout: 'center', keyword: false,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 56, fill: '#FFFFFF', highlight: '#FFFFFF', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 4, anim: 'fade' },
    { id: 'cap-grit', name: 'Grit', category: 'Trending', popularity: 96, layout: 'center', keyword: false,
      font: 'Anton', fallbackFonts: ['Bebas Neue', 'Impact', 'Arial Black'],
      fontSize: 86, fill: '#FFFFFF', highlight: '#FFD400', highlightScale: 1.16, stroke: '#000000', strokeWidth: 11,
      uppercase: true, wordsPerCue: 3, anim: 'karaoke' },
    { id: 'cap-hype', name: 'Surge', category: 'Trending', popularity: 95, layout: 'center', keyword: false,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 70, fill: '#FFFFFF', highlight: '#22C55E', highlightStyle: 'box', boxRadius: 16, stroke: '#000000', strokeWidth: 6,
      uppercase: true, wordsPerCue: 3, anim: 'karaoke' }
  ];

  /* ⭐ Premium — refined, modern, "expensive"-looking styles (NOT the loud
     bold-caps look). Clean grotesk/serif faces, tasteful muted accents,
     soft bars/pills, gentle fade/slide/scale. These lead the library. */
  var PREMIUM_TEMPLATES = [
    // Spotlight — the signature Captions.ai look: clean white modern sans, soft
    // drop-shadow (NOT a thick outline), the key word on a tasteful blue pill.
    { id: 'pro-spotlight', name: 'Spotlight', category: '⭐ Premium', popularity: 100, layout: 'bottom', keyword: false, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#2D7CFF', highlightStyle: 'box', boxRadius: 12,
      glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Subs Light — light pill, dark text, spoken word blue, upcoming words dimmed
    // (matches the uploaded "SUBS 1" reference exactly).
    { id: 'pro-subs-light', name: 'Subs Light', category: '⭐ Premium', popularity: 100, layout: 'bottom', keyword: false, highlightScale: 1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 58, fill: '#15181E', highlight: '#2D7CFF', highlightStyle: 'color',
      boxColor: '#F1F2F4', boxRadius: 16, boxOpacity: 1, upcomingOpacity: 0.4,
      glow: null, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    // Clean Glow — bold white, soft glow, no box, spoken word pops (matches the
    // uploaded "SUBS 2" reference).
    { id: 'pro-clean-glow', name: 'Clean Glow', category: '⭐ Premium', popularity: 99, layout: 'center', keyword: false, highlightScale: 1.12,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial Black'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      glow: '#000000', glowBlur: 0.5, stroke: null, strokeWidth: 0, boxColor: null,
      upcomingOpacity: 0.55, uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    // Karaoke Bar — white words on a translucent dark rounded bar; the spoken
    // word rides in a SOLID amber box with auto-contrast (dark) text. The classic
    // reel/explainer look (matches the uploaded m.Stock reference).
    { id: 'pro-karaokebar', name: 'Karaoke Bar', category: '⭐ Premium', popularity: 99, layout: 'bottom', keyword: false, highlightScale: 1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#F5A623', highlightStyle: 'box', boxRadius: 9,
      boxColor: '#0C0D11', boxOpacity: 0.72, boxPad: 1.15,
      glow: null, stroke: null, strokeWidth: 0, weight: 800, uppercase: false, wordsPerCue: 5, anim: 'karaoke' },
    // Pulse — UPPERCASE clean sans, key word on a blue pill (Captions.ai "Pulse")
    { id: 'pro-pulse', name: 'Pulse', category: '⭐ Premium', popularity: 99, layout: 'center', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 66, fill: '#FFFFFF', highlight: '#3B5BFF', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    // Thuban — key word on a yellow pill (black text auto-contrasts)
    { id: 'pro-thuban', name: 'Thuban', category: '⭐ Premium', popularity: 98, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#FFE000', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    // Runway — lowercase clean, key word on a pink pill
    { id: 'pro-runway', name: 'Runway', category: '⭐ Premium', popularity: 97, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Poppins', fallbackFonts: ['Montserrat', 'Inter', 'Arial'],
      fontSize: 58, fill: '#FFFFFF', highlight: '#FF2D9B', highlightStyle: 'box', boxRadius: 14, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'reveal' },
    // Copernicus — key word on a green pill
    { id: 'pro-copernicus', name: 'Copernicus', category: '⭐ Premium', popularity: 96, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#15C47E', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    // Clarity — minimal clean white, sentence case, soft shadow (Captions.ai "Clarity")
    { id: 'pro-clarity', name: 'Clarity', category: '⭐ Premium', popularity: 95, layout: 'center', keyword: false,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#FFFFFF', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'fade' },
    // Evo — clean white, key word pops in a soft gold (no box)
    { id: 'pro-evo', name: 'Evo', category: '⭐ Premium', popularity: 94, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Poppins', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 60, fill: '#FFFFFF', highlight: '#FFD400', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'reveal' },
    // Nova — UPPERCASE clean, key word in coral-pink (no box)
    { id: 'pro-nova', name: 'Nova', category: '⭐ Premium', popularity: 93, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FF3B6B', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    // Andromeda — clean white on a soft dark rounded bar (lower-third, Captions.ai "Byline")
    { id: 'pro-andromeda', name: 'Andromeda', category: '⭐ Premium', popularity: 92, layout: 'bottom', keyword: false,
      font: 'Outfit', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#9FE7FF', boxColor: '#10131A', boxRadius: 16, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 0, anim: 'slide' },
    // Elevate — cinematic serif, soft gold accent (Captions.ai "Elevate")
    { id: 'pro-elevate', name: 'Elevate', category: '⭐ Premium', popularity: 91, layout: 'center', keyword: false,
      font: 'Playfair Display', fallbackFonts: ['Lora', 'Georgia', 'serif'],
      fontSize: 60, fill: '#F6F2EC', highlight: '#E8C77A', glow: '#000000', stroke: null, strokeWidth: 0, letterSpacing: 0.5,
      uppercase: false, wordsPerCue: 4, anim: 'fade' },
    // Quintessence — elegant warm-gold serif, centered (Captions.ai "Quintessence")
    { id: 'pro-quint', name: 'Quintessence', category: '⭐ Premium', popularity: 90, layout: 'center', keyword: false,
      font: 'Playfair Display', fallbackFonts: ['Lora', 'Georgia', 'serif'],
      fontSize: 66, fill: '#F3E9D2', highlight: '#D9B36A', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'scale' },
    // Velocity — bold word-by-word caps with a blue accent (Captions.ai "Velocity")
    { id: 'pro-velocity', name: 'Velocity', category: '⭐ Premium', popularity: 89, layout: 'bottom', keyword: true, highlightScale: 1.12,
      font: 'Montserrat', fallbackFonts: ['Archivo Black', 'Arial Black'],
      fontSize: 78, fill: '#FFFFFF', highlight: '#2D7CFF', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 1, anim: 'pop-scale' },
    // Neon — glowing gaming/music look (Captions.ai "Neon" / "Rocket")
    { id: 'pro-neon', name: 'Neon', category: '⭐ Premium', popularity: 88, layout: 'center', keyword: true,
      font: 'Bebas Neue', fallbackFonts: ['Anton', 'Impact'],
      fontSize: 84, fill: '#FFFFFF', highlight: '#FF2D9B', glow: '#22D3FF', stroke: '#0A0A0A', strokeWidth: 3,
      uppercase: true, wordsPerCue: 1, anim: 'glitch-in' },

    // ---- v1.0 creator presets (word reveal + viral-word pop built in) ----
    { id: 'v1-hormozi26', name: 'Statement Pro', category: '⭐ Premium', popularity: 87, layout: 'bottom', keyword: true, highlightScale: 1.12,
      font: 'Montserrat', fallbackFonts: ['Archivo Black', 'Arial Black'],
      fontSize: 72, fill: '#FFFFFF', highlight: '#FFE000', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    { id: 'v1-finance', name: 'Finance Pro', category: '⭐ Premium', popularity: 86, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 60, fill: '#FFFFFF', highlight: '#16C784', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'reveal' },
    { id: 'v1-podcast', name: 'Podcast Pro', category: '⭐ Premium', popularity: 85, layout: 'bottom', keyword: false, speaker: true,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: '#5CC8FF', boxColor: '#10131A', boxRadius: 14, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 0, anim: 'slide' },
    { id: 'v1-reels', name: 'Indian Reels', category: '⭐ Premium', popularity: 84, layout: 'bottom', keyword: true, highlightScale: 1.12,
      font: 'Poppins', fallbackFonts: ['Montserrat', 'Inter', 'Arial'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#FF2D9B', highlightStyle: 'box', boxRadius: 14, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'reveal' },
    { id: 'v1-beast', name: 'MrBeast Inspired', category: '⭐ Premium', popularity: 83, layout: 'bottom', keyword: true, highlightScale: 1.18,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Arial Black'],
      fontSize: 78, fill: '#FFFFFF', highlight: '#FF2A2A', glow: '#000000', stroke: '#000000', strokeWidth: 4,
      uppercase: true, wordsPerCue: 1, anim: 'pop-scale' },
    { id: 'v1-ali', name: 'Ali Abdaal Inspired', category: '⭐ Premium', popularity: 82, layout: 'bottom', keyword: false,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 50, fill: '#FFFFFF', highlight: '#FFFFFF', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'fade' }
  ];

  /* The full catalog the library browses (base + extras). */
  // ---- Fresh, distinct aesthetic styles (each a clearly different look) ----
  var NEW_TEMPLATES = [
    // Gradient sky text, soft glow — premium cinematic
    { id: 'cap-aurora', name: 'Aurora', category: 'Cinematic', popularity: 96, layout: 'center', keyword: false, highlightScale: 1.12,
      font: 'Outfit', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 64, fill: '#FFFFFF', fill2: '#B9C7FF', highlight: '#7FE7FF', highlightStyle: 'color',
      glow: '#0A1030', glowBlur: 0.5, stroke: null, strokeWidth: 0, boxColor: null,
      upcomingOpacity: 0.55, uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    // Comic-poster energy — Bangers, thick outline, white active word
    { id: 'cap-motiv', name: 'Hype', category: 'Motivation', popularity: 95, layout: 'center', keyword: false, highlightScale: 1.2,
      font: 'Bangers', fallbackFonts: ['Luckiest Guy', 'Anton', 'Impact'],
      fontSize: 96, fill: '#FFE53B', highlight: '#FFFFFF', highlightStyle: 'color',
      stroke: '#000000', strokeWidth: 13, glow: null, boxColor: null,
      uppercase: true, wordsPerCue: 3, anim: 'karaoke' },
    // Terminal mono on a dark pill — techy / gaming
    { id: 'cap-mono', name: 'Mono', category: 'Gaming Stream', popularity: 91, layout: 'bottom', keyword: false, highlightScale: 1.05,
      font: 'JetBrains Mono', fallbackFonts: ['Roboto Mono', 'Space Mono', 'Courier New'],
      fontSize: 46, fill: '#E6FBFF', highlight: '#00F0FF', highlightStyle: 'color',
      boxColor: '#0B1118', boxRadius: 8, boxOpacity: 0.92, glow: null, stroke: null, strokeWidth: 0,
      upcomingOpacity: 0.5, uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Rounded white pill, soft pink active — friendly social look
    { id: 'cap-pastel', name: 'Pastel', category: 'Social Growth', popularity: 92, layout: 'bottom', keyword: false, highlightScale: 1.08,
      font: 'Nunito', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 56, fill: '#2A2233', highlight: '#FF5DA2', highlightStyle: 'box', boxColor: '#FFFFFF', boxRadius: 24, boxOpacity: 1,
      glow: null, stroke: null, strokeWidth: 0, upcomingOpacity: 0.5, uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    // Elegant serif, gold active — storytelling / luxury
    { id: 'cap-editorial', name: 'Column', category: 'Storytelling', popularity: 90, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Playfair Display', fallbackFonts: ['Georgia', 'Merriweather', 'Times New Roman'],
      fontSize: 60, fill: '#F6F2EA', highlight: '#E7B45A', highlightStyle: 'color',
      glow: '#000000', glowBlur: 0.45, stroke: null, strokeWidth: 0, boxColor: null,
      upcomingOpacity: 0.6, uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Condensed news ticker, teal bar under the spoken word
    { id: 'cap-ticker', name: 'Ticker', category: 'Education', popularity: 88, layout: 'bottom', keyword: false, highlightScale: 1.02,
      font: 'Oswald', fallbackFonts: ['Bebas Neue', 'Inter', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#13C2A8', highlightStyle: 'bar', boxOpacity: 1,
      glow: null, stroke: '#000000', strokeWidth: 5, uppercase: true, wordsPerCue: 4, anim: 'karaoke' },
    // Crisp white subtitle card, blue active — minimal & professional
    { id: 'cap-card', name: 'Clean Card', category: 'Minimal Professional', popularity: 93, layout: 'bottom', keyword: false, highlightScale: 1,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 52, fill: '#11151C', highlight: '#2D7CFF', highlightStyle: 'color',
      boxColor: '#FFFFFF', boxRadius: 12, boxOpacity: 0.96, glow: null, stroke: null, strokeWidth: 0,
      upcomingOpacity: 0.45, uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Warm clean studio caption — podcast/interview
    { id: 'cap-studio', name: 'Studio', category: 'Podcast Pro', popularity: 90, layout: 'bottom', keyword: false, highlightScale: 1.06,
      font: 'Manrope', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#FFC857', highlightStyle: 'color',
      glow: '#000000', glowBlur: 0.42, stroke: null, strokeWidth: 0, boxColor: null,
      upcomingOpacity: 0.55, uppercase: false, wordsPerCue: 4, anim: 'karaoke' },

    // ---- Extracted from reference video: centered MULTI-WORD caption, heavy sans,
    //      the AUTO-DETECTED keyword pops bigger in a GLOSSY (shiny) gradient.
    //      White words carry a subtle sheen; soft shadow for depth. ----
    // Warm glossy orange keyword
    { id: 'pro-boldpop', name: 'Bold Pop', category: '⭐ Premium', popularity: 100, layout: 'center', keyword: true, wordHl: false, highlightScale: 1.5,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', fill2: '#D2D7DE', highlight: '#FFE45C', highlight2: '#EF6C0A', highlightStyle: 'color', glossy: true,
      stroke: '#2A1A06', strokeWidth: 5, glow: '#000000', glowBlur: 0.5,
      weight: 900, uppercase: false, wordsPerLine: 3, wordsPerCue: 6, lineGap: 1.04, anim: 'pop' },
    // Cool glossy blue keyword
    { id: 'pro-coolpop', name: 'Cool Pop', category: '⭐ Premium', popularity: 99, layout: 'center', keyword: true, wordHl: false, highlightScale: 1.5,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', fill2: '#D2D7DE', highlight: '#BFE3FF', highlight2: '#1E63E6', highlightStyle: 'color', glossy: true,
      stroke: '#06101A', strokeWidth: 5, glow: '#000000', glowBlur: 0.5,
      weight: 900, uppercase: false, wordsPerLine: 3, wordsPerCue: 6, lineGap: 1.04, anim: 'pop' },
    // Clean all-white — the keyword just pops bigger with a subtle sheen + shadow
    { id: 'pro-cleanbold', name: 'Clean Bold', category: '⭐ Premium', popularity: 98, layout: 'center', keyword: true, wordHl: false, highlightScale: 1.5,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', fill2: '#CED2D8', highlight: '#FFFFFF', highlightStyle: 'color',
      glow: '#000000', glowBlur: 0.55, stroke: null, strokeWidth: 0, boxColor: null,
      weight: 900, uppercase: false, wordsPerLine: 3, wordsPerCue: 6, lineGap: 1.04, anim: 'pop' },

    // ---- Extracted from reference video #2: an EDITORIAL/anchor caption — a big
    //      bold grotesque headline line over a smaller second line (two-tier), the
    //      AUTO-DETECTED keyword set in an italic SERIF with a soft white glow, all
    //      sitting on a soft dark shadow so it reads over any footage. ----
    { id: 'pro-editorial', name: 'Editorial', category: '⭐ Premium', popularity: 100, layout: 'center', keyword: true, wordHl: false, highlightScale: 1.08,
      font: 'Helvetica', fallbackFonts: ['Arial', 'Inter', 'Montserrat'],
      fontSize: 60, fill: '#FFFFFF', fill2: '#DDE1E6',
      highlight: '#FFFFFF', highlightStyle: 'color',
      highlightFont: 'Playfair Display', highlightFallbacks: 'Georgia, "Times New Roman", serif',
      highlightItalic: true, highlightWeight: 800, highlightGlow: '#FFFFFF', highlightGlowBlur: 0.4,
      subScale: 0.62, build: true,
      glow: '#000000', glowBlur: 0.6, stroke: null, strokeWidth: 0, boxColor: null,
      weight: 700, uppercase: false, wordsPerLine: 3, wordsPerCue: 6, lineGap: 0.95, anim: 'pop' }
  ];

  /* "Buttons" pack — caption pills recreated from the user's SVG button set
     (uiverse-style). Each carries exact colours/gradients/borders/glow/3D from
     the source SVG, and every one is fully editable in the customizer
     (colours, gradient stops, border, glow, gloss, 3D depth, corner radius,
     font, animation). Box-level styling is driven by render.js's new
     boxStroke / boxGlow / box3d / boxGloss / boxShadow / boxStops props. */
  var BUTTON_TEMPLATES = [
    // Neon — glowing border + text on a near-black pill (Neon.svg #14FF8E)
    { id: 'btn-neon', name: 'Neon', category: '🔘 Buttons', popularity: 97, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Space Mono', fallbackFonts: ['JetBrains Mono', 'Roboto Mono', 'monospace'],
      fontSize: 54, fill: '#14FF8E', highlight: '#A8FFD2', highlightStyle: 'color',
      boxColor: '#0A0A0A', boxRadius: 18, boxPad: 1.2, boxStroke: '#14FF8E', boxStrokeWidth: 4,
      boxGlow: '#14FF8E', boxGlowBlur: 0.8, glow: '#14FF8E', glowBlur: 0.45,
      uppercase: false, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Spotify — solid green pill, white uppercase (Spotify.svg)
    { id: 'btn-spotify', name: 'Spotify', category: '🔘 Buttons', popularity: 95, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#1DB954', boxRadius: 120, boxPad: 1.4, letterSpacing: 3, uppercase: true, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Pop 3D — Duolingo-style extruded green button (darkened for caption contrast)
    { id: 'btn-pop3d', name: 'Pop 3D', category: '🔘 Buttons', popularity: 96, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Nunito', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 50, fill: '#FFFFFF', highlight: '#EAFFD0', highlightStyle: 'color',
      boxColor: '#3FA000', boxRadius: 120, boxPad: 1.35, box3d: '#2C7000', box3dDepth: 11,
      letterSpacing: 1, uppercase: true, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // 3D Red — red face, dark-red extruded edge, black border (3D Red.svg)
    { id: 'btn-3dred', name: '3D Red', category: '🔘 Buttons', popularity: 90, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Nunito', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 50, fill: '#7A1E1E', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#FF6666', boxRadius: 120, boxPad: 1.35, box3d: '#8B2626', box3dDepth: 11,
      boxStroke: '#000000', boxStrokeWidth: 3, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Neomorphism — soft peach pill, soft drop shadow, dark text (Neomorphism.svg)
    { id: 'btn-neo', name: 'Neo', category: '🔘 Buttons', popularity: 92, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Nunito', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 48, fill: '#6B4A33', highlight: '#3F2A1C', highlightStyle: 'color',
      boxColor: '#F2C4A3', boxColor2: '#E5A878', boxGradient: 'v', boxRadius: 120, boxPad: 1.35,
      boxShadow: 'rgba(120,95,75,0.55)', boxShadowBlur: 0.55, boxShadowDY: 9, weight: 700, wordsPerCue: 3, anim: 'scale' },
    // Aura — 8-stop pastel horizontal gradient, black border, dark text (Your Stack.svg)
    { id: 'btn-aura', name: 'Aura', category: '🔘 Buttons', popularity: 94, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 50, fill: '#111111', highlight: '#111111', highlightStyle: 'color',
      boxColor: '#F4C5C1', boxStops: [[0, '#FCF1B2'], [0.229, '#F4C5C1'], [0.406, '#EEC2EA'], [0.588, '#C0C8F9'], [0.75, '#C9F2FC'], [1, '#E7FCC5']],
      boxGradient: 'h', boxRadius: 120, boxPad: 1.35, boxStroke: '#000000', boxStrokeWidth: 4, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Candy — glossy pink pill, white script italic + top sheen (Candy Crush.svg)
    { id: 'btn-candy', name: 'Candy', category: '🔘 Buttons', popularity: 93, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Pacifico', fallbackFonts: ['Caveat', 'Inter'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#F75BA2', boxColor2: '#D73F6E', boxGradient: 'v', boxGloss: 0.9, boxRadius: 120, boxPad: 1.35,
      boxStroke: '#E0367E', boxStrokeWidth: 2, weight: 700, wordsPerCue: 2, anim: 'pop' },
    // Gold Gloss — Paypal glossy gold, navy bold italic (Paypal.svg)
    { id: 'btn-gold', name: 'Gold Gloss', category: '🔘 Buttons', popularity: 91, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 50, fill: '#1B3661', highlight: '#1B3661', highlightStyle: 'color', highlightItalic: true,
      boxColor: '#F9BC5C', boxColor2: '#F9A92A', boxGradient: 'v', boxGloss: 0.85, boxRadius: 120, boxPad: 1.35, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Glass — dark frosted pill, white text, light hairline border (glassmorphism)
    { id: 'btn-glass', name: 'Glass', category: '🔘 Buttons', popularity: 90, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 50, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#15171C', boxOpacity: 0.4, boxRadius: 120, boxPad: 1.35,
      boxStroke: '#FFFFFF', boxStrokeWidth: 2, boxGlow: '#FFFFFF', boxGlowBlur: 0.3, weight: 700, wordsPerCue: 3, anim: 'scale' },
    // Outline — transparent pill, coloured border + matching text
    { id: 'btn-outline', name: 'Outline', category: '🔘 Buttons', popularity: 89, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 50, fill: '#FFD23F', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: null, boxRadius: 120, boxPad: 1.35, boxStroke: '#FFD23F', boxStrokeWidth: 4,
      glow: '#000000', glowBlur: 0.3, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Pixel — Minecraft dirt block, pixel mono font, hard text shadow (Minecraft.svg)
    { id: 'btn-pixel', name: 'Pixel', category: '🔘 Buttons', popularity: 88, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Space Mono', fallbackFonts: ['Roboto Mono', 'Courier New', 'monospace'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#7CF03F', highlightStyle: 'color',
      boxColor: '#6B4423', boxRadius: 2, boxPad: 1.25, boxStroke: '#1C1208', boxStrokeWidth: 6,
      shadowDX: 3, shadowDY: 3, uppercase: true, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Basic Blue — solid blue gradient pill, white (Basic Blue.svg)
    { id: 'btn-blue', name: 'Basic Blue', category: '🔘 Buttons', popularity: 87, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#4363F8', boxColor2: '#2748E1', boxGradient: 'v', boxRadius: 120, boxPad: 1.35, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Paper — clean white pill, dark text, soft drop shadow (Paper / MacOS)
    { id: 'btn-paper', name: 'Paper', category: '🔘 Buttons', popularity: 86, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 48, fill: '#15171C', highlight: '#2D7CFF', highlightStyle: 'color',
      boxColor: '#FFFFFF', boxRadius: 120, boxPad: 1.35, boxShadow: 'rgba(0,0,0,0.35)', boxShadowBlur: 0.45, boxShadowDY: 7, weight: 800, wordsPerCue: 3, anim: 'scale' },
    // Twitter — solid sky-blue pill, white (Twitter.svg #1BA1F2)
    { id: 'btn-twitter', name: 'Sky', category: '🔘 Buttons', popularity: 85, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#1BA1F2', boxRadius: 120, boxPad: 1.35, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Twitch — purple rounded button, white (Twitch.svg #9147FF)
    { id: 'btn-twitch', name: 'Purple', category: '🔘 Buttons', popularity: 84, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: '#E9DDFF', highlightStyle: 'color',
      boxColor: '#9147FF', boxRadius: 16, boxPad: 1.3, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Windows Classic — grey 3D bevelled button, dark text (Windows Classic.svg)
    { id: 'btn-win', name: 'Retro Win', category: '🔘 Buttons', popularity: 83, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Inter', fallbackFonts: ['Tahoma', 'Arial'],
      fontSize: 46, fill: '#111111', highlight: '#0A0AC8', highlightStyle: 'color',
      boxColor: '#C8C8C8', boxRadius: 3, boxPad: 1.25, box3d: '#707070', box3dDepth: 6,
      boxStroke: '#1A1A1A', boxStrokeWidth: 2, boxGloss: 0.35, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Bios — retro terminal: deep-blue box, mono text (Bios.svg #0300E4)
    { id: 'btn-bios', name: 'BIOS', category: '🔘 Buttons', popularity: 82, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Space Mono', fallbackFonts: ['JetBrains Mono', 'Courier New', 'monospace'],
      fontSize: 44, fill: '#FFFFFF', highlight: '#5BFF8A', highlightStyle: 'color',
      boxColor: '#0300E4', boxRadius: 2, boxPad: 1.25, boxStroke: '#6A78FF', boxStrokeWidth: 2, uppercase: true, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Figma — blue rounded-rect chip, white (Figma.svg #18A0FB)
    { id: 'btn-figma', name: 'Chip', category: '🔘 Buttons', popularity: 84, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#18A0FB', boxRadius: 16, boxPad: 1.3, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // De Stijl — Mondrian: white card, thick black border, red active word (De Stijl.svg)
    { id: 'btn-destijl', name: 'De Stijl', category: '🔘 Buttons', popularity: 83, layout: 'center', keyword: false, highlightScale: 1.08,
      font: 'Archivo Black', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 46, fill: '#111111', highlight: '#E64043', highlightStyle: 'color',
      boxColor: '#F1F1F1', boxRadius: 2, boxPad: 1.3, boxStroke: '#000000', boxStrokeWidth: 7, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Google — dark grey rounded button, white (Google.svg #3D4043)
    { id: 'btn-google', name: 'Slate', category: '🔘 Buttons', popularity: 85, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Inter', fallbackFonts: ['Roboto', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#8AB4F8', highlightStyle: 'color',
      boxColor: '#3D4043', boxRadius: 26, boxPad: 1.3, weight: 600, wordsPerCue: 3, anim: 'scale' }
  ];
  // A button is ONE pill on ONE line — force single-line (the renderer shrinks the
  // font to fit) so the caption never wraps into two stacked pills.
  BUTTON_TEMPLATES.forEach(function (bt) {
    if (bt.maxLines == null) bt.maxLines = 1;
    if (bt.maxWidthPct == null) bt.maxWidthPct = 0.9;
  });

  var TEMPLATES = STYLE_PRESETS.concat(PREMIUM_TEMPLATES, MORE_TEMPLATES, NEW_TEMPLATES, BUTTON_TEMPLATES);
  // Retire near-duplicate styles that differed from a kept one only by colour or
  // size (both editable in the customizer) — keeps the gallery curated & distinct.
  var _RETIRED = { evo: 1, cleanwhite: 1, byline: 1, 'pro-neon': 1, rebel: 1, boldyellow: 1,
    grind: 1, 'v1-podcast': 1, paper: 1, tvnews: 1, 'v1-finance': 1, 'pro-copernicus': 1,
    'v1-hormozi26': 1, 'v1-reels': 1, 'pro-velocity': 1, 'pro-quint': 1, magazine: 1,
    lumen: 1, bloom: 1, sonnet: 1 };
  TEMPLATES = TEMPLATES.filter(function (t) { return !_RETIRED[t.id]; });

  /* Niche → recommended template id (the "AI Caption Styling" suggester). */
  var NICHE_RECOMMEND = {
    Podcast: 'lift', Business: 'stack', Finance: 'minimal', Education: 'mars',
    Fitness: 'impact', Motivation: 'hormozi', Gaming: 'neon', Tech: 'align', Vlog: 'karaoke'
  };
  var NICHES = ['Podcast', 'Business', 'Finance', 'Education', 'Fitness', 'Motivation', 'Gaming', 'Tech', 'Vlog'];

  /* Curated font list for the customizer. First fallback keeps it readable
     if the chosen face is not installed on the editing machine. */
  var FONTS = [
    // Bold / display — the caption workhorses
    'Anton', 'Bebas Neue', 'Archivo Black', 'Oswald', 'Teko', 'Fjalla One',
    'Bangers', 'Luckiest Guy', 'Passion One', 'Alfa Slab One', 'Bungee', 'Titan One',
    'Impact', 'Arial Black',
    // Sans
    'Montserrat', 'Poppins', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Raleway',
    'Work Sans', 'Nunito', 'Rubik', 'DM Sans', 'Outfit', 'Sora', 'Barlow', 'Manrope',
    'Helvetica', 'Verdana', 'Tahoma', 'Futura',
    // Serif
    'Playfair Display', 'Merriweather', 'Lora', 'Georgia', 'Times New Roman',
    // Mono
    'JetBrains Mono', 'Roboto Mono', 'Space Mono', 'Courier New',
    // Handwriting / marker
    'Caveat', 'Permanent Marker', 'Shadows Into Light', 'Pacifico', 'Bradley Hand', 'Comic Sans MS'
  ];

  /*
   * Merge a base preset with explicit user overrides into a flat style
   * object (absolute 1080p sizes — the renderer scales later). Empty/null
   * overrides fall back to the preset. Pure + tested.
   */
  function mergeStyle(preset, o) {
    o = o || {};
    function has(k) { return o[k] !== undefined && o[k] !== null && o[k] !== ''; }
    return {
      font: has('font') ? o.font : preset.font,
      fallbackFonts: preset.fallbackFonts || [],
      fontSize: has('fontSize') ? o.fontSize : preset.fontSize,
      fill: has('fill') ? o.fill : preset.fill,
      highlight: has('highlight') ? o.highlight : (preset.highlight || '#FFD400'),
      stroke: (o.stroke !== undefined) ? o.stroke : (preset.stroke || null),
      strokeWidth: (o.strokeWidth != null) ? o.strokeWidth : (preset.strokeWidth || 0),
      boxColor: (o.boxColor !== undefined) ? o.boxColor : (preset.boxColor || null),
      boxRadius: (o.boxRadius != null) ? o.boxRadius : (preset.boxRadius || 10),
      glow: (o.glow !== undefined) ? o.glow : (preset.glow || null),
      letterSpacing: (o.letterSpacing != null) ? o.letterSpacing : (preset.letterSpacing || 0),
      highlightScale: (o.highlightScale != null) ? o.highlightScale : (preset.highlightScale || 1),
      highlightStyle: o.highlightStyle || preset.highlightStyle || 'color',
      uppercase: (o.uppercase != null) ? o.uppercase : !!preset.uppercase,
      yPct: (o.yPct != null) ? o.yPct : 0.76
    };
  }

  /*
   * Built-in animation catalog (Pulse's own engine — no MOGRTs needed).
   * 'keyframed' anims are realized as Premiere Motion/Opacity keyframes on
   * rendered caption images; 'framed' anims are realized as a sequence of
   * rendered frames (the swap is the animation).
   */
  var ANIMATIONS = [
    { id: 'pop',        name: 'Pop',        kind: 'keyframed', demo: 'anim-pop',    description: 'Word scales in with a punchy overshoot' },
    { id: 'scale',      name: 'Scale',      kind: 'keyframed', demo: 'anim-scale',  description: 'Smooth grow-in, no overshoot' },
    { id: 'zoom',       name: 'Zoom',       kind: 'keyframed', demo: 'anim-zoom',   description: 'Zooms in from oversized to settle' },
    { id: 'bounce',     name: 'Bounce',     kind: 'keyframed', demo: 'anim-bounce', description: 'Drops in and settles with a bounce' },
    { id: 'slide',      name: 'Slide up',   kind: 'keyframed', demo: 'anim-slide',  description: 'Rises from below while fading in' },
    { id: 'wave',       name: 'Wave',       kind: 'keyframed', demo: 'anim-wave',   description: 'Gentle vertical wave on entry' },
    { id: 'shake',      name: 'Shake',      kind: 'keyframed', demo: 'anim-shake',  description: 'Quick attention-grabbing shake' },
    { id: 'fade',       name: 'Fade',       kind: 'keyframed', demo: 'anim-fade',   description: 'Soft opacity fade-in' },
    { id: 'glitch',     name: 'Glitch',     kind: 'keyframed', demo: 'anim-glitch', description: 'Two-frame jitter + flicker on entry' },
    { id: 'whoosh',     name: 'Whoosh',     kind: 'keyframed', demo: 'anim-whoosh', description: 'FilmImpact-style push: flies in fast with blur + overshoot' },
    { id: 'zoompunch',  name: 'Zoom Punch', kind: 'keyframed', demo: 'anim-zoompunch', description: 'FilmImpact-style zoom blur: punches in from oversized' },
    { id: 'blurdissolve', name: 'Blur Dissolve', kind: 'keyframed', demo: 'anim-blurdissolve', description: 'FilmImpact-style soft blur dissolve in' },
    { id: 'glide',      name: 'Glide',      kind: 'keyframed', demo: 'anim-glide',  description: 'FilmImpact-style smooth rise with motion blur' },
    { id: 'reveal',     name: 'Word reveal', kind: 'framed',   demo: 'anim-type',   description: 'Words appear one at a time as spoken, the newest pops in' },
    { id: 'karaoke',    name: 'Karaoke',    kind: 'framed',    demo: 'anim-sweep',  description: 'Phrase stays up, spoken word lights up' },
    { id: 'typewriter', name: 'Typewriter', kind: 'framed',    demo: 'anim-type',   description: 'Words accumulate as they are spoken' },
    { id: 'none',       name: 'None',       kind: 'keyframed', demo: '',            description: 'Hard cut, no motion' }
  ];

  function getAnimation(id) {
    for (var i = 0; i < ANIMATIONS.length; i++) if (ANIMATIONS[i].id === id) return ANIMATIONS[i];
    return ANIMATIONS[0];
  }

  /* Map preset.anim concept names onto engine animation ids. */
  var PRESET_ANIM_MAP = {
    'pop-scale': 'pop', 'color-sweep': 'karaoke', 'box-snap': 'karaoke',
    'fade': 'fade', 'glitch-in': 'glitch', 'typewriter': 'typewriter'
  };

  /*
   * Karaoke planning: phrase stays on screen, the active word is rendered
   * highlighted. One frame per spoken word.
   * Returns [{start, end, words:[...], active}] — render highlights words[active].
   */
  function planKaraoke(cues, wordsPerPhrase, accumulate) {
    var k = Math.max(2, wordsPerPhrase || 3);
    var frames = [];
    for (var c = 0; c < cues.length; c++) {
      var words = explodeWords([cues[c]], { wordsPerCue: 1 });
      for (var p = 0; p < words.length; p += k) {
        var phrase = words.slice(p, p + k);
        var texts = [];
        for (var i = 0; i < phrase.length; i++) texts.push(phrase[i].text);
        for (i = 0; i < phrase.length; i++) {
          // accumulate = 'reveal' (phrase grows); otherwise full phrase + sweep
          var shown = accumulate ? texts.slice(0, i + 1) : texts;
          frames.push({ start: phrase[i].start, end: phrase[i].end, words: shown, active: i });
        }
      }
    }
    return frames;
  }

  /*
   * Typewriter planning: words accumulate within each cue.
   * Returns [{start, end, text}] with growing text.
   */
  function planTypewriter(cues) {
    var frames = [];
    for (var c = 0; c < cues.length; c++) {
      var words = explodeWords([cues[c]], { wordsPerCue: 1 });
      var acc = [];
      for (var i = 0; i < words.length; i++) {
        acc.push(words[i].text);
        frames.push({ start: words[i].start, end: words[i].end, text: acc.join(' ') });
      }
    }
    return frames;
  }

  function getPreset(id) {
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === id) return TEMPLATES[i];
    }
    return null;
  }

  /* Resolve a template's `anim` (which may be a concept name like
     'pop-scale' or a direct engine id like 'zoom') to a real animation id. */
  function animIdForConcept(concept) {
    if (PRESET_ANIM_MAP[concept]) return PRESET_ANIM_MAP[concept];
    if (getAnimation(concept).id === concept) return concept;
    return 'pop';
  }

  // ----------------------------------------------- keyword highlight engine --
  var CTA_WORDS = {
    subscribe: 1, follow: 1, like: 1, share: 1, comment: 1, now: 1, free: 1,
    today: 1, new: 1, watch: 1, click: 1, save: 1, join: 1, download: 1,
    limited: 1, secret: 1, proven: 1, instantly: 1, guaranteed: 1, never: 1,
    best: 1, viral: 1, money: 1, growth: 1, results: 1, win: 1, stop: 1, start: 1
  };
  var STOP_WORDS = {
    the: 1, a: 1, an: 1, and: 1, or: 1, but: 1, of: 1, to: 1, in: 1, on: 1,
    for: 1, is: 1, are: 1, was: 1, it: 1, this: 1, that: 1, with: 1, as: 1,
    at: 1, by: 1, be: 1, you: 1, your: 1, i: 1, we: 1, they: 1, he: 1, she: 1,
    my: 1, me: 1, so: 1, if: 1, do: 1, not: 1, can: 1, will: 1, just: 1
  };

  function _clean(w) { return String(w).replace(/[^A-Za-z0-9$%']/g, ''); }

  // ---- v1.0: viral-word emphasis + emoji enrichment -----------------------
  /* Words that should ALWAYS pop (highlighted + scaled up) — the ones that make
     short-form hooks land. Used by markKeywords and the renderer's wordScale. */
  var VIRAL_WORDS = {
    secret: 1, biggest: 1, mistake: 1, profit: 1, loss: 1, million: 1, billion: 1,
    trillion: 1, crore: 1, lakh: 1, warning: 1, never: 1, always: 1, money: 1,
    free: 1, ai: 1, stocks: 1, growth: 1, rich: 1, viral: 1, proven: 1, huge: 1,
    instantly: 1, guaranteed: 1, results: 1, win: 1, stop: 1, now: 1
  };
  /* Optional auto-emoji after a keyword (opt-in, "✨ Auto-emoji"). */
  var EMOJI_MAP = {
    money: '💰', cash: '💰', profit: '📈', growth: '📈', loss: '📉', stock: '📊',
    stocks: '📊', secret: '🤫', warning: '⚠️', ai: '🤖', success: '🚀', rich: '🤑',
    idea: '💡', time: '⏰', fire: '🔥', love: '❤️', win: '🏆', million: '💸',
    crore: '💸', target: '🎯', up: '⬆️', down: '⬇️', best: '⭐'
  };
  /* Append an emoji after each word that has one (opt-in). Pure + tested. */
  function enrichCaptionText(text) {
    return String(text == null ? '' : text).replace(/[A-Za-z]+/g, function (m) {
      var e = EMOJI_MAP[m.toLowerCase()];
      return e ? m + ' ' + e : m;
    });
  }

  /*
   * Decide which words in a list to highlight.
   * opts.mode: 'smart' (numbers + CTAs + capitalized names + the longest
   * content word), 'numbers', 'cta', 'names', 'keywords' (longest words),
   * 'all'. Returns a boolean[] aligned to `words`. Pure + tested.
   */
  function markKeywords(words, opts) {
    opts = opts || {};
    var mode = opts.mode || 'smart';
    var flags = [];
    var i, w, clean, lc;
    for (i = 0; i < words.length; i++) flags.push(false);
    if (mode === 'all') { for (i = 0; i < words.length; i++) flags[i] = true; return flags; }
    // 'auto' (TF-IDF): highlight words present in a transcript-wide salient set
    // precomputed by CPTranscript.topKeywordSet and passed as opts.set.
    if (mode === 'auto') {
      var set = opts.set || {};
      for (i = 0; i < words.length; i++) {
        var key = String(words[i]).toLowerCase().replace(/[^a-z0-9']/g, '');
        flags[i] = !!set[key] || !!VIRAL_WORDS[key];   // v1.0: viral words always pop
      }
      return flags;
    }

    var set = opts.set || null;
    var bestIdx = -1, bestScore = 0;
    for (i = 0; i < words.length; i++) {
      w = words[i]; clean = _clean(w); lc = clean.toLowerCase();
      var hasNum = /\d/.test(w);
      var isCta = !!CTA_WORDS[lc];
      var isName = /^[A-Z][a-z]{2,}$/.test(clean) && i > 0;   // capitalised mid-sentence ≈ proper noun

      if (mode === 'numbers') { if (hasNum) flags[i] = true; continue; }
      if (mode === 'cta') { if (isCta) flags[i] = true; continue; }
      if (mode === 'names') { if (isName) flags[i] = true; continue; }

      // 'keywords' / 'smart': score each word for salience and pick the BEST one
      // (not merely the longest), so the highlight lands on a meaningful word.
      var sc = wordSalienceScore(w, i, set);
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    }
    if ((mode === 'keywords' || mode === 'smart') && bestIdx >= 0) flags[bestIdx] = true;
    // 'smart' also always pops numbers/money and viral power-words (they're worth
    // highlighting even when they aren't the single most salient word).
    if (mode === 'smart') {
      for (i = 0; i < words.length; i++) {
        var c2 = _clean(words[i]).toLowerCase();
        if (/\d/.test(words[i]) || VIRAL_WORDS[c2]) flags[i] = true;
      }
    }
    return flags;
  }

  /* Filler / low-value words that should never be picked as the keyword. */
  var FILLER_WORDS = {
    um: 1, uh: 1, er: 1, ah: 1, hmm: 1, like: 1, well: 1, okay: 1, ok: 1, yeah: 1,
    yep: 1, kinda: 1, sorta: 1, basically: 1, literally: 1, actually: 1, really: 1,
    just: 1, very: 1, stuff: 1, things: 1, thing: 1, gonna: 1, wanna: 1, gotta: 1,
    today: 1, also: 1, then: 1, there: 1, here: 1, this: 1, that: 1, these: 1, those: 1
  };
  /*
   * Salience score for a single word (0 = never a keyword). Favours nouns/proper
   * nouns, numbers/money, named CTAs/power-words and TF-IDF-salient words; longer
   * content words rank higher; stop/filler words score 0. Pure + tested.
   */
  function wordSalienceScore(w, i, set) {
    var clean = _clean(w), lc = clean.toLowerCase();
    if (!clean) return 0;
    var hasNum = /\d/.test(w);
    if (!hasNum && (clean.length < 3 || STOP_WORDS[lc] || FILLER_WORDS[lc])) return 0;
    var s = 1;
    s += Math.min(4, Math.max(0, clean.length - 3) * 0.5);     // length (capped)
    if (hasNum) s += 3.5;                                       // 2026, $4, 50%, 10x
    if (/^[A-Z][a-z]{2,}/.test(clean) && i > 0) s += 2.5;       // proper noun
    if (CTA_WORDS[lc]) s += 2;
    if (VIRAL_WORDS[lc]) s += 2.5;
    if (set && set[lc]) s += 3;                                 // salient across the whole transcript
    return s;
  }

  /*
   * Split a leading "Name:" speaker prefix off a cue.
   * "Sarah: let's begin" -> { speaker:'Sarah', text:"let's begin" }.
   * Only fires for a short (<=3 word) name followed by a colon + space, so
   * normal sentences with colons are left alone. Pure + tested.
   */
  function extractSpeaker(text) {
    var m = /^\s*([A-Za-z][\w .'\-]{0,24}?)\s*[:：]\s+(.+)$/.exec(text || '');
    if (m && m[2] && m[1].trim().split(/\s+/).length <= 3) {
      return { speaker: m[1].trim(), text: m[2] };
    }
    return { speaker: null, text: text };
  }

  /*
   * Detect speech-energy onsets within [startT, endT] of a dB envelope
   * (samples: [{t, db}]). An onset is where the level rises above an adaptive
   * threshold after being below it. Returns onset times. Pure + tested.
   */
  function detectOnsets(samples, startT, endT, opts) {
    opts = opts || {};
    var win = [];
    for (var i = 0; i < samples.length; i++) {
      if (samples[i].t >= startT - 1e-6 && samples[i].t <= endT + 1e-6) win.push(samples[i]);
    }
    if (win.length < 2) return [];
    var sorted = win.map(function (s) { return s.db; }).sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(sorted.length * 0.3)];
    var thr = floor + (opts.rise != null ? opts.rise : 6);
    var minSpacing = opts.minSpacing != null ? opts.minSpacing : 0.12;
    var onsets = [], prevAbove = false, last = -1e9;
    for (i = 0; i < win.length; i++) {
      var above = win[i].db >= thr;
      if (above && !prevAbove && (win[i].t - last) >= minSpacing) { onsets.push(win[i].t); last = win[i].t; }
      prevAbove = above;
    }
    return onsets;
  }

  /*
   * Time a phrase's words across [start, end]: start with length-weighted
   * boundaries, then SNAP each interior word boundary to the nearest speech
   * onset (if one is close). This pulls word timing onto the real speech.
   * Returns [{start, end, text}] per word. Pure + tested.
   */
  function alignPhrase(words, start, end, onsets, snapWin) {
    var n = words.length;
    if (n <= 1) return [{ start: start, end: end, text: words[0] || '' }];
    snapWin = snapWin != null ? snapWin : 0.18;
    var weights = [], total = 0, i;
    for (i = 0; i < n; i++) { var wt = Math.max(2, words[i].replace(/\s/g, '').length); weights.push(wt); total += wt; }
    var bounds = [start], t = start;
    for (i = 0; i < n - 1; i++) { t += (end - start) * weights[i] / total; bounds.push(t); }
    bounds.push(end);
    // snap interior boundaries to nearest onset
    for (i = 1; i < n; i++) {
      var b = bounds[i], best = null, bd = snapWin;
      for (var o = 0; o < onsets.length; o++) {
        var d = Math.abs(onsets[o] - b);
        if (d < bd) { bd = d; best = onsets[o]; }
      }
      if (best != null) bounds[i] = best;
    }
    for (i = 1; i < bounds.length; i++) if (bounds[i] < bounds[i - 1]) bounds[i] = bounds[i - 1];
    var out = [];
    for (i = 0; i < n; i++) out.push({ start: bounds[i], end: bounds[i + 1], text: words[i] });
    return out;
  }

  /*
   * Re-time every cue's words to the audio envelope. inPoint is the audio
   * clip's sync offset (sequence time + inPoint = media time). Returns a flat
   * list of word-level cues [{start, end, text}]. Pure + tested.
   */
  function alignCuesToAudio(cues, samples, inPoint, opts) {
    inPoint = inPoint || 0;
    var out = [];
    for (var c = 0; c < cues.length; c++) {
      var words = cues[c].text.replace(/\s+/g, ' ').trim().split(' ');
      if (words.length <= 1) { out.push({ start: cues[c].start, end: cues[c].end, text: words[0] || '' }); continue; }
      var onsetsMedia = detectOnsets(samples, cues[c].start + inPoint, cues[c].end + inPoint, opts);
      var onsetsSeq = onsetsMedia.map(function (o) { return o - inPoint; });
      var aligned = alignPhrase(words, cues[c].start, cues[c].end, onsetsSeq, opts && opts.snapWin);
      for (var k = 0; k < aligned.length; k++) out.push(aligned[k]);
    }
    return out;
  }

  /* Clean a word-cue list so EVERY word survives placement and the highlight
     can't skip one. Drops empties, sorts by start, and forces strictly
     increasing starts spaced by at least minWin (≈1-2 video frames) with a
     minimum on-screen window. Without this, two cues at the same/!ascending
     time make Premiere's overwriteClip stomp the earlier word — so it never
     lights up — and rapid sub-frame words vanish. Pure + tested. */
  function sanitizeWordCues(cues, minWin) {
    minWin = minWin || 0.06;
    var s = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (!c || c.text == null || !String(c.text).length) continue;
      s.push({ start: +c.start || 0, end: +c.end || 0, text: c.text });
    }
    s.sort(function (a, b) { return a.start - b.start; });
    for (i = 0; i < s.length; i++) {
      if (i > 0 && s[i].start < s[i - 1].start + minWin) s[i].start = s[i - 1].start + minWin;
      if (s[i].end < s[i].start + minWin) s[i].end = s[i].start + minWin;
    }
    return s;
  }

  /* Build frames from pre-timed word cues (used when audio alignment is on).
     Groups words per the chosen rhythm; karaoke highlights the active word. */
  function framesFromWordCues(wordCues, anim, wordsPerCue, kw, up) {
    function ucw(arr) { return up ? arr.map(uc) : arr; }
    var swept = (anim === 'karaoke' || anim === 'reveal');
    var per = swept ? Math.max(2, wordsPerCue || 3) : Math.max(1, wordsPerCue || 1);
    var frames = [], i, j;
    for (i = 0; i < wordCues.length; i += per) {
      var group = wordCues.slice(i, i + per);
      var words = ucw(group.map(function (g) { return g.text; }));
      if (swept) {
        for (j = 0; j < group.length; j++) {
          // 'reveal' GROWS the phrase one word at a time (newest = active, so it
          // pops); 'karaoke' shows the whole phrase and sweeps the active word.
          // Only the ACTIVE (spoken) word is highlighted here — no keyword boxes,
          // so it reads as ONE clean highlight riding the voice, not several
          // words lit at once.
          var shown = (anim === 'reveal') ? words.slice(0, j + 1) : words;
          // Hold each word until the NEXT word starts (within the phrase) so the
          // caption stays on screen continuously and the highlight advances
          // exactly on the word boundary — no flicker/gap between words, no drift.
          var fend = (j + 1 < group.length) ? group[j + 1].start : group[j].end;
          frames.push({ start: group[j].start, end: fend, words: shown, active: j });
        }
      } else {
        var fr = { start: group[0].start, end: group[group.length - 1].end, words: words };
        if (kw && kw.on) fr.highlightSet = markKeywords(words, kw);
        frames.push(fr);
      }
    }
    return frames;
  }

  /* Windowed/diagonal frames: each frame is [prevWord, spokenWord, nextWord] with
     the SPOKEN word active (centre) — used by the dynamic diagonal styles so the
     highlighted word is always the middle line. */
  function framesWindowed(wordCues, up) {
    var frames = [];
    for (var i = 0; i < wordCues.length; i++) {
      var words = [], active;
      if (i > 0) words.push(wordCues[i - 1].text);
      active = words.length;
      words.push(wordCues[i].text);
      if (i < wordCues.length - 1) words.push(wordCues[i + 1].text);
      if (up) words = words.map(uc);
      // hold until the next word starts so the window never blanks between words
      var wend = (i + 1 < wordCues.length) ? wordCues[i + 1].start : wordCues[i].end;
      frames.push({ start: wordCues[i].start, end: wend, words: words, active: active });
    }
    return frames;
  }
  /* Keyword-build frames: the phrase GROWS one word at a time (like reveal), but
     instead of lighting the newest word, the AUTO-DETECTED keyword stays
     emphasised (italic-serif/colour) the whole time. Used by the Editorial style
     so the caption animates in word-by-word while the keyword reads cleanly.
     Timing is contiguous so each new word lands exactly on the spoken word. */
  function framesKeywordBuild(wordCues, per, kw, up) {
    function ucw(arr) { return up ? arr.map(uc) : arr; }
    per = Math.max(2, per || 6);
    var frames = [], i = 0;
    while (i < wordCues.length) {
      // accumulate up to `per` words, but END EARLY at sentence punctuation so a
      // caption never resets mid-sentence (the old fixed-N grouping did, which
      // looked like the phrase randomly restarting).
      var group = [];
      while (group.length < per && i < wordCues.length) {
        group.push(wordCues[i]); i++;
        if (/[.!?]["')\]]?$/.test(group[group.length - 1].text)) break;
      }
      var words = ucw(group.map(function (g) { return g.text; }));
      // pick the keyword once on the WHOLE phrase so it's stable as words appear
      var flags = (kw && kw.on) ? markKeywords(words, kw) : null;
      for (var j = 0; j < group.length; j++) {
        var fend = (j + 1 < group.length) ? group[j + 1].start : group[j].end;
        // words = the FULL phrase every frame (stable layout); `reveal` grows so
        // each word appears in its final spot — no recentering, no re-pop.
        var fr = { start: group[j].start, end: fend, words: words, reveal: j + 1 };
        if (flags) fr.highlightSet = flags;
        frames.push(fr);
      }
    }
    return frames;
  }

  /* Split line-cues into per-word cues with even timing (when no real word timing
     is available) so windowed/diagonal styles still work. */
  function flattenWords(cues) {
    var out = [];
    for (var c = 0; c < cues.length; c++) {
      var ws = String(cues[c].text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      var n = Math.max(1, ws.length), dur = ((cues[c].end - cues[c].start) || n * 0.4) / n;
      for (var k = 0; k < ws.length; k++) out.push({ start: cues[c].start + k * dur, end: cues[c].start + (k + 1) * dur, text: ws[k] });
    }
    return out;
  }

  /*
   * Single entry point that turns cues into render-ready frames for any
   * animation, applying words-per-cue, casing, and keyword highlighting.
   * opts: { anim, wordsPerCue, uppercase, keyword:{on,mode}, window }
   * Frame shapes:
   *   keyframed/word/line -> { start, end, words:[...], highlightSet:[bool] }
   *   karaoke             -> { start, end, words:[...], active, highlightSet }
   *   typewriter          -> { start, end, text }
   * Pure + tested.
   */
  function buildCaptionFrames(cues, opts) {
    opts = opts || {};
    var anim = opts.anim || 'pop';
    var wpc = opts.wordsPerCue || 0;
    var up = !!opts.uppercase;
    var kw = opts.keyword || {};
    var spk = opts.speaker || {};
    var i, f, frames;

    // Pull "Name:" speaker prefixes off the cues so they don't pollute the
    // caption words; remember them by time for a post-pass.
    var speakers = null;
    if (spk.on) {
      speakers = [];
      cues = cues.map(function (c) {
        var s = extractSpeaker(c.text);
        speakers.push({ start: c.start, end: c.end, speaker: s.speaker });
        return { start: c.start, end: c.end, text: s.text };
      });
    }

    // v1.0: opt-in auto-emoji on keywords (💰 📈 🤖 …), before words are split.
    if (opts.emoji) cues = cues.map(function (c) { return { start: c.start, end: c.end, text: enrichCaptionText(c.text) }; });

    // Clean the per-word timing once so no word can be dropped/overwritten and
    // the highlight never skips a word (see sanitizeWordCues).
    var wordCues = (opts.wordCues && opts.wordCues.length) ? sanitizeWordCues(opts.wordCues) : null;

    if (opts.build) {
      // keyword-emphasis styles that animate in word-by-word (Editorial)
      frames = framesKeywordBuild(wordCues || flattenWords(cues), wpc || 6, kw, up);
    } else if (anim === 'karaoke' || anim === 'reveal') {
      if (opts.window) {
        frames = framesWindowed(wordCues || flattenWords(cues), up);
      } else if (wordCues) {
        frames = framesFromWordCues(wordCues, anim, wpc, kw, up);
      } else {
        frames = planKaraoke(cues, Math.max(2, wpc || 3), anim === 'reveal');
        for (i = 0; i < frames.length; i++) {
          f = frames[i];
          if (up) f.words = f.words.map(uc);
          // word-following styles highlight ONLY the active word (no keyword boxes)
        }
      }
    } else if (anim === 'typewriter') {
      frames = planTypewriter(cues);
      if (up) for (i = 0; i < frames.length; i++) frames[i].text = frames[i].text.toUpperCase();
    } else if (wordCues && wpc > 0) {
      // audio-aligned word/phrase frames (tight sync)
      frames = framesFromWordCues(wordCues, anim, wpc, kw, up);
    } else {
      var src = (wpc > 0)
        ? regroupWords(cues, wpc, { uppercase: up })   // merge across lines -> N-word captions
        : cues.map(function (c) { return { start: c.start, end: c.end, text: up ? c.text.toUpperCase() : c.text }; });
      frames = src.map(function (c) {
        var words = c.text.replace(/\s+/g, ' ').trim().split(' ');
        if (up) words = words.map(uc);
        var frame = { start: c.start, end: c.end, words: words };
        if (kw.on) frame.highlightSet = markKeywords(words, kw);
        return frame;
      });
    }

    // Attach the speaker label to every frame that falls inside its cue.
    if (speakers) {
      for (i = 0; i < frames.length; i++) {
        for (var s = 0; s < speakers.length; s++) {
          // start-inclusive, end-exclusive so a frame on a cue boundary
          // belongs to the cue that is starting, not the one that ended
          if (frames[i].start >= speakers[s].start - 1e-3 && frames[i].start < speakers[s].end - 1e-3) {
            if (speakers[s].speaker) frames[i].speaker = speakers[s].speaker;
            break;
          }
        }
      }
    }
    // Clean, modern look: drop surrounding punctuation from the displayed words
    // (the transcript/SRT keep theirs — this only affects what's drawn).
    if (opts.stripPunctuation) {
      for (i = 0; i < frames.length; i++) {
        if (frames[i].words) {
          frames[i].words = frames[i].words.map(stripWordPunct);
        }
        if (frames[i].text != null) {
          frames[i].text = frames[i].text.split(/\s+/).map(stripWordPunct).join(' ').replace(/\s+/g, ' ').trim();
        }
      }
    }

    // Display case (Title / Sentence / lower). 'upper' is handled by the planners
    // via opts.uppercase; 'original' leaves the words as transcribed.
    var tc = opts.textCase;
    if (tc && tc !== 'original' && tc !== 'upper') {
      for (i = 0; i < frames.length; i++) {
        if (frames[i].words) frames[i].words = caseWords(frames[i].words, tc);
        if (frames[i].text != null) frames[i].text = caseWords(frames[i].text.split(/\s+/), tc).join(' ');
      }
    }

    // Profanity censor (s***, f***) — preserves length so timing is unaffected.
    if (opts.censor) {
      for (i = 0; i < frames.length; i++) {
        if (frames[i].words) frames[i].words = frames[i].words.map(censorWord);
        if (frames[i].text != null) frames[i].text = frames[i].text.split(/\s+/).map(censorWord).join(' ');
      }
    }

    // Keep captions on screen through the natural pauses between words/phrases:
    // word-sync places one short clip per word, so without this the caption
    // blinks off during every breath/pause ("missing in some parts"). Each frame
    // is held until the next one starts, capped so a long silence doesn't keep a
    // stale caption up. Never creates overlaps (end is clamped to the next start).
    fillFrameGaps(frames, 2);
    return frames;
  }

  /* Hold each frame until the next one begins so brief pauses don't blink the
     caption off; cap the hold (maxLinger seconds) so a long silence still clears
     it. Frames must be in start order. Pure + tested. */
  function fillFrameGaps(frames, maxLinger) {
    if (!frames || frames.length < 2) return frames;
    var cap = (maxLinger == null) ? 2 : maxLinger;
    for (var i = 0; i < frames.length - 1; i++) {
      var nextStart = frames[i + 1].start;
      if (nextStart > frames[i].end) {
        frames[i].end = Math.min(nextStart, frames[i].end + cap);
      }
    }
    return frames;
  }

  /* Gaps (>= threshold seconds) between consecutive cues — used to find stretches
     where the speech engine produced nothing (a "no-speech misfire"), so we can
     re-check just those spans. Returns [{from,to}] in the cues' own time base. */
  function findCueGaps(cues, threshold) {
    var gaps = [];
    if (!cues || cues.length < 2) return gaps;
    var s = cues.slice().sort(function (a, b) { return a.start - b.start; });
    for (var i = 0; i < s.length - 1; i++) {
      var d = (s[i + 1].start || 0) - (s[i].end || 0);
      if (d >= threshold) gaps.push({ from: s[i].end, to: s[i + 1].start });
    }
    return gaps;
  }

  /* True for transcript text that is almost certainly NOT real speech — the
     bracketed markers and stock hallucinations whisper emits over silence/music.
     Lets a gap re-check drop junk instead of captioning "[BLANK_AUDIO]". */
  function isLikelyNonSpeech(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return true;
    if (/^[\[(].*[\])]$/.test(t)) return true;                                  // [BLANK_AUDIO], (music), [silence]
    if (t.replace(/[^A-Za-z0-9ऀ-ॿ]/g, '').length <= 1) return true;   // punctuation / single char
    if (/^(thanks for watching|thank you|please subscribe|subscribe|bye|you|okay|ok|so|the|♪+|music)\.?$/i.test(t)) return true;
    return false;
  }

  return {
    srtTimeToSeconds: srtTimeToSeconds,
    secondsToSrtTime: secondsToSrtTime,
    parseSRT: parseSRT,
    toSRT: toSRT,
    findCueGaps: findCueGaps,
    fillFrameGaps: fillFrameGaps,
    isLikelyNonSpeech: isLikelyNonSpeech,
    VIRAL_WORDS: VIRAL_WORDS,
    EMOJI_MAP: EMOJI_MAP,
    enrichCaptionText: enrichCaptionText,
    devanagariToLatin: devanagariToLatin,
    explodeWords: explodeWords,
    framesKeywordBuild: framesKeywordBuild,
    regroupWords: regroupWords,
    remapCuesToKeeps: remapCuesToKeeps,
    STYLE_PRESETS: STYLE_PRESETS,
    TEMPLATES: TEMPLATES,
    CATEGORIES: CATEGORIES,
    NICHES: NICHES,
    NICHE_RECOMMEND: NICHE_RECOMMEND,
    getPreset: getPreset,
    animIdForConcept: animIdForConcept,
    FONTS: FONTS,
    mergeStyle: mergeStyle,
    ANIMATIONS: ANIMATIONS,
    getAnimation: getAnimation,
    PRESET_ANIM_MAP: PRESET_ANIM_MAP,
    planKaraoke: planKaraoke,
    planTypewriter: planTypewriter,
    markKeywords: markKeywords,
    wordSalienceScore: wordSalienceScore,
    extractSpeaker: extractSpeaker,
    detectOnsets: detectOnsets,
    alignPhrase: alignPhrase,
    alignCuesToAudio: alignCuesToAudio,
    sanitizeWordCues: sanitizeWordCues,
    buildCaptionFrames: buildCaptionFrames
  };
});
