/*
 * Pulse — repeated-take / bad-take cleanup (fuzzy).
 * Real retakes are rarely word-for-word identical — the speaker rephrases a
 * little (5–15% different). So instead of exact matching we split the transcript
 * into PHRASES (by pauses / sentence punctuation) and cluster consecutive
 * phrases that are SIMILAR (token LCS ratio ≥ threshold), then keep the best
 * take (last, or most confident) and return the others' time ranges to ripple-
 * delete. Pure (no DOM/Node) so it's unit-tested and runs anywhere.
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

  /* Longest-common-subsequence length of two token arrays (order-aware, tolerant
     of insertions/deletions/substitutions — exactly how retakes differ). */
  function lcsLen(a, b) {
    var n = a.length, m = b.length;
    if (!n || !m) return 0;
    var prev = new Array(m + 1), cur = new Array(m + 1), i, j;
    for (j = 0; j <= m; j++) prev[j] = 0;
    for (i = 1; i <= n; i++) {
      cur[0] = 0;
      for (j = 1; j <= m; j++) {
        cur[j] = (a[i - 1] === b[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[m];
  }

  /* Similarity of two phrases (0..1): LCS over normalized tokens / longer length.
     Two retakes of the same line score ~0.85–0.95; unrelated lines score < ~0.4. */
  function phraseSim(A, B) {
    if (!A.length || !B.length) return 0;
    return lcsLen(A, B) / Math.max(A.length, B.length);
  }

  /* Containment: how much of the SHORTER phrase is covered by the longer one
     (LCS / shorter length). High containment with a short A means A is a
     fragment/restart of B even when overall similarity (LCS / longer) is low. */
  function phraseContain(A, B) {
    if (!A.length || !B.length) return 0;
    return lcsLen(A, B) / Math.min(A.length, B.length);
  }

  /* Is `a` a near-prefix of `b` — the speaker started a line, stopped, and
     restarted it ("so the— so the main thing is…"). `a` must be the shorter one. */
  function isNearPrefix(a, b, frac) {
    frac = (frac == null) ? 0.7 : frac;
    var n = a.length;
    if (!n || n >= b.length) return false;
    var match = 0;
    for (var i = 0; i < n; i++) if (a[i] === b[i]) match++;
    return (match / n) >= frac;
  }

  function pTokens(p) { var a = []; for (var i = 0; i < p.length; i++) { var n = norm(p[i].text); if (n) a.push(n); } return a; }
  function pText(p) { var s = []; for (var i = 0; i < p.length; i++) s.push(p[i].text); return s.join(' '); }
  function pConf(p) { var s = 0, c = 0; for (var i = 0; i < p.length; i++) { if (p[i].conf != null) { s += p[i].conf; c++; } } return c ? s / c : null; }

  /* Split a word stream into phrases at pauses (gap in word timing) or sentence
     punctuation — each phrase is one candidate "take". */
  function splitPhrases(words, pauseGap) {
    pauseGap = (pauseGap != null) ? pauseGap : 0.45;
    var phrases = [], cur = [words[0]];
    for (var k = 1; k < words.length; k++) {
      var gap = words[k].start - words[k - 1].end;
      var endsSentence = /[.!?]["')\]]?$/.test(words[k - 1].text);
      if (gap > pauseGap || endsSentence) { if (cur.length) phrases.push(cur); cur = []; }
      cur.push(words[k]);
    }
    if (cur.length) phrases.push(cur);
    return phrases;
  }

  /*
   * Find repeated takes (fuzzy).
   *   words: [{start,end,text, conf?}]
   *   opts.sim     similarity 0..1 to call two phrases the same take (default .6)
   *   opts.minRun  min words a take must have to be considered (default 3)
   *   opts.keep    'last' (default) | 'confident'
   *   opts.pauseGap pause (s) that separates takes (default .45)
   * Returns { deletes:[{start,end,text,reason}], kept:n, removedWords:n }.
   * Each delete spans a worse take INCLUDING its trailing pause (up to the next
   * phrase) so ripple-deleting it leaves no dangling silence.
   */
  function findRepeatedTakes(words, opts) {
    opts = opts || {};
    var thresh = (opts.sim != null) ? opts.sim : 0.6;
    var minRun = Math.max(2, opts.minRun || 3);
    var keep = opts.keep || 'last';
    var win = opts.window || 16;                // how many phrases ahead a retake can be (TimeBolt-style wide look-ahead; a retake after a "ugh let me redo that" aside is often >6 phrases away)
    var containThresh = (opts.contain != null) ? opts.contain : 0.85;
    var N = (words || []).length;
    if (N < minRun * 2) return { deletes: [], kept: 0, removedWords: 0 };

    var phrases = splitPhrases(words, opts.pauseGap);
    var toks = phrases.map(pTokens);
    var P = phrases.length;

    // Union-find: group phrases that are similar within a small window. This is
    // transitive, so a drifting run of 3–4 retakes (take1≈take2≈take3, even if
    // take1 vs take3 alone is weaker) all collapse into ONE group → complete
    // removal, not just the first pair.
    var parent = []; for (var x = 0; x < P; x++) parent[x] = x;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function uni(a, b) { parent[find(a)] = find(b); }
    for (var a = 0; a < P; a++) {
      if (toks[a].length < minRun) continue;
      var hi = Math.min(P - 1, a + win);
      for (var b = a + 1; b <= hi; b++) {
        if (toks[b].length < Math.min(minRun, 2)) continue;
        // Link if the two phrases are broadly similar (a re-recorded line) OR if
        // one is largely CONTAINED in the other (a rephrased/partial retake that
        // similarity-over-longer-length would score too low to catch).
        if (phraseSim(toks[a], toks[b]) >= thresh ||
            phraseContain(toks[a], toks[b]) >= containThresh) uni(a, b);
      }
    }

    var groups = {};
    for (var g = 0; g < P; g++) { var r = find(g); (groups[r] = groups[r] || []).push(g); }

    function startOf(idx) { return phrases[idx][0].start; }
    function nextStart(idx) { return (idx + 1 < P) ? phrases[idx + 1][0].start : phrases[idx][phrases[idx].length - 1].end; }

    var deletes = [], removedWords = 0;
    var inRetakeGroup = {};   // phrase idx → member of a real (2+) retake group
    Object.keys(groups).forEach(function (key) {
      var grp = groups[key];
      if (grp.length < 2) return;
      for (var gm = 0; gm < grp.length; gm++) inRetakeGroup[grp[gm]] = true;
      grp.sort(function (x, y) { return x - y; });
      var keepIdx = grp[grp.length - 1];          // default: keep the LAST attempt
      if (keep === 'best') {
        // Score each take: completeness (a truncated/false-start take scores low
        // and is rejected) dominates, then mean per-word confidence (clean vs
        // flubbed delivery — needs a verbatim transcript to be meaningful), then
        // recency (people usually nail a later try). Keep the highest.
        var maxLen = 0, mi;
        for (mi = 0; mi < grp.length; mi++) maxLen = Math.max(maxLen, phrases[grp[mi]].length);
        var bestScore = -Infinity;
        for (var bi = 0; bi < grp.length; bi++) {
          var ph = phrases[grp[bi]];
          var completeness = maxLen ? (ph.length / maxLen) : 1;
          var cf = pConf(ph); if (cf == null) cf = 0.6;          // neutral when no confidence
          var recency = (grp.length > 1) ? (bi / (grp.length - 1)) : 1;
          var sc = 0.55 * completeness + 0.25 * cf + 0.20 * recency;
          if (sc > bestScore) { bestScore = sc; keepIdx = grp[bi]; }
        }
      } else if (keep === 'confident') {
        var bc = -Infinity, anyConf = false;
        for (var ci = 0; ci < grp.length; ci++) {
          var cf = pConf(phrases[grp[ci]]);
          if (cf != null) { anyConf = true; if (cf > bc) { bc = cf; keepIdx = grp[ci]; } }
        }
        // No per-word confidence anywhere (the common case for most transcripts)?
        // Fall back to the LAST take — never silently keep the first/worse one.
        if (!anyConf) keepIdx = grp[grp.length - 1];
      }
      for (var c2 = 0; c2 < grp.length; c2++) {
        var idx = grp[c2];
        if (idx === keepIdx) continue;
        deletes.push({ start: startOf(idx), end: nextStart(idx), text: pText(phrases[idx]), reason: 'repeated take' });
        removedWords += phrases[idx].length;
      }
    });

    // False starts / restarts: a SHORT phrase that is a near-prefix of the NEXT
    // phrase — the speaker began a line, stopped, and restarted it. These have no
    // full second take to cluster against, so the similarity pass alone misses
    // them. Delete the fragment, keep the completed line.
    if (opts.falseStarts !== false) {
      var maxFrag = opts.maxFragWords || 6;
      for (var fi = 0; fi + 1 < P; fi++) {
        if (!toks[fi].length || toks[fi].length > maxFrag) continue;
        if (isNearPrefix(toks[fi], toks[fi + 1], opts.prefixFrac)) {
          deletes.push({ start: startOf(fi), end: nextStart(fi), text: pText(phrases[fi]), reason: 'false start' });
          removedWords += phrases[fi].length;
          inRetakeGroup[fi] = true;   // retake activity — lets the aside pass anchor on it
        }
      }
    }

    // Off-script ASIDES between takes ("no no wait", "ugh let me try that
    // again", "okay one more time"…): they're not similar to anything, so the
    // grouping can't catch them — but they're exactly what a one-button cleanup
    // must remove. TWO locks keep this safe: (1) the phrase must be short and
    // chatter-worded (a strong marker + mostly filler vocabulary), and (2) it
    // must sit DIRECTLY NEXT TO detected retake activity. In a video with no
    // retakes nothing is adjacent, so nothing can ever be taken by mistake.
    if (opts.asides !== false) {
      var STRONG = /^(no|nope|wait|again|redo|sorry|cut|ugh|over|messed|flubbed|scratch|terrible|awful|horrible|damn|dammit|shit|fuck|crap|retry|restart|stop)$/;
      var WEAK = /^(let|me|try|that|this|it|one|more|time|okay|ok|hmm|um|uh|oh|man|god|was|is|i|do|did|hold|on|start|take|two|three|from|the|top|line|up|so|bad|not|good|right|yeah|well|alright|a|go|gonna|redo)$/;
      var PHRASE_STRONG = /\b(one more time|take (two|three|\d+)|start over|from the top|try (that|it) again|do (that|it) again|that again)\b/;
      var maxAside = opts.maxAsideWords || 8;
      for (var ai = 0; ai < P; ai++) {
        if (inRetakeGroup[ai]) continue;
        var tk = toks[ai];
        if (!tk.length || tk.length > maxAside) continue;
        var near = (ai > 0 && inRetakeGroup[ai - 1]) || (ai + 1 < P && inRetakeGroup[ai + 1]);
        if (!near) continue;
        var joined = tk.join(' ');
        var strong = 0, weak = 0;
        for (var ti = 0; ti < tk.length; ti++) {
          if (STRONG.test(tk[ti])) strong++;
          else if (WEAK.test(tk[ti])) weak++;
        }
        var hasStrong = strong > 0 || PHRASE_STRONG.test(joined);
        var chattery = (strong + weak) / tk.length >= 0.75;
        if (hasStrong && chattery) {
          deletes.push({ start: startOf(ai), end: nextStart(ai), text: pText(phrases[ai]), reason: 'off-script aside' });
          removedWords += phrases[ai].length;
        }
      }
    }
    return { deletes: tidyDeletes(deletes, 0.1), kept: deletes.length, removedWords: removedWords };
  }

  /* Merge delete ranges that touch/overlap, drop anything shorter than min. */
  function tidyDeletes(deletes, minLen) {
    minLen = minLen || 0.08;
    var s = deletes.slice().sort(function (a, b) { return a.start - b.start; });
    var out = [];
    for (var i = 0; i < s.length; i++) {
      if (s[i].end - s[i].start < minLen) continue;
      if (out.length && s[i].start <= out[out.length - 1].end + 0.05) {
        out[out.length - 1].end = Math.max(out[out.length - 1].end, s[i].end);
        out[out.length - 1].text += ' / ' + s[i].text;
      } else { out.push({ start: s[i].start, end: s[i].end, text: s[i].text, reason: s[i].reason }); }
    }
    return out;
  }

  return {
    findRepeatedTakes: findRepeatedTakes, flatten: flatten, tidyDeletes: tidyDeletes,
    phraseSim: phraseSim, phraseContain: phraseContain, isNearPrefix: isNearPrefix,
    lcsLen: lcsLen, splitPhrases: splitPhrases, _norm: norm
  };
});
