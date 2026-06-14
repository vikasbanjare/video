/*
 * CutPilot — command-palette matcher (⌘K quick actions).
 * Pure fuzzy/subsequence scoring so the palette ranking is unit-testable.
 * No DOM/CEP dependencies.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPCommand = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /*
   * Score how well `query` matches `text` (higher = better, -1 = no match).
   * Subsequence match (query chars appear in order), rewarding contiguous
   * runs, word-boundary hits, and early matches.
   */
  function score(text, query) {
    text = String(text || '').toLowerCase();
    query = String(query || '').toLowerCase().replace(/\s+/g, '');
    if (!query) return 0;
    var ti = 0, qi = 0, s = 0, streak = 0, firstIdx = -1;
    while (ti < text.length && qi < query.length) {
      if (text.charAt(ti) === query.charAt(qi)) {
        if (firstIdx < 0) firstIdx = ti;
        streak++;
        s += 1 + streak;                                   // contiguous bonus
        if (ti === 0 || /[^a-z0-9]/.test(text.charAt(ti - 1))) s += 4; // word start
        qi++;
      } else {
        streak = 0;
      }
      ti++;
    }
    if (qi < query.length) return -1;                      // not all chars matched
    return s + Math.max(0, 20 - firstIdx);                 // earlier = better
  }

  /*
   * Filter + rank a list of actions against a query. Each action is matched on
   * its `label`, `keywords`, and `group`. Empty query returns the list as-is.
   */
  function filter(actions, query) {
    if (!String(query || '').trim()) return actions.slice();
    var scored = [];
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      var hay = (a.label || '') + ' ' + (a.keywords || '') + ' ' + (a.group || '');
      var sc = score(hay, query);
      if (sc >= 0) scored.push({ a: a, s: sc, i: i });
    }
    scored.sort(function (x, y) { return y.s - x.s || x.i - y.i; });
    return scored.map(function (o) { return o.a; });
  }

  return { score: score, filter: filter };
});
