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
    return {
      font: o.font || preset.font,
      fallbacks: (preset.fallbackFonts || []).join('", "'),
      size: Math.round((o.fontSize || preset.fontSize) * scale),
      fill: o.fill || preset.fill,
      highlight: o.highlight || preset.highlight || '#FFD400',
      stroke: (o.stroke !== undefined) ? o.stroke : (preset.stroke || null),
      strokeWidth: Math.round(strokeW * scale),
      boxColor: box,
      boxRadius: Math.round(((o.boxRadius != null ? o.boxRadius : preset.boxRadius) || 10) * scale),
      glow: (o.glow !== undefined) ? o.glow : (preset.glow || null),
      letterSpacing: Math.round(((o.letterSpacing != null ? o.letterSpacing : (preset.letterSpacing || 0))) * scale),
      highlightScale: (o.highlightScale != null) ? o.highlightScale : (preset.highlightScale || 1),
      highlightStyle: o.highlightStyle || preset.highlightStyle || 'color',
      uppercase: o.uppercase != null ? o.uppercase : preset.uppercase,
      yPct: o.yPct != null ? o.yPct : 0.76,
      maxWidthPct: 0.86,
      lineGap: 1.18
    };
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

    function setFont(px) {
      ctx.font = '900 ' + px + 'px "' + style.font + '", "' + style.fallbacks + '", sans-serif';
    }

    var words = frame.words ? frame.words.slice() : String(frame.text).split(/\s+/);
    if (style.uppercase) for (var u = 0; u < words.length; u++) words[u] = words[u].toUpperCase();

    var base = style.size;
    var hlSize = Math.round(base * (style.highlightScale || 1));
    function isHL(i) {
      return frame.words != null &&
        (i === frame.active || (frame.highlightSet && frame.highlightSet[i]));
    }

    setFont(base);
    var spaceW = ctx.measureText(' ').width;

    // per-word metrics (highlighted words get the larger font)
    var meta = [];
    for (var i = 0; i < words.length; i++) {
      var hp = isHL(i);
      var px = hp ? hlSize : base;
      setFont(px);
      meta.push({ word: words[i], px: px, hl: hp, w: ctx.measureText(words[i]).width });
    }

    // greedy wrap into lines, tracking each line's tallest word
    var maxW = W * style.maxWidthPct;
    var lines = [];
    var cur = { items: [], width: 0, height: base };
    for (i = 0; i < meta.length; i++) {
      var add = meta[i].w + (cur.items.length ? spaceW : 0);
      if (cur.items.length && cur.width + add > maxW) {
        lines.push(cur);
        cur = { items: [], width: 0, height: base };
        add = meta[i].w;
      }
      cur.items.push(meta[i]);
      cur.width += add;
      cur.height = Math.max(cur.height, meta[i].px);
    }
    if (cur.items.length) lines.push(cur);

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
      ctx.fillStyle = style.highlight || '#FFD400';
      ctx.fillText(spk, sx, sy);
    }

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var x = (W - line.width) / 2;
      var y = baseY + li * lineStep;

      if (style.boxColor) {
        var padX = base * 0.32, padY = base * 0.22;
        ctx.fillStyle = style.boxColor;
        roundRect(ctx, x - padX, y - line.height - padY + line.height * 0.18,
                  line.width + padX * 2, line.height + padY * 2, style.boxRadius);
        ctx.fill();
      }

      for (var wi = 0; wi < line.items.length; wi++) {
        var it = line.items[wi];
        setFont(it.px);
        var boxed = it.hl && style.highlightStyle === 'box';

        // Captions.ai signature: highlighted word sits on a rounded pill
        if (boxed) {
          var bpadX = it.px * 0.22, bpadY = it.px * 0.16;
          var br = Math.min((it.px + 2 * bpadY) * 0.32, style.boxRadius || 14);
          ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
          ctx.fillStyle = style.highlight;
          roundRect(ctx, x - bpadX, y - it.px + it.px * 0.16 - bpadY,
                    it.w + bpadX * 2, it.px + bpadY * 2, br);
          ctx.fill();
        }

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        if (style.glow && !boxed) { ctx.shadowColor = style.glow; ctx.shadowBlur = it.px * 0.35; }
        // outline (skip on boxed words — the pill already separates them)
        if (style.stroke && style.strokeWidth && !boxed) {
          ctx.strokeStyle = style.stroke;
          ctx.lineWidth = style.strokeWidth;
          ctx.strokeText(it.word, x, y);
        }
        ctx.fillStyle = boxed ? contrastColor(style.highlight)
                              : (it.hl ? style.highlight : style.fill);
        ctx.fillText(it.word, x, y);
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

  return {
    wrapLines: wrapLines,
    styleForFrame: styleForFrame,
    drawFrame: drawFrame,
    renderFrames: renderFrames
  };
});
