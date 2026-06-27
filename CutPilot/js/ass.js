/*
 * Pulse — ASS (Advanced SubStation Alpha) karaoke caption generator.
 *
 * The reliable, word-accurate animated-caption engine: turn word-timed cues into
 * ONE .ass file that ffmpeg+libass burns into the video in a single pass. Because
 * the SAME .ass can be rendered by libass-in-WASM for the on-panel preview,
 * preview == output by construction (no second rasterizer, no MOGRT/AE).
 *
 * Per-word highlight uses the "one Dialogue event per active-word state" pattern:
 * for each spoken word we emit a Dialogue spanning that word's time, showing the
 * whole caption with the active word recoloured + a quick scale "pop". This is
 * deterministic and needs no karaoke-tag quirks.
 *
 * Pure functions — unit-tested in Node, no DOM/Premiere dependency.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPAss = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function pad(n, w) { n = String(Math.floor(n)); while (n.length < w) n = '0' + n; return n; }

  /* seconds -> ASS time  H:MM:SS.cc  (centiseconds, the ASS resolution) */
  function assTime(sec) {
    if (!(sec > 0)) sec = 0;
    var cs = Math.round(sec * 100);
    var h = Math.floor(cs / 360000); cs -= h * 360000;
    var m = Math.floor(cs / 6000);   cs -= m * 6000;
    var s = Math.floor(cs / 100);    cs -= s * 100;
    return h + ':' + pad(m, 2) + ':' + pad(s, 2) + '.' + pad(cs, 2);
  }

  /* '#RRGGBB' -> ASS '&HBBGGRR&'  (ASS colour is BGR and dropped the '#'). */
  function assColor(hex) {
    hex = String(hex == null ? '#FFFFFF' : hex).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    if (hex.length < 6) hex = (hex + 'FFFFFF').slice(0, 6);
    var r = hex.substr(0, 2), g = hex.substr(2, 2), b = hex.substr(4, 2);
    return '&H' + (b + g + r).toUpperCase() + '&';
  }

  /* Make text safe inside an ASS event: neutralise braces (they delimit override
     blocks) and turn newlines into the ASS hard break. */
  function assText(t) {
    return String(t == null ? '' : t)
      .replace(/[{}]/g, function (c) { return c === '{' ? '(' : ')'; })
      .replace(/\r?\n/g, '\\N');
  }

  /* Normalise input into a list of caption events, each: {words:[{text,start,end}]}.
     Accepts either word-timed cues (cue.words) or plain {start,end,text} cues
     (treated as a single "word" so static captions still render). */
  function toEvents(cues) {
    var out = [];
    for (var i = 0; i < (cues || []).length; i++) {
      var c = cues[i]; if (!c) continue;
      if (c.words && c.words.length) { out.push(c.words); continue; }
      var txt = String(c.text == null ? '' : c.text).replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      out.push([{ text: txt, start: +c.start || 0, end: +c.end || ((+c.start || 0) + 1) }]);
    }
    return out;
  }

  /*
   * Build a complete .ass document from word-timed cues.
   * opts: width, height, font, fontSize, fill, highlight, outline, outlineColor,
   *       shadow, bold, italic, marginLR, marginV, align (2=bottom,5=middle),
   *       allCaps, anim ('pop'|'none'), popScale (default 116), letterSpacing.
   */
  function buildAss(cues, opts) {
    opts = opts || {};
    var W = opts.width || 1920, H = opts.height || 1080;
    var font = opts.font || 'Arial';
    var fontSize = opts.fontSize || Math.round(H * 0.055);
    var fill = assColor(opts.fill || '#FFFFFF');
    var hi = assColor(opts.highlight || '#FFD400');
    var outlineCol = assColor(opts.outlineColor || '#000000');
    var outline = (opts.outline != null) ? opts.outline : Math.max(2, Math.round(fontSize * 0.06));
    var shadow = (opts.shadow != null) ? opts.shadow : 0;
    var bold = opts.bold ? -1 : 0;            // ASS booleans: -1 = true, 0 = false
    var italic = opts.italic ? -1 : 0;
    var spacing = opts.letterSpacing || 0;
    var marginLR = (opts.marginLR != null) ? opts.marginLR : Math.round(W * 0.06);
    var marginV = (opts.marginV != null) ? opts.marginV : Math.round(H * 0.12);
    var align = opts.align || 2;              // 2 = bottom-centre, 5 = middle-centre
    var allCaps = !!opts.allCaps;
    var anim = opts.anim || 'pop';
    var popScale = opts.popScale || 116;

    var head = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: ' + W,
      'PlayResY: ' + H,
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      'YCbCr Matrix: TV.709',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
        'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, ' +
        'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Pulse,' + font + ',' + fontSize + ',' + fill + ',' + hi + ',' + outlineCol + ',&H64000000&,' +
        bold + ',' + italic + ',0,0,100,100,' + spacing + ',0,1,' + outline + ',' + shadow + ',' +
        align + ',' + marginLR + ',' + marginLR + ',' + marginV + ',1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ];

    function caseIt(s) { return allCaps ? String(s).toUpperCase() : s; }

    var events = toEvents(cues), lines = [];
    for (var c = 0; c < events.length; c++) {
      var ws = events[c];
      for (var k = 0; k < ws.length; k++) {
        var start = +ws[k].start || 0;
        var end = (k + 1 < ws.length) ? (+ws[k + 1].start || 0) : (+ws[k].end || 0);
        if (!(end > start)) end = start + 0.04;     // never zero-length
        var parts = [];
        for (var j = 0; j < ws.length; j++) {
          var word = assText(caseIt(ws[j].text));
          if (j === k) {
            var pop = (anim === 'pop')
              ? '\\fscx' + popScale + '\\fscy' + popScale + '\\t(0,90,\\fscx100\\fscy100)'
              : '';
            // recolour to highlight for this word, then restore the fill for the rest
            parts.push('{\\1c' + hi + pop + '}' + word + '{\\1c' + fill + '}');
          } else {
            parts.push(word);
          }
        }
        lines.push('Dialogue: 0,' + assTime(start) + ',' + assTime(end) + ',Pulse,,0,0,0,,' + parts.join(' '));
      }
    }
    return head.join('\n') + '\n' + lines.join('\n') + '\n';
  }

  /* Escape an .ass path for use inside ffmpeg's subtitles filter (the filter
     graph treats ':' and '\' specially; Windows backslashes must become '/'). */
  function escFilterPath(p) {
    return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  }

  /* Build the ffmpeg burn-in command args (caller supplies in/out paths). The
     subtitles filter path must be escaped for the platform; fontsdir pins the
     bundled font so the burn matches the preview. Returns an argv array. */
  function ffmpegBurnArgs(inPath, assPath, outPath, fontsDir) {
    var filter = 'subtitles=' + escFilterPath(assPath);
    if (fontsDir) filter += ':fontsdir=' + escFilterPath(fontsDir);
    return ['-y', '-i', inPath, '-vf', filter, '-c:a', 'copy', outPath];
  }

  /* Build ffmpeg args that render the captions onto a TRANSPARENT background (an
     alpha overlay), so the result drops onto a video track above the footage
     without re-encoding the user's source. Output is qtrle .mov (lossless RGBA,
     plays in every Premiere on Mac+Win). Caller supplies sequence dims + duration. */
  function ffmpegOverlayArgs(assPath, width, height, durSec, outPath, fontsDir, fps) {
    var dur = (durSec > 0) ? Math.ceil(durSec * 100) / 100 : 1;
    var rate = fps || 30;
    var sub = 'subtitles=' + escFilterPath(assPath) + ':alpha=1';
    if (fontsDir) sub += ':fontsdir=' + escFilterPath(fontsDir);
    return ['-y', '-f', 'lavfi',
      '-i', 'color=c=black@0.0:s=' + width + 'x' + height + ':d=' + dur + ':r=' + rate + ',format=rgba',
      '-vf', sub, '-c:v', 'qtrle', outPath];
  }

  return {
    assTime: assTime,
    assColor: assColor,
    assText: assText,
    toEvents: toEvents,
    buildAss: buildAss,
    ffmpegBurnArgs: ffmpegBurnArgs,
    ffmpegOverlayArgs: ffmpegOverlayArgs,
    escFilterPath: escFilterPath
  };
});
