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
 * Then (v0.10.12): "it is zooming anywhere, randomly — it was supposed to
 * check where to zoom in based on the face in the frame … on all formats,
 * three cameras, one camera", and "let me mark on the screen where the
 * people are". So the framing is by FACES (pico, CPPico) or by the boxes
 * the owner marked:
 *   detectFaces / faceTracks     the faces in a camera's frames, followed
 *                                across frames, with how much each mouth
 *                                moves (who talks moves their mouth)
 *   regionTracks / markCrop      the people the owner marked, as boxes
 *   assign(people, voices)       which person is which mic / voice
 *   faceCrop(face, src, aspect)  the 9:16 window: the face about a third of
 *                                its width, the eyes in its upper third
 *   turnsFrom(series, step)      who talks when (one camera, two people)
 *   pieces(keep, plan, speech)   the short's stretches by camera / talker
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
        out.push({ start: Math.max(k.start, p.start), end: Math.min(k.end, p.end), angle: p.angle, spk: p.spk });
      });
    });
    // a piece too short to read joins the one before it (when they touch):
    // a camera never flashes; the same camera twice in a row is one piece
    var merged = [];
    out.forEach(function (p) {
      var last = merged[merged.length - 1];
      var touches = last && Math.abs(last.end - p.start) < 1e-3;
      // (one camera with two talkers: each talker's turn is its own piece)
      if (touches && ((p.angle === last.angle && p.spk === last.spk) || p.end - p.start < minPiece)) { last.end = p.end; return; }
      merged.push({ start: p.start, end: p.end, angle: p.angle, spk: p.spk });
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

  // ---- faces (pico: CPPico + the facefinder cascade) ----------------------
  var _cascade = null;
  function cascadeOf(lib, b64) {
    if (_cascade) return _cascade;
    if (!lib || !b64) return null;
    var bin = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    var bytes = new Int8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) << 24 >> 24;
    _cascade = lib.unpack_cascade(bytes);
    return _cascade;
  }
  /* The faces in one grey frame (w×h bytes): [{cx, cy, s, q}] as fractions of
     the frame (s = the face's width over the frame's width), strongest first.
     q > 10 keeps faces and drops pico's weak false hits (5–7 on shirts). */
  function detectFaces(gray, w, h, lib, b64, o) {
    o = o || {};
    var classify = cascadeOf(lib, b64);
    if (!classify) return [];
    var minsize = Math.max(16, Math.round(Math.min(w, h) * (o.minFace || 0.05)));
    var dets = lib.run_cascade({ pixels: gray, nrows: h, ncols: w, ldim: w }, classify,
      { shiftfactor: 0.1, minsize: minsize, maxsize: Math.round(Math.min(w, h) * 0.95), scalefactor: 1.1 });
    dets = lib.cluster_detections(dets, 0.2).filter(function (d) { return d[3] > (o.minQ || 10); });
    dets.sort(function (a, b) { return b[3] - a[3]; });
    return dets.map(function (d) { return { cx: d[1] / w, cy: d[0] / h, s: d[2] / w, q: d[3] }; });
  }

  /* The people in a camera's frames, by their faces: each detection joined
     to the face it continues (near where it was, a similar size), a track
     kept when it is seen in at least 20% of the frames. Each track: its
     middle position and size (medians), how often it was seen, and how much
     its MOUTH moves frame to frame (the lower part of the face box) — the
     one who talks moves their mouth. frames: grey w×h. */
  /* Movement inside [x0..x1] × [y0..y1] per step. With o.motion — frames of
     the movement itself (ffmpeg: each frame's difference from the one
     before, averaged over the step, so a mouth that opens and shuts between
     two sampled frames still counts) — read straight from them; else the
     difference between consecutive sampled frames. Same length as frames. */
  function movementIn(frames, motion, w, x0, x1, y0, y1) {
    var n = frames.length, series = [], f, y, x, sum, cnt;
    for (f = 0; f < n; f++) {
      sum = 0; cnt = 0;
      if (motion && motion[f]) {
        var M = motion[f];
        for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) { sum += M[y * w + x]; cnt++; }
      } else if (f > 0) {
        var A = frames[f], B = frames[f - 1];
        for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) { sum += Math.abs(A[y * w + x] - B[y * w + x]); cnt++; }
      }
      series.push(cnt ? sum / cnt : 0);
    }
    return series;
  }
  function faceTracks(frames, w, h, lib, b64, o) {
    var tracks = [], n = frames.length;
    frames.forEach(function (g, fi) {
      detectFaces(g, w, h, lib, b64, o).forEach(function (d) {
        var best = null, bd = Infinity;
        tracks.forEach(function (t) {
          if (t.last === fi) return;
          var ratio = d.s / t.s, dist = Math.abs(d.cx - t.cx) + Math.abs(d.cy - t.cy) * 0.5;
          if (ratio > 0.6 && ratio < 1.6 && dist < Math.max(t.s * 1.2, 0.06) && dist < bd) { bd = dist; best = t; }
        });
        if (!best) { best = { xs: [], ys: [], ss: [], qs: [], cx: d.cx, cy: d.cy, s: d.s, last: -1, seen: [] }; tracks.push(best); }
        best.xs.push(d.cx); best.ys.push(d.cy); best.ss.push(d.s); best.qs.push(d.q); best.seen.push(fi); best.last = fi;
        var k = best.xs.length;
        best.cx += (d.cx - best.cx) / k; best.cy += (d.cy - best.cy) / k; best.s += (d.s - best.s) / k;
      });
    });
    function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }); return b.length ? b[Math.floor(b.length / 2)] : 0; }
    var out = tracks.filter(function (t) { return t.xs.length >= Math.max(1, Math.round(n * 0.2)); }).map(function (t) {
      var tr = { cx: median(t.xs), cy: median(t.ys), s: median(t.ss), seen: t.xs.length / Math.max(1, n), q: median(t.qs) };
      // mouth movement per step: the lower part of the face box
      var x0 = Math.max(0, Math.round((tr.cx - tr.s * 0.35) * w)), x1 = Math.min(w - 1, Math.round((tr.cx + tr.s * 0.35) * w));
      var y0 = Math.max(0, Math.round((tr.cy + tr.s * 0.05 * w / h) * h)), y1 = Math.min(h - 1, Math.round((tr.cy + tr.s * 0.55 * w / h) * h));
      tr.series = movementIn(frames, (o && o.motion) || null, w, x0, x1, y0, y1);
      tr.x0 = tr.cx - tr.s / 2; tr.x1 = tr.cx + tr.s / 2; tr.y0 = tr.cy - tr.s * 0.5 * w / h; tr.y1 = tr.cy + tr.s * 0.5 * w / h;
      return tr;
    });
    out.sort(function (a, b) { return a.cx - b.cx; });
    return out;
  }

  /* The 9:16 window for a face in a src.w × src.h frame. A vertical short
     frames a talking head with the face about a third of the window wide
     and the eyes in its upper third: a close shot (big face) keeps the full
     height; a wide shot zooms in until the face fills ~34% of the width —
     never past o.minHeight of the frame's height (default 50%, so the
     picture stays sharp). */
  function faceCrop(face, src, aspect, o) {
    o = o || {};
    var ch = src.h, cw = ch * aspect;
    if (cw > src.w) { cw = src.w; ch = cw / aspect; }
    if (!face) {
      // no face: the part of the frame "Keep in frame" names (the middle by default)
      var fx = o.fallbackCx != null ? o.fallbackCx * src.w : src.w / 2;
      return { x: Math.round(Math.max(0, Math.min(src.w - cw, fx - cw / 2))) & ~1, y: Math.round((src.h - ch) / 2) & ~1, w: Math.round(cw) & ~1, h: Math.round(ch) & ~1 };
    }
    var fw = face.s * src.w, minH = (o.minHeight || 0.5) * src.h;
    var wantW = fw / (o.faceShare || 0.34);
    if (wantW < cw) { cw = Math.max(minH * aspect, wantW); ch = cw / aspect; }
    var cx = face.cx * src.w, cy = face.cy * src.h;
    var x = Math.max(0, Math.min(src.w - cw, cx - cw / 2));
    var y = Math.max(0, Math.min(src.h - ch, cy - ch * 0.36));      // the face's middle at 36% from the top
    return { x: Math.round(x) & ~1, y: Math.round(y) & ~1, w: Math.round(cw) & ~1, h: Math.round(ch) & ~1 };
  }

  /* People the owner MARKED on a frame (Shorts → 👥 Mark the people): each
     box {x, y, w, h} (fractions of the frame) becomes a person like a face
     track — its middle, and how much the picture moves inside it frame to
     frame (who talks moves), so the mics and voices match it the same way. */
  function regionTracks(frames, w, h, boxes, o) {
    return (boxes || []).map(function (b) {
      var x0 = Math.max(0, Math.round(b.x * w)), x1 = Math.min(w - 1, Math.round((b.x + b.w) * w));
      var y0 = Math.max(0, Math.round(b.y * h)), y1 = Math.min(h - 1, Math.round((b.y + b.h) * h));
      var series = movementIn(frames, (o && o.motion) || null, w, x0, x1, y0, y1);
      return { marked: true, box: b, cx: b.x + b.w / 2, cy: b.y + b.h * 0.3, s: b.w * 0.5, x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h, series: series, seen: 1 };
    });
  }
  /* The window for a marked person: the whole box in view with a little room
     (8%), its top near the window's top; never smaller than o.minHeight of
     the frame (sharpness), never bigger than the frame. */
  function markCrop(box, src, aspect, o) {
    o = o || {};
    var bw = box.w * src.w, bh = box.h * src.h, minH = (o.minHeight || 0.4) * src.h;
    var ch = Math.max(minH, bh * 1.08, (bw * 1.08) / aspect);
    ch = Math.min(ch, src.h);
    var cw = ch * aspect;
    if (cw > src.w) { cw = src.w; ch = cw / aspect; }
    var cx = (box.x + box.w / 2) * src.w;
    var x = Math.max(0, Math.min(src.w - cw, cx - cw / 2));
    var y = Math.max(0, Math.min(src.h - ch, box.y * src.h - ch * 0.04));
    return { x: Math.round(x) & ~1, y: Math.round(y) & ~1, w: Math.round(cw) & ~1, h: Math.round(ch) & ~1 };
  }

  /* Who talks when, as turns of at least minHold seconds: series[k] is
     speaker k's activity per step (louder / moving more = talking). Each step
     goes to the most active speaker when they clearly lead (1.4× the next),
     else stays with whoever had it; turns shorter than minHold join the one
     before. → [{start, end, spk}] in seconds from the first step. */
  function turnsFrom(series, step, minHold) {
    var n = 0; series.forEach(function (s) { n = Math.max(n, s.length); });
    if (!n || !series.length) return [];
    var cur = -1, lab = [];
    for (var i = 0; i < n; i++) {
      var order = series.map(function (s, k) { return k; }).sort(function (a, b) { return (series[b][i] || 0) - (series[a][i] || 0); });
      var top = order[0], second = order[1];
      var lead = series.length < 2 || (series[top][i] || 0) > 1.4 * (series[second][i] || 0) + 1e-6;
      if (cur < 0 || (lead && top !== cur)) cur = top;
      lab.push(cur);
    }
    var turns = [];
    lab.forEach(function (k, i) {
      var last = turns[turns.length - 1];
      if (last && last.spk === k) last.end = (i + 1) * step;
      else turns.push({ start: i * step, end: (i + 1) * step, spk: k });
    });
    var merged = [];
    turns.forEach(function (t) {
      var last = merged[merged.length - 1];
      if (last && (t.end - t.start < minHold || t.spk === last.spk)) last.end = t.end;
      else merged.push({ start: t.start, end: t.end, spk: t.spk });
    });
    if (merged.length > 1 && merged[0].end - merged[0].start < minHold) { merged[1].start = 0; merged.shift(); }
    return merged;
  }

  return { detectFaces: detectFaces, faceTracks: faceTracks, faceCrop: faceCrop, turnsFrom: turnsFrom,
           regionTracks: regionTracks, markCrop: markCrop,
           pearson: pearson, assign: assign, pieces: pieces,
           filterArgs: filterArgs, levels: levels, talker: talker };
});
