/*
 * Pulse — the finished short.
 *
 * The owner: "how can we make the caption and short videos content more
 * better". "Make clip" cut the moment as it was spoken — every pause and
 * "um" kept, starting on "so…" / "accha…", no captions, no title — and the
 * moment finder needed an AI key. What holds viewers on a short (the short
 * tools and their retention data agree): the first 3 seconds decide (half
 * the drop-off happens there), burned-in captions (+15–25% retention), no
 * dead air, a short text hook on screen while the hook is said.
 *
 * Pure and DOM-free except drawHookCard (which is handed a canvas), so it
 * unit-tests in Node; main.js renders with ffmpeg and places the captions
 * with Pulse's own caption pipeline.
 *   trimEnds(words)          the clip starts on the hook, not on a filler
 *   tightenPlan(words, o)    which stretches of the source to keep (pauses
 *                            shortened, "um"/"uh" cut) and every kept word
 *                            on the short's own timeline
 *   localHighlights(segs, o) the strongest moments without an AI key
 *   hookText(h)              the few words shown on screen for 3 s
 *   drawHookCard(cv, text)   that text as a card at the top of the frame
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPShorts = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function norm(t) {
    return String(t == null ? '' : t).toLowerCase()
      .replace(/^[\s"'“”‘’(\[¿¡]+|[\s"'“”‘’)\].,!?;:…।॥۔؟-]+$/g, '');
  }
  function has(set, t) { return Object.prototype.hasOwnProperty.call(set, norm(t)); }

  // sounds that carry no words — never kept in a short
  var HESITATION = { um: 1, umm: 1, ummm: 1, uh: 1, uhh: 1, uhm: 1, erm: 1, hmm: 1, hmmm: 1, hm: 1, mm: 1, mmm: 1, mhm: 1,
                     'हम्म': 1, 'उम्म': 1, 'अं': 1 };
  // words a speaker warms up with before the real first line. Only at the very
  // start (and end) of a clip — inside a sentence "so" and "to" are real words.
  var LEAD_IN = { so: 1, okay: 1, ok: 1, alright: 1, right: 1, well: 1, yeah: 1, yes: 1, like: 1, basically: 1, actually: 1, and: 1, but: 1,
                  accha: 1, achha: 1, acha: 1, toh: 1, to: 1, haan: 1, han: 1, ha: 1, matlab: 1, dekho: 1, aur: 1, lekin: 1, par: 1,
                  'अच्छा': 1, 'तो': 1, 'हाँ': 1, 'हां': 1, 'मतलब': 1, 'देखो': 1, 'और': 1, 'लेकिन': 1 };
  var TAIL_OFF = { so: 1, and: 1, but: 1, like: 1, okay: 1, ok: 1, right: 1, yeah: 1, toh: 1, to: 1, aur: 1, accha: 1, achha: 1, haan: 1,
                   'तो': 1, 'और': 1, 'अच्छा': 1, 'हाँ': 1 };

  function isHesitation(t) { return has(HESITATION, t); }

  /* The words of a moment without the warm-up before its first real word
     and the trail-off after its last ("so… accha… THE line … so"). Keeps at
     least `keep` words. */
  function trimEnds(words, keep) {
    var w = (words || []).filter(function (x) { return x && String(x.text || '').trim() && !isHesitation(x.text); });
    keep = keep || 3;
    var a = 0, b = w.length;
    while (b - a > keep && has(LEAD_IN, w[a].text)) a++;
    while (b - a > keep && has(TAIL_OFF, w[b - 1].text)) b--;
    return w.slice(a, b);
  }

  /* Which stretches of the source make the short, and where each kept word
     lands on the short's own timeline. words: [{text,start,end}] in source
     seconds, already trimmed. A pause longer than maxGap becomes keepGap;
     "um"/"uh" are cut like a pause. lead/tail: room before the first word
     and after the last.
     → { segments: [{start,end}] (source), words: [{text,start,end}] (short),
         duration, removed (seconds cut) } */
  function tightenPlan(words, o) {
    o = o || {};
    var maxGap = o.maxGap != null ? o.maxGap : 0.35, keepGap = o.keepGap != null ? o.keepGap : 0.14;
    var lead = o.lead != null ? o.lead : 0.08, tail = o.tail != null ? o.tail : 0.3;
    var w = (words || []).filter(function (x) { return x && String(x.text || '').trim() && !isHesitation(x.text) && +x.end >= +x.start; })
      .map(function (x) { return { text: String(x.text), start: +x.start, end: +x.end }; })
      .sort(function (a, b) { return a.start - b.start; });
    if (!w.length) return { segments: [], words: [], duration: 0, removed: 0 };
    if (o.tight === false) { maxGap = Infinity; }
    var segs = [], cur = { start: Math.max(0, w[0].start - lead), end: w[0].end };
    for (var i = 1; i < w.length; i++) {
      var gap = w[i].start - cur.end;
      if (gap > maxGap) {
        cur.end = cur.end + keepGap / 2;
        segs.push(cur);
        cur = { start: w[i].start - keepGap / 2, end: w[i].end };
      } else cur.end = Math.max(cur.end, w[i].end);
    }
    cur.end += tail;
    segs.push(cur);
    // the short's clock: each segment follows the last with no gap
    var out = [], offs = [], t = 0;
    segs.forEach(function (s) { offs.push(t - s.start); t += s.end - s.start; });
    var si = 0;
    w.forEach(function (x) {
      while (si < segs.length - 1 && x.start >= segs[si].end) si++;
      out.push({ text: x.text, start: +(x.start + offs[si]).toFixed(3), end: +(Math.min(x.end, segs[si].end) + offs[si]).toFixed(3) });
    });
    var span = segs[segs.length - 1].end - segs[0].start;
    return { segments: segs.map(function (s) { return { start: +s.start.toFixed(3), end: +s.end.toFixed(3) }; }),
             words: out, duration: +t.toFixed(3), removed: +Math.max(0, span - t).toFixed(3) };
  }

  /* Sentence-sized lines of the short's words, for the caption pipeline. */
  function sentenceCues(words) {
    var cues = [], cur = [];
    (words || []).forEach(function (w, i, all) {
      cur.push(w);
      var nx = all[i + 1];
      if (/[.!?।॥۔؟…]["'”’)\]]*$/.test(w.text) || !nx || nx.start - w.end > 0.6 || cur.length >= 14) {
        cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map(function (x) { return x.text; }).join(' ') });
        cur = [];
      }
    });
    return cues;
  }

  // ---- finding moments without an AI key ---------------------------------
  var QUESTION_START = /^(why|how|what|who|when|where|which|is|are|do|does|did|can|should|would|kya|kyun|kyon|kaise|kaun|kitna|kitne|kab|kahan|क्या|क्यों|कैसे|कौन|कितना|कब|कहाँ)\b/i;
  var STRONG = /\b(secret|secrets|mistake|mistakes|never|nobody|no one|truth|biggest|best|worst|stop|money|million|crore|lakh|lakhs|rich|broke|free|hack|hacks|why|warning|shocking|actually|exactly|important|problem|easy|simple|fastest|only|everyone|nobody|sach|galti|kabhi|sabse|raaz|paisa|paise|zindagi|asli|seedha|bilkul|sach|सच|गलती|कभी|सबसे|राज़|पैसा|ज़िंदगी|असली)\b/i;
  var NUMBER = /(\d|\b(one|two|three|five|ten|hundred|thousand|ek|do|teen|paanch|das|sau|hazaar|lakh|crore)\b|%)/i;
  var YOU = /\b(you|your|you're|aap|aapko|aapka|aapki|tum|tumhe|tumhara|आप|तुम)\b/i;
  var CONNECTIVE = /^(and|but|so|because|also|then|which|that|aur|lekin|par|toh|to|kyunki|isliye|phir|और|लेकिन|तो|क्योंकि|फिर)\b/i;
  var BACKREF = /\b(as i said|like i said|earlier|that one|this one|jaise maine kaha|pehle bataya|wahi)\b/i;
  var ENDS = /[.!?।॥۔؟…]["'”’)\]]*\s*$/;

  function hookScore(text) {
    var t = String(text || '').trim(), s = 0, why = [];
    if (/\?\s*$/.test(t) || QUESTION_START.test(t)) { s += 22; why.push('opens on a question'); }
    if (STRONG.test(t)) { s += 18; why.push('a bold claim'); }
    if (NUMBER.test(t)) { s += 10; why.push('a number'); }
    if (YOU.test(t)) { s += 8; why.push('talks to the viewer'); }
    if (CONNECTIVE.test(t)) { s -= 25; why.push('starts mid-thought'); }
    if (BACKREF.test(t)) { s -= 20; }
    return { score: s, why: why };
  }

  /* The strongest self-contained moments of a transcript, by its own words:
     a window of whole sentences, minLen–maxLen seconds, that opens on a hook
     (a question, a bold claim, a number, "you") and ends on a sentence end;
     brisk speech scores higher. Best first, no overlaps.
     segs: [{text,start,end}] (sentences); o: {min,max,count}. */
  function localHighlights(segs, o) {
    o = o || {};
    var minS = o.min || 15, maxS = o.max || 60, want = o.count || 6;
    segs = (segs || []).filter(function (s) { return s && String(s.text || '').trim() && +s.end > +s.start; });
    var cands = [];
    for (var i = 0; i < segs.length; i++) {
      var hk = hookScore(segs[i].text);
      if (hk.score < 0) continue;                    // never open mid-thought
      var words = 0, chars = 0;
      for (var j = i; j < segs.length; j++) {
        var dur = segs[j].end - segs[i].start;
        if (j > i && segs[j].start - segs[j - 1].end > 3) break;   // a long silence ends the moment
        words += String(segs[j].text).split(/\s+/).filter(Boolean).length;
        chars += String(segs[j].text).length;
        if (dur > maxS) break;
        if (dur < minS) continue;
        var endsClean = ENDS.test(segs[j].text);
        var wps = words / Math.max(1, dur);
        var s = 40 + hk.score + (endsClean ? 12 : -15) + Math.max(-10, Math.min(12, (wps - 2) * 8));
        // the middle of the length range reads best
        var mid = (minS + maxS) / 2, spread = Math.max(1, (maxS - minS) / 2);
        s -= Math.abs(dur - mid) / spread * 6;
        cands.push({ i: i, j: j, start: +segs[i].start, end: +segs[j].end, dur: dur, score: s, why: hk.why.concat(endsClean ? ['ends on a full stop'] : []) });
      }
    }
    cands.sort(function (a, b) { return b.score - a.score || a.start - b.start; });
    var picked = [];
    for (var k = 0; k < cands.length && picked.length < want; k++) {
      var c = cands[k];
      if (picked.some(function (p) { return c.start < p.end && p.start < c.end; })) continue;
      picked.push(c);
    }
    return picked.map(function (c) {
      var body = [];
      for (var m = c.i; m <= c.j; m++) body.push(String(segs[m].text).trim());
      var hook = String(segs[c.i].text).trim();
      return { start: c.start, end: c.end, dur: c.dur, score: Math.round(Math.max(1, Math.min(99, c.score))),
               title: titleFrom(hook), hook: hook.slice(0, 120), reason: c.why.length ? c.why.join(', ') : 'a complete thought',
               text: body.join(' '), local: true };
    });
  }

  /* A few words of a line as a title: up to 6 words, its own case. */
  function titleFrom(line) {
    var all = String(line || '').replace(/["“”]/g, '').split(/\s+/).filter(Boolean);
    var ws = all.length <= 8 ? all : all.slice(0, 6);
    var t = ws.join(' ').replace(/[,;:–—-]+$/, '') + (all.length > 8 ? '…' : '');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Clip';
  }

  /* The text shown on screen while the hook is said: the moment's title
     (3–6 words), else the start of its hook line — never more than 7 words. */
  function hookText(h) {
    var t = String((h && (h.title && h.title !== 'Clip' ? h.title : h.hook)) || '').replace(/\s+/g, ' ').trim();
    var ws = t.split(' ').filter(Boolean);
    if (ws.length > 7) t = ws.slice(0, 7).join(' ') + '…';
    return t;
  }

  /* Draw the hook card on a W×H transparent canvas: bold dark words on a
     white rounded card near the top (below the app's own top bar, above the
     face), at most 3 lines, the words shrunk until they fit 84% of the
     width. Returns the card's box. */
  function drawHookCard(cv, text, o) {
    o = o || {};
    var W = cv.width, H = cv.height, ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    text = String(text || '').trim();
    if (!text) return null;
    var deva = /[ऀ-ॿ]/.test(text);
    var family = deva ? '"Kohinoor Devanagari", "Noto Sans Devanagari", "Mukta", "Nirmala UI", sans-serif'
                      : '"Montserrat", "Arial Black", "Helvetica Neue", Arial, sans-serif';
    var maxW = W * 0.84, fs = Math.round(Math.min(W, H) * 0.075), minFs = Math.round(Math.min(W, H) * 0.04), lines;
    function wrap(limit) {
      ctx.font = '800 ' + fs + 'px ' + family;
      var ws = text.split(/\s+/), out = [], cur = '';
      for (var i = 0; i < ws.length; i++) {
        var tryL = cur ? cur + ' ' + ws[i] : ws[i];
        if (ctx.measureText(tryL).width <= limit || !cur) cur = tryL;
        else { out.push(cur); cur = ws[i]; }
      }
      if (cur) out.push(cur);
      return out;
    }
    for (;;) {
      lines = wrap(maxW - fs * 0.9);
      var widest = Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; }));
      if ((lines.length <= 3 && widest <= maxW - fs * 0.9) || fs <= minFs) break;
      fs = Math.max(minFs, Math.round(fs * 0.9));
    }
    // balanced lines: the narrowest width that still needs no more lines
    // ("Why most people / fail" → "Why most / people fail")
    if (lines.length > 1) {
      var lo = 0, hi = maxW - fs * 0.9;
      for (var it = 0; it < 14; it++) {
        var mid = (lo + hi) / 2;
        if (wrap(mid).length <= lines.length) hi = mid; else lo = mid;
      }
      lines = wrap(hi);
    }
    var lh = Math.round(fs * 1.18), padX = Math.round(fs * 0.45), padY = Math.round(fs * 0.3);
    var tw = Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; }));
    var bw = Math.min(W - 2, Math.round(tw + padX * 2)), bh = lines.length * lh + padY * 2;
    var bx = Math.round((W - bw) / 2), by = Math.round(H * (o.topPct != null ? o.topPct : 0.12));
    var r = Math.round(fs * 0.35);
    ctx.fillStyle = o.cardColor || '#ffffff';
    ctx.beginPath();
    ctx.moveTo(bx + r, by); ctx.lineTo(bx + bw - r, by); ctx.arcTo(bx + bw, by, bx + bw, by + r, r);
    ctx.lineTo(bx + bw, by + bh - r); ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r);
    ctx.lineTo(bx + r, by + bh); ctx.arcTo(bx, by + bh, bx, by + bh - r, r);
    ctx.lineTo(bx, by + r); ctx.arcTo(bx, by, bx + r, by, r);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = o.textColor || '#111111';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach(function (l, i) { ctx.fillText(l, W / 2, by + padY + lh * i + lh / 2); });
    return { x: bx, y: by, w: bw, h: bh, fontSize: fs, lines: lines };
  }

  /* ffmpeg's select expression keeping these segments (times relative to `base`). */
  function selectExpr(segments, base) {
    base = base || 0;
    return segments.map(function (s) {
      return 'between(t,' + Math.max(0, s.start - base).toFixed(3) + ',' + Math.max(0, s.end - base).toFixed(3) + ')';
    }).join('+');
  }

  return {
    isHesitation: isHesitation,
    trimEnds: trimEnds,
    tightenPlan: tightenPlan,
    sentenceCues: sentenceCues,
    hookScore: hookScore,
    localHighlights: localHighlights,
    titleFrom: titleFrom,
    hookText: hookText,
    drawHookCard: drawHookCard,
    selectExpr: selectExpr
  };
});
