/*
 * CutPilot — caption tooling.
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
   * Style presets — the catalog the panel UI shows. Each preset carries:
   *  - native:  recommended settings for Premiere's built-in caption styling
   *  - mogrt:   parameter hints applied when inserting a .mogrt per cue
   *  - anim:    the animation concept (used by MOGRT templates / docs)
   * Based on 2026 short-form trends: word-by-word karaoke, Hormozi bold,
   * highlight-box, clean minimal, neon, typewriter.
   */
  var STYLE_PRESETS = [
    {
      id: 'hormozi',
      name: 'Hormozi Bold',
      description: 'ALL-CAPS word-by-word, heavy condensed sans, thick black stroke, yellow highlight on keywords. The dominant short-form style.',
      font: 'Montserrat Black', fallbackFonts: ['Anton', 'Bebas Neue', 'Arial Black'],
      fontSize: 90, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 12,
      uppercase: true, wordsPerCue: 1, anim: 'pop-scale',
      animNotes: 'Each word scales 0%→110%→100% over ~120ms with ease-out.'
    },
    {
      id: 'karaoke',
      name: 'Karaoke Highlight',
      description: 'Full phrase visible, the spoken word lights up in a highlight color as it is said. Best retention for educational content (~+15% engagement).',
      font: 'Poppins SemiBold', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 70, fill: '#FFFFFF', highlight: '#00E676', stroke: '#000000', strokeWidth: 8,
      uppercase: false, wordsPerCue: 3, anim: 'color-sweep',
      animNotes: 'Active word fill animates white→highlight; others stay white.'
    },
    {
      id: 'highlight-box',
      name: 'Highlight Box',
      description: 'The spoken word sits on a solid rounded pill that snaps word to word (Submagic/CapCut style).',
      font: 'Inter Bold', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FF3B6B', stroke: '#000000', strokeWidth: 6,
      boxRadius: 14, highlightStyle: 'box',
      uppercase: false, wordsPerCue: 3, anim: 'box-snap',
      animNotes: 'Background box width-animates to each new word in ~80ms.'
    },
    {
      id: 'minimal',
      name: 'Clean Minimal',
      description: 'Lower-third sentence captions, soft shadow, no gimmicks. For long-form YouTube and corporate.',
      font: 'Inter Medium', fallbackFonts: ['Helvetica Neue', 'Arial'],
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
      fontSize: 54, fill: '#EAEAEA', highlight: null, stroke: null, strokeWidth: 0,
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
      font: 'Poppins SemiBold', fallbackFonts: ['Inter', 'Helvetica', 'Arial'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 5,
      uppercase: false, wordsPerCue: 2, anim: 'fade',
      animNotes: 'Gentle scale + fade.'
    },
    {
      id: 'tvnews',
      name: 'News Bar',
      description: 'White text on a translucent dark bar, lower third. Interviews and explainers.',
      font: 'Inter Medium', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#33C1FF', stroke: null, strokeWidth: 0,
      boxColor: '#000000', boxRadius: 6,
      uppercase: false, wordsPerCue: 0, anim: 'fade',
      animNotes: 'Bar slides/fades in along the lower third.'
    }
  ];

  function uc(s) { return String(s).toUpperCase(); }

  /* The ten library categories the browser groups templates into. */
  var CATEGORIES = [
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
      fontSize: 58, fill: '#F5F1E8', highlight: '#D9B36A', stroke: null, strokeWidth: 0,
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
      fontSize: 56, fill: '#F3EEE6', highlight: '#E0C189', stroke: null, strokeWidth: 0,
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
      fontSize: 44, fill: '#EDEDED', highlight: '#EDEDED', stroke: null, strokeWidth: 0,
      letterSpacing: 4, uppercase: true, wordsPerCue: 0, anim: 'fade' },
    { id: 'align', name: 'Align', category: 'Cinematic', popularity: 71, layout: 'center', keyword: false,
      font: 'JetBrains Mono', fallbackFonts: ['Courier New', 'monospace'],
      fontSize: 40, fill: '#FFFFFF', highlight: '#9AD0FF', stroke: null, strokeWidth: 0,
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
    { id: 'elevate', name: 'Elevate', category: 'Cinematic', popularity: 77, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 60, fill: '#F3ECE0', highlight: '#D9B36A', stroke: null, strokeWidth: 0,
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'sketch', name: 'Sketch', category: 'Storytelling', popularity: 74, layout: 'center', keyword: false,
      font: 'Bradley Hand', fallbackFonts: ['Comic Sans MS', 'cursive'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFE53B', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'bloom', name: 'Bloom', category: 'Storytelling', popularity: 71, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['serif'],
      fontSize: 58, fill: '#FFF3E9', highlight: '#E6A0B0', stroke: null, strokeWidth: 0,
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'linen', name: 'Linen', category: 'Minimal Professional', popularity: 73, layout: 'bottom', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#C9A36A', stroke: null, strokeWidth: 0,
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'sonnet', name: 'Sonnet', category: 'Storytelling', popularity: 67, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 48, fill: '#EFE8DF', highlight: '#CBB68B', stroke: null, strokeWidth: 0,
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' }
  ];

  /* The full catalog the library browses (base + extras). */
  var TEMPLATES = STYLE_PRESETS.concat(MORE_TEMPLATES);

  /* Niche → recommended template id (the "AI Caption Styling" suggester). */
  var NICHE_RECOMMEND = {
    Podcast: 'lift', Business: 'byline', Finance: 'minimal', Education: 'paper',
    Fitness: 'grind', Motivation: 'boldyellow', Gaming: 'neon', Tech: 'align', Vlog: 'cleanwhite'
  };
  var NICHES = ['Podcast', 'Business', 'Finance', 'Education', 'Fitness', 'Motivation', 'Gaming', 'Tech', 'Vlog'];

  /* Curated font list for the customizer. First fallback keeps it readable
     if the chosen face is not installed on the editing machine. */
  var FONTS = [
    'Montserrat', 'Anton', 'Bebas Neue', 'Poppins', 'Inter', 'Oswald',
    'Archivo Black', 'Impact', 'Arial Black', 'Roboto', 'Helvetica',
    'Futura', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma',
    'Bradley Hand', 'Comic Sans MS', 'JetBrains Mono', 'Courier New'
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
   * Built-in animation catalog (CutPilot's own engine — no MOGRTs needed).
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
  function planKaraoke(cues, wordsPerPhrase) {
    var k = Math.max(2, wordsPerPhrase || 3);
    var frames = [];
    for (var c = 0; c < cues.length; c++) {
      var words = explodeWords([cues[c]], { wordsPerCue: 1 });
      for (var p = 0; p < words.length; p += k) {
        var phrase = words.slice(p, p + k);
        var texts = [];
        for (var i = 0; i < phrase.length; i++) texts.push(phrase[i].text);
        for (i = 0; i < phrase.length; i++) {
          frames.push({ start: phrase[i].start, end: phrase[i].end, words: texts, active: i });
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

    var longestIdx = -1, longestLen = 0;
    for (i = 0; i < words.length; i++) {
      w = words[i]; clean = _clean(w); lc = clean.toLowerCase();
      var hasNum = /\d/.test(w);
      var isCta = !!CTA_WORDS[lc];
      var isName = /^[A-Z][a-z]{2,}$/.test(clean) && i > 0;
      var isContent = clean.length >= 4 && !STOP_WORDS[lc];

      if (mode === 'numbers' && hasNum) flags[i] = true;
      else if (mode === 'cta' && isCta) flags[i] = true;
      else if (mode === 'names' && isName) flags[i] = true;
      else if (mode === 'keywords' && isContent && clean.length > longestLen) { longestLen = clean.length; longestIdx = i; }
      else if (mode === 'smart') {
        if (hasNum || isCta || isName) flags[i] = true;
        else if (isContent && clean.length > longestLen) { longestLen = clean.length; longestIdx = i; }
      }
    }
    if ((mode === 'keywords' || mode === 'smart') && longestIdx >= 0) flags[longestIdx] = true;
    return flags;
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

  /* Build frames from pre-timed word cues (used when audio alignment is on).
     Groups words per the chosen rhythm; karaoke highlights the active word. */
  function framesFromWordCues(wordCues, anim, wordsPerCue, kw, up) {
    function ucw(arr) { return up ? arr.map(uc) : arr; }
    var per = (anim === 'karaoke') ? Math.max(2, wordsPerCue || 3) : Math.max(1, wordsPerCue || 1);
    var frames = [], i, j;
    for (i = 0; i < wordCues.length; i += per) {
      var group = wordCues.slice(i, i + per);
      var words = ucw(group.map(function (g) { return g.text; }));
      if (anim === 'karaoke') {
        for (j = 0; j < group.length; j++) {
          var f = { start: group[j].start, end: group[j].end, words: words, active: j };
          if (kw && kw.on) f.highlightSet = markKeywords(words, kw);
          frames.push(f);
        }
      } else {
        var fr = { start: group[0].start, end: group[group.length - 1].end, words: words };
        if (kw && kw.on) fr.highlightSet = markKeywords(words, kw);
        frames.push(fr);
      }
    }
    return frames;
  }

  /*
   * Single entry point that turns cues into render-ready frames for any
   * animation, applying words-per-cue, casing, and keyword highlighting.
   * opts: { anim, wordsPerCue, uppercase, keyword:{on,mode} }
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

    if (anim === 'karaoke') {
      if (opts.wordCues && opts.wordCues.length) {
        frames = framesFromWordCues(opts.wordCues, anim, wpc, kw, up);
      } else {
        frames = planKaraoke(cues, Math.max(2, wpc || 3));
        for (i = 0; i < frames.length; i++) {
          f = frames[i];
          if (up) f.words = f.words.map(uc);
          if (kw.on) f.highlightSet = markKeywords(f.words, kw);
        }
      }
    } else if (anim === 'typewriter') {
      frames = planTypewriter(cues);
      if (up) for (i = 0; i < frames.length; i++) frames[i].text = frames[i].text.toUpperCase();
    } else if (opts.wordCues && opts.wordCues.length && wpc > 0) {
      // audio-aligned word/phrase frames (tight sync)
      frames = framesFromWordCues(opts.wordCues, anim, wpc, kw, up);
    } else {
      var src = (wpc > 0)
        ? explodeWords(cues, { wordsPerCue: wpc, uppercase: up })
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
    return frames;
  }


  return {
    srtTimeToSeconds: srtTimeToSeconds,
    secondsToSrtTime: secondsToSrtTime,
    parseSRT: parseSRT,
    toSRT: toSRT,
    explodeWords: explodeWords,
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
    extractSpeaker: extractSpeaker,
    detectOnsets: detectOnsets,
    alignPhrase: alignPhrase,
    alignCuesToAudio: alignCuesToAudio,
    buildCaptionFrames: buildCaptionFrames
  };
});
