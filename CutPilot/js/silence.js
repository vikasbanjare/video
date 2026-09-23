/*
 * Pulse — silence range math.
 * Pure functions, no DOM/CEP dependencies, so they can be unit-tested in Node.
 * All times are in seconds relative to the analyzed media.
 */
(function (root, factory) {
  var lib = factory();
  // CEP panels with --enable-nodejs have BOTH `module` and `window`, so
  // register in both places (module-only broke the panel: "CPSilence is not defined").
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPSilence = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function dbToLinear(db) {
    return Math.pow(10, db / 20);
  }

  /*
   * Detect silent ranges in a mono Float32 sample buffer using windowed RMS.
   * opts: { thresholdDb, windowSec, hopSec }
   * Returns raw ranges [{start, end}] — call refineSilences() afterwards.
   */
  function detectSilences(samples, sampleRate, opts) {
    opts = opts || {};
    var threshold = dbToLinear(opts.thresholdDb != null ? opts.thresholdDb : -40);
    var windowSize = Math.max(1, Math.round((opts.windowSec || 0.05) * sampleRate));
    var hop = Math.max(1, Math.round((opts.hopSec || 0.01) * sampleRate));

    var ranges = [];
    var silentFrom = -1;
    var i, j, sum, rms, t;

    for (i = 0; i + windowSize <= samples.length; i += hop) {
      sum = 0;
      for (j = i; j < i + windowSize; j++) sum += samples[j] * samples[j];
      rms = Math.sqrt(sum / windowSize);
      t = i / sampleRate;
      if (rms < threshold) {
        if (silentFrom < 0) silentFrom = t;
      } else if (silentFrom >= 0) {
        ranges.push({ start: silentFrom, end: t });
        silentFrom = -1;
      }
    }
    if (silentFrom >= 0) ranges.push({ start: silentFrom, end: samples.length / sampleRate });
    return ranges;
  }

  /* Merge ranges separated by gaps smaller than `gap` seconds. */
  function mergeRanges(ranges, gap) {
    if (!ranges.length) return [];
    var sorted = ranges.slice().sort(function (a, b) { return a.start - b.start; });
    var out = [{ start: sorted[0].start, end: sorted[0].end }];
    for (var i = 1; i < sorted.length; i++) {
      var last = out[out.length - 1];
      if (sorted[i].start - last.end <= gap) {
        last.end = Math.max(last.end, sorted[i].end);
      } else {
        out.push({ start: sorted[i].start, end: sorted[i].end });
      }
    }
    return out;
  }

  /*
   * Production pipeline over raw silence ranges:
   *  - merge near-adjacent silences (mergeGap)
   *  - drop silences shorter than minSilence (natural breaths stay)
   *  - shrink each silence by `padding` on both sides so speech never clips
   * opts: { minSilence, padding, mergeGap, totalDuration }
   */
  function refineSilences(ranges, opts) {
    opts = opts || {};
    var minSilence = opts.minSilence != null ? opts.minSilence : 0.6;
    var padding = opts.padding != null ? opts.padding : 0.12;
    var merged = mergeRanges(ranges, opts.mergeGap != null ? opts.mergeGap : 0.05);
    var out = [];
    for (var i = 0; i < merged.length; i++) {
      var r = merged[i];
      if (r.end - r.start < minSilence) continue;
      var start = r.start + padding;
      var end = r.end - padding;
      // Padding at the head/tail of the media is pointless — nothing to protect.
      if (r.start <= 0.001) start = r.start;
      if (opts.totalDuration && r.end >= opts.totalDuration - 0.001) end = r.end;
      if (end - start >= Math.max(0.05, minSilence - 2 * padding)) {
        out.push({ start: start, end: end });
      }
    }
    return out;
  }

  /*
   * Invert silences into keep-segments over [0, totalDuration].
   * Segments shorter than minKeep get absorbed into the preceding cut
   * (a 3-frame sliver between two pauses is never worth keeping).
   */
  function invertToKeep(silences, totalDuration, minKeep) {
    minKeep = minKeep || 0;
    var keep = [];
    var cursor = 0;
    for (var i = 0; i < silences.length; i++) {
      var s = silences[i];
      if (s.start > cursor) keep.push({ start: cursor, end: s.start });
      cursor = Math.max(cursor, s.end);
    }
    if (cursor < totalDuration) keep.push({ start: cursor, end: totalDuration });
    return keep.filter(function (k) { return k.end - k.start >= minKeep; });
  }

  /* Total seconds covered by a range list. */
  function totalDuration(ranges) {
    var t = 0;
    for (var i = 0; i < ranges.length; i++) t += ranges[i].end - ranges[i].start;
    return t;
  }

  /*
   * Parse ffmpeg `silencedetect` stderr output into ranges.
   * Lines look like:
   *   [silencedetect @ 0x...] silence_start: 12.345
   *   [silencedetect @ 0x...] silence_end: 15.678 | silence_duration: 3.333
   */
  function parseFfmpegSilences(stderrText, mediaDuration) {
    var ranges = [];
    var pending = null;
    var re = /silence_(start|end):\s*(-?[\d.]+)/g;
    var m;
    while ((m = re.exec(stderrText)) !== null) {
      var t = parseFloat(m[2]);
      if (m[1] === 'start') {
        pending = Math.max(0, t);
      } else if (pending != null) {
        ranges.push({ start: pending, end: t });
        pending = null;
      }
    }
    if (pending != null && mediaDuration) ranges.push({ start: pending, end: mediaDuration });
    return ranges;
  }

  // ==========================================================================
  // ADAPTIVE DEAD-AIR DETECTOR — what "Clean up my video" listens with.
  // ffmpeg's silencedetect tests every SAMPLE's peak against one fixed dB
  // number, so a room with a fan never goes "silent" while a quiet room cuts
  // soft words, and the old easing ladder climbed until anything at all was
  // found. This works the way a person listens:
  //  1. 30 ms RMS loudness every 10 ms, per microphone (makeEnvelopeBuilder);
  //  2. each mic's OWN room noise (10th percentile, digital zero ignored) and
  //     speech level (60th percentile of what is clearly above the room);
  //  3. gate = room + a share of the room→speech distance, never within 8 dB
  //     of speech, with hysteresis so noise flicker can't split a pause;
  //  4. a moment is dead air only when EVERY mic is quiet (combineMics) — a
  //     two-mic podcast never loses the guest's answers;
  //  5. auto-editor-style smoothing (public domain idea): a click or a lone
  //     breath between two pauses joins the pause, cuts shorter than minCut
  //     are dropped, and every cut keeps pre-roll before the next word and
  //     post-roll after the last one (planCuts).
  // ==========================================================================
  var HOP = 0.01;                 // analysis step, seconds
  var DIGITAL_SILENCE_DB = -90;   // at/below this = digital zero (camera pre-roll, fades, mute button)
  var HYSTERESIS_DB = 3;

  /* The three presets. Keyed by the panel's existing strength ids:
     strong = Reel (tight), balanced = YouTube (balanced), gentle = Podcast
     (natural). Numbers from the research brief (auto-editor / unsilence /
     DeadAir / Descript): a podcast pause over 0.8 s is shortened to 0.35 s
     (pre+post), a YouTube pause over 0.5 s to 0.30 s, a reel pause over 0.3 s
     to 0.18 s. `share` is how far from the room noise toward speech the gate
     sits. Every number moves the same way from Podcast → Reel, so a tighter
     preset can never keep more than a looser one. */
  var TUNING = {
    strong:   { key: 'reel',    label: 'Reel (tight)',       share: 0.35, minPause: 0.30, pre: 0.08, post: 0.10, minCut: 0.20, minClip: 0.10, breathIsland: 0.30 },
    balanced: { key: 'youtube', label: 'YouTube (balanced)', share: 0.30, minPause: 0.50, pre: 0.13, post: 0.17, minCut: 0.20, minClip: 0.10, breathIsland: 0.25 },
    gentle:   { key: 'podcast', label: 'Podcast (natural)',  share: 0.25, minPause: 0.80, pre: 0.15, post: 0.20, minCut: 0.25, minClip: 0.10, breathIsland: 0.15 }
  };
  function tuning(name) {
    var t = TUNING[name] || TUNING.balanced, o = {};
    for (var k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) o[k] = t[k]; }
    return o;
  }

  /*
   * Streaming loudness envelope. Feed signed 16-bit little-endian PCM bytes in
   * any chunking (pushBytes) or float samples (pushFloats); finish() returns
   * { db: Float32Array, hop, duration } — one 30 ms RMS level (dBFS) per 10 ms.
   * Only per-10 ms energies are kept, so an hour of audio is ~360k numbers.
   */
  function makeEnvelopeBuilder(sampleRate, hopSec) {
    var hop = hopSec || HOP;
    var hopN = Math.max(1, Math.round(sampleRate * hop));
    var energies = [], acc = 0, n = 0, low = -1;
    function push(v) { acc += v * v; if (++n === hopN) { energies.push(acc); acc = 0; n = 0; } }
    return {
      pushBytes: function (bytes) {
        var i = 0, L = bytes.length, s;
        if (low >= 0 && L > 0) { s = (bytes[0] << 8) | low; if (s & 0x8000) s -= 0x10000; push(s / 32768); low = -1; i = 1; }
        for (; i + 1 < L; i += 2) { s = (bytes[i + 1] << 8) | bytes[i]; if (s & 0x8000) s -= 0x10000; push(s / 32768); }
        if (i < L) low = bytes[i];
      },
      pushFloats: function (arr) { for (var i = 0; i < arr.length; i++) push(arr[i]); },
      seconds: function () { return (energies.length * hopN + n) / sampleRate; },
      finish: function () {
        var N = energies.length, db = new Float32Array(N);
        for (var i = 0; i < N; i++) {
          var a = i > 0 ? energies[i - 1] : energies[i], c = i + 1 < N ? energies[i + 1] : energies[i];
          var ms = (a + energies[i] + c) / (3 * hopN);
          db[i] = ms > 1e-12 ? 10 * Math.log(ms) / Math.LN10 : -120;
        }
        return { db: db, hop: hop, duration: N * hop };
      }
    };
  }

  function pct(sorted, p) {
    if (!sorted.length) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  }

  /*
   * One microphone's levels, measured only over the envelope windows the
   * timeline actually uses (spans: [[i0, i1), …]). Digital zero is left out so a
   * silent camera pre-roll can't pretend the room is quiet.
   * Returns { floor, speech, range, threshold, continuous, digital, pauses, bed }:
   *   continuous — speech is < 10 dB above the room (sustained music, loud fan):
   *                loudness can't find dead air, only digital zero counts;
   *   digital    — nothing but digital zero here (a muted/empty mic);
   *   pauses     — share of the span spent in pauses of 1 s or more;
   *   bed        — sounds like music or steady noise, not a voice: continuous,
   *                or a narrow loudness range that never pauses (a beat). The
   *                caller leaves a bed out of the vote only when a real voice
   *                track is there to decide instead.
   * The threshold is always this mic's OWN automatic gate: Fine-tune → Manual
   * is applied by the caller, to the tracks that vote as voices.
   */
  function micLevels(db, spans, tune) {
    var share = (tune && tune.share != null) ? tune.share : 0.30;
    var n = 0, s, i, a, b;
    for (s = 0; s < spans.length; s++) {
      a = Math.max(0, Math.floor(spans[s][0])); b = Math.min(db.length, Math.ceil(spans[s][1]));
      for (i = a; i < b; i++) if (db[i] > DIGITAL_SILENCE_DB) n++;
    }
    if (n < 30) return { floor: null, speech: null, range: 0, threshold: DIGITAL_SILENCE_DB, continuous: false, digital: true, pauses: 1, bed: false };
    var vals = new Float32Array(n), j = 0;
    for (s = 0; s < spans.length; s++) {
      a = Math.max(0, Math.floor(spans[s][0])); b = Math.min(db.length, Math.ceil(spans[s][1]));
      for (i = a; i < b; i++) if (db[i] > DIGITAL_SILENCE_DB) vals[j++] = db[i];
    }
    vals.sort();
    var floor = pct(vals, 0.10);
    var lo = 0; while (lo < n && vals[lo] <= floor + 6) lo++;
    var speech = (n - lo >= 30) ? vals[lo + Math.floor(0.6 * (n - lo - 1))] : floor + 6;
    var range = speech - floor;
    var continuous = range < 10;
    var thr = continuous ? DIGITAL_SILENCE_DB : floor + Math.min(share * range, range - 8);
    var pauses = pauseShare(db, spans, thr, BED_PAUSE_SEC);
    var bed = continuous || (range < BED_MAX_RANGE && pauses < BED_MAX_PAUSES);
    return { floor: floor, speech: speech, range: range, threshold: thr, continuous: continuous, digital: false,
             pauses: pauses, bed: bed };
  }

  /* What tells a music bed from a voice. A beat is loud on every hit and dips
     between hits (13–19 dB apart), so loudness range alone called a drum loop
     a mic, and its vote blocked every cut it played under. What a beat never
     does is PAUSE: its dips are the gaps between hits, well under a second,
     while a voice stops for a second or more between thoughts (and a podcast
     mic is quiet the whole time the other person talks). */
  var BED_PAUSE_SEC = 1.0;      // a real pause, whatever the preset
  var BED_MAX_RANGE = 22;       // dB — a voice into its own mic swings 25–45 dB
  var BED_MAX_PAUSES = 0.05;    // share of its span a bed spends in such pauses (intro, a break)

  /* Share of the used windows (spans) that sit in quiet runs of at least
     minSec under `threshold`, with the same hysteresis the cut uses. */
  function pauseShare(db, spans, threshold, minSec) {
    var flags = loudFlags(db, threshold), need = Math.max(1, Math.round(minSec / HOP));
    var total = 0, paused = 0, s, i, a, b, run;
    for (s = 0; s < spans.length; s++) {
      a = Math.max(0, Math.floor(spans[s][0])); b = Math.min(db.length, Math.ceil(spans[s][1]));
      if (b <= a) continue;
      total += b - a; run = 0;
      for (i = a; i < b; i++) {
        if (!flags[i]) { run++; continue; }
        if (run >= need) paused += run;
        run = 0;
      }
      if (run >= need) paused += run;
    }
    return total ? paused / total : 0;
  }

  /* Loud(1)/quiet(0) per window with hysteresis: speech ends when the level
     drops below the gate; a quiet stretch only ends when it climbs 3 dB ABOVE
     it, so a noise flicker can't chop one pause into slivers. */
  function loudFlags(db, threshold, hyst) {
    var h = hyst != null ? hyst : HYSTERESIS_DB;
    var out = new Uint8Array(db.length);
    var loud = db.length ? db[0] > threshold : false;
    for (var i = 0; i < db.length; i++) {
      if (loud) { if (db[i] < threshold) loud = false; }
      else if (db[i] > threshold + h) loud = true;
      out[i] = loud ? 1 : 0;
    }
    return out;
  }

  /* Quiet runs of one envelope as media-time ranges (≥ minLen seconds). */
  function quietRuns(flags, env, minLen) {
    var out = [], i = 0, n = flags.length, t0 = env.start || 0, hop = env.hop || HOP;
    while (i < n) {
      if (flags[i]) { i++; continue; }
      var j = i; while (j < n && !flags[j]) j++;
      if ((j - i) * hop >= (minLen || 0) - 1e-9) out.push({ start: t0 + i * hop, end: t0 + j * hop });
      i = j;
    }
    return out;
  }

  /*
   * Lay every microphone onto ONE timeline grid (sequence seconds, 10 ms steps).
   * sources: [{ seqStart, seqEnd, inPoint, speed,
   *             env: {db, hop, start} | null   (null = unreadable → treated as speech),
   *             flags: loudFlags(env.db, …), strongDb: speech − 20 }]
   * Only sources that VOTE belong here (music beds are left out by the caller).
   * range: {start, end}. Returns { t0, hop, n, state, strong } where state is
   *   0 — no mic under this moment (never cut: b-roll/music-only stretches),
   *   1 — every mic here is quiet (dead air),
   *   2 — somebody is talking (or we could not hear this part → keep).
   */
  function combineMics(sources, range, hop) {
    hop = hop || HOP;
    var t0 = range.start;
    var n = Math.max(0, Math.ceil((range.end - range.start) / hop - 1e-9));
    var cov = new Uint8Array(n), loud = new Uint8Array(n), strong = new Uint8Array(n);
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s], sp = src.speed > 0 ? src.speed : 1;
      var g0 = Math.max(0, Math.ceil((src.seqStart - t0) / hop - 0.5 - 1e-9));
      var g1 = Math.min(n, Math.ceil((src.seqEnd - t0) / hop - 0.5 - 1e-9));
      for (var g = g0; g < g1; g++) {
        cov[g] = 1;
        if (!src.env || !src.flags) { loud[g] = 1; strong[g] = 1; continue; }
        var m = src.inPoint + (t0 + (g + 0.5) * hop - src.seqStart) * sp;
        var k = Math.floor((m - (src.env.start || 0)) / (src.env.hop || hop));
        if (k < 0 || k >= src.flags.length) { loud[g] = 1; continue; }   // not in the decoded audio → keep
        if (src.flags[k]) loud[g] = 1;
        if (src.strongDb != null && src.env.db[k] > src.strongDb) strong[g] = 1;
      }
    }
    var state = new Uint8Array(n);
    for (var q = 0; q < n; q++) state[q] = cov[q] ? (loud[q] ? 2 : 1) : 0;
    return { t0: t0, hop: hop, n: n, state: state, strong: strong };
  }

  /*
   * Turn the combined grid into cut ranges (sequence seconds).
   * tune: { minPause, pre, post, minCut, minClip, breathIsland } (see TUNING).
   *  - a loud blip shorter than minClip, or a quiet (breath-level) island
   *    shorter than breathIsland, sitting between two pauses joins the pause —
   *    no 50 ms jump cuts, no lone breath with a cut on each side;
   *  - a pause shorter than minPause stays (natural rhythm);
   *  - post-roll is kept after speech ends, pre-roll before speech starts, so
   *    word onsets and trailing-off endings are never clipped;
   *  - a cut left shorter than minCut is dropped.
   * Next to a stretch with no mic at all (state 0: head/tail of the voice
   * clip) no margin is needed — there is no word there to protect.
   */
  function planCuts(grid, tune) {
    var hop = grid.hop, st = grid.state, n = grid.n;
    var runs = [], i = 0, r, R;
    while (i < n) { var v = st[i], j = i; while (j < n && st[j] === v) j++; runs.push({ v: v, a: i, b: j }); i = j; }
    function hasStrong(x) { for (var q = x.a; q < x.b; q++) if (grid.strong[q]) return true; return false; }
    function mergeRuns(list) {
      var out = [];
      for (var k = 0; k < list.length; k++) {
        if (out.length && out[out.length - 1].v === list[k].v) out[out.length - 1].b = list[k].b;
        else out.push({ v: list[k].v, a: list[k].a, b: list[k].b });
      }
      return out;
    }
    for (var pass = 0; pass < 4; pass++) {
      var changed = false;
      for (r = 1; r < runs.length - 1; r++) {
        R = runs[r];
        if (R.v !== 2 || runs[r - 1].v !== 1 || runs[r + 1].v !== 1) continue;
        var len = (R.b - R.a) * hop;
        if (len < tune.minClip - 1e-9 || (len < tune.breathIsland - 1e-9 && !hasStrong(R))) { R.v = 1; changed = true; }
      }
      if (!changed) break;
      runs = mergeRuns(runs);
    }
    var cuts = [];
    for (r = 0; r < runs.length; r++) {
      R = runs[r];
      if (R.v !== 1) continue;
      var s = grid.t0 + R.a * hop, e = grid.t0 + R.b * hop;
      if (e - s < tune.minPause - 1e-9) continue;
      var prev = runs[r - 1], next = runs[r + 1];
      var cs = s + ((!prev || prev.v === 2) ? tune.post : 0);
      var ce = e - ((!next || next.v === 2) ? tune.pre : 0);
      if (ce - cs >= tune.minCut - 1e-9) cuts.push({ start: cs, end: ce });
    }
    return cuts;
  }

  /* True when a word list carries real per-word timings (median word ≤ 1 s),
     not line-level cues spread evenly across pauses. */
  function isWordLevel(words) {
    if (!words || words.length < 3) return false;
    var d = [];
    for (var i = 0; i < words.length; i++) d.push(words[i].end - words[i].start);
    d.sort(function (a, b) { return a - b; });
    return d[Math.floor(d.length / 2)] <= 1.0;
  }

  /*
   * Carve spoken words (sequence time) out of cut ranges, with room for ASR
   * timing drift (before/after). Only word-level timings are trusted; a coarse
   * line-level transcript would "protect" every real pause away, so it is
   * ignored. With word-level timings the protected result stands even if it is
   * empty — a word is never cut to make the numbers look better.
   */
  function protectCutsFromWords(cuts, words, opts) {
    opts = opts || {};
    if (!cuts || !cuts.length || !isWordLevel(words)) return (cuts || []).slice();
    var before = opts.before != null ? opts.before : 0.2;
    var after = opts.after != null ? opts.after : 0.15;
    var minCut = opts.minCut != null ? opts.minCut : 0.2;
    var prot = mergeRanges(words.map(function (w) { return { start: w.start - before, end: w.end + after }; }), 0);
    var sorted = cuts.slice().sort(function (a, b) { return a.start - b.start; });
    var out = [], p0 = 0;
    for (var c = 0; c < sorted.length; c++) {
      var segStart = sorted[c].start, end = sorted[c].end;
      while (p0 < prot.length && prot[p0].end <= segStart) p0++;
      for (var p = p0; p < prot.length && prot[p].start < end; p++) {
        if (prot[p].start > segStart && prot[p].start - segStart >= minCut - 1e-9) out.push({ start: segStart, end: prot[p].start });
        segStart = Math.max(segStart, prot[p].end);
      }
      if (end - segStart >= minCut - 1e-9) out.push({ start: segStart, end: end });
    }
    return out;
  }

  // ---- transcript ↔ timeline sync ------------------------------------------
  // These keep the transcript (words / caption cues) aligned to the timeline
  // after an edit, so silence-cut → remove-takes → captions all compose. Pure,
  // so they're unit-tested in Node and shared by every edit path in the panel.

  /* Copy a remapped item forward with EVERY field it had (caption cues carry
     their per-word timings, emphasis, speaker…) — only start/end change. */
  function carry(src, start, end) {
    var o = {};
    for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) o[k] = src[k]; }
    o.start = start; o.end = end;
    return o;
  }

  /* How much of an item must still be spoken for it to stay after a cut.
     The host snaps every cut edge to a whole frame (up to half a frame, ~20 ms,
     either way), so a retake cut that started exactly on the removed take's
     first word left 10–20 ms of it — and "keep anything over 10 ms" brought
     that word back ("so I I think that we go"), and left a fully-cut caption
     line behind as a 10–20 ms cue carrying all its text.
       a word:  at least half of it, and at least 50 ms (all of it if shorter);
       a line:  at least 50 ms; a line with per-word timings stays only while
                one of its words does, and its text is rebuilt from them. */
  var WORD_KEEP_SEC = 0.05, LINE_KEEP_SEC = 0.05;
  function oneWord(it) { return !/\S\s+\S/.test(String(it.text == null ? '' : it.text).trim()); }
  function wordNeeds(len) { return Math.min(len, Math.max(WORD_KEEP_SEC, len / 2)); }

  /* The line's text after some of its words were cut: the surviving tokens of
     its own text when they line up one-to-one with its words (punctuation and
     script kept), else the surviving words joined. */
  function survivingText(line, keepIdx) {
    var toks = String(line.text == null ? '' : line.text).trim().split(/\s+/);
    if (toks.length === line.words.length) return keepIdx.map(function (j) { return toks[j]; }).join(' ');
    return keepIdx.map(function (j) { return String(line.words[j].text == null ? '' : line.words[j].text).trim(); })
      .filter(Boolean).join(' ');
  }

  /*
   * Ripple a list of timed items through a set of CUT ranges (same time base) —
   * exactly what a ripple-delete does on the timeline. START and END are mapped
   * separately: a time after a cut slides left by the cut's length, a time
   * inside a cut collapses onto the cut's start. A caption line that merely
   * spans a removed pause keeps its words and just gets shorter; an item goes
   * when too little of it is still spoken (wordNeeds / LINE_KEEP_SEC above — a
   * sliver left by frame snapping is not speech). Because the mapping never
   * reverses order, lines that did not overlap before cannot overlap after.
   * Nested per-word timings (cue.words) are remapped with the word rule; a
   * line none of whose words is still spoken goes, one that lost some of its
   * words gets its text rebuilt from the ones that are left.
   * closeGaps:false leaves the gap open: nothing shifts, cut items drop,
   * edges inside a cut are pulled back to the surviving side.
   * items: [{start,end,…}], ranges: [{start,end}].
   */
  function rippleItems(items, ranges, closeGaps) {
    if (!items || !items.length) return items ? items.slice() : [];
    var merged = mergeRanges((ranges || []).filter(function (r) { return r.end > r.start; }), 0.0001);
    if (!merged.length) return items.slice();
    if (closeGaps === undefined) closeGaps = true;
    function removedBefore(t) {
      var s = 0;
      for (var i = 0; i < merged.length; i++) {
        var r = merged[i];
        if (r.start >= t) break;
        s += Math.min(t, r.end) - r.start;
      }
      return s;
    }
    function cutAt(t) {   // the cut strictly containing t, if any
      for (var i = 0; i < merged.length; i++) {
        if (merged[i].start > t) return null;
        if (t > merged[i].start && t < merged[i].end) return merged[i];
      }
      return null;
    }
    function survives(it, need) {
      var len = it.end - it.start;
      if (!(len > 0)) return !cutAt(it.start);             // a zero-length mark: gone only inside a cut
      var kept = len - (removedBefore(it.end) - removedBefore(it.start));
      return kept >= need(len) - 1e-9;
    }
    function asWord(len) { return wordNeeds(len); }
    function asLine(len) { return Math.min(len, LINE_KEEP_SEC); }
    function moved(it) {
      var ns, ne;
      if (closeGaps) {
        ns = it.start - removedBefore(it.start);
        ne = it.end - removedBefore(it.end);
      } else {                                             // gap stays open: nothing slides
        var cs = cutAt(it.start), ce = cutAt(it.end);
        ns = cs ? cs.end : it.start;
        ne = ce ? ce.start : it.end;
        if (ne <= ns) { ns = it.start; ne = it.end; }
      }
      return carry(it, Math.max(0, ns), Math.max(0, ne));
    }
    var out = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      if (it.words && it.words.length) {
        var keepIdx = [];
        for (var j = 0; j < it.words.length; j++) if (survives(it.words[j], asWord)) keepIdx.push(j);
        if (!keepIdx.length) continue;                     // none of its words is still spoken → the line goes
        var o = moved(it);
        o.words = keepIdx.map(function (x) { return moved(it.words[x]); });
        if (keepIdx.length < it.words.length) o.text = survivingText(it, keepIdx);
        out.push(o);
        continue;
      }
      if (!survives(it, oneWord(it) ? asWord : asLine)) continue;
      out.push(moved(it));
    }
    return out;
  }

  /*
   * Remap a list of timed items through a set of KEEP ranges that get
   * concatenated (the "rebuild a trimmed sequence" case): each keep is laid down
   * back-to-back starting at 0, so an item inside keep i lands at
   * (sum of earlier keep durations) + (item.start − keep.start). Items outside
   * every keep are dropped. items/keeps share one time base.
   */
  function remapThroughKeeps(items, keeps) {
    if (!items || !items.length) return items ? items.slice() : [];
    var ks = (keeps || []).filter(function (k) { return k.end > k.start; })
      .sort(function (a, b) { return a.start - b.start; });
    if (!ks.length) return [];
    var cum = [], acc = 0, i;
    for (i = 0; i < ks.length; i++) { cum.push(acc); acc += (ks[i].end - ks[i].start); }
    var out = [];
    for (var j = 0; j < items.length; j++) {
      var it = items[j], mid = (it.start + it.end) / 2;
      for (var k = 0; k < ks.length; k++) {
        var seg = ks[k];
        if (mid >= seg.start - 0.001 && mid < seg.end + 0.001) {
          var len = seg.end - seg.start;
          var ns = cum[k] + Math.min(len, Math.max(0, it.start - seg.start));
          var ne = cum[k] + Math.min(len, Math.max(0, it.end - seg.start));
          if (ne <= ns) ne = Math.min(cum[k] + len, ns + 0.02);
          var o = carry(it, ns, ne);
          if (it.words && it.words.length) o.words = remapThroughKeeps(it.words, ks);
          out.push(o);
          break;
        }
      }
    }
    return out;
  }

  /*
   * Snap each cut edge to the nearest real silence boundary so cuts land in the
   * gap BETWEEN takes, not mid-word. Transcript-derived word times drift by up to
   * a few hundred ms; the breath/pause around a retake is precise. For each cut
   * [s,e], move s and e to the nearest silence on/offset within `window`; then
   * shrink very slightly (`pad`) so a plosive onset / breath tail is never
   * clipped. cuts:[{start,end,...}], silences:[{start,end}]. Pure.
   */
  function snapCutsToSilence(cuts, silences, opts) {
    opts = opts || {};
    var win = opts.window != null ? opts.window : 0.25;
    var pad = opts.pad != null ? opts.pad : 0.02;
    var edges = [];
    (silences || []).forEach(function (s) { edges.push(s.start); edges.push(s.end); });
    edges.sort(function (a, b) { return a - b; });
    function nearest(t) {
      var best = null, bd = Infinity;
      for (var i = 0; i < edges.length; i++) { var d = Math.abs(edges[i] - t); if (d < bd) { bd = d; best = edges[i]; } }
      return (best != null && bd <= win) ? best : null;
    }
    return (cuts || []).map(function (c) {
      var ns = nearest(c.start), ne = nearest(c.end);
      var s = (ns != null ? ns : c.start) + pad;
      var e = (ne != null ? ne : c.end) - pad;
      if (e <= s) { s = c.start; e = c.end; }            // pad/snap collapsed it → keep original
      var o = { start: s, end: e };
      if (c.text != null) o.text = c.text;
      if (c.reason != null) o.reason = c.reason;
      if (c.label != null) o.label = c.label;
      return o;
    });
  }

  return {
    dbToLinear: dbToLinear,
    detectSilences: detectSilences,
    mergeRanges: mergeRanges,
    refineSilences: refineSilences,
    invertToKeep: invertToKeep,
    totalDuration: totalDuration,
    parseFfmpegSilences: parseFfmpegSilences,
    rippleItems: rippleItems,
    remapThroughKeeps: remapThroughKeeps,
    snapCutsToSilence: snapCutsToSilence,
    // adaptive dead-air detector
    HOP: HOP,
    DIGITAL_SILENCE_DB: DIGITAL_SILENCE_DB,
    tuning: tuning,
    makeEnvelopeBuilder: makeEnvelopeBuilder,
    micLevels: micLevels,
    loudFlags: loudFlags,
    quietRuns: quietRuns,
    combineMics: combineMics,
    planCuts: planCuts,
    isWordLevel: isWordLevel,
    protectCutsFromWords: protectCutsFromWords
  };
});
