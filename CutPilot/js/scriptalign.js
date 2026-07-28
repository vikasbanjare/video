/*
 * Pulse — script alignment.
 *
 * "Add script uploading option to fix all the script": the creator already has
 * the words they MEANT to say. The transcriber supplies accurate TIMING but
 * misheard words (names, brands, Hinglish, jargon). This module marries the
 * two: the script's spelling wins, the transcript's timing is kept.
 *
 * alignToScript(cues, scriptText) walks a word-level alignment (LCS backtrack
 * over normalised tokens) and rewrites each cue's text from the script — so
 * "Akshay Uddeshi" stops coming out "Akshi Adeshi" while every caption keeps
 * landing exactly on the voice.
 *
 * Pure + unit-tested; no DOM, no CEP.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPScript = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* Comparison key: case/punctuation-insensitive, digits kept, Devanagari kept
     (so Hindi scripts align as well as English ones). */
  function norm(w) {
    return String(w == null ? '' : w).toLowerCase()
      .replace(/[^\wऀ-ॿ']+/g, '')
      .replace(/^'+|'+$/g, '');
  }

  /* Split a script into words, dropping speaker labels ("VIKAS:"), stage
     directions ("[laughs]", "(pause)") and blank lines — the things a person
     writes but never says. */
  function scriptWords(text) {
    var t = String(text == null ? '' : text);
    t = t.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    var lines = t.split(/\r?\n/), out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^\s*\d+\s*$/.test(ln)) continue;                       // SRT index line
      if (/-->/.test(ln)) continue;                               // SRT timing line
      ln = ln.replace(/^\s*[A-Z][A-Z0-9 _.'-]{1,24}:\s*/, '');    // "SPEAKER:" label
      var parts = ln.split(/\s+/);
      for (var p = 0; p < parts.length; p++) if (parts[p]) out.push(parts[p]);
    }
    return out;
  }

  /* LCS backtrack over two token lists → pairs [ai, bi] of matched indices,
     in order. Bounded so a huge script can never hang the panel; beyond the
     cap the inputs are aligned in sequential blocks. */
  function matchPairs(a, b, cap) {
    cap = cap || 1200;
    var n = a.length, m = b.length;
    if (!n || !m) return [];
    if (n > cap || m > cap) {                    // block-wise for long texts
      var pairs = [], off = 0, offB = 0;
      while (off < n && offB < m) {
        var sa = a.slice(off, off + cap), sb = b.slice(offB, offB + cap);
        var sub = matchPairs(sa, sb, cap);
        for (var s = 0; s < sub.length; s++) pairs.push([sub[s][0] + off, sub[s][1] + offB]);
        if (!sub.length) break;
        off += sub[sub.length - 1][0] + 1;
        offB += sub[sub.length - 1][1] + 1;
      }
      return pairs;
    }
    var prev = new Uint32Array(m + 1), cur = new Uint32Array(m + 1);
    var keep = [];
    for (var i = 1; i <= n; i++) {
      var row = new Uint8Array(m + 1);
      for (var j = 1; j <= m; j++) {
        if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; row[j] = 1; }
        else if (prev[j] >= cur[j - 1]) { cur[j] = prev[j]; row[j] = 2; }
        else { cur[j] = cur[j - 1]; row[j] = 3; }
      }
      keep.push(row);
      var t = prev; prev = cur; cur = t;
      for (var z = 0; z <= m; z++) cur[z] = 0;
    }
    var out = [], ii = n, jj = m;
    while (ii > 0 && jj > 0) {
      var d = keep[ii - 1][jj];
      if (d === 1) { out.push([ii - 1, jj - 1]); ii--; jj--; }
      else if (d === 2) ii--;
      else jj--;
    }
    out.reverse();
    return out;
  }

  /*
   * Rewrite cue texts from the script, keeping every cue's timing.
   * cues: [{start,end,text}] · scriptText: the user's script
   * opts.minMatch (0..1, default 0.35): if fewer than this share of transcript
   *   words match the script, the script is assumed to be for a different
   *   recording and the transcript is returned UNCHANGED (with matched:false)
   *   — a wrong file must never destroy good captions.
   * Returns { cues, matched, matchRate, replaced, scriptWords }.
   */
  function alignToScript(cues, scriptText, opts) {
    opts = opts || {};
    var minMatch = (opts.minMatch != null) ? opts.minMatch : 0.35;
    var src = cues || [];
    // flatten transcript to words, remembering which cue each came from
    var tw = [], owner = [];
    for (var c = 0; c < src.length; c++) {
      var parts = String(src[c].text == null ? '' : src[c].text).split(/\s+/);
      for (var p = 0; p < parts.length; p++) {
        if (!parts[p]) continue;
        tw.push(parts[p]); owner.push(c);
      }
    }
    var sw = scriptWords(scriptText);
    if (!tw.length || !sw.length) {
      return { cues: src, matched: false, matchRate: 0, replaced: 0, scriptWords: sw.length };
    }
    var an = [], bn = [], i;
    for (i = 0; i < tw.length; i++) an.push(norm(tw[i]));
    for (i = 0; i < sw.length; i++) bn.push(norm(sw[i]));
    var pairs = matchPairs(an, bn);
    var rate = pairs.length / tw.length;
    if (rate < minMatch) {
      return { cues: src, matched: false, matchRate: rate, replaced: 0, scriptWords: sw.length };
    }
    // every transcript word takes the script's spelling; script words that sit
    // BETWEEN two matches (words the transcriber dropped) are inserted into the
    // cue that owns the following match.
    var perCue = [];
    for (i = 0; i < src.length; i++) perCue.push([]);
    var lastB = -1, pi = 0, replaced = 0, gapOwner = -1;
    for (var t = 0; t < tw.length; t++) {
      var cueIx = owner[t];
      if (pi < pairs.length && pairs[pi][0] === t) {
        var bIx = pairs[pi][1];
        // Script words with no transcript match belong to the cue whose OWN
        // words they replace (a misheard name lives in that cue's time), not
        // to the cue of the next match — otherwise the corrected words jump a
        // caption forward.
        var fillCue = (gapOwner >= 0) ? gapOwner : cueIx;
        for (var fill = lastB + 1; fill < bIx; fill++) perCue[fillCue].push(sw[fill]);
        perCue[cueIx].push(sw[bIx]);
        if (sw[bIx] !== tw[t]) replaced++;
        lastB = bIx; pi++; gapOwner = -1;
      } else if (gapOwner < 0) {
        gapOwner = cueIx;      // misheard word: its cue owns the coming fill
      }
    }
    // trailing script words go to the last cue that has any content
    if (lastB < sw.length - 1) {
      var lastCue = perCue.length - 1;
      while (lastCue > 0 && !perCue[lastCue].length) lastCue--;
      for (var r = lastB + 1; r < sw.length; r++) perCue[lastCue].push(sw[r]);
    }
    var out = [];
    for (i = 0; i < src.length; i++) {
      var txt = perCue[i].join(' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
      out.push({ start: src[i].start, end: src[i].end, text: txt || src[i].text });
    }
    return { cues: out, matched: true, matchRate: rate, replaced: replaced, scriptWords: sw.length };
  }

  return { norm: norm, scriptWords: scriptWords, matchPairs: matchPairs, alignToScript: alignToScript };
});
