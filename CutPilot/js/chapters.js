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
   'got really very up out if than too also one more many thing things way ' +
   // Hinglish
   'hai hain ki ka ke ko me mein main aur se toh to ye yeh wo woh vo nahi nahin hum aap ' +
   'kya bhi tha thi the ho hota hoti kar karna karte raha rahe rahi ek par jo ke liye ' +
   'bhai yaar haan accha acha matlab basically actually like know mean right because ' +
   'phir fir agar lekin magar sab kuch koi kaise kyun kab kahan jab tab abhi bahut zyada ' +
   'baare baat baatein karenge karo karta karti bol bolo bola bolte wala wali wale saath sath ' +
   'aaj kal log logon unka unki unke apna apni apne isko usko iska uska hoga hogi sakte sakta ' +
   'dekho dekhiye samjho chahiye hota jaise waise aise vaise bilkul sahi ' +
   // Devanagari
   'है हैं के की का को में और से तो ये यह वो वह नहीं हम आप मैं क्या भी था थी थे हो कर रहा रहे ' +
   'एक पर जो कि लिए बहुत कुछ कोई अब जब तब फिर अगर लेकिन सब आज बात करेंगे करना करते ' +
   'बारे वाला वाली वाले साथ अपना अपनी अपने लोग होगा सकते चाहिए जैसे बिल्कुल सही').split(/\s+/)
    .forEach(function (w) { STOP[w] = 1; });

  // letters of any script Pulse captions (Latin, Devanagari) survive
  function clean(w) { return String(w).toLowerCase().replace(/[^a-z0-9'\u0900-\u097f]/g, '').replace(/^'+|'+$/g, ''); }
  function titleCase(s) { return String(s).replace(/(^|\s)([a-z])/g, function (m, sp, c) { return sp + c.toUpperCase(); }); }
  function wordsOf(text) {
    var out = [], toks = String(text || '').split(/\s+/);
    for (var j = 0; j < toks.length; j++) {
      var t = clean(toks[j]);
      // a Devanagari word of 2 letters can be a real noun; Latin needs 4
      if (!t || STOP[t] || (/^[a-z0-9']+$/.test(t) ? t.length < 4 : t.length < 2)) continue;
      out.push(t);
    }
    return out;
  }

  /* Most frequent meaningful word across a set of cues -> a short title. */
  function labelFor(cues) {
    var freq = {}, best = null, bestN = 0, i, j;
    for (i = 0; i < cues.length; i++) {
      var ws = wordsOf(cues[i].text);
      for (j = 0; j < ws.length; j++) {
        var t = ws[j];
        freq[t] = (freq[t] || 0) + 1;
        if (freq[t] > bestN) { bestN = freq[t]; best = t; }
      }
    }
    if (best) return titleCase(best);
    var fw = String((cues[0] && cues[0].text) || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
    return titleCase(fw) || 'Chapter';
  }

  /* A chapter's title: its 1–2 most telling words — frequent in it, rare in
     the other chapters (a podcast says "paisa" everywhere; the chapter about
     the stock market is the one that keeps saying "stock"). */
  function titlesFor(groups) {
    var df = {};
    var counts = groups.map(function (cs) {
      var f = {};
      cs.forEach(function (c) { wordsOf(c.text).forEach(function (w) { f[w] = (f[w] || 0) + 1; }); });
      Object.keys(f).forEach(function (w) { df[w] = (df[w] || 0) + 1; });
      return f;
    });
    var n = groups.length;
    return counts.map(function (f, gi) {
      // a word said in EVERY chapter tells none of them apart (it scores 0.1)
      var scored = Object.keys(f).map(function (w) { return { w: w, n: f[w], s: f[w] * (Math.log(n / df[w]) + 0.1) }; })
        .sort(function (a, b) { return b.s - a.s || b.n - a.n; });
      if (!scored.length) return labelFor(groups[gi]);
      var t = scored[0].w;
      if (scored[1] && scored[1].n >= 2 && scored[1].s >= 0.6 * scored[0].s) t += ' ' + scored[1].w;
      return titleCase(t);
    });
  }

  /*
   * Chapters where the TOPIC changes (YouTube/podcast style). It used to close
   * a chapter every `minChapterSec` seconds whatever was said: a 2-hour
   * podcast got 220 "chapters" titled "Paisa, Stock, Paisa, Stock…".
   * Now: at every pause between lines, the words said in the stretch before
   * are compared with the words after (cosine of word counts); the chapter
   * breaks go where they differ most (the deepest dips), at least
   * `minChapterSec` (default 30) apart and from either end, about one per 5
   * minutes (2–15 in all, opts.max to change). The first chapter starts at
   * 0:00 (YouTube requires it). Returns [{start, title}].
   */
  function buildChapters(cues, opts) {
    opts = opts || {};
    var minSec = opts.minChapterSec || 30;
    if (!cues || !cues.length) return [];
    var cs = cues.filter(function (c) { return c && c.text != null; }).slice().sort(function (a, b) { return a.start - b.start; });
    if (!cs.length) return [];
    var t0 = +cs[0].start, t1 = +cs[cs.length - 1].end, dur = t1 - t0;
    var maxN = opts.max || Math.max(2, Math.min(15, Math.round(dur / 300)));
    var W = Math.max(minSec, Math.min(120, dur / 40));      // how much talk each side is compared
    var bags = cs.map(function (c) { var f = {}; wordsOf(c.text).forEach(function (w) { f[w] = (f[w] || 0) + 1; }); return f; });
    // a word heard in nearly every line (the show's name, a catchphrase)
    // says nothing about the topic: each word counts by how rare it is
    // across the lines, so it cannot drown out the words that change
    var lineDf = {};
    bags.forEach(function (f) { for (var w in f) lineDf[w] = (lineDf[w] || 0) + 1; });
    bags = bags.map(function (f) {
      var g = {};
      for (var w in f) { var idf = Math.log(cs.length / lineDf[w]); if (idf > 0.05) g[w] = f[w] * idf; }
      return g;
    });
    function bag(lo, hi) {   // cues whose middle lies in [lo, hi)
      var f = {};
      for (var k = 0; k < cs.length; k++) {
        var m = (cs[k].start + cs[k].end) / 2;
        if (m < lo || m >= hi) continue;
        for (var w in bags[k]) f[w] = (f[w] || 0) + bags[k][w];
      }
      return f;
    }
    function cos(a, b) {
      var dot = 0, na = 0, nb = 0, w;
      for (w in a) { na += a[w] * a[w]; if (b[w]) dot += a[w] * b[w]; }
      for (w in b) nb += b[w] * b[w];
      return (na && nb) ? dot / Math.sqrt(na * nb) : 1;
    }
    // one candidate break per line start (after the first)
    var gaps = [];
    for (var i = 1; i < cs.length; i++) {
      var t = +cs[i].start;
      if (t - t0 < minSec || t1 - t < minSec) continue;
      gaps.push({ i: i, t: t, sim: cos(bag(t - W, t), bag(t, t + W)) });
    }
    if (!gaps.length) return [{ start: 0, title: labelFor(cs) }];
    // depth: how far the similarity dips below the peaks on either side
    for (var g = 0; g < gaps.length; g++) {
      var l = gaps[g].sim, r = gaps[g].sim, a;
      for (a = g - 1; a >= 0 && gaps[g].t - gaps[a].t <= W * 2; a--) l = Math.max(l, gaps[a].sim);
      for (a = g + 1; a < gaps.length && gaps[a].t - gaps[g].t <= W * 2; a++) r = Math.max(r, gaps[a].sim);
      gaps[g].depth = (l - gaps[g].sim) + (r - gaps[g].sim);
    }
    // only real dips: deeper than the typical one
    var depths = gaps.map(function (x) { return x.depth; }).filter(function (d) { return d > 0; }).sort(function (x, y) { return x - y; });
    // a topic change is a dip clearly deeper than the talk's usual wobble
    var mean = 0, sd = 0;
    depths.forEach(function (d) { mean += d; }); mean /= Math.max(1, depths.length);
    depths.forEach(function (d) { sd += (d - mean) * (d - mean); }); sd = Math.sqrt(sd / Math.max(1, depths.length));
    var bar = depths.length ? Math.max(depths[Math.floor(depths.length / 2)], mean + 0.75 * sd) : Infinity;
    var picked = [];
    gaps.slice().sort(function (x, y) { return y.depth - x.depth || x.sim - y.sim; }).forEach(function (x) {
      // …and big in its own right: one topic all along has only small wobbles
      if (picked.length >= maxN - 1 || !(x.depth >= 0.25) || x.depth < bar) return;
      // two breaks in one dip are one topic change: as far apart as the
      // stretch compared (else 43:27 and 43:59 both made it)
      if (picked.some(function (p) { return Math.abs(p.t - x.t) < Math.max(minSec, W); })) return;
      picked.push(x);
    });
    picked.sort(function (x, y) { return x.i - y.i; });
    var groups = [], from = 0;
    picked.forEach(function (p) { groups.push(cs.slice(from, p.i)); from = p.i; });
    groups.push(cs.slice(from));
    var titles = titlesFor(groups);
    var chapters = groups.map(function (gr, k) { return { start: k ? +gr[0].start : 0, title: titles[k] }; });
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
    titlesFor: titlesFor,
    buildChapters: buildChapters,
    formatTimecode: formatTimecode,
    formatChapters: formatChapters
  };
});
