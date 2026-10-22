/*
 * hookcheck.js — 🪝 Hook check: how strong the first 3 seconds of a short are.
 *
 * Half of a short's viewers leave in its first 3 seconds. Each moment Shorts
 * finds gets a score out of 100 for the opening the FINISHED short will have
 * (the warm-up words trimmed and pauses shortened, as Make this short does),
 * and one plain line on what would make it stronger:
 *   · it opens on a question, a bold line, a number or "you/aap"
 *   · it does not start mid-thought ("and…", "toh…", "lekin…")
 *   · enough words land in the first 3 seconds (no slow start)
 * (no hook title card: Pulse no longer puts one over the opening — the words
 * are the hook, and anything that delays them costs viewers)
 * Pure: words in, score out (uses CPShorts' own trimming and hook reading).
 */
(function (root) {
  'use strict';
  function S() { return root.CPShorts || null; }

  /* words: [{text,start,end}] of the whole transcript (sequence seconds);
     h: the moment ({start,end,hook}). → { score, label, tip, opening } */
  function check(words, h) {
    var lib = S();
    if (!lib || !h) return null;
    var inMoment = (words || []).filter(function (w) { return w && +w.start >= h.start - 0.05 && +w.start < h.end; });
    if (!inMoment.length) return null;
    var plan = lib.tightenPlan(lib.trimEnds(inMoment));
    var first = plan.words.filter(function (w) { return w.start < 3; });
    var opening = first.map(function (w) { return w.text; }).join(' ');
    var hs = lib.hookScore(opening), n = first.length;
    var midThought = hs.why.indexOf('starts mid-thought') >= 0 || hs.score <= -20;
    var score = 40 + Math.min(n, 8) * 4 + Math.max(-30, Math.min(40, hs.score)) * 0.8;
    // a short that starts mid-thought loses its viewers however fast it talks
    if (midThought) score = Math.min(score, 45);
    score = Math.max(0, Math.min(100, Math.round(score)));
    var tip;
    if (midThought) tip = 'Starts mid-thought — viewers miss what came before. Pick a moment that opens on its own line.';
    else if (n < 4) tip = 'A slow first 3 seconds (' + n + ' word' + (n === 1 ? '' : 's') + '). Start where the talking is quick.';
    else if (!hs.why.length) tip = 'Open on a question, a bold line or a number — it stops the scroll.';
    else tip = 'Strong start: ' + hs.why.join(', ') + '.';
    return { score: score, label: score >= 75 ? 'Strong hook' : (score >= 50 ? 'OK hook' : 'Weak hook'), tip: tip, opening: opening };
  }

  root.CPHookCheck = { check: check };
})(typeof window !== 'undefined' ? window : this);
