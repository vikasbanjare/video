/*
 * CutPilot — built-in caption rendering engine.
 * Renders every caption frame to a transparent PNG via <canvas> (any font,
 * fill, stroke, glow, highlight box — full pixel control), saves them with
 * Node, and hands the list to the ExtendScript host which places them on
 * the timeline and keyframes the entry animation.
 * The pure layout helpers are exported for Node unit tests.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPRender = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /*
   * Greedy line wrap using an injected measure function (px width of a
   * string). Pure — tested in Node with a fake measurer.
   */
  function wrapLines(words, maxWidth, measure) {
    var lines = [];
    var line = [];
    for (var i = 0; i < words.length; i++) {
      var candidate = line.concat([words[i]]).join(' ');
      if (line.length && measure(candidate) > maxWidth) {
        lines.push(line);
        line = [words[i]];
      } else {
        line.push(words[i]);
      }
    }
    if (line.length) lines.push(line);
    return lines;
  }

  /*
   * Resolve a preset + user overrides into concrete pixel values for a
   * given frame height. Override precedence matches CPCaptions.mergeStyle.
   */
  function styleForFrame(preset, frameH, o) {
    o = o || {};
    var scale = frameH / 1080;
    var strokeW = (o.strokeWidth != null) ? o.strokeWidth : (preset.strokeWidth || 0);
    var box = (o.boxColor !== undefined) ? o.boxColor : (preset.boxColor || null);
    var fill = o.fill || preset.fill;
    var highlight = o.highlight || preset.highlight || '#FFD400';
    var hlScale = (o.highlightScale != null) ? o.highlightScale : (preset.highlightScale || 1);
    // Guarantee the spoken word is always visible: if the highlight colour is the
    // same as the body text AND there's no box behind it (several minimalist
    // templates are monochrome by design), make the active word pop by size so
    // word-by-word sync is never invisible on those styles.
    if (!box && String(highlight).toLowerCase() === String(fill).toLowerCase()) {
      hlScale = Math.max(hlScale, 1.18);
    }
    return {
      font: o.font || preset.font,
      fallbacks: (preset.fallbackFonts || []).join('", "'),
      size: Math.round((o.fontSize || preset.fontSize) * scale),
      fill: fill,
      highlight: highlight,
      stroke: (o.stroke !== undefined) ? o.stroke : (preset.stroke || null),
      strokeWidth: Math.round(strokeW * scale),
      boxColor: box,
      boxRadius: Math.round(((o.boxRadius != null ? o.boxRadius : preset.boxRadius) || 10) * scale),
      glow: (o.glow !== undefined) ? o.glow : (preset.glow || null),
      glowBlur: (o.glowBlur != null) ? o.glowBlur : (preset.glowBlur != null ? preset.glowBlur : 0.35),
      letterSpacing: Math.round(((o.letterSpacing != null ? o.letterSpacing : (preset.letterSpacing || 0))) * scale),
      highlightScale: hlScale,
      highlightStyle: o.highlightStyle || preset.highlightStyle || 'color',
      // --- premium customization additions ---
      fill2: (o.fill2 !== undefined) ? o.fill2 : (preset.fill2 || null),      // gradient 2nd colour (null = solid)
      highlightColors: o.highlightColors || preset.highlightColors || null,    // cycle colours word-to-word
      boxOpacity: (o.boxOpacity != null) ? o.boxOpacity : (preset.boxOpacity != null ? preset.boxOpacity : 1),
      boxPad: (o.boxPad != null) ? o.boxPad : (preset.boxPad != null ? preset.boxPad : 1),  // padding multiplier
      shadowDX: Math.round(((o.shadowDX != null ? o.shadowDX : (preset.shadowDX || 0))) * scale),
      shadowDY: Math.round(((o.shadowDY != null ? o.shadowDY : (preset.shadowDY || 0))) * scale),
      wordSpacing: Math.round(((o.wordSpacing != null ? o.wordSpacing : (preset.wordSpacing || 0))) * scale),
      emphasizeWords: (o.emphasizeWords != null) ? o.emphasizeWords : (preset.emphasizeWords != null ? preset.emphasizeWords : false),
      boxColor2: (o.boxColor2 !== undefined) ? o.boxColor2 : (preset.boxColor2 || null),   // box gradient 2nd colour
      numberColor: (o.numberColor !== undefined) ? o.numberColor : (preset.numberColor || null), // colour numbers/money
      brandColor: (o.brandColor !== undefined) ? o.brandColor : (preset.brandColor || null),      // colour brand keywords
      brandWords: o.brandWords || preset.brandWords || null,
      weight: (o.weight != null) ? o.weight : (preset.weight || 800),
      align: o.align || preset.align || 'center',
      uppercase: o.uppercase != null ? o.uppercase : preset.uppercase,
      yPct: o.yPct != null ? o.yPct : 0.76,
      // 0 = unlimited (legacy wrap), 1 = force single line, 2 = max two lines.
      // When set, the renderer shrinks the font to keep the caption within it.
      maxLines: (o.maxLines != null) ? o.maxLines : (preset.maxLines || 0),
      maxWidthPct: (o.maxWidthPct != null) ? o.maxWidthPct : (preset.maxWidthPct || 0.86),
      lineGap: (o.lineGap != null) ? o.lineGap : (preset.lineGap || 1.18)
    };
  }

  // ---- v1.0: dynamic word scaling + per-speaker colours -------------------
  var VIRAL_WORDS = {
    secret: 1, biggest: 1, mistake: 1, profit: 1, loss: 1, million: 1, billion: 1,
    trillion: 1, crore: 1, lakh: 1, warning: 1, never: 1, always: 1, money: 1,
    free: 1, ai: 1, stocks: 1, growth: 1, rich: 1, viral: 1, proven: 1, huge: 1,
    instantly: 1, guaranteed: 1, results: 1, win: 1, stop: 1, now: 1
  };
  /* Extra size multiplier for a word: viral words pop biggest, long words a bit. */
  function wordScale(word) {
    var w = String(word).toLowerCase().replace(/[^a-z0-9']/g, '');
    if (VIRAL_WORDS[w]) return 1.5;
    if (w.length > 8) return 1.15;
    return 1;
  }
  var SPEAKER_COLORS = ['#3B82F6', '#F97316', '#22C55E', '#E11D8F', '#A855F7'];
  /* Stable colour per speaker name (so each speaker keeps one colour). */
  function speakerColor(name) {
    var s = String(name || ''), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return SPEAKER_COLORS[h % SPEAKER_COLORS.length];
  }

  /* Pick black or white text for legibility on a given background hex. */
  function contrastColor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#ffd400'));
    if (!m) return '#111111';
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#111111' : '#ffffff';
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /*
   * Draw one caption frame onto a canvas.
   * frame: { words:[...], active?, highlightSet?, speaker? } or { text }.
   * Highlighted words (active OR in highlightSet) render in the highlight
   * color and scaled up by style.highlightScale. A frame.speaker draws a
   * small label pill above the caption.
   * Returns the canvas (caller turns it into a PNG).
   */
  function drawFrame(canvas, frame, style) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    if (style.letterSpacing) { try { ctx.letterSpacing = style.letterSpacing + 'px'; } catch (eLS) {} }

    // honor a per-style weight (clean styles want ~500-700, bold ones 800-900);
    // forcing 900 on everything made even the minimal styles look heavy/cheap.
    var fontWeight = style.weight || 800;
    function setFont(px) {
      ctx.font = fontWeight + ' ' + px + 'px "' + style.font + '", "' + style.fallbacks + '", sans-serif';
    }

    var words = frame.words ? frame.words.slice() : String(frame.text).split(/\s+/);
    if (style.uppercase) for (var u = 0; u < words.length; u++) words[u] = words[u].toUpperCase();

    var base = style.size;
    function isHL(i) {
      return frame.words != null &&
        (i === frame.active || (frame.highlightSet && frame.highlightSet[i]));
    }
    var hlScale = style.highlightScale || 1;
    var maxW = W * style.maxWidthPct;
    // In word-sync frames (karaoke/reveal expose frame.active) ONLY the spoken
    // word should stand out. The dynamic viral/long-word size boost is therefore
    // suppressed here — otherwise words like "trillion"/"million" stay enlarged
    // even when they're not the active word and look highlighted alongside it.
    var wordSync = (frame.active != null);

    // Build per-word metrics and greedy-wrap into lines at a given font scale.
    // Highlighted words get the highlight scale; non-word-sync frames also let
    // viral/long words grow. Pure measurement — called repeatedly to shrink the
    // caption until it fits the allowed line count.
    function layout(fit) {
      var eff = Math.max(8, Math.round(base * fit));
      setFont(eff);
      var sp = ctx.measureText(' ').width + (style.wordSpacing || 0);
      var m = [];
      for (var k = 0; k < words.length; k++) {
        var hpk = isHL(k);
        // auto-enlarge punchy/long words only when the user opts in AND it's not
        // a word-sync frame (where only the spoken word should stand out).
        var dyn = (style.emphasizeWords && !wordSync) ? wordScale(words[k]) : 1;
        var multk = Math.max(hpk ? hlScale : 1, dyn);
        var pxk = Math.round(eff * multk);
        setFont(pxk);
        m.push({ word: words[k], px: pxk, hl: hpk, w: ctx.measureText(words[k]).width });
      }
      var ls = [];
      var cur = { items: [], width: 0, height: eff };
      for (var j = 0; j < m.length; j++) {
        var add = m[j].w + (cur.items.length ? sp : 0);
        if (cur.items.length && cur.width + add > maxW) {
          ls.push(cur);
          cur = { items: [], width: 0, height: eff };
          add = m[j].w;
        }
        cur.items.push(m[j]);
        cur.width += add;
        cur.height = Math.max(cur.height, m[j].px);
      }
      if (cur.items.length) ls.push(cur);
      return { meta: m, lines: ls, eff: eff, hlSize: Math.round(eff * hlScale), spaceW: sp };
    }

    // Enforce the line limit (1 = single, 2 = double) by shrinking the font
    // until it fits — this kills the ugly "one stray word on a 2nd line" look.
    var lay = layout(1);
    if (style.maxLines) {
      var fit = 1, guard = 0;
      while (lay.lines.length > style.maxLines && fit > 0.5 && guard < 16) {
        fit *= 0.93; guard++;
        lay = layout(fit);
      }
    }
    base = lay.eff;
    var meta = lay.meta, lines = lay.lines, hlSize = lay.hlSize, spaceW = lay.spaceW;

    var lineStep = hlSize * style.lineGap;
    var blockH = lines.length * lineStep;
    var baseY = H * style.yPct - blockH + lineStep; // baseline of first line

    // speaker label pill above the block
    if (frame.speaker) {
      var spk = String(frame.speaker).toUpperCase();
      var spx = Math.max(16, Math.round(base * 0.5));
      setFont(spx);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
      var swid = ctx.measureText(spk).width;
      var sx = (W - swid) / 2;
      var sy = Math.max(spx * 1.5, baseY - lines[0].height - spx * 0.6);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, sx - spx * 0.45, sy - spx, swid + spx * 0.9, spx * 1.4, spx * 0.35);
      ctx.fill();
      ctx.fillStyle = speakerColor(frame.speaker) || style.highlight || '#FFD400';
      ctx.fillText(spk, sx, sy);
    }

    // v1.0: tint the body text with this speaker's colour (multi-speaker clarity)
    var spkBody = frame.speaker ? speakerColor(frame.speaker) : null;

    // a vertical gradient fill for the body text (premium two-tone look), or a
    // solid colour when no second colour is set.
    function textFill(yTop, h, c1, c2) {
      if (!c2) return c1;
      var g = ctx.createLinearGradient(0, yTop, 0, yTop + h);
      g.addColorStop(0, c1); g.addColorStop(1, c2);
      return g;
    }
    // smart per-word colours: brand keywords + numbers/money/percent
    var brandSet = {};
    if (style.brandWords) for (var bwI = 0; bwI < style.brandWords.length; bwI++) {
      var bw = String(style.brandWords[bwI]).toLowerCase().replace(/[^a-z0-9']/g, '');
      if (bw) brandSet[bw] = 1;
    }
    function bareWord(w) { return String(w).toLowerCase().replace(/[^a-z0-9']/g, ''); }
    function isNumberish(w) { return /\d/.test(String(w)); }   // 2026, $1M, 50%, 10x, 1,000
    function restColorFor(word) {
      if (style.brandColor && brandSet[bareWord(word)]) return style.brandColor;
      if (style.numberColor && isNumberish(word)) return style.numberColor;
      return null;   // fall back to the body fill / gradient
    }

    // horizontal alignment within the safe text column
    var margin = (W - maxW) / 2;
    var mi = 0;   // running word index across the caption (drives colour cycling)
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var x = (style.align === 'left') ? margin
            : (style.align === 'right') ? (W - margin - line.width)
            : (W - line.width) / 2;
      var y = baseY + li * lineStep;

      // background box behind the whole line (opacity + padding + gradient)
      if (style.boxColor) {
        var padX = base * 0.32 * style.boxPad, padY = base * 0.22 * style.boxPad;
        var bxTop = y - line.height - padY + line.height * 0.18, bxH = line.height + padY * 2;
        ctx.save();
        ctx.globalAlpha = style.boxOpacity;
        if (style.boxColor2) {
          var bg = ctx.createLinearGradient(0, bxTop, 0, bxTop + bxH);
          bg.addColorStop(0, style.boxColor); bg.addColorStop(1, style.boxColor2);
          ctx.fillStyle = bg;
        } else {
          ctx.fillStyle = style.boxColor;
        }
        roundRect(ctx, x - padX, bxTop, line.width + padX * 2, bxH, style.boxRadius);
        ctx.fill();
        ctx.restore();
      }

      for (var wi = 0; wi < line.items.length; wi++) {
        var it = line.items[wi];
        setFont(it.px);
        // per-word highlight colour — cycle the palette word-to-word when set
        var hlColor = style.highlight;
        if (style.highlightColors && style.highlightColors.length) {
          hlColor = style.highlightColors[mi % style.highlightColors.length];
        }
        var shape = it.hl ? (style.highlightStyle || 'color') : null;
        var filled = (shape === 'box' || shape === 'bar');   // word sits on a solid shape

        // highlight shape behind / around the active word
        if (shape && shape !== 'color') {
          ctx.save();
          ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
          var gtop = y - it.px + it.px * 0.16;
          if (shape === 'box') {
            var bpadX = it.px * 0.22 * style.boxPad, bpadY = it.px * 0.16 * style.boxPad;
            var br = Math.min((it.px + 2 * bpadY) * 0.32, style.boxRadius || 14);
            ctx.globalAlpha = style.boxOpacity;
            ctx.fillStyle = hlColor;
            roundRect(ctx, x - bpadX, gtop - bpadY, it.w + bpadX * 2, it.px + bpadY * 2, br);
            ctx.fill();
          } else if (shape === 'bar') {
            var qpadX = it.px * 0.16, qpadY = it.px * 0.12;
            ctx.globalAlpha = style.boxOpacity;
            ctx.fillStyle = hlColor;
            roundRect(ctx, x - qpadX, gtop - qpadY, it.w + qpadX * 2, it.px + qpadY * 2, Math.round(it.px * 0.08));
            ctx.fill();
          } else if (shape === 'marker') {
            ctx.globalAlpha = 0.42;            // translucent highlighter swipe
            ctx.fillStyle = hlColor;
            var mh = it.px * 0.62;
            roundRect(ctx, x - it.px * 0.06, y - mh * 0.78, it.w + it.px * 0.12, mh, Math.round(mh * 0.16));
            ctx.fill();
          } else if (shape === 'underline') {
            ctx.strokeStyle = hlColor;
            ctx.lineWidth = Math.max(2, it.px * 0.09);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(x, y + it.px * 0.16);
            ctx.lineTo(x + it.w, y + it.px * 0.16);
            ctx.stroke();
          } else if (shape === 'circle') {
            ctx.strokeStyle = hlColor;
            ctx.lineWidth = Math.max(2, it.px * 0.06);
            ctx.beginPath();
            ctx.ellipse(x + it.w / 2, y - it.px * 0.3, it.w / 2 + it.px * 0.16, it.px * 0.62, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }

        // drop shadow (blur + optional hard offset) — skip behind solid shapes
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        if (style.glow && !filled) {
          ctx.shadowColor = style.glow;
          ctx.shadowBlur = it.px * (style.glowBlur != null ? style.glowBlur : 0.35);
          ctx.shadowOffsetX = style.shadowDX; ctx.shadowOffsetY = style.shadowDY;
        }
        // outline (skip behind solid shapes — the shape already separates the word)
        if (style.stroke && style.strokeWidth && !filled) {
          ctx.strokeStyle = style.stroke;
          ctx.lineWidth = style.strokeWidth;
          ctx.strokeText(it.word, x, y);
        }
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        // text colour: contrast on solid shapes; the highlight colour on
        // colour/underline/circle; otherwise the body fill (gradient if set)
        if (filled) {
          ctx.fillStyle = contrastColor(hlColor);
        } else if (it.hl && (shape === 'color' || shape === 'underline' || shape === 'circle')) {
          ctx.fillStyle = hlColor;
        } else {
          // smart colour for numbers/brand words, else the body fill (gradient if set)
          var rc = restColorFor(it.word);
          ctx.fillStyle = rc ? rc : textFill(y - it.px * 0.72, it.px * 0.8, spkBody || style.fill, style.fill2);
        }
        ctx.fillText(it.word, x, y);
        mi++;
        x += it.w + spaceW;
      }
    }
    return canvas;
  }

  function nodeRequire(mod) {
    var req = (typeof cep_node !== 'undefined' && cep_node.require) ||
              (typeof window !== 'undefined' && window.require) ||
              (typeof require !== 'undefined' && require);
    return req(mod);
  }

  /*
   * Render all frames to PNG files. Async (yields to the UI between
   * chunks). Returns Promise of [{path, start, end}].
   * opts: { width, height, preset, overrides, outDir, onProgress }
   */
  function renderFrames(frames, opts) {
    var fs = nodeRequire('fs');
    var pathMod = nodeRequire('path');
    // Buffer is not always a page global in CEP mixed context
    var NodeBuffer = (typeof Buffer !== 'undefined') ? Buffer : nodeRequire('buffer').Buffer;
    var outDir = opts.outDir;
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    var style = styleForFrame(opts.preset, opts.height, opts.overrides);
    var canvas = document.createElement('canvas');
    canvas.width = opts.width;
    canvas.height = opts.height;

    var results = [];
    var i = 0;
    function run() {
      return new Promise(function (resolve, reject) {
        function chunk() {
          try {
            var stop = Math.min(i + 20, frames.length);
            for (; i < stop; i++) {
              drawFrame(canvas, frames[i], style);
              var b64 = canvas.toDataURL('image/png').split(',')[1];
              var file = pathMod.join(outDir, 'cap_' + String(10000 + i) + '.png');
              fs.writeFileSync(file, NodeBuffer.from(b64, 'base64'));
              results.push({ path: file, start: frames[i].start, end: frames[i].end });
            }
            if (opts.onProgress) opts.onProgress(i, frames.length);
            if (i < frames.length) setTimeout(chunk, 0);
            else resolve(results);
          } catch (e) { reject(e); }
        }
        chunk();
      });
    }
    // Wait for the chosen font, but NEVER block rendering on it: if the font
    // can't load (e.g. an offline/blocked web font, or an unknown custom name)
    // proceed after a short timeout so the render can't hang forever.
    return new Promise(function (resolve) {
      var settled = false;
      function go() { if (!settled) { settled = true; resolve(); } }
      try {
        if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
          document.fonts.load('700 ' + Math.max(8, style.size) + 'px "' + style.font + '"').then(go, go);
        } else { go(); }
      } catch (e) { go(); }
      setTimeout(go, 1500);
    }).then(run);
  }

  /* WCAG relative luminance of a #rrggbb color (0..1). */
  function relativeLuminance(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 0;
    var n = parseInt(m[1], 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /* WCAG contrast ratio between two colors (1..21). */
  function contrastRatio(a, b) {
    var la = relativeLuminance(a), lb = relativeLuminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  /*
   * Captions sit over unknown footage, so legibility comes from an outline,
   * a box, or a glow — never from the fill color alone. Returns a short
   * warning string when the current style would be hard to read, else null.
   * Pure + tested.
   */
  function legibilityWarning(style) {
    var hasStroke = !!style.stroke && (style.strokeWidth || 0) > 0;
    var hasBox = !!style.boxColor;
    var hasGlow = !!style.glow;
    if (!hasStroke && !hasBox && !hasGlow) {
      return 'No outline, box, or glow — captions can disappear on bright or busy footage. Add an outline.';
    }
    if (hasBox && contrastRatio(style.fill, style.boxColor) < 2.5) {
      return 'Text and box colors are too close — pick a more contrasting text color.';
    }
    return null;
  }

  return {
    wrapLines: wrapLines,
    styleForFrame: styleForFrame,
    drawFrame: drawFrame,
    renderFrames: renderFrames,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    legibilityWarning: legibilityWarning
  };
});
