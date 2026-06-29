/*
 * Pulse — CPAlign: word-timing refinement + readability grouping.
 *
 * The recogniser tells us WHAT was said and a rough WHEN. This module sharpens
 * the WHEN so the word-by-word highlight rides the actual voice, using only the
 * data we already have locally (the ASR word stamps + an RMS energy envelope) —
 * no extra model, no cloud, and it never touches the media. It is the cheap,
 * verifiable cousin of forced alignment:
 *
 *   1) snap   — a word boundary can't sit in silence; pull it to the nearest
 *               real speech onset/offset (physics: speech has energy, gaps don't)
 *   2) shape  — inside a continuous run of speech, nudge the internal boundaries
 *               toward a SYLLABLE-proportional split (a long word deserves more
 *               time than "a") — blended with the ASR guess so good timing is
 *               never thrown away
 *   3) read   — group words into cues that respect reading speed + line length,
 *               breaking on natural punctuation (readability, not just accuracy)
 *
 * Pure functions, no DOM/Node deps → unit-tested in test/run-tests.js and reused
 * verbatim by both the live preview and the editable output (one source of truth).
 */
(function (root) {
  'use strict';

  // ---- English syllable estimate (heuristic): count vowel groups, trim the
  //      common silent endings. Good enough as a *relative* duration weight. ----
  function syllableCount(word) {
    var w = String(word == null ? '' : word).toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 1;
    if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|[^laeiouy]e|ed)$/, '');   // silent -e / -es / -ed
    w = w.replace(/^y/, '');                                  // leading y is a consonant
    var groups = w.match(/[aeiouy]{1,2}/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  // ---- P-centre (perceptual "beat") fractional offset within a word [0..~0.4].
  //      Humans hear a word ON its first vowel; a consonant cluster before it
  //      ("strike") pushes the beat later than a vowel-initial word ("apple").
  //      Used only to nudge the highlight TRIGGER, never the word's stored time. ----
  function pCenterFraction(word) {
    var w = String(word == null ? '' : word).toLowerCase();
    var i = w.search(/[aeiouy]/);
    if (i <= 0) return 0;
    return Math.min(0.4, (i / Math.max(1, w.length)) * 0.6);
  }

  // ---- derive speech runs [{start,end}] from an RMS-dB envelope
  //      (samples: [{t, db}], db≈-100 in silence). Threshold a few dB above a
  //      low percentile (the noise floor), bridging micro-gaps < minSilence. ----
  function speechRuns(samples, opts) {
    opts = opts || {};
    if (!samples || !samples.length) return [];
    var dbs = samples.map(function (s) { return (typeof s.db === 'number' && isFinite(s.db)) ? s.db : -100; });
    var sorted = dbs.slice(0).sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(sorted.length * 0.10)];
    var peak = sorted[Math.floor(sorted.length * 0.95)];
    if (!(peak > floor)) return [];                                  // flat → no usable speech structure
    var thr = floor + (peak - floor) * (opts.sens != null ? opts.sens : 0.18);
    var minSilence = (opts.minSilence != null ? opts.minSilence : 0.08);
    var runs = [], inRun = false, runStart = 0, gapStart = 0;
    for (var i = 0; i < samples.length; i++) {
      var loud = dbs[i] >= thr, t = samples[i].t;
      if (loud) {
        if (!inRun) { inRun = true; runStart = t; }
        gapStart = 0;
      } else if (inRun) {
        if (gapStart === 0) gapStart = t;
        if (t - gapStart >= minSilence) { runs.push({ start: runStart, end: gapStart }); inRun = false; gapStart = 0; }
      }
    }
    if (inRun) runs.push({ start: runStart, end: samples[samples.length - 1].t });
    return runs;
  }

  function inSpeech(t, runs, pad) {
    pad = pad || 0;
    for (var i = 0; i < runs.length; i++) if (t >= runs[i].start - pad && t <= runs[i].end + pad) return true;
    return false;
  }
  // nearest speech edge to t (start edges if isStart, else end edges, but the
  // opposite edge is allowed too — whichever is closer)
  function nearestEdge(t, runs, isStart) {
    var best = t, bestD = Infinity;
    for (var i = 0; i < runs.length; i++) {
      var edges = [isStart ? runs[i].start : runs[i].end, isStart ? runs[i].end : runs[i].start];
      for (var e = 0; e < edges.length; e++) { var d = Math.abs(edges[e] - t); if (d < bestD) { bestD = d; best = edges[e]; } }
    }
    return best;
  }

  /* Refine ASR word stamps. words: [{start,end,text,...}] (seconds, sorted).
     samples: RMS-dB envelope. Returns a NEW array, same length/text/order, with
     sharpened start/end. Conservative: snaps boundaries out of silence and blends
     internal boundaries toward a syllable split — never reorders or drops words. */
  function refineWords(words, samples, opts) {
    opts = opts || {};
    if (!words || words.length < 1) return words ? words.slice() : [];
    var w = words.map(function (x) {
      return { start: +x.start || 0, end: (x.end != null ? +x.end : (+x.start || 0)), text: x.text, conf: x.conf };
    });
    var runs = speechRuns(samples, opts);
    var blend = (opts.blend != null) ? opts.blend : 0.5;     // 0 = trust ASR, 1 = trust syllables
    var snapWin = (opts.snapWin != null) ? opts.snapWin : 0.25;

    // 1) snap boundaries that fall inside a silence gap to the nearest speech edge
    if (runs.length) {
      for (var i = 0; i < w.length; i++) {
        if (!inSpeech(w[i].start, runs, 0.01)) { var ns = nearestEdge(w[i].start, runs, true); if (Math.abs(ns - w[i].start) <= snapWin) w[i].start = ns; }
        if (!inSpeech(w[i].end, runs, 0.01)) { var ne = nearestEdge(w[i].end, runs, false); if (Math.abs(ne - w[i].end) <= snapWin) w[i].end = ne; }
      }
    }

    // 2) within a group of words that share one speech run (no real gap between
    //    them), blend internal boundaries toward a syllable-proportional split.
    var g = 0;
    while (g < w.length) {
      var h = g;
      while (h + 1 < w.length && (w[h + 1].start - w[h].end) < 0.12) h++;   // contiguous run
      if (h > g) {
        var t0 = w[g].start, t1 = w[h].end, span = t1 - t0;
        if (span > 1e-3) {
          var weights = [], total = 0;
          for (var k = g; k <= h; k++) { var sy = syllableCount(w[k].text); weights.push(sy); total += sy; }
          var acc = 0, prevEnd = t0;
          for (var m = g; m <= h; m++) {
            acc += weights[m - g];
            var sylBoundary = t0 + span * (acc / total);     // where syllables say this word ends
            if (m < h) {
              var blended = w[m].end * (1 - blend) + sylBoundary * blend;
              if (blended < prevEnd + 0.02) blended = prevEnd + 0.02;        // keep order + min width
              w[m].end = blended; w[m + 1].start = blended;
            }
            prevEnd = w[m].end;
          }
        }
      }
      g = h + 1;
    }

    // 3) final guard: strictly monotonic, no zero/negative widths
    for (var n = 0; n < w.length; n++) {
      if (n > 0 && w[n].start < w[n - 1].end) w[n].start = w[n - 1].end;
      if (w[n].end <= w[n].start) w[n].end = w[n].start + 0.04;
    }
    return w;
  }

  /* Group words into readable cues. Breaks on sentence/clause punctuation and
     when a cue would exceed maxChars, maxWords, maxDur, or the reading-speed cap
     (chars-per-second). Returns [{start,end,text,words:[...]}]. */
  function groupForReadability(words, opts) {
    opts = opts || {};
    var maxChars = opts.maxChars || 42, maxWords = opts.maxWords || 0;
    var maxDur = opts.maxDur || 6, minDur = opts.minDur || 0.7, maxCps = opts.maxCps || 17;
    var out = [], cur = [];
    function flush() {
      if (!cur.length) return;
      var text = cur.map(function (x) { return x.text; }).join(' ');
      var start = cur[0].start, end = cur[cur.length - 1].end;
      if (end - start < minDur) end = start + minDur;
      out.push({ start: start, end: end, text: text, words: cur.slice() });
      cur = [];
    }
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      var tentative = cur.concat([word]);
      var text = tentative.map(function (x) { return x.text; }).join(' ');
      var dur = word.end - (cur.length ? cur[0].start : word.start);
      var over = (text.length > maxChars) || (maxWords && tentative.length > maxWords) ||
                 (dur > maxDur) || (text.length / Math.max(0.3, dur) > maxCps && cur.length >= 2);
      if (over && cur.length) flush();
      cur.push(word);
      if (/[.!?…]$|[,;:—]$/.test(String(word.text).trim())) flush();   // natural break
    }
    flush();
    return out;
  }

  var CPAlign = {
    syllableCount: syllableCount,
    pCenterFraction: pCenterFraction,
    speechRuns: speechRuns,
    refineWords: refineWords,
    groupForReadability: groupForReadability
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CPAlign;
  else root.CPAlign = CPAlign;
})(typeof self !== 'undefined' ? self : this);
