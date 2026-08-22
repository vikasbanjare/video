/*
 * Pulse — built-in caption rendering engine.
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
  function styleForFrame(preset, frameH, o, frameW) {
    o = o || {};
    preset = preset || {};   // never deref a null preset (stale id / missing base)
    // Scale by frame WIDTH (relative to a 1920-wide reference), not height, so a
    // caption is a consistent fraction of the frame's WIDTH and always fits inside
    // it — vertical (1080×1920), horizontal (1920×1080) and square all auto-adjust.
    // Height-based scaling made vertical captions 1.78× too big for the narrow
    // frame, so they spilled outside. Falls back to height-based when no width is
    // given (e.g. fixed-aspect gallery thumbnails).
    var scale = (frameW && frameW > 0) ? (frameW / 1920) : (frameH / 1080);
    // PORTRAIT BOOST: pure width-scaling makes a vertical caption the same
    // fraction of WIDTH as a landscape one — on a 1080×1920 frame that lands at
    // ~30px, unreadable on a phone (measured by tools/style-quality-audit.js:
    // 57 of 74 styles came out below the legibility floor). Reels/Shorts
    // captions run far larger relative to width, so tall frames scale up
    // proportionally to how tall they are, capped so nothing overflows.
    if (frameW && frameH && frameH > frameW) {
      var tallness = Math.min(1.9, frameH / frameW);      // 16:9 vertical = 1.78
      scale *= 1 + 0.55 * (tallness - 1);                 // 1.0 (square) … ~1.43 (9:16)
    }
    var strokeW = (o.strokeWidth != null) ? o.strokeWidth : (preset.strokeWidth || 0);
    var box = (o.boxColor !== undefined) ? o.boxColor : (preset.boxColor || null);
    // A box colour the user CHANGED (differs from the template's default) becomes a
    // SOLID box: drop the template's multi-stop gradient so the new colour actually
    // shows. Unchanged → keep the template's designed gradient (e.g. "Aura").
    var boxChanged = (o.boxColor !== undefined && preset.boxColor != null &&
                      String(o.boxColor).toLowerCase() !== String(preset.boxColor).toLowerCase());
    var fill = o.fill || preset.fill;
    var highlight = o.highlight || preset.highlight || '#FFD400';
    var hlScale = (o.highlightScale != null) ? o.highlightScale : (preset.highlightScale || 1);
    // Guarantee the spoken word is ALWAYS visible: if the highlight colour matches
    // the body text (so colour alone wouldn't set the active word apart), pop it by
    // size — on EVERY template, box or not — so word-by-word is never invisible.
    if (String(highlight).toLowerCase() === String(fill).toLowerCase()) {
      hlScale = Math.max(hlScale, 1.2);
    }
    return {
      font: o.font || preset.font,
      fallbacks: (preset.fallbackFonts || []).join('", "'),
      // LEGIBILITY FLOOR on real output frames (never on gallery tiles, which
      // pass their own band-relative fontSize and no frameW): a style authored
      // small must still be readable on a phone. The floor is 5% of the frame's
      // SMALLER side.
      //
      // It used to be 5% of the WIDTH, which is the same thing for vertical and
      // square frames but wrong for landscape: at 1920x1080 the floor came to
      // 96px while every style computes 48-90px, so the floor bound on ALL of
      // them — every caption rendered at exactly 96px (8.9% of frame height,
      // oversized for a podcast) and all size differences between styles
      // vanished. Measured across 10 styles: 10/10 identical at 1920x1080,
      // varied at 1080x1920. Using the smaller side leaves vertical and square
      // output byte-identical and gives landscape its styles back.
      size: (function () {
        var px = Math.round((o.fontSize || preset.fontSize) * scale);
        if (frameW && frameW > 0) {
          var shortSide = (frameH && frameH > 0) ? Math.min(frameW, frameH) : frameW;
          px = Math.max(px, Math.round(shortSide * 0.05));
        }
        return px;
      })(),
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
      highlight2: (o.highlight2 !== undefined) ? o.highlight2 : (preset.highlight2 || null), // gradient 2nd colour for the highlighted word
      glossy: (o.glossy != null) ? o.glossy : (preset.glossy || false),   // metallic sheen on the highlighted word
      fill2: (o.fill2 !== undefined) ? o.fill2 : (preset.fill2 || null),      // gradient 2nd colour (null = solid)
      highlightColors: o.highlightColors || preset.highlightColors || null,    // cycle colours word-to-word
      boxOpacity: (o.boxOpacity != null) ? o.boxOpacity : (preset.boxOpacity != null ? preset.boxOpacity : 1),
      boxPad: (o.boxPad != null) ? o.boxPad : (preset.boxPad != null ? preset.boxPad : 1),  // padding multiplier
      shadowDX: Math.round(((o.shadowDX != null ? o.shadowDX : (preset.shadowDX || 0))) * scale),
      shadowDY: Math.round(((o.shadowDY != null ? o.shadowDY : (preset.shadowDY || 0))) * scale),
      wordSpacing: Math.round(((o.wordSpacing != null ? o.wordSpacing : (preset.wordSpacing || 0))) * scale),
      emphasizeWords: (o.emphasizeWords != null) ? o.emphasizeWords : (preset.emphasizeWords != null ? preset.emphasizeWords : false),
      boxColor2: (o.boxColor2 !== undefined) ? o.boxColor2 : (boxChanged ? null : (preset.boxColor2 || null)),   // box gradient 2nd colour
      numberColor: (o.numberColor !== undefined) ? o.numberColor : (preset.numberColor || null), // colour numbers/money
      brandColor: (o.brandColor !== undefined) ? o.brandColor : (preset.brandColor || null),      // colour brand keywords
      brandWords: o.brandWords || preset.brandWords || null,
      // word-sync: fade words not yet spoken (Captions.ai 3-state look). 1 = off.
      upcomingOpacity: (o.upcomingOpacity != null) ? o.upcomingOpacity : (preset.upcomingOpacity != null ? preset.upcomingOpacity : 1),
      weight: (o.weight != null) ? o.weight : (preset.weight || 800),
      align: o.align || preset.align || 'center',
      uppercase: o.uppercase != null ? o.uppercase : preset.uppercase,
      yPct: o.yPct != null ? o.yPct : 0.76,
      vCenter: o.vCenter || preset.vCenter || false,   // center the block vertically (gallery thumbs)
      // 0 = unlimited (legacy wrap), 1 = force single line, 2 = max two lines.
      // When set, the renderer shrinks the font to keep the caption within it.
      maxLines: (o.maxLines != null) ? o.maxLines : (preset.maxLines || 0),
      maxWidthPct: (o.maxWidthPct != null) ? o.maxWidthPct : (preset.maxWidthPct || 0.86),
      lineGap: (o.lineGap != null) ? o.lineGap : (preset.lineGap || 1.18),
      // force N words per line (0 = off) → vertical "stacked" caption layout
      wordsPerLine: (o.wordsPerLine != null) ? o.wordsPerLine : (preset.wordsPerLine || 0),
      // diagonal cascade (top-left → centre → bottom-right) for dynamic captions
      stagger: (o.stagger != null) ? o.stagger : (preset.stagger || false),
      // a different (heavier/italic) face + weight for the highlighted word.
      // Authoritative when the override key is present (lets a UI toggle turn it
      // off even though the preset defines one).
      highlightFont: (o.highlightFont !== undefined) ? o.highlightFont : (preset.highlightFont || null),
      highlightFallbacks: (o.highlightFallbacks !== undefined) ? o.highlightFallbacks : (preset.highlightFallbacks || null),
      highlightItalic: (o.highlightItalic != null) ? o.highlightItalic : (preset.highlightItalic || false),
      highlightWeight: (o.highlightWeight != null) ? o.highlightWeight : (preset.highlightWeight || 0),
      // a soft glow halo around the highlighted word (the "shiny" keyword look)
      highlightGlow: (o.highlightGlow !== undefined) ? o.highlightGlow : (preset.highlightGlow || null),
      highlightGlowBlur: (o.highlightGlowBlur != null) ? o.highlightGlowBlur : (preset.highlightGlowBlur != null ? preset.highlightGlowBlur : 0.4),
      // two-tier "stacked" sizing: lines after the first render at this scale
      // (1 = off). Drives the big-headline / small-subline editorial look.
      subScale: (o.subScale != null) ? o.subScale : (preset.subScale != null ? preset.subScale : 1),
      // ---- "Buttons" pack: full box styling (border / glow / 3D / gloss / shadow) ----
      boxStroke: (o.boxStroke !== undefined) ? o.boxStroke : (preset.boxStroke || null),     // box border colour
      boxStrokeWidth: Math.round(((o.boxStrokeWidth != null ? o.boxStrokeWidth : (preset.boxStrokeWidth || 0))) * scale),
      boxGlow: (o.boxGlow !== undefined) ? o.boxGlow : (preset.boxGlow || null),             // neon glow colour around the box
      boxGlowBlur: (o.boxGlowBlur != null) ? o.boxGlowBlur : (preset.boxGlowBlur != null ? preset.boxGlowBlur : 0.6),
      box3d: (o.box3d !== undefined) ? o.box3d : (preset.box3d || null),                     // extruded bottom-edge colour
      box3dDepth: Math.round(((o.box3dDepth != null ? o.box3dDepth : (preset.box3dDepth || 0))) * scale),
      boxGloss: (o.boxGloss != null) ? o.boxGloss : (preset.boxGloss || 0),                  // 0..1 glossy top sheen
      boxShadow: (o.boxShadow !== undefined) ? o.boxShadow : (preset.boxShadow || null),     // drop-shadow colour under the box
      boxShadowBlur: (o.boxShadowBlur != null) ? o.boxShadowBlur : (preset.boxShadowBlur != null ? preset.boxShadowBlur : 0.5),
      boxShadowDY: Math.round(((o.boxShadowDY != null ? o.boxShadowDY : (preset.boxShadowDY != null ? preset.boxShadowDY : 0))) * scale),
      boxGradient: o.boxGradient || preset.boxGradient || 'v',   // 'v' vertical | 'h' horizontal
      boxStops: o.boxStops || (boxChanged ? null : preset.boxStops) || null   // [[offset,'#hex'],…] multi-stop fill
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
    // clamp the radius so a large "pill" radius can't overshoot into a pinched
    // leaf shape (arcTo crosses over when r > half the smaller side).
    r = Math.max(0, Math.min(r, w / 2, h / 2));
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
    // the highlighted word can use a DIFFERENT (heavier/italic) font + weight,
    // with its own fallback chain (e.g. a serif keyword falls back to Georgia).
    function setFontFor(px, hl) {
      if (hl && style.highlightFont) {
        var w = style.highlightWeight || 900;
        var it = style.highlightItalic ? 'italic ' : '';
        var fb = style.highlightFallbacks
          ? (', ' + style.highlightFallbacks)
          : (', "' + style.font + '", "' + style.fallbacks + '", sans-serif');
        ctx.font = it + w + ' ' + px + 'px "' + style.highlightFont + '"' + fb;
      } else { setFont(px); }
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
        setFontFor(pxk, hpk);
        m.push({ word: words[k], px: pxk, hl: hpk, w: ctx.measureText(words[k]).width });
      }
      var ls = [];
      var cur = { items: [], width: 0, height: eff };
      var wpl = style.wordsPerLine || 0;             // stacked layout: N words per line
      for (var j = 0; j < m.length; j++) {
        var add = m[j].w + (cur.items.length ? sp : 0);
        var forceBreak = wpl && cur.items.length >= wpl;
        if (cur.items.length && (forceBreak || cur.width + add > maxW)) {
          ls.push(cur);
          cur = { items: [], width: 0, height: eff };
          add = m[j].w;
        }
        cur.items.push(m[j]);
        cur.width += add;
        cur.height = Math.max(cur.height, m[j].px);
      }
      if (cur.items.length) ls.push(cur);
      // default per-line spacing/scale (uniform unless two-tier shrinks lines 2+)
      for (var lz = 0; lz < ls.length; lz++) { ls[lz].spaceW = sp; ls[lz].scale = 1; }
      // two-tier "stacked" editorial look: lines after the first shrink to subScale.
      // Re-measure those words at the smaller size so wrapping/centering stay tight.
      var sub = style.subScale;
      if (sub && sub < 1) {
        for (var lr = 1; lr < ls.length; lr++) {
          var lineR = ls[lr], lw = 0, hMax = 0;
          for (var ir = 0; ir < lineR.items.length; ir++) {
            var itr = lineR.items[ir];
            itr.px = Math.max(6, Math.round(itr.px * sub));
            setFontFor(itr.px, itr.hl);
            itr.w = ctx.measureText(itr.word).width;
            lw += itr.w; if (itr.px > hMax) hMax = itr.px;
          }
          setFont(Math.max(6, Math.round(eff * sub)));
          lineR.spaceW = ctx.measureText(' ').width + (style.wordSpacing || 0);
          lw += lineR.spaceW * Math.max(0, lineR.items.length - 1);
          lineR.width = lw; lineR.height = hMax; lineR.scale = sub;
        }
      }
      var widest = 0;
      for (var lw2 = 0; lw2 < ls.length; lw2++) if (ls[lw2].width > widest) widest = ls[lw2].width;
      return { meta: m, lines: ls, eff: eff, hlSize: Math.round(eff * hlScale), spaceW: sp, widest: widest };
    }

    // Enforce the line limit (1 = single, 2 = double) by shrinking the font
    // until it fits — this kills the ugly "one stray word on a 2nd line" look.
    var lay = layout(1);
    // Shrink until the caption fits BOTH ways:
    //  · within the allowed number of lines (kills the stray-word second line)
    //  · within the frame's width — a single unbreakable word (a long URL, a
    //    compound German/medical word) forms its own line that wrapping cannot
    //    split, and used to run straight off both edges of the video.
    var fit = 1, guard = 0;
    while (((style.maxLines && lay.lines.length > style.maxLines) || lay.widest > maxW) &&
           fit > 0.34 && guard < 30) {
      fit *= 0.93; guard++;
      lay = layout(fit);
    }
    // Still wider than the frame at the smallest sane size (an extreme word):
    // break it across lines rather than let it bleed off screen.
    if (lay.widest > maxW) {
      var broken = [], bi;
      for (bi = 0; bi < words.length; bi++) {
        var wOne = words[bi];
        setFont(lay.eff);
        if (ctx.measureText(wOne).width <= maxW || wOne.length < 6) { broken.push(wOne); continue; }
        var per = Math.max(3, Math.floor(wOne.length * maxW / ctx.measureText(wOne).width) - 1);
        for (var cpos = 0; cpos < wOne.length; cpos += per) broken.push(wOne.substr(cpos, per));
      }
      if (broken.length !== words.length) { words = broken; lay = layout(fit); }
    }
    base = lay.eff;
    var meta = lay.meta, lines = lay.lines, hlSize = lay.hlSize, spaceW = lay.spaceW;
    // Record the line count the layout ACTUALLY produced. Counting lines from
    // pixels afterwards is unreliable for tight-leading styles (pro-boldpop has
    // lineGap 1.04, so its two lines nearly touch and merge into one blob at
    // some scales but not others) — the renderer already knows the answer.
    try { canvas._cpLines = lines.length; } catch (eLn) {}

    var lineStep = hlSize * style.lineGap;
    var blockH = lines.length * lineStep;
    // per-line baselines. Uniform stepping for normal styles; two-tier styles
    // (subScale<1) use each line's own height so a big headline + small subline
    // sit at a natural, tight distance.
    var twoTier = (style.subScale && style.subScale < 1 && lines.length > 1);
    var lineY = [], baseY;
    if (twoTier) {
      var lastY = H * style.yPct;            // bottom-anchored, same as uniform
      lineY[lines.length - 1] = lastY;
      for (var lb = lines.length - 2; lb >= 0; lb--) {
        var adv = (lines[lb].height + lines[lb + 1].height) / 2 * style.lineGap;
        lineY[lb] = lineY[lb + 1] - adv;
      }
      baseY = lineY[0];
    } else {
      baseY = H * style.yPct - blockH + lineStep; // baseline of first line
      for (var lc = 0; lc < lines.length; lc++) lineY[lc] = baseY + lc * lineStep;
    }

    // vertically centre the whole block in the frame (gallery thumbnails) so a
    // 1- or 2-line caption never clips off the top/bottom of a short card.
    if (style.vCenter && lines.length) {
      var topY = lineY[0] - lines[0].height * 0.80;
      var botY = lineY[lines.length - 1] + lines[lines.length - 1].height * 0.20;
      var shift = (H - (botY - topY)) / 2 - topY;
      for (var vc = 0; vc < lineY.length; vc++) lineY[vc] += shift;
      baseY += shift;
    }

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
    // glossy/metallic sheen: dark edges, bright band through the middle
    function glossyFill(yTop, h, edge, mid) {
      var g = ctx.createLinearGradient(0, yTop, 0, yTop + h);
      g.addColorStop(0, edge); g.addColorStop(0.42, mid); g.addColorStop(0.58, mid); g.addColorStop(1, edge);
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
      // diagonal stagger: first line hugs top-left, last line bottom-right,
      // middle line centred — the "dynamic" cascading caption look.
      if (style.stagger && lines.length > 1) {
        var frac = li / (lines.length - 1);                 // 0 → 1 down the stack
        var leftX = margin, rightX = W - margin - line.width;
        x = leftX + (rightX - leftX) * frac;
        if (x < 6) x = 6; if (x + line.width > W - 6) x = W - 6 - line.width;
      }
      var y = lineY[li];

      // background box behind the whole line (opacity + padding + gradient).
      // barTop/barH are remembered so an active-word box can be centred inside it.
      var barTop = null, barH = null;
      // Draw the box layer when ANY box effect is set — face, border, glow, a 3D
      // extrusion, or a gloss sheen. (3D/gloss were missing here, so a preset that
      // only defined those drew nothing.)
      if (style.boxColor || style.boxStroke || style.boxGlow ||
          (style.box3d && style.box3dDepth > 0) || style.boxGloss > 0) {
        var padX = base * 0.32 * style.boxPad, padY = base * 0.22 * style.boxPad;
        var bxTop = y - line.height - padY + line.height * 0.18, bxH = line.height + padY * 2;
        var bxLeft = x - padX, bxW = line.width + padX * 2;
        barTop = bxTop; barH = bxH;
        ctx.save();

        // fill style: multi-stop > 2-stop gradient > solid. Direction h/v.
        function boxFill() {
          if (style.boxStops && style.boxStops.length) {
            var horiz = style.boxGradient === 'h';
            var gg = ctx.createLinearGradient(horiz ? bxLeft : 0, horiz ? 0 : bxTop,
                                              horiz ? bxLeft + bxW : 0, horiz ? 0 : bxTop + bxH);
            for (var si = 0; si < style.boxStops.length; si++) gg.addColorStop(style.boxStops[si][0], style.boxStops[si][1]);
            return gg;
          }
          if (style.boxColor2) {
            var horiz2 = style.boxGradient === 'h';
            var g2 = ctx.createLinearGradient(horiz2 ? bxLeft : 0, horiz2 ? 0 : bxTop,
                                              horiz2 ? bxLeft + bxW : 0, horiz2 ? 0 : bxTop + bxH);
            g2.addColorStop(0, style.boxColor); g2.addColorStop(1, style.boxColor2);
            return g2;
          }
          return style.boxColor || 'rgba(0,0,0,0)';
        }

        // 1) 3D extruded bottom edge (drawn behind the face, offset down)
        if (style.box3d && style.box3dDepth > 0) {
          ctx.fillStyle = style.box3d;
          roundRect(ctx, bxLeft, bxTop + style.box3dDepth, bxW, bxH, style.boxRadius);
          ctx.fill();
        }
        // 2) soft drop shadow under the box (neomorphism / paper / floating pill)
        if (style.boxShadow) {
          ctx.save();
          ctx.shadowColor = style.boxShadow;
          ctx.shadowBlur = bxH * style.boxShadowBlur;
          ctx.shadowOffsetY = style.boxShadowDY || Math.round(bxH * 0.12);
          ctx.fillStyle = style.boxColor || style.boxShadow;
          roundRect(ctx, bxLeft, bxTop, bxW, bxH, style.boxRadius); ctx.fill();
          ctx.restore();
        }
        // 3) neon glow: emanate the box colour/stroke colour outward
        if (style.boxGlow) {
          ctx.save();
          ctx.shadowColor = style.boxGlow; ctx.shadowBlur = bxH * style.boxGlowBlur;
          ctx.fillStyle = style.boxColor || 'rgba(0,0,0,0.001)';
          roundRect(ctx, bxLeft, bxTop, bxW, bxH, style.boxRadius); ctx.fill();
          if (style.boxStroke) { ctx.lineWidth = Math.max(2, style.boxStrokeWidth); ctx.strokeStyle = style.boxStroke; ctx.stroke(); ctx.stroke(); }
          ctx.restore();
        }
        // 4) the face fill (boxOpacity dims ONLY the fill, so borders stay crisp)
        if (style.boxColor) {
          ctx.save();
          ctx.globalAlpha = style.boxOpacity;
          ctx.fillStyle = boxFill();
          roundRect(ctx, bxLeft, bxTop, bxW, bxH, style.boxRadius);
          ctx.fill();
          ctx.restore();
        }
        // 5) glossy top sheen (Candy / Paypal / Windows): bright band fading down
        if (style.boxGloss > 0) {
          var sg = ctx.createLinearGradient(0, bxTop, 0, bxTop + bxH * 0.55);
          sg.addColorStop(0, 'rgba(255,255,255,' + (0.75 * style.boxGloss) + ')');
          sg.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = sg;
          roundRect(ctx, bxLeft + bxW * 0.03, bxTop + bxH * 0.06, bxW * 0.94, bxH * 0.46, style.boxRadius * 0.8);
          ctx.fill();
        }
        // 6) crisp border on top
        if (style.boxStroke && style.boxStrokeWidth > 0) {
          ctx.lineWidth = style.boxStrokeWidth; ctx.strokeStyle = style.boxStroke;
          roundRect(ctx, bxLeft, bxTop, bxW, bxH, style.boxRadius);
          ctx.stroke();
        }
        ctx.restore();
      }

      var lineSpace = (line.spaceW != null) ? line.spaceW : spaceW;
      for (var wi = 0; wi < line.items.length; wi++) {
        var it = line.items[wi];
        // progressive reveal (frame.reveal = N): words past N are still LAID OUT
        // (so the line never re-centres / shifts) but not drawn — a clean
        // word-by-word reveal in stable positions, no jitter.
        if (frame.reveal != null && mi >= frame.reveal) { x += it.w + lineSpace; mi++; continue; }
        setFontFor(it.px, it.hl);   // keyword may use a different (italic serif) face
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
            var bpadX = it.px * 0.22 * style.boxPad;
            var wbTop, wbH;
            if (barH != null) {
              // sitting inside a backing bar: make the word box clearly smaller
              // than the bar and centre it vertically so top/bottom margins match.
              wbH = barH * 0.70;
              wbTop = barTop + (barH - wbH) / 2;
            } else {
              var bpadY = it.px * 0.16 * style.boxPad;
              wbH = it.px + bpadY * 2;
              wbTop = gtop - bpadY;
            }
            var br = Math.min(wbH * 0.32, style.boxRadius || 14);
            // the highlight box stays solid even when the bar behind it is
            // translucent (so the active word always pops).
            ctx.globalAlpha = (barH != null) ? 1 : style.boxOpacity;
            ctx.fillStyle = hlColor;
            roundRect(ctx, x - bpadX, wbTop, it.w + bpadX * 2, wbH, br);
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
        // fade words not yet spoken (3-state karaoke: past=full, current=highlight, future=dim)
        var prevA = ctx.globalAlpha;
        if (wordSync && style.upcomingOpacity < 1 && frame.active != null && mi > frame.active && !it.hl) {
          ctx.globalAlpha = style.upcomingOpacity;
        }
        // soft glow halo around the highlighted keyword (the "shiny" look) —
        // a pre-pass laid down under the crisp glyph so the halo reads clearly.
        if (it.hl && style.highlightGlow && !filled) {
          ctx.save();
          ctx.shadowColor = style.highlightGlow;
          ctx.shadowBlur = it.px * (style.highlightGlowBlur != null ? style.highlightGlowBlur : 0.45);
          ctx.fillStyle = style.highlightGlow;
          ctx.fillText(it.word, x, y);   // halo pass
          ctx.fillText(it.word, x, y);   // double for intensity
          ctx.restore();
        }
        // text colour: contrast on solid shapes; the highlight colour on
        // colour/underline/circle; otherwise the body fill (gradient if set)
        if (filled) {
          ctx.fillStyle = contrastColor(hlColor);
        } else if (it.hl && (shape === 'color' || shape === 'underline' || shape === 'circle')) {
          // highlighted word: glossy/metallic sheen (bright band) or a 2-tone
          // gradient when a 2nd colour is set; else solid.
          var solo = (!style.highlightColors || !style.highlightColors.length);
          if (solo && style.highlight2 && style.glossy) {
            ctx.fillStyle = glossyFill(y - it.px * 0.78, it.px * 0.92, style.highlight2, hlColor);
          } else if (solo && style.highlight2) {
            ctx.fillStyle = textFill(y - it.px * 0.72, it.px * 0.8, hlColor, style.highlight2);
          } else {
            ctx.fillStyle = hlColor;
          }
        } else {
          // smart colour for numbers/brand words, else the body fill (gradient if set)
          var rc = restColorFor(it.word);
          ctx.fillStyle = rc ? rc : textFill(y - it.px * 0.72, it.px * 0.8, spkBody || style.fill, style.fill2);
        }
        // Cast the drop shadow / glow from the FILLED word itself. Previously the
        // shadow was applied only around the outline and cleared before the fill,
        // so a drop shadow or glow on a style WITHOUT an outline produced nothing
        // at all (the "shadow does nothing" bug).
        if (style.glow && !filled) {
          ctx.shadowColor = style.glow;
          ctx.shadowBlur = it.px * (style.glowBlur != null ? style.glowBlur : 0.35);
          ctx.shadowOffsetX = style.shadowDX; ctx.shadowOffsetY = style.shadowDY;
        }
        ctx.fillText(it.word, x, y);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;   // clear keyword glow
        ctx.globalAlpha = prevA;
        mi++;
        x += it.w + lineSpace;
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

    var style = styleForFrame(opts.preset, opts.height, opts.overrides, opts.width);
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
    var hasStroke = (!!style.stroke && (style.strokeWidth || 0) > 0) ||
                    (!!style.boxStroke && (style.boxStrokeWidth || 0) > 0);
    var hasBox = !!style.boxColor;
    var hasGlow = !!style.glow || !!style.boxGlow;
    // a bordered / glowing / extruded pill is its own legible backing
    var hasBacking = hasBox || hasStroke || hasGlow || !!style.box3d;
    if (!hasBacking) {
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
