/*
 * Pulse — a vertical short from a multi-camera podcast.
 *
 * The owner: "in podcasts we have three cameras, left, right and center.
 * While converting podcasts into shorts … use all three cameras — when
 * someone is speaking show the left camera or the right camera, sometimes
 * the center. Since it's vertical, you have to know exactly where to zoom in:
 * if someone in the center frame is talking to the left side, focus there
 * and fit them in the frame. Same for the left and right cameras."
 *
 * Which camera shows when is the podcast director's own plan (Podcast
 * cameras: each camera row names its mic; a row with no mic is the wide
 * shot). This module decides WHERE inside each camera the 9:16 window goes:
 *   subjects(frames, w, h)       the people in a camera's frames — where the
 *                                picture moves (people do, the set doesn't)
 *                                and where there is skin — with each one's
 *                                movement over time
 *   assign(subjects, mics)       which person is which mic: the person whose
 *                                head moves while that mic is loud
 *   cropFor(subject, src, aspect, o)  the window: the person centred, head
 *                                room above, zoomed in on a wide shot
 *   pieces(keep, plan, speech, o)    the short's stretches cut by the
 *                                camera plan, each wide piece told who talks
 *                                (or that both do: then both are stacked)
 *   filterArgs(...)              the one ffmpeg pass that makes it
 * Pure (no DOM, no Node) — it unit-tests in Node; main.js reads the frames
 * and the mics with ffmpeg and runs the render.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPPodShort = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* Skin likelihood of one RGB pixel (YCbCr box rule widened for Indian
     skin tones and warm studio light), 0..1. */
  function skin(r, g, b) {
    var y = 0.299 * r + 0.587 * g + 0.114 * b;
    var cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    var cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (y < 40 || y > 245) return 0;
    if (cr < 133 || cr > 180 || cb < 77 || cb > 130) return 0;
    return 1;
  }

  /* The people in a camera's frames. frames: [Uint8Array(w*h*3) RGB], in
     time order (e.g. 2 a second). Returns up to 4 subjects, biggest first:
     { x0, x1, y0, y1 (0..1 of the frame), cx, energy, series: [movement per
     frame step] }. Empty when nothing moves and nothing looks like skin. */
  function subjects(frames, w, h, o) {
    o = o || {};
    var n = frames ? frames.length : 0;
    if (!n || !w || !h) return [];
    var N = w * h, motion = new Float32Array(N), sk = new Float32Array(N), luma = [];
    for (var f = 0; f < n; f++) {
      var fr = frames[f], L = new Float32Array(N);
      for (var p = 0, q = 0; p < N; p++, q += 3) {
        L[p] = 0.299 * fr[q] + 0.587 * fr[q + 1] + 0.114 * fr[q + 2];
        sk[p] += skin(fr[q], fr[q + 1], fr[q + 2]);
      }
      if (f > 0) { var P = luma[f - 1]; for (p = 0; p < N; p++) motion[p] += Math.abs(L[p] - P[p]); }
      luma.push(L);
    }
    var mN = Math.max(1, n - 1);
    // what a person adds: movement (weighted up where there is skin) and
    // skin itself, the upper part of the frame counting more (heads)
    var score = new Float32Array(N), col = new Float32Array(w);
    for (var y = 0; y < h; y++) {
      var wy = y < h * 0.7 ? 1 : 0.5;
      for (var x = 0; x < w; x++) {
        var i = y * w + x, m = motion[i] / mN, s = sk[i] / n;
        var v = (Math.min(40, m) / 40) * (0.4 + s) + s * 0.35;
        score[i] = v; col[x] += v * wy;
      }
    }
    // smooth the column profile (5% of the width)
    var rad = Math.max(1, Math.round(w * 0.025)), sm = new Float32Array(w);
    for (x = 0; x < w; x++) {
      var t = 0, c = 0;
      for (var k = Math.max(0, x - rad); k <= Math.min(w - 1, x + rad); k++) { t += col[k]; c++; }
      sm[x] = t / c;
    }
    var max = 0; for (x = 0; x < w; x++) if (sm[x] > max) max = sm[x];
    if (!(max > h * 0.02)) return [];
    // the peaks: each a person, at least 12% of the width apart
    var peaks = [], minSep = Math.round(w * 0.12);
    var order = []; for (x = 0; x < w; x++) order.push(x);
    order.sort(function (a, b) { return sm[b] - sm[a]; });
    for (var oi = 0; oi < order.length && peaks.length < 4; oi++) {
      var px = order[oi];
      if (sm[px] < max * 0.35) break;
      if (peaks.some(function (pk) { return Math.abs(pk - px) < minSep; })) continue;
      if ((px > 0 && sm[px - 1] > sm[px]) || (px < w - 1 && sm[px + 1] > sm[px])) continue;
      peaks.push(px);
    }
    peaks.sort(function (a, b) { return a - b; });
    // two peaks are ONE person (both shoulders of someone who sways, the
    // moving edges of one body) when there is no real dip between them, or
    // when that person's skin runs unbroken from one to the other — two
    // people always have some of the set between them
    var skCol = new Float32Array(w);
    for (x = 0; x < w; x++) { var sc = 0; for (y = 0; y < Math.round(h * 0.8); y++) sc += sk[y * w + x] / n; skCol[x] = sc / Math.round(h * 0.8); }
    for (var pi0 = 0; pi0 + 1 < peaks.length;) {
      var lo = Infinity, skLo = Infinity, pa = peaks[pi0], pb = peaks[pi0 + 1];
      for (var xv = pa; xv <= pb; xv++) { if (sm[xv] < lo) lo = sm[xv]; if (skCol[xv] < skLo) skLo = skCol[xv]; }
      var skEnds = Math.min(skCol[pa], skCol[pb]);
      var one = lo > 0.6 * Math.min(sm[pa], sm[pb]) || (skEnds > 0.05 && skLo > 0.5 * skEnds && pb - pa < w * 0.3);
      if (one) {
        // one person: a peak in the middle of them both
        var keep = Math.round((pa + pb) / 2);
        peaks.splice(pi0, 2, keep);
      } else pi0++;
    }
    var out = peaks.map(function (pk, pi) {
      // the band: out to where the profile falls under 40% of the peak, or
      // halfway to the next person
      var lim0 = pi > 0 ? Math.round((peaks[pi - 1] + pk) / 2) : 0;
      var lim1 = pi < peaks.length - 1 ? Math.round((peaks[pi + 1] + pk) / 2) : w - 1;
      var x0 = pk, x1 = pk;
      while (x0 > lim0 && sm[x0 - 1] > sm[pk] * 0.4) x0--;
      while (x1 < lim1 && sm[x1 + 1] > sm[pk] * 0.4) x1++;
      // rows: where this band holds a person
      var rows = new Float32Array(h), rmax = 0;
      for (var yy = 0; yy < h; yy++) {
        var rs = 0; for (var xx = x0; xx <= x1; xx++) rs += score[yy * w + xx];
        rows[yy] = rs / (x1 - x0 + 1); if (rows[yy] > rmax) rmax = rows[yy];
      }
      var y0 = 0, y1 = h - 1;
      while (y0 < h - 1 && rows[y0] < rmax * 0.3) y0++;
      while (y1 > y0 && rows[y1] < rmax * 0.3) y1--;
      // movement inside the band, frame step by frame step
      var series = [];
      for (var ff = 1; ff < n; ff++) {
        var A = luma[ff], B = luma[ff - 1], sum = 0;
        for (yy = y0; yy <= y1; yy++) for (xx = x0; xx <= x1; xx++) sum += Math.abs(A[yy * w + xx] - B[yy * w + xx]);
        series.push(sum / ((x1 - x0 + 1) * (y1 - y0 + 1)));
      }
      // the person's middle: the weighted centre of the whole band (the
      // peak sits on a moving edge — a swaying shoulder — not the middle)
      var energy = 0, mx = 0;
      for (xx = x0; xx <= x1; xx++) { energy += sm[xx]; mx += sm[xx] * (xx + 0.5); }
      return { x0: x0 / w, x1: (x1 + 1) / w, y0: y0 / h, y1: (y1 + 1) / h, cx: (energy > 0 ? mx / energy : pk + 0.5) / w, energy: energy, series: series };
    });
    out.sort(function (a, b) { return b.energy - a.energy; });
    return out;
  }

  function pearson(a, b) {
    var n = Math.min(a.length, b.length);
    if (n < 3) return 0;
    var ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var sab = 0, saa = 0, sbb = 0;
    for (i = 0; i < n; i++) { var da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    return (saa > 0 && sbb > 0) ? sab / Math.sqrt(saa * sbb) : 0;
  }

  /* Which person is which mic. mics: [series] of loudness per frame step,
     aligned with the subjects' series. Returns, per mic, the index of its
     person in `subjs` (or -1), each person used once, the best match first. */
  function assign(subjs, mics) {
    var pairs = [];
    (mics || []).forEach(function (m, mi) {
      (subjs || []).forEach(function (s, si) { pairs.push({ mi: mi, si: si, r: pearson(s.series, m) }); });
    });
    pairs.sort(function (a, b) { return b.r - a.r; });
    var out = (mics || []).map(function () { return -1; }), usedS = {};
    pairs.forEach(function (p) {
      if (out[p.mi] !== -1 || usedS[p.si]) return;
      if (p.r < 0.05) return;            // no tie between this mic and anyone's movement
      out[p.mi] = p.si; usedS[p.si] = true;
    });
    return out;
  }

  /* The source window (pixels) for a subject in a src.w × src.h frame at
     aspect (w/h of the short). The person is centred, with head room above:
     a close shot keeps the full height; a wide shot (the person takes less
     than ~45% of the window) zooms in until they fill about 60% of its width,
     never past o.minHeight of the frame's height (default 62%, so the picture
     stays sharp). No subject → the centre of the frame. */
  function cropFor(subj, src, aspect, o) {
    o = o || {};
    var minH = (o.minHeight || 0.62) * src.h;
    var ch = src.h, cw = ch * aspect;
    if (cw > src.w) { cw = src.w; ch = cw / aspect; }
    var cx = src.w / 2, top = 0;
    if (subj) {
      var pw = (subj.x1 - subj.x0) * src.w;
      cx = subj.cx * src.w;
      if (o.zoom !== false && pw < cw * 0.45) {
        var want = Math.max(minH, Math.min(ch, (pw / 0.6) / aspect));
        ch = want; cw = ch * aspect;
      }
      top = subj.y0 * src.h - ch * 0.12;          // head room above the head
    }
    var x = Math.round(Math.max(0, Math.min(src.w - cw, cx - cw / 2)));
    var y = Math.round(Math.max(0, Math.min(src.h - ch, top)));
    return { x: x, y: y, w: Math.round(cw) - (Math.round(cw) % 2), h: Math.round(ch) - (Math.round(ch) % 2) };
  }

  /* The short's stretches cut by the camera plan. keep: [{start,end}] (the
     tightened short, sequence time); plan: [{start,end,angle}] (the podcast
     director's); speech(t0, t1) → index of the mic talking most, or -1 when
     nobody, or 'both' when two talk. Pieces shorter than o.minPiece (0.7 s)
     join the one before — a camera never flashes. Each piece:
     {start,end,angle,who} in sequence time. */
  function pieces(keep, plan, speech, o) {
    o = o || {};
    var minPiece = o.minPiece != null ? o.minPiece : 0.7;
    var out = [];
    (keep || []).forEach(function (k) {
      var covered = (plan || []).filter(function (p) { return p.end > k.start + 1e-3 && p.start < k.end - 1e-3; })
        .sort(function (a, b) { return a.start - b.start; });
      if (!covered.length) { out.push({ start: k.start, end: k.end, angle: o.fallbackAngle || 0 }); return; }
      covered.forEach(function (p) {
        out.push({ start: Math.max(k.start, p.start), end: Math.min(k.end, p.end), angle: p.angle });
      });
    });
    // a piece too short to read joins the one before it (when they touch):
    // a camera never flashes; the same camera twice in a row is one piece
    var merged = [];
    out.forEach(function (p) {
      var last = merged[merged.length - 1];
      var touches = last && Math.abs(last.end - p.start) < 1e-3;
      if (touches && (p.angle === last.angle || p.end - p.start < minPiece)) { last.end = p.end; return; }
      merged.push({ start: p.start, end: p.end, angle: p.angle });
    });
    // …and a too-short FIRST piece joins the one after it
    if (merged.length > 1 && merged[0].end - merged[0].start < minPiece && Math.abs(merged[0].end - merged[1].start) < 1e-3) {
      merged[1].start = merged[0].start; merged.shift();
    }
    merged.forEach(function (p) { p.who = speech ? speech(p.start, p.end) : -1; });
    return merged;
  }

  /* The one ffmpeg pass. inputs: [{path, base}] (each file once, read from
     `base` seconds of the media); pieces: [{input, from, to, crops:[{x,y,w,h}]}]
     (from/to in that input's media seconds; one crop fills the frame, two
     are stacked top/bottom); audio: [{input, channel|null}] mixed under every
     piece; target {w,h}; hookPng (optional, shown for 3 s); out path. */
  function filterArgs(inputs, segs, audio, target, hookPng, outPath) {
    var args = ['-y', '-hide_banner'];
    var last = {};
    segs.forEach(function (p) { last[p.input] = Math.max(last[p.input] || 0, p.to); });
    audio.forEach(function (a) { segs.forEach(function (p) { last[a.input] = Math.max(last[a.input] || 0, p.toAudio != null ? p.toAudio[a.input] : p.to); }); });
    inputs.forEach(function (inp, i) {
      args.push('-ss', Math.max(0, inp.base).toFixed(3), '-t', Math.max(1, (last[i] || inp.base + 1) - inp.base + 0.5).toFixed(3), '-i', inp.path);
    });
    var hookIdx = -1;
    if (hookPng) { hookIdx = inputs.length; args.push('-loop', '1', '-t', '3.2', '-i', hookPng); }
    var useV = {}, useA = {};
    segs.forEach(function (p) { useV[p.input] = (useV[p.input] || 0) + p.crops.length; });
    audio.forEach(function (a) { useA[a.input] = (useA[a.input] || 0) + segs.length; });
    var fc = [], vq = {}, aq = {};
    Object.keys(useV).forEach(function (k) {
      var labels = []; for (var i = 0; i < useV[k]; i++) labels.push('v' + k + '_' + i);
      fc.push('[' + k + ':v]fps=30,split=' + useV[k] + labels.map(function (l) { return '[' + l + ']'; }).join(''));
      vq[k] = labels;
    });
    Object.keys(useA).forEach(function (k) {
      var labels = []; for (var i = 0; i < useA[k]; i++) labels.push('a' + k + '_' + i);
      fc.push('[' + k + ':a]asplit=' + useA[k] + labels.map(function (l) { return '[' + l + ']'; }).join(''));
      aq[k] = labels;
    });
    var concatIn = [];
    segs.forEach(function (p, si) {
      var b = inputs[p.input].base, from = (p.from - b).toFixed(3), to = (p.to - b).toFixed(3);
      if (p.crops.length === 1) {
        var c = p.crops[0];
        fc.push('[' + vq[p.input].shift() + ']trim=start=' + from + ':end=' + to + ',setpts=PTS-STARTPTS,crop=' + c.w + ':' + c.h + ':' + c.x + ':' + c.y +
          ',scale=' + target.w + ':' + target.h + ',setsar=1[pv' + si + ']');
      } else {
        var half = Math.round(target.h / p.crops.length / 2) * 2, cells = [];
        p.crops.forEach(function (c, ci) {
          fc.push('[' + vq[p.input].shift() + ']trim=start=' + from + ':end=' + to + ',setpts=PTS-STARTPTS,crop=' + c.w + ':' + c.h + ':' + c.x + ':' + c.y +
            ',scale=' + target.w + ':' + half + ':force_original_aspect_ratio=increase,crop=' + target.w + ':' + half + ',setsar=1[pv' + si + 'c' + ci + ']');
          cells.push('[pv' + si + 'c' + ci + ']');
        });
        fc.push(cells.join('') + 'vstack=inputs=' + cells.length + ',scale=' + target.w + ':' + target.h + ',setsar=1[pv' + si + ']');
      }
      var mix = [];
      audio.forEach(function (a, ai) {
        var ab = inputs[a.input].base, af = p.fromAudio ? p.fromAudio[a.input] : p.from, at = p.toAudio ? p.toAudio[a.input] : p.to;
        var pan = a.channel != null ? 'pan=mono|c0=c' + a.channel + ',' : '';
        fc.push('[' + aq[a.input].shift() + ']' + pan + 'atrim=start=' + (af - ab).toFixed(3) + ':end=' + (at - ab).toFixed(3) +
          ',asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[pa' + si + '_' + ai + ']');
        mix.push('[pa' + si + '_' + ai + ']');
      });
      if (mix.length > 1) fc.push(mix.join('') + 'amix=inputs=' + mix.length + ':normalize=0:duration=first[pa' + si + ']');
      else if (mix.length === 1) fc.push(mix[0] + 'anull[pa' + si + ']');
      concatIn.push('[pv' + si + ']' + (mix.length ? '[pa' + si + ']' : ''));
    });
    var hasA = audio.length > 0;
    fc.push(concatIn.join('') + 'concat=n=' + segs.length + ':v=1:a=' + (hasA ? 1 : 0) + '[cv]' + (hasA ? '[ca]' : ''));
    var vout = 'cv';
    if (hookIdx >= 0) { fc.push('[cv][' + hookIdx + ':v]overlay=0:0:eof_action=pass:enable=\'lt(t,3)\'[vo]'); vout = 'vo'; }
    args.push('-filter_complex', fc.join(';'), '-map', '[' + vout + ']');
    if (hasA) args.push('-map', '[ca]', '-c:a', 'aac', '-ar', '48000');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', outPath);
    return args;
  }

  /* Loudness (dB) per step from raw 16-bit mono PCM bytes. */
  function levels(bytes, rate, step) {
    var per = Math.max(1, Math.round(rate * step)), out = [];
    for (var i = 0; i + 1 < bytes.length; i += per * 2) {
      var s = 0, c = 0;
      for (var j = i; j + 1 < Math.min(bytes.length, i + per * 2); j += 2) {
        var v = (bytes[j] | (bytes[j + 1] << 8)); if (v > 32767) v -= 65536;
        s += v * v; c++;
      }
      out.push(c ? 10 * Math.log(Math.max(1e-9, s / c / (32768 * 32768))) / Math.LN10 : -90);
    }
    return out;
  }

  /* Who talks over [i0, i1) steps of the mics' dB series: the mic loud for
     most of it, 'both' when two are each loud for over a third of it, -1
     when nobody is. Loud = within 18 dB of that mic's own loudest. */
  function talker(mics, i0, i1) {
    var share = mics.map(function (m) {
      var top = -90; m.forEach(function (v) { if (v > top) top = v; });
      var on = 0, n = 0;
      for (var i = Math.max(0, i0); i < Math.min(m.length, i1); i++) { n++; if (m[i] > top - 18 && m[i] > -50) on++; }
      return n ? on / n : 0;
    });
    var order = share.map(function (s, i) { return i; }).sort(function (a, b) { return share[b] - share[a]; });
    if (!order.length || share[order[0]] < 0.15) return -1;
    if (order.length > 1 && share[order[1]] > 0.33 && share[order[0]] > 0.33) return 'both';
    return order[0];
  }

  return { skin: skin, subjects: subjects, pearson: pearson, assign: assign, cropFor: cropFor, pieces: pieces,
           filterArgs: filterArgs, levels: levels, talker: talker };
});
