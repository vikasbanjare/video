/*
 * Pulse — chapter generator.
 * Turns transcript cues into timestamped chapters (YouTube/podcast style):
 * segment by a minimum length, then label each chapter with its most frequent
 * content word. Pure + unit-testable; no DOM/CEP dependencies.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPChapters = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var STOP = {};
  ('the a an and or but of to in on for is are was were it this that with as at by ' +
   'be been being you your we our they them then there here so now just about into ' +
   'over from not no can could would should will yeah okay ok gonna wanna lets let us ' +
   'i me my he she his her their our what when where which who how why do does did get ' +
   'got really very up out if than too also one more many thing things way').split(/\s+/)
    .forEach(function (w) { STOP[w] = 1; });

  function clean(w) { return String(w).toLowerCase().replace(/[^a-z0-9']/g, ''); }
  function titleCase(s) { return String(s).replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }

  /* Most frequent meaningful word across a set of cues -> a short title. */
  function labelFor(cues) {
    var freq = {}, best = null, bestN = 0, i, j;
    for (i = 0; i < cues.length; i++) {
      var toks = String(cues[i].text || '').split(/\s+/);
      for (j = 0; j < toks.length; j++) {
        var t = clean(toks[j]);
        if (t.length < 4 || STOP[t]) continue;
        freq[t] = (freq[t] || 0) + 1;
        if (freq[t] > bestN) { bestN = freq[t]; best = t; }
      }
    }
    if (best) return titleCase(best);
    var fw = String((cues[0] && cues[0].text) || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
    return titleCase(fw) || 'Chapter';
  }

  /*
   * Build chapters from cues. A chapter closes once it spans at least
   * `minChapterSec` seconds (default 30); the first chapter always starts at 0
   * (YouTube requires it). Returns [{start, title}].
   */
  function buildChapters(cues, opts) {
    opts = opts || {};
    var minSec = opts.minChapterSec || 30;
    if (!cues || !cues.length) return [];
    var chapters = [], startIdx = 0, i;
    for (i = 0; i < cues.length; i++) {
      var chapStart = cues[startIdx].start;
      if (cues[i].end - chapStart >= minSec && i < cues.length - 1) {
        chapters.push({ start: cues[startIdx].start, title: labelFor(cues.slice(startIdx, i + 1)) });
        startIdx = i + 1;
      }
    }
    chapters.push({ start: cues[startIdx].start, title: labelFor(cues.slice(startIdx)) });
    chapters[0].start = 0;
    return chapters;
  }

  /* Seconds -> "M:SS" (or "H:MM:SS" past an hour), YouTube-chapter style. */
  function formatTimecode(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? (h + ':' + p2(m) + ':' + p2(s)) : (m + ':' + p2(s));
  }

  function formatChapters(chapters) {
    return (chapters || []).map(function (c) {
      return formatTimecode(c.start) + ' ' + c.title;
    }).join('\n');
  }

  return {
    labelFor: labelFor,
    buildChapters: buildChapters,
    formatTimecode: formatTimecode,
    formatChapters: formatChapters
  };
});
