/*
 * CutPilot — repeated-take / bad-take cleanup.
 * Works on the transcript word stream (which CutPilot already produces) to find
 * places where the speaker RESTARTED a phrase — false starts and retakes — and
 * returns the time ranges of the worse takes to ripple-delete, keeping the best
 * (by default the last/most-complete attempt, optionally the most confident).
 * Pure (no DOM/Node) so it's unit-tested and runs anywhere.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPTakes = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function norm(w) { return String(w == null ? '' : w).toLowerCase().replace(/[^a-z0-9']/g, ''); }

  /* Flatten cues (line-level, with text) into a word stream with even per-word
     timing when real word cues aren't supplied. */
  function flatten(cues) {
    var out = [];
    for (var c = 0; c < (cues || []).length; c++) {
      var ws = String(cues[c].text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      var n = Math.max(1, ws.length), d = ((cues[c].end - cues[c].start) || n * 0.4) / n;
      for (var k = 0; k < ws.length; k++) out.push({ start: cues[c].start + k * d, end: cues[c].start + (k + 1) * d, text: ws[k] });
    }
    return out;
  }

  /*
   * Find repeated takes in a word stream.
   *   words: [{start,end,text, conf?}]  (conf optional 0..1, higher = better)
   *   opts.minRun   minimum matching words to count as a retake (default 3)
   *   opts.maxGap   filler words allowed between the two takes (default 3)
   *   opts.keep     'last' (default — usually the good take) | 'confident'
   * Returns { deletes:[{start,end,text,reason}], kept:n, removedWords:n }.
   * A delete range covers the WORSE take, from its first word to the start of the
   * kept take (so the kept take and everything after it survive).
   */
  function findRepeatedTakes(words, opts) {
    opts = opts || {};
    var minRun = Math.max(2, opts.minRun || 3);
    var maxGap = (opts.maxGap != null) ? opts.maxGap : 3;
    var keep = opts.keep || 'last';
    var N = (words || []).length;
    if (N < minRun * 2) return { deletes: [], kept: 0, removedWords: 0 };

    var nw = new Array(N);
    for (var x = 0; x < N; x++) nw[x] = norm(words[x].text);

    function eq(a, b, L) {           // words[a..a+L-1] === words[b..b+L-1] (normalized, ignoring empties)
      for (var t = 0; t < L; t++) { if (!nw[a + t] || nw[a + t] !== nw[b + t]) return false; }
      return true;
    }
    function avgConf(a, L) {
      var s = 0, c = 0; for (var t = 0; t < L; t++) { var cf = words[a + t].conf; if (cf != null) { s += cf; c++; } }
      return c ? s / c : null;
    }

    var deletes = [], removedWords = 0, i = 0;
    while (i < N) {
      var bestL = 0, bestJ = -1;
      // longest repeat first; the second take may start right after (gap 0) or
      // after a few filler words (gap 1..maxGap)
      var maxL = Math.floor((N - i) / 2);
      for (var L = maxL; L >= minRun && !bestL; L--) {
        for (var gap = 0; gap <= maxGap; gap++) {
          var j = i + L + gap;
          if (j + L > N) continue;
          if (eq(i, j, L)) { bestL = L; bestJ = j; break; }
        }
      }
      if (bestL) {
        var firstStart = words[i].start, secondStart = words[bestJ].start;
        var drop = { start: firstStart, end: secondStart, text: sliceText(words, i, bestL), reason: 'repeated phrase' };
        // 'confident' mode: if the FIRST take scores clearly higher, keep it and
        // drop the second instead (rare, but respects confidence when available).
        if (keep === 'confident') {
          var c1 = avgConf(i, bestL), c2 = avgConf(bestJ, bestL);
          if (c1 != null && c2 != null && c1 > c2 + 0.05) {
            var thirdStart = (bestJ + bestL < N) ? words[bestJ + bestL].start : words[bestJ + bestL - 1].end;
            drop = { start: secondStart, end: thirdStart, text: sliceText(words, bestJ, bestL), reason: 'lower-confidence retake' };
            deletes.push(drop); removedWords += bestL; i = i + bestL; continue;
          }
        }
        deletes.push(drop); removedWords += bestL;
        i = bestJ;                  // continue scanning from the kept take
      } else { i++; }
    }
    return { deletes: deletes, kept: deletes.length, removedWords: removedWords };
  }

  function sliceText(words, a, L) {
    var s = []; for (var t = 0; t < L; t++) s.push(words[a + t].text); return s.join(' ');
  }

  /* Merge delete ranges that touch/overlap, and drop anything shorter than min. */
  function tidyDeletes(deletes, minLen) {
    minLen = minLen || 0.08;
    var s = deletes.slice().sort(function (a, b) { return a.start - b.start; });
    var out = [];
    for (var i = 0; i < s.length; i++) {
      if (s[i].end - s[i].start < minLen) continue;
      if (out.length && s[i].start <= out[out.length - 1].end + 0.02) {
        out[out.length - 1].end = Math.max(out[out.length - 1].end, s[i].end);
        out[out.length - 1].text += ' / ' + s[i].text;
      } else { out.push({ start: s[i].start, end: s[i].end, text: s[i].text, reason: s[i].reason }); }
    }
    return out;
  }

  return { findRepeatedTakes: findRepeatedTakes, flatten: flatten, tidyDeletes: tidyDeletes, _norm: norm };
});
