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

  // --------------------------------------------------------------------------
  // LEGACY, kept for test/run-tests.js only: detectSilences, refineSilences and
  // parseFfmpegSilences are the old fixed-threshold detector. Nothing in the
  // panel calls them any more — "Clean up my video" and "Find the silences"
  // listen with the adaptive detector further down (micLevels → combineMics →
  // planCuts). Do not build new features on them.
  // --------------------------------------------------------------------------

  /*
   * (legacy — unit tests only) Detect silent ranges in a mono Float32 sample
   * buffer using windowed RMS. opts: { thresholdDb, windowSec, hopSec }
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
   * (legacy — unit tests only) The old pipeline over raw silence ranges:
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
   * (legacy — unit tests only) Parse ffmpeg `silencedetect` stderr output into ranges.
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
   *   bed        — steady like music: continuous, or a narrow loudness range
   *                that never pauses (a beat). It never takes a track out of
   *                the vote — a noisy guest mic is "steady" too — it only
   *                shapes what Pulse says about the track.
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

  /* What a steady track looks like. A beat is loud on every hit and dips
     between hits (13–19 dB apart), and what it never does is PAUSE: its dips
     are the gaps between hits, well under a second. A voice in a noisy room
     can look the same (café clatter, a TV behind the guest), so this only
     describes a track; see versusOthers for what tells music from a voice. */
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

  // ---- which tracks decide what is dead air ---------------------------------
  // What a track SOUNDS like never takes it out of the vote — a guest in a
  // noisy café, or a fast talker, sounds "steady" too, and leaving that mic
  // out cut every one of the guest's answers. A track leaves the vote only
  // when its NAME says music, or the owner says so; what it sounds like only
  // decides whether Pulse ASKS.

  /* What a Premiere track name says: 'music' ("Music", "BGM", "Song",
     "Score", "Beat", "Background", "गाना"…), 'voice' ("Voice", "VO", "Mic",
     "Host", "Guest"…), or '' — "Audio 3" says nothing, and a name that says
     both ("Music + VO") is not trusted either way. A nested track's name is
     "Nest › A2"; only its own part (after the last ›) counts. */
  var MUSIC_NAME = /(^|[^a-z0-9])(music|musics|bgm|bg music|songs?|score|beats?|background|instrumental|gaana|gana|sangeet)(?![a-z0-9])/i;
  var MUSIC_NAME_HI = /(संगीत|गाना|गीत|म्यूजिक|म्यूज़िक)/;
  var VOICE_NAME = /(^|[^a-z0-9])(voices?|vo|v\.o\.?|mics?|microphone|host|guest|dialog|dialogue|narration|narrator|interview|speaker)(?![a-z0-9])/i;
  function trackNameSays(name) {
    var own = String(name == null ? '' : name).split('›').pop().trim();
    if (!own) return '';
    var music = MUSIC_NAME.test(own) || MUSIC_NAME_HI.test(own), voice = VOICE_NAME.test(own);
    return (music && !voice) ? 'music' : (voice && !music) ? 'voice' : '';
  }

  /*
   * How one track behaves while the OTHER tracks talk and while they pause.
   * grid = combineMics(the others); srcs = this track's clips
   * [{ seqStart, seqEnd, inPoint, speed, env }]. Returns { share, turn, talk, quiet }:
   *   share — of the time the others are heard under this track, how much of
   *           it they are talking: a music bed plays UNDER the talking; a
   *           jingle plays in the pauses (share ≈ 0);
   *   turn  — how much louder this track is in the others' pauses than while
   *           they talk (dB, 90th percentile of each): a guest answers in the
   *           host's pauses, so the guest's mic is 8–15 dB louder there however
   *           noisy the guest's room is; music does not care who is talking
   *           (−2…+1 dB). 0 when either side is under half a second.
   */
  function versusOthers(grid, srcs) {
    var q = [], t = [];
    for (var s = 0; s < (srcs || []).length; s++) {
      var src = srcs[s], sp = src.speed > 0 ? src.speed : 1, env = src.env;
      if (!env || !env.db) continue;
      var g0 = Math.max(0, Math.ceil((src.seqStart - grid.t0) / grid.hop - 0.5 - 1e-9));
      var g1 = Math.min(grid.n, Math.ceil((src.seqEnd - grid.t0) / grid.hop - 0.5 - 1e-9));
      for (var g = g0; g < g1; g++) {
        var st = grid.state[g];
        if (!st) continue;                                  // nobody else is on the timeline here
        var m = src.inPoint + (grid.t0 + (g + 0.5) * grid.hop - src.seqStart) * sp;
        var k = Math.floor((m - (env.start || 0)) / (env.hop || HOP));
        if (k < 0 || k >= env.db.length || !(env.db[k] > DIGITAL_SILENCE_DB)) continue;
        (st === 2 ? t : q).push(env.db[k]);
      }
    }
    var enough = Math.round(0.5 / HOP);
    var turn = 0;
    if (q.length >= enough && t.length >= enough) {
      q.sort(function (a, b) { return a - b; }); t.sort(function (a, b) { return a - b; });
      turn = pct(q, 0.9) - pct(t, 0.9);
    }
    return { share: (q.length + t.length) ? t.length / (q.length + t.length) : 0, turn: turn, talk: t.length * HOP, quiet: q.length * HOP };
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
    var cov = new Uint8Array(n), loud = new Uint8Array(n), strong = new Uint8Array(n), peak = new Float32Array(n).fill(-200), rel = null;
    var envs = [];
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s], sp = src.speed > 0 ? src.speed : 1;
      if (src.env && envs.indexOf(src.env) < 0) envs.push(src.env);
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
        if (src.env.db[k] > peak[g]) peak[g] = src.env.db[k];
        if (src.speechDb != null) {
          if (!rel) rel = new Float32Array(n).fill(-200);
          if (src.env.db[k] - src.speechDb > rel[g]) rel[g] = src.env.db[k] - src.speechDb;
        }
      }
    }
    var state = new Uint8Array(n);
    for (var q = 0; q < n; q++) state[q] = cov[q] ? (loud[q] ? 2 : 1) : 0;
    return { t0: t0, hop: hop, n: n, state: state, strong: strong, peak: peak, rel: rel, mics: envs.length };
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

  /*
   * Words kept only where the audio agrees. The transcriber writes words over
   * silence (a quiet stretch came back as "झाल आज पुरावा पर दिखाई था") and
   * stretches real words across pauses ("listed" lasting 2 s over a 0.9 s
   * pause). Trusted as is, those words shielded 22 s of dead air from the cut
   * and glued an abandoned take onto its retake as one 41-second "sentence",
   * so the retake was never found. Measured against a hand edit of the same
   * recording, that was most of what Clean up left in.
   * grid: combineMics() output (state 2 = a voice mic is loud, 0 = no mic).
   * Each word keeps only its loud stretches — at least `minRun` long (a click
   * is not a syllable) or half the word (a short real word) — joined across
   * dips under `bridge`; a word with none is dropped, and one longer than
   * `maxWord` keeps only what is near its own ends. Where no mic covers it,
   * or it falls outside the grid, a word is kept as it is (nothing to judge).
   * Caption-line transcripts (no word timing) are returned unchanged.
   */
  function audibleWords(words, grid, opts) {
    if (!words || !words.length || !grid || !grid.state || !isWordLevel(words)) return words || [];
    opts = opts || {};
    var hop = grid.hop, n = grid.n, st = grid.state;
    var minRun = Math.max(1, Math.round((opts.minRun != null ? opts.minRun : 0.06) / hop));
    var bridge = Math.round((opts.bridge != null ? opts.bridge : 0.3) / hop);
    var maxWord = opts.maxWord != null ? opts.maxWord : 2.5;
    var bar = opts.bar, lone = opts.lone != null ? opts.lone : 0.8;
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      // one word alone in a long silence whose sound never reaches the voice's
      // level: the on-computer engine smears a sentence's first words back
      // across the quiet before it ("lekin … kuch … challenges … bhi" spread
      // over 16 s of room noise) — not where they were said
      if (bar != null && (i === 0 || w.start - words[i - 1].end >= lone) && (i === words.length - 1 || words[i + 1].start - w.end >= lone)) {
        var pk = [];
        for (var gq = Math.max(0, Math.floor((w.start - grid.t0) / hop)); gq < Math.min(n, Math.ceil((w.end - grid.t0) / hop)); gq++) if (grid.peak) pk.push(grid.peak[gq]);
        if (pk.length) { pk.sort(function (x, y) { return x - y; }); if (pk[Math.floor(0.9 * (pk.length - 1))] < bar) continue; }
      }
      // no word lasts 2.5 s: one laid over 3-15 s of room noise was made up, or a
      // real word stretched back over the silence before it ("अक्टोबर" over 5 s).
      // Only its loud parts within `edge` of its start or end count; a number
      // ("95,345", said slowly) is long for real and keeps them all.
      var long = (w.end - w.start > maxWord) && !/\d/.test(String(w.text || w.word || ''));
      var edge = opts.edge != null ? opts.edge : 1.0;
      var g0 = Math.floor((w.start - grid.t0) / hop + 1e-9), g1 = Math.ceil((w.end - grid.t0) / hop - 1e-9);
      if (g1 <= 0 || g0 >= n || g1 <= g0) { out.push(w); continue; }
      g0 = Math.max(0, g0); g1 = Math.min(n, g1);
      var len = g1 - g0, runs = [], r0 = -1, uncovered = 0;
      for (var g = g0; g <= g1; g++) {
        var on = g < g1 && (st[g] === 2 || st[g] === 0);
        if (g < g1 && st[g] === 0) uncovered++;
        if (on && r0 < 0) r0 = g;
        if (!on && r0 >= 0) {
          var rs = grid.t0 + r0 * hop, re = grid.t0 + g * hop;
          if ((g - r0 >= minRun || 2 * (g - r0) >= len) && (!long || rs - w.start < edge || w.end - re < edge)) {
            if (runs.length && r0 - runs[runs.length - 1][1] < bridge) runs[runs.length - 1][1] = g;
            else runs.push([r0, g]);
          }
          r0 = -1;
        }
      }
      if (uncovered === len) { out.push(w); continue; }
      if (!runs.length) {
        // nothing loud under the word itself: its times may only have drifted
        // (the on-computer engine stamps words a little early — "FD" at
        // 0.60 s, the voice from ~0.8 s). A voice within `drift` keeps the
        // word as it is; one made up over a long silence has none near it.
        var dr = Math.round((opts.drift != null ? opts.drift : 0.25) / hop), near = false;
        for (var q = Math.max(0, g0 - dr); q < Math.min(n, g1 + dr) && !near; q++) if (st[q] === 2) near = true;
        // (a slip of a fraction of a second — never a word lasting seconds with no voice
        // under it: "11,009" laid over 2.7 s of silence, numbers being exempt from `long`)
        if (near && !long && w.end - w.start <= 1) out.push(w);
        continue;
      }
      for (var k = 0; k < runs.length; k++) {
        var piece = carry(w, Math.max(w.start, grid.t0 + runs[k][0] * hop), Math.min(w.end, grid.t0 + runs[k][1] * hop));
        if (k > 0) { piece.text = ''; piece.word = ''; piece.part = true; }   // one word said once: its later loud stretches only hold time
        out.push(piece);
      }
    }
    return out;
  }

  /*
   * Noise with no words in it. A quiet recording puts the gate only a few dB
   * over the room (here speech −40 dB, room −65, gate −57): rustles, chair
   * creaks and breathing cross it and read as talking, so seconds of them
   * stayed (the hand edit cut every one). Where the transcript has no word
   * for at least `minGap` and the loud moments (90th percentile) stay under
   * `bar` — the voice's own level, a few dB up — nobody is talking: cut it,
   * keeping the usual breathing room (tune.pre / tune.post) next to words.
   * Measured: that noise peaked at −39…−52 dB, real speech never below −34.
   * grid: combineMics() output (needs .peak). Returns sequence-time cuts.
   */
  function wordlessNoise(words, grid, bar, tune, opts) {
    if (!words || !words.length || !grid || !grid.peak || bar == null || !isFinite(bar) || !isWordLevel(words)) return [];
    opts = opts || {}; tune = tune || {};
    var minGap = opts.minGap != null ? opts.minGap : 1.0;
    var pre = tune.pre != null ? tune.pre : 0.13, post = tune.post != null ? tune.post : 0.17;
    var minCut = tune.minCut != null ? tune.minCut : 0.2;
    var sp = words.filter(function (w) { return w.end > w.start; }).sort(function (a, b) { return a.start - b.start; });
    if (!sp.length) return [];
    var tEnd = grid.t0 + grid.n * grid.hop, out = [], prevEnd = grid.t0;
    for (var i = 0; i <= sp.length; i++) {
      var nextStart = i < sp.length ? sp[i].start : tEnd;
      if (nextStart - prevEnd >= minGap) {
        var a = prevEnd + (i > 0 ? post : 0), b = nextStart - (i < sp.length ? pre : 0);
        var g0 = Math.max(0, Math.ceil((a - grid.t0) / grid.hop)), g1 = Math.min(grid.n, Math.floor((b - grid.t0) / grid.hop));
        var vals = [];
        for (var g = g0; g < g1; g++) if (grid.state[g] !== 0) vals.push(grid.peak[g]);
        if (vals.length && b - a >= minCut) {
          vals.sort(function (x, y) { return x - y; });
          if (vals[Math.floor(0.9 * (vals.length - 1))] < bar) out.push({ start: a, end: b });
        }
      }
      if (i < sp.length) prevEnd = Math.max(prevEnd, sp[i].end);
    }
    return out;
  }

  /*
   * Quiet stretches, whatever the transcript says. The on-computer engine
   * smears a sentence's words back over seconds of room noise ("lekin … kuch
   * … challenges … bhi" spread over 20 s at −45…−54 dB while the voice peaks
   * at −26), and a word — even a made-up one — kept those seconds in. Real
   * speech lasting 1.5 s always rises past the voice's level; where every
   * quarter-second stays under `bar` for `minLen`, nobody is talking: cut it,
   * `pad` short of each end. Measured on the hand edit: 9 s more of what the
   * owner cut, 0.2 s of what they kept (the edges of a long pause).
   * Applied AFTER protectCutsFromWords — overruling made-up words is the point.
   */
  function quietStretches(grid, bar, opts) {
    if (!grid || !grid.peak || bar == null || !isFinite(bar)) return [];
    opts = opts || {};
    var minLen = opts.minLen != null ? opts.minLen : 1.5, step = opts.step || 0.25, pad = opts.pad != null ? opts.pad : 0.35;
    var per = Math.max(1, Math.round(step / grid.hop)), nb = Math.floor(grid.n / per), out = [], k = 0;
    // each mic against its OWN speech level: a quieter guest never reaches the host's
    var level = grid.rel || grid.peak, top = grid.rel ? 3 : bar;
    // Several tracks: a level says nothing about who else is talking or playing, so
    // only stretches under every mic's own room-noise gate count (measured: the bar
    // alone cut a guest's answers and a track the owner said was a voice).
    var strict = grid.mics > 1;
    // The rule rests on speech rising past that level within 1.5 s. Where it does
    // not (a steady or limited voice, music nobody left out) stretches of talk read
    // as quiet, and no word guard comes after this: cut nothing on that recording.
    var span = Math.max(1, Math.round(minLen / step)), talk = 0, rises = 0;
    for (var w0 = 0; w0 + span <= nb; w0 += span) {
      var on = 0, up = false, of = span * per;
      for (var q = w0 * per; q < (w0 + span) * per; q++) { if (grid.state[q] === 2) on++; if (grid.state[q] !== 0 && level[q] >= top) up = true; }
      if (on * 2 >= of) { talk++; if (up) rises++; }
    }
    if (!strict && talk && rises / talk < (opts.minRise != null ? opts.minRise : 0.6)) return [];
    function quiet(b) {
      for (var g = b * per; g < (b + 1) * per; g++) if (grid.state[g] !== 0 && (level[g] >= top || (strict && grid.state[g] === 2))) return false;
      return true;
    }
    while (k < nb) {
      if (!quiet(k)) { k++; continue; }
      var e = k; while (e < nb && quiet(e)) e++;
      var a0 = grid.t0 + k * per * grid.hop, a1 = grid.t0 + e * per * grid.hop;
      if (a1 - a0 >= minLen) {
        // a cut edge must land in quiet: a word's last syllable can sit just under
        // the bar ("गया" fading at −39 dB). Each edge moves inward (at most 0.6 s)
        // until the 0.25 s around it stays 9 dB under the bar (and near the
        // stretch's floor, below) — longer than the dip between two words
        var c0 = a0 + (k > 0 ? pad : 0), c1 = a1 - (e < nb ? pad : 0);
        // "quiet" is also judged against this stretch's own floor: a word trailing
        // off sits under the bar for a second or more ("…video mein" at −44…−60 dB
        // with the pause beside it at −68), and an edge landing there cut audible
        // voice. Only sound near the stretch's quietest tenth counts as hush.
        var fl = [];
        for (var gf = k * per; gf < e * per; gf++) if (grid.state[gf] !== 0) fl.push(grid.peak[gf]);
        fl.sort(function (x, y) { return x - y; });
        var floor10 = fl.length ? fl[Math.floor(0.1 * (fl.length - 1))] : -Infinity;
        var soft = Math.min(bar - 9, floor10 + 6), w10 = Math.round(0.25 / grid.hop), max = Math.round(0.6 / grid.hop);
        function hush(g0) { for (var g = g0; g < g0 + w10; g++) if (g >= 0 && g < grid.n && grid.peak[g] >= soft) return false; return true; }
        var gs = Math.round((c0 - grid.t0) / grid.hop), ge = Math.round((c1 - grid.t0) / grid.hop), st;
        var sure = true;
        if (k > 0) { for (st = 0; st < max && !hush(gs + st - Math.round(w10 / 2)); st++); c0 += st * grid.hop; if (st >= max) sure = false; }
        if (e < nb) { for (st = 0; st < max && !hush(ge - st - Math.round(w10 / 2)); st++); c1 -= st * grid.hop; if (st >= max) sure = false; }
        // at the very start or end, sound over the gate may be a music intro or outro
        if (k === 0 || e >= nb) for (var h = k * per; h < e * per && sure; h++) if (grid.state[h] === 2) sure = false;
        // no true quiet to land on: too unsure that nobody is talking, so it stays
        if (sure && c1 - c0 >= 0.2) out.push({ start: c0, end: c1 });
      }
      k = e;
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
                one of its words does, and its text is rebuilt from them.
     Which rule an item gets is said by the caller (opts.kind: 'words' for a
     word list, 'lines' for caption cues) — a one-word line ("Haan.") or a
     line with no spaces (Chinese, Japanese) is still a LINE, and the word
     rule dropped it whenever the pause it ran into was cut. Without a kind,
     an item with one word of text is treated as a word. */
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
   * items: [{start,end,…}], ranges: [{start,end}], opts: { kind: 'words' | 'lines' }.
   */
  function rippleItems(items, ranges, closeGaps, opts) {
    var kind = opts && opts.kind, heard = opts && opts.heard;
    if (!items || !items.length) return items ? items.slice() : [];
    var merged = mergeRanges((ranges || []).filter(function (r) { return r.end > r.start; }), 0.0001);
    if (!merged.length) return items.slice();
    if (closeGaps === undefined) closeGaps = true;
    // the cuts are sorted and apart: found by halves, with the time removed
    // before each kept as a running total. A scan of every cut for each of a
    // 2-hour podcast's 20k words (four to six times a word) made re-syncing
    // the words after Clean up slow; the totals add up in the same order.
    var before = [0];
    for (var bi = 0; bi < merged.length; bi++) before.push(before[bi] + (merged[bi].end - merged[bi].start));
    function countStartingBelow(t, inclusive) {   // how many cuts start before t (at or before, if inclusive)
      var lo = 0, hi = merged.length;
      while (lo < hi) { var m = (lo + hi) >> 1; if (inclusive ? merged[m].start <= t : merged[m].start < t) lo = m + 1; else hi = m; }
      return lo;
    }
    function removedBefore(t) {
      var k = countStartingBelow(t, false);
      if (!k) return 0;
      var r = merged[k - 1];
      return before[k - 1] + (Math.min(t, r.end) - r.start);
    }
    function cutAt(t) {   // the cut strictly containing t, if any
      var k = countStartingBelow(t, true) - 1;
      return (k >= 0 && t > merged[k].start && t < merged[k].end) ? merged[k] : null;
    }
    function survives(it, need) {
      var len = it.end - it.start;
      if (!(len > 0)) return !cutAt(it.start);             // a zero-length mark: gone only inside a cut
      var kept = len - (removedBefore(it.end) - removedBefore(it.start));
      if (kept >= need(len) - 1e-9) return true;
      // The cuts were planned on where each word is HEARD (audibleWords), not
      // on its raw stamp: a word stamped 1.4 s over a pause whose 0.2 s of
      // voice is kept is still spoken, and went missing from captions made
      // right after Clean up. Judge the heard part the same way.
      if (need !== asWord || !heard) return false;
      var hl = 0, hk = 0;
      for (var h = 0; h < heard.length; h++) {   // ponytail: linear scan per doubtful word; index by start if 20k-word clean-ups feel slow
        var a = Math.max(it.start, heard[h].start), b = Math.min(it.end, heard[h].end);
        if (b > a) { hl += b - a; hk += (b - a) - (removedBefore(b) - removedBefore(a)); }
      }
      return hl > 0 && hk >= wordNeeds(hl) - 1e-9;
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
      var isWord = kind === 'words' || (kind !== 'lines' && oneWord(it));
      if (!survives(it, isWord ? asWord : asLine)) continue;
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
      // A line that carries its words lives wherever its words survive: a long
      // line whose MIDDLE fell in a removed pause used to vanish whole, words
      // and all. Its span is first surviving word → last surviving word.
      if (it.words && it.words.length) {
        var ws = remapThroughKeeps(it.words, ks);
        if (!ws.length) continue;
        var ol = carry(it, ws[0].start, ws[ws.length - 1].end);
        ol.words = ws;
        out.push(ol);
        continue;
      }
      for (var k = 0; k < ks.length; k++) {
        var seg = ks[k];
        if (mid >= seg.start - 0.001 && mid < seg.end + 0.001) {
          var len = seg.end - seg.start;
          var ns = cum[k] + Math.min(len, Math.max(0, it.start - seg.start));
          var ne = cum[k] + Math.min(len, Math.max(0, it.end - seg.start));
          if (ne <= ns) ne = Math.min(cum[k] + len, ns + 0.02);
          out.push(carry(it, ns, ne));
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
    trackNameSays: trackNameSays,
    versusOthers: versusOthers,
    loudFlags: loudFlags,
    quietRuns: quietRuns,
    combineMics: combineMics,
    planCuts: planCuts,
    isWordLevel: isWordLevel,
    protectCutsFromWords: protectCutsFromWords,
    audibleWords: audibleWords,
    wordlessNoise: wordlessNoise, quietStretches: quietStretches
  };
});
