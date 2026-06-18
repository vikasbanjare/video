/*
 * CutPilot — transcript intelligence (v0.3).
 * Two transcript-driven features, both pure and unit-testable in Node:
 *
 *   1. Filler-word removal — find "um / uh / you know / …" in the transcript,
 *      turn each occurrence into a cut range, and feed those ranges into the
 *      same cutting pipeline Smart Cut already uses (CPSilence.invertToKeep).
 *   2. Keyword auto-highlight — score every content word across the WHOLE
 *      transcript with TF-IDF and return the most salient ones, so the caption
 *      engine can emphasize them automatically (markKeywords mode 'auto').
 *
 * No DOM/CEP dependencies. All times are seconds in the cue's own time base.
 */
(function (root, factory) {
  var lib = factory();
  // CEP panels with --enable-nodejs have BOTH `module` and `window` — register in both.
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPTranscript = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* Conservative default: true disfluencies almost nobody wants to keep. */
  var FILLER_WORDS = {
    um: 1, umm: 1, uh: 1, uhh: 1, uhm: 1, erm: 1, er: 1, ah: 1, ahh: 1,
    hmm: 1, mm: 1, mhm: 1, mmm: 1, eh: 1
  };

  /* Opt-in (opts.extra): real words that are *usually* filler but can be
     meaningful, so they are off by default to avoid cutting real speech. */
  var FILLER_EXTRA = {
    like: 1, so: 1, well: 1, right: 1, okay: 1, ok: 1, anyway: 1, anyways: 1,
    actually: 1, basically: 1, literally: 1, honestly: 1, just: 1
  };

  /* Multi-word filler phrases (matched on consecutive cleaned tokens,
     longest first). */
  var FILLER_PHRASES = [
    ['you', 'know', 'what', 'i', 'mean'],
    ['you', 'know'], ['i', 'mean'], ['i', 'guess'],
    ['sort', 'of'], ['kind', 'of'], ['or', 'something'], ['or', 'whatever']
  ];

  /* Common English stop words — excluded from TF-IDF salience so the
     highlight lands on content, not glue. */
  var STOP = {};
  ('a an and are as at be been being but by can could did do does doing for ' +
   'from had has have having he her here hers him his how i if in into is it ' +
   'its just me my no nor not of off on or our out over own she should so some ' +
   'such than that the their them then there these they this those to too up ' +
   'us was we were what when where which while who whom why will with would you ' +
   'your yours yeah ok okay gonna wanna got get really very much many one also ' +
   'now then thing things way').split(/\s+/).forEach(function (w) { STOP[w] = 1; });

  function clean(w) { return String(w).toLowerCase().replace(/[^a-z0-9']/g, ''); }

  /* Split a string into lowercased alphanumeric tokens (apostrophes kept
     inside words, e.g. "don't"). */
  function tokenize(text) {
    var out = [];
    var raw = String(text || '').toLowerCase().split(/[^a-z0-9']+/);
    for (var i = 0; i < raw.length; i++) {
      var t = raw[i].replace(/^'+|'+$/g, '');
      if (t) out.push(t);
    }
    return out;
  }

  /*
   * Length-weighted word timing within one cue (same approach as
   * captions.explodeWords): longer words get proportionally more time. Returns
   * [{start, end, raw, tok}] where `raw` is the original word and `tok` its
   * cleaned form for matching.
   */
  function wordTimings(cue) {
    var raw = String(cue.text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return [];
    var words = raw.split(' ');
    var weights = [], total = 0, i;
    for (i = 0; i < words.length; i++) {
      var wt = Math.max(2, clean(words[i]).length);
      weights.push(wt); total += wt;
    }
    var out = [], t = cue.start, dur = cue.end - cue.start;
    for (i = 0; i < words.length; i++) {
      var end = (i === words.length - 1) ? cue.end : t + dur * weights[i] / total;
      out.push({ start: t, end: end, raw: words[i], tok: clean(words[i]) });
      t = end;
    }
    return out;
  }

  /* Merge ranges that overlap or sit within `gap` seconds of each other. */
  function mergeRanges(ranges, gap) {
    if (!ranges.length) return [];
    var sorted = ranges.slice().sort(function (a, b) { return a.start - b.start; });
    var out = [{ start: sorted[0].start, end: sorted[0].end, word: sorted[0].word }];
    for (var i = 1; i < sorted.length; i++) {
      var last = out[out.length - 1];
      if (sorted[i].start - last.end <= gap) {
        last.end = Math.max(last.end, sorted[i].end);
        last.word = last.word + ' ' + sorted[i].word;
      } else {
        out.push({ start: sorted[i].start, end: sorted[i].end, word: sorted[i].word });
      }
    }
    return out;
  }

  /*
   * Find filler-word occurrences across the transcript and return them as cut
   * ranges (sorted, optionally padded and merged).
   * opts: {
   *   extra:    also cut FILLER_EXTRA words (default false),
   *   words:    custom single-word map (overrides the defaults),
   *   phrases:  custom phrase list (overrides the defaults),
   *   padding:  seconds added to each side of a hit (default 0),
   *   mergeGap: merge hits within this gap (default 0.08)
   * }
   * Returns { ranges:[{start,end,word}], count, removed }.
   */
  function findFillerRanges(cues, opts) {
    opts = opts || {};
    var single = opts.words || FILLER_WORDS;
    if (!opts.words && opts.extra) {
      single = {};
      var k;
      for (k in FILLER_WORDS) single[k] = 1;
      for (k in FILLER_EXTRA) single[k] = 1;
    }
    var phrases = opts.phrases || FILLER_PHRASES;
    var pad = opts.padding != null ? opts.padding : 0;
    var hits = [];

    for (var c = 0; c < (cues || []).length; c++) {
      var words = wordTimings(cues[c]);
      var i = 0;
      while (i < words.length) {
        var matched = 0;
        // longest phrase first
        for (var p = 0; p < phrases.length; p++) {
          var ph = phrases[p];
          if (i + ph.length > words.length) continue;
          var ok = true;
          for (var j = 0; j < ph.length; j++) {
            if (words[i + j].tok !== ph[j]) { ok = false; break; }
          }
          if (ok && ph.length > matched) matched = ph.length;
        }
        if (matched) {
          var startW = words[i], endW = words[i + matched - 1];
          var label = [];
          for (var q = 0; q < matched; q++) label.push(words[i + q].raw);
          hits.push({ start: startW.start, end: endW.end, word: label.join(' ') });
          i += matched;
          continue;
        }
        if (single[words[i].tok]) {
          hits.push({ start: words[i].start, end: words[i].end, word: words[i].raw });
        }
        i++;
      }
    }

    if (pad) {
      hits = hits.map(function (h) { return { start: Math.max(0, h.start - pad), end: h.end + pad, word: h.word }; });
    }
    var ranges = mergeRanges(hits, opts.mergeGap != null ? opts.mergeGap : 0.08);
    var removed = 0;
    for (var r = 0; r < ranges.length; r++) removed += ranges[r].end - ranges[r].start;
    return { ranges: ranges, count: ranges.length, removed: removed };
  }

  // -------------------------------------------------- TF-IDF keyword salience --
  /*
   * Score every content word across the transcript. Each cue is treated as a
   * document; a word's salience is its corpus term-frequency times its inverse
   * document frequency, so words that recur but aren't ubiquitous float up.
   * Returns [{word, score, tf, df}] sorted by score descending.
   * opts: { minLen (default 3), keepNumbers (default true), stop (custom set) }
   */
  function keywordScores(cues, opts) {
    opts = opts || {};
    var minLen = opts.minLen != null ? opts.minLen : 3;
    var keepNumbers = opts.keepNumbers !== false;
    var stop = opts.stop || STOP;

    var docs = (cues || []).map(function (c) { return tokenize(c.text); });
    var N = docs.length || 1;
    var tf = {}, df = {};
    for (var d = 0; d < docs.length; d++) {
      var seen = {};
      for (var i = 0; i < docs[d].length; i++) {
        var w = docs[d][i];
        var isNum = /^[0-9]/.test(w);
        if (stop[w]) continue;
        if (!isNum && w.replace(/'/g, '').length < minLen) continue;
        if (isNum && !keepNumbers) continue;
        tf[w] = (tf[w] || 0) + 1;
        if (!seen[w]) { df[w] = (df[w] || 0) + 1; seen[w] = 1; }
      }
    }
    var out = [];
    for (var t in tf) {
      var idf = Math.log(1 + N / df[t]);
      out.push({ word: t, score: tf[t] * idf, tf: tf[t], df: df[t] });
    }
    out.sort(function (a, b) { return b.score - a.score || (a.word < b.word ? -1 : 1); });
    return out;
  }

  /*
   * The set of words to auto-highlight: the top salient words from
   * keywordScores. opts: { maxWords (default 12), minScore }. Returns a map
   * { word: true } for O(1) lookup by markSalient.
   */
  function topKeywordSet(cues, opts) {
    opts = opts || {};
    var max = opts.maxWords != null ? opts.maxWords : 12;
    var scored = keywordScores(cues, opts);
    var set = {};
    for (var i = 0; i < scored.length && i < max; i++) {
      if (opts.minScore != null && scored[i].score < opts.minScore) break;
      set[scored[i].word] = true;
    }
    return set;
  }

  /* Boolean[] aligned to `words`: true where the (cleaned) word is in `set`. */
  function markSalient(words, set) {
    set = set || {};
    var flags = [];
    for (var i = 0; i < words.length; i++) flags.push(!!set[clean(words[i])]);
    return flags;
  }

  // ---- v1.0: hook detection + B-roll suggestions --------------------------
  /* Phrases that tend to mark a viral hook / retention beat. */
  var HOOK_PATTERNS = [
    { re: /nobody (talks about|tells you)/i, label: 'Hook' },
    { re: /this changed everything/i, label: 'Hook' },
    { re: /\b(i|we) lost\b.*\b(lakh|crore|million|thousand|dollars?|rupees?)\b/i, label: 'Stakes' },
    { re: /biggest mistake/i, label: 'Mistake' },
    { re: /\bsecret\b/i, label: 'Secret' },
    { re: /here'?s (why|how|the)/i, label: 'Payoff' },
    { re: /the truth (is|about)/i, label: 'Truth' },
    { re: /\bwarning\b/i, label: 'Warning' },
    { re: /most people (don'?t|never)/i, label: 'Hook' },
    { re: /\bin (this video|the next)\b/i, label: 'Setup' }
  ];
  /* Scan cues for hook phrases. Returns [{time, label, text}] for markers. */
  function detectHooks(cues) {
    var out = [];
    if (!cues) return out;
    for (var i = 0; i < cues.length; i++) {
      var txt = String(cues[i].text || '');
      for (var p = 0; p < HOOK_PATTERNS.length; p++) {
        if (HOOK_PATTERNS[p].re.test(txt)) {
          out.push({ time: cues[i].start || 0, label: HOOK_PATTERNS[p].label, text: txt.slice(0, 80) });
          break;   // one marker per cue
        }
      }
    }
    return out;
  }

  /* Suggest B-roll search terms from the transcript: the most salient content
     nouns/keywords (reuses TF-IDF) + any concrete multi-word phrases. Returns
     [{term, time}] — `time` is when the term is first spoken (for placement). */
  function extractBrollSuggestions(cues, opts) {
    opts = opts || {};
    var max = opts.max != null ? opts.max : 12;
    var set = topKeywordSet(cues, { maxWords: max * 2 });
    var firstAt = {}, order = [];
    for (var i = 0; i < (cues || []).length; i++) {
      var toks = tokenize(cues[i].text);
      for (var j = 0; j < toks.length; j++) {
        var w = toks[j];
        if (set[w] && w.length >= 4 && firstAt[w] == null) {
          firstAt[w] = cues[i].start || 0; order.push(w);
        }
      }
    }
    var out = [];
    for (var k = 0; k < order.length && out.length < max; k++) {
      out.push({ term: order[k], time: firstAt[order[k]] });
    }
    return out;
  }

  return {
    detectHooks: detectHooks,
    extractBrollSuggestions: extractBrollSuggestions,
    FILLER_WORDS: FILLER_WORDS,
    FILLER_EXTRA: FILLER_EXTRA,
    FILLER_PHRASES: FILLER_PHRASES,
    STOP: STOP,
    clean: clean,
    tokenize: tokenize,
    wordTimings: wordTimings,
    mergeRanges: mergeRanges,
    findFillerRanges: findFillerRanges,
    keywordScores: keywordScores,
    topKeywordSet: topKeywordSet,
    markSalient: markSalient
  };
});
