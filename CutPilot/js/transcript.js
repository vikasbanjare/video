/*
 * Pulse — transcript intelligence (v0.3).
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

  /* Everything that is not a letter, a combining mark (matras, virama,
     nukta…) or a digit, in ANY script. RegExp constructor + fallback so an
     engine without Unicode property escapes can still parse this file. */
  var NON_WORD = (function () {
    try { return new RegExp("[^\\p{L}\\p{M}\\p{N}']", 'gu'); }
    catch (e) { return /[^a-z0-9'À-ɏͰ-ӿ؀-ۿݐ-ݿऀ-෿꣠-ꣿ]/g; }
  })();

  /* One comparable token per word in any script: NFC, Latin case-folded,
     curly apostrophes straightened, punctuation and dandas dropped. (It used
     to keep only a-z/0-9, so every Devanagari word came out empty.) */
  function clean(w) {
    var s = String(w == null ? '' : w);
    if (s.normalize) s = s.normalize('NFC');
    return s.toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(NON_WORD, '').replace(/^'+|'+$/g, '');
  }
  function wordMap(list) { var o = {}; for (var i = 0; i < list.length; i++) o[clean(list[i])] = 1; return o; }

  /* Pure hesitation sounds — cut wherever they occur (the default list).
     Hindi speakers say "aaa… / umm / hmm" too; Devanagari transcripts write
     them उम्म / अं / हम्म / आआ. "hum"/"हम" (we) are words and are NOT here. */
  var FILLER_WORDS = wordMap([
    'um', 'umm', 'ummm', 'ummmm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'hmmm', 'hmmmm', 'hm', 'mm', 'mhm',
    'mmm', 'eh', 'aaa', 'aaaa', 'aaah',
    'उम', 'उम्म', 'उम्मम', 'अम्म', 'अं', 'अंअ', 'हम्म', 'हम्मम', 'हम्मम्म', 'आआ', 'आआआ', 'एम्म'
  ]);

  /* Words that are filler ONLY when said on their own. "aa" is also the verb
     "come" ("aa jao"), "matlab" also means "means" ("iska matlab hai"), "like"
     is also a verb, and "toh / acha / dekho / yaani" are real Hindi words. So
     they are cut only when a pause (or a comma) sits on BOTH sides of them, or
     they are the whole line — and never when a grammar guard below says the
     word is doing a job in the sentence. On by default. */
  var DISCOURSE_WORDS = wordMap([
    'aa', 'आ',
    'matlab', 'matlb', 'toh', 'basically', 'like', 'acha', 'achha', 'accha', 'acchha', 'dekho', 'yaani', 'yani', 'yaane',
    'मतलब', 'तो', 'अच्छा', 'देखो', 'यानी', 'यानि', 'बेसिकली'
  ]);
  var DISCOURSE_PHRASES = [
    ['you', 'know'], ['kya', 'bolte', 'hain'], ['kya', 'kehte', 'hain'], ['kya', 'bolte', 'hai'], ['kya', 'kehte', 'hai'],
    ['क्या', 'बोलते', 'हैं'], ['क्या', 'कहते', 'हैं'], ['यू', 'नो']
  ].map(function (p) { return p.map(clean); });

  /* Opt-in (opts.extra): real words that are *usually* filler but can be
     meaningful, so they are off by default to avoid cutting real speech. */
  var FILLER_EXTRA = {
    like: 1, so: 1, well: 1, right: 1, okay: 1, ok: 1, anyway: 1, anyways: 1,
    actually: 1, basically: 1, literally: 1, honestly: 1, just: 1
  };

  /* Multi-word phrases cut ANYWHERE — only with opts.extra now. "what kind of
     camera", "do you know the answer", "I mean it" are speech, and the old
     always-on list cut all of them. */
  var FILLER_PHRASES = [
    ['you', 'know', 'what', 'i', 'mean'],
    ['you', 'know'], ['i', 'mean'], ['i', 'guess'],
    ['sort', 'of'], ['kind', 'of'], ['or', 'something'], ['or', 'whatever']
  ];

  /* Grammar guards for the stand-alone words. */
  var LIKE_AFTER = wordMap(['i', 'you', 'we', 'they', 'he', 'she', 'would', "i'd", "you'd", "we'd", "they'd", 'do', 'did',
    "don't", 'dont', "didn't", 'didnt', 'to', 'really', 'also', 'will', 'might', 'people', 'who', 'not', 'feel', 'looks', 'look',
    'sounds', 'seems', 'just', 'more', 'most', 'much']);
  var MATLAB_AFTER = wordMap(['iska', 'uska', 'iski', 'uski', 'jiska', 'kiska', 'kya', 'ka', 'ki', 'ke', 'is', 'us', 'mera', 'tera',
    'apna', 'koi', 'kuch', 'aapka', 'tumhara', 'hamara', 'इसका', 'उसका', 'इसकी', 'उसकी', 'जिसका', 'क्या', 'का', 'की', 'के',
    'मेरा', 'तेरा', 'अपना', 'कोई', 'कुछ', 'आपका']);
  var MATLAB_BEFORE = wordMap(['hai', 'hain', 'hota', 'hoti', 'hua', 'tha', 'thi', 'nahi', 'nahin', 'samjhe', 'samjha', 'है', 'हैं',
    'होता', 'होती', 'हुआ', 'था', 'थी', 'नहीं']);
  var AA_BEFORE = wordMap(['jao', 'jaao', 'jaiye', 'jana', 'gaya', 'gayi', 'gaye', 'raha', 'rahi', 'rahe', 'jaa', 'ja', 'sakta',
    'sakte', 'sakti', 'kar', 'ke', 'jaunga', 'jayega', 'jaega', 'जाओ', 'जाइए', 'गया', 'गई', 'गए', 'रहा', 'रही', 'रहे', 'जा',
    'सकता', 'सकते', 'कर', 'के']);
  var YOUKNOW_AFTER = wordMap(['do', 'did', "don't", 'dont', "didn't", 'didnt', 'if', 'as', 'what', 'how', 'would', 'could',
    'should', "you'd", 'will', 'might', 'now', 'since', 'already']);
  var YOUKNOW_BEFORE = wordMap(['the', 'that', 'what', 'how', 'him', 'her', 'it', 'about', 'this', 'them', 'why', 'who', 'where',
    'when', 'which', 'me', 'us', 'everything', 'nothing', 'anything', 'something', 'someone', 'anyone', 'a', 'an', 'my', 'your',
    'his', 'their', 'our', 'more', 'less', 'better', 'too']);
  var PAUSE_PUNCT = /[,.!?;:…—–।॥۔؟،-]["'”’)\]]*$/;
  var QUESTION_PUNCT = /[?؟？]["'”’)\]]*$/;
  var EDGE_PUNCT = /^["'“”‘’(\[]+|[,.!?;:…—–।॥۔؟،"'“”‘’)\]-]+$/g;   // "know," → "know" in the review list

  /* Common English stop words — excluded from TF-IDF salience so the
     highlight lands on content, not glue. The KEYWORD side (this list,
     tokenize, markSalient) is deliberately a–z only, exactly as before the
     filler work: caption emphasis looks keywords up with an a–z key, so a
     Devanagari keyword would take an emphasis slot it can never fill, and
     adding Hinglish "main" (I) here stopped English "main" being emphasised.
     The filler finder uses clean() above, which reads every script. */
  var STOP = {};
  ('a an and are as at be been being but by can could did do does doing for ' +
   'from had has have having he her here hers him his how i if in into is it ' +
   'its just me my no nor not of off on or our out over own she should so some ' +
   'such than that the their them then there these they this those to too up ' +
   'us was we were what when where which while who whom why will with would you ' +
   'your yours yeah ok okay gonna wanna got get really very much many one also ' +
   'now then thing things way').split(/\s+/).forEach(function (w) { STOP[w] = 1; });

  /* The keyword side's word key: lowercase a–z / 0–9 / apostrophe only. */
  function kwClean(w) { return String(w).toLowerCase().replace(/[^a-z0-9']/g, ''); }

  /* Split a string into lowercased alphanumeric tokens (apostrophes kept
     inside words, e.g. "don't") — for keyword salience. */
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

  /* The words findFillerRanges works on, split into runs of connected speech.
     With REAL word timing (cues.words — what the panel's transcribers attach)
     each word keeps its own start/end and a run breaks at any gap ≥ 0.5 s.
     Without it each cue is one run and words are placed by length inside it —
     only a fallback now: that estimate put cuts NEXT to the "um" (leaving it
     in) and into the neighbouring word. */
  function fillerRuns(cues, words) {
    var runs = [], i;
    if (words && words.length) {
      var ws = [];
      for (i = 0; i < words.length; i++) {
        var w = words[i];
        if (!w || w.text == null || !isFinite(+w.start) || !isFinite(+w.end) || +w.end < +w.start) continue;
        var raw = String(w.text).trim();
        if (raw) ws.push({ start: +w.start, end: +w.end, raw: raw, tok: clean(raw) });
      }
      ws.sort(function (a, b) { return a.start - b.start; });
      var cur = [];
      for (i = 0; i < ws.length; i++) {
        if (cur.length && ws[i].start - cur[cur.length - 1].end >= 0.5) { runs.push(cur); cur = []; }
        cur.push(ws[i]);
      }
      if (cur.length) runs.push(cur);
      return { runs: runs, timed: true };
    }
    for (var c = 0; c < (cues || []).length; c++) {
      var wt = wordTimings(cues[c]);
      if (wt.length) runs.push(wt);
    }
    return { runs: runs, timed: false };
  }

  /*
   * Find filler-word occurrences across the transcript and return them as cut
   * ranges (sorted, optionally padded and merged).
   *   cues: [{start,end,text}], optionally carrying cues.words =
   *         [{start,end,text}] — real per-word timing, used whenever present.
   * opts: {
   *   extra:    also cut FILLER_EXTRA words and FILLER_PHRASES anywhere (default false),
   *   words:    custom single-word map (overrides the defaults),
   *   phrases:  custom phrase list (overrides the defaults),
   *   padding:  seconds added to each side of a hit — with real timing it
   *             never reaches into the neighbouring word (default 0),
   *   mergeGap: merge hits within this gap (default 0.08),
   *   pause:    silence (s) that sets a discourse word apart (default 0.18)
   * }
   * Returns { ranges:[{start,end,word}], count, removed, timed }.
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
    var phrases = opts.phrases || (opts.extra ? FILLER_PHRASES : []);
    var discourse = opts.words ? {} : DISCOURSE_WORDS;
    var dPhrases = (opts.words || opts.phrases) ? [] : DISCOURSE_PHRASES;
    var pad = opts.padding != null ? opts.padding : 0;
    var pauseS = opts.pause != null ? opts.pause : 0.18;
    var fr = fillerRuns(cues, cues && cues.words);
    var hits = [];

    function matchAt(ws, i, list) {
      var best = 0;
      for (var p = 0; p < list.length; p++) {
        var ph = list[p];
        if (!ph.length || i + ph.length > ws.length || ph.length <= best) continue;
        var ok = true;
        for (var j = 0; j < ph.length; j++) if (ws[i + j].tok !== ph[j]) { ok = false; break; }
        if (ok) best = ph.length;
      }
      return best;
    }
    /* A pause (or a comma / sentence mark / the edge of the line) before word i… */
    function boundedLeft(ws, i) {
      if (i === 0) return true;
      if (PAUSE_PUNCT.test(ws[i - 1].raw)) return true;
      return fr.timed && (ws[i].start - ws[i - 1].end) >= pauseS;
    }
    /* …and after word e. */
    function boundedRight(ws, e) {
      if (e === ws.length - 1 || PAUSE_PUNCT.test(ws[e].raw)) return true;
      return fr.timed && (ws[e + 1].start - ws[e].end) >= pauseS;
    }
    function allFiller(ws) {
      for (var q = 0; q < ws.length; q++) if (!single[ws[q].tok] && !discourse[ws[q].tok]) return false;
      return true;
    }
    /* The word is doing a job in the sentence here — keep it, pauses or not. */
    function guarded(ws, i, n) {
      var prev = i > 0 ? ws[i - 1].tok : '', next = (i + n < ws.length) ? ws[i + n].tok : '';
      var first = ws[i].tok, last = ws[i + n - 1];
      var closed = PAUSE_PUNCT.test(last.raw);   // "you know, the thing is…" — the comma ends it
      if (QUESTION_PUNCT.test(last.raw)) return true;                              // "isko kya bolte hain?"
      if (n === 1 && first === 'like' && LIKE_AFTER[prev]) return true;             // "I like it"
      if (n === 1 && (first === 'matlab' || first === 'matlb' || first === clean('मतलब')) &&
          (MATLAB_AFTER[prev] || (!closed && MATLAB_BEFORE[next]))) return true;    // "iska matlab hai"
      if (n === 1 && (first === 'aa' || first === clean('आ')) && !closed && AA_BEFORE[next]) return true;   // "aa jao"
      if (n === 2 && first === 'you' && (YOUKNOW_AFTER[prev] || (!closed && YOUKNOW_BEFORE[next]))) return true; // "do you know the answer"
      return false;
    }

    for (var r = 0; r < fr.runs.length; r++) {
      var ws = fr.runs[r];
      var whole = allFiller(ws);
      var i = 0;
      while (i < ws.length) {
        var n = matchAt(ws, i, phrases);
        if (!n && single[ws[i].tok]) n = 1;
        if (!n) {
          var d = matchAt(ws, i, dPhrases);
          if (!d && discourse[ws[i].tok]) d = 1;
          if (d && !guarded(ws, i, d) && (whole || (boundedLeft(ws, i) && boundedRight(ws, i + d - 1)))) n = d;
        }
        if (n) {
          var label = [];
          for (var q = 0; q < n; q++) label.push(ws[i + q].raw.replace(EDGE_PUNCT, ''));
          var s = ws[i].start, e = ws[i + n - 1].end;
          if (pad) {
            if (fr.timed) {
              // pad into the silence only — never into the neighbouring words
              var lo = i > 0 ? Math.min(ws[i - 1].end, s) : Math.max(0, s - pad);
              var hi = (i + n < ws.length) ? Math.max(ws[i + n].start, e) : e + pad;
              s = Math.max(s - pad, lo); e = Math.min(e + pad, hi);
            } else { s = Math.max(0, s - pad); e = e + pad; }
          }
          hits.push({ start: s, end: e, word: label.join(' '), run: r, from: i, to: i + n });
          i += n;
          continue;
        }
        i++;
      }
    }

    var ranges;
    if (fr.timed) {
      // with real timing, join only fillers that follow each other word for
      // word ("um uh") — a short real word between two fillers must survive
      ranges = [];
      for (var h = 0; h < hits.length; h++) {
        var last = ranges[ranges.length - 1];
        if (last && last._run === hits[h].run && last._to === hits[h].from) {
          last.end = Math.max(last.end, hits[h].end); last.word += ' ' + hits[h].word; last._to = hits[h].to;
        } else ranges.push({ start: hits[h].start, end: hits[h].end, word: hits[h].word, _run: hits[h].run, _to: hits[h].to });
      }
      ranges = ranges.map(function (x) { return { start: x.start, end: x.end, word: x.word }; });
    } else ranges = mergeRanges(hits, opts.mergeGap != null ? opts.mergeGap : 0.08);
    var removed = 0;
    for (var rr = 0; rr < ranges.length; rr++) removed += ranges[rr].end - ranges[rr].start;
    return { ranges: ranges, count: ranges.length, removed: removed, timed: fr.timed };
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
    for (var i = 0; i < words.length; i++) flags.push(!!set[kwClean(words[i])]);
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
