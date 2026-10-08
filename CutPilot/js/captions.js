/*
 * Pulse — caption tooling.
 * SRT parse/serialize, word-by-word "karaoke" exploding, and the style
 * preset catalog used by both the native-caption and MOGRT pipelines.
 * Pure functions, unit-testable in Node.
 */
(function (root, factory) {
  var lib = factory();
  // CEP panels with --enable-nodejs have BOTH `module` and `window` — register in both.
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPCaptions = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* "00:01:02,345" -> seconds */
  function srtTimeToSeconds(t) {
    var m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t.trim());
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  }

  function secondsToSrtTime(sec) {
    if (sec < 0) sec = 0;
    var ms = Math.round(sec * 1000);
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var min = Math.floor(ms / 60000); ms -= min * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    function p(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    return p(h, 2) + ':' + p(min, 2) + ':' + p(s, 2) + ',' + p(ms, 3);
  }

  /* Parse SRT text into [{start, end, text}] */
  function parseSRT(text) {
    var blocks = text.replace(/\r/g, '').split(/\n\n+/);
    var cues = [];
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) continue;
      if (/^\d+$/.test(lines[0].trim())) lines.shift(); // optional index line
      if (!lines.length) continue;
      var tm = /([\d:,.]+)\s*-->\s*([\d:,.]+)/.exec(lines[0]);
      if (!tm) continue;
      cues.push({
        start: srtTimeToSeconds(tm[1]),
        end: srtTimeToSeconds(tm[2]),
        text: lines.slice(1).join('\n').trim()
      });
    }
    return cues;
  }

  function toSRT(cues) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      out.push(String(i + 1));
      out.push(secondsToSrtTime(cues[i].start) + ' --> ' + secondsToSrtTime(cues[i].end));
      out.push(cues[i].text);
      out.push('');
    }
    return out.join('\n');
  }

  /*
   * A caption's text in at most TWO lines of about perLine drawn letters,
   * '\n' between them: one line when it fits; otherwise the break with the
   * best grammar (never a noun from its postposition, a verb from its
   * auxiliary), the top line a little shorter than the bottom one, and never
   * one word alone. Premiere's native caption box re-wraps unbroken text at
   * its own width (often into three lines); explicit breaks keep this shape.
   * Pure + tested.
   */
  function wrapForNative(text, perLine) {
    perLine = perLine || 42;
    var ws = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().split(' ');
    if (!ws[0]) return '';
    if (ws.length < 2 || visLen(ws.join(' ')) <= perLine) return ws.join(' ');
    var ctx = textContext(ws), best = null;
    for (var k = 1; k < ws.length; k++) {
      var top = visLen(ws.slice(0, k).join(' ')), bot = visLen(ws.slice(k).join(' '));
      var over = Math.max(0, top - perLine) + Math.max(0, bot - perLine);
      var c = lineBreakCost(ws[k - 1], ws[k], ctx);
      var score = over * 10 + (c === Infinity ? 100 : c * 2) +
        Math.abs(top - 0.95 * bot) / perLine * 6 +
        ((k === 1 || k === ws.length - 1) && ws.length >= 3 ? 4 : 0);
      if (!best || score < best.score) best = { score: score, k: k };
    }
    return ws.slice(0, best.k).join(' ') + '\n' + ws.slice(best.k).join(' ');
  }

  /*
   * Caption lines ready for Premiere's own caption track: balanced two-line
   * text (wrapForNative), each caption on screen at least 1 s and 0.5 s past
   * its words where the silence after it allows, and on the sequence's frames
   * exactly 2 frames or at least half a second apart (never touching, never
   * overlapping). opts: { fps, perLine }. Pure + tested.
   */
  function nativeSubtitleCues(cues, opts) {
    opts = opts || {};
    var F = fpsExact(opts.fps), half = Math.round(F * 0.5), two = CAPTION_RULES.gapFrames;
    var list = [], i;
    for (i = 0; i < (cues || []).length; i++) {
      var c = cues[i];
      if (!c || !String(c.text == null ? '' : c.text).trim()) continue;
      list.push({ s: Math.round(+c.start * F), e: Math.round(+c.end * F), text: String(c.text) });
    }
    list.sort(function (a, b) { return a.s - b.s; });
    for (i = 1; i < list.length; i++) if (list[i].s < list[i - 1].s + 1 + two) list[i].s = list[i - 1].s + 1 + two;
    var out = [];
    for (i = 0; i < list.length; i++) {
      var cur = list[i], nx = list[i + 1];
      var e = Math.max(cur.e + Math.round(CAPTION_RULES.lagOut * F), cur.s + Math.round(1.0 * F));
      if (nx) {
        e = Math.min(e, nx.s - two);
        if (nx.s - e < half) e = nx.s - two;
      }
      if (e <= cur.s) e = cur.s + 1;
      out.push({ start: cur.s / F, end: e / F, text: wrapForNative(cur.text, opts.perLine || 42) });
    }
    return out;
  }

  /* Phonetic Devanagari -> Latin (for "Hinglish" captions: Hindi spoken, written
     in English letters). Not linguistically perfect (no full schwa-deletion) but
     produces the readable romanized style Indian creators use. English text and
     punctuation pass through untouched. */
  var _DEV_C = {
    'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'ny',
    'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n',
    'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v','श':'sh','ष':'sh',
    'स':'s','ह':'h','क़':'q','ख़':'kh','ग़':'gh','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f','ळ':'l'
  };
  var _DEV_V = { 'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au','ऑ':'o','ॐ':'om' };
  var _DEV_M = { 'ा':'aa','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ॉ':'o','ॅ':'e' };
  var _DEV_VIRAMA = '्', _DEV_ANUSVARA = 'ं', _DEV_CHANDRA = 'ँ', _DEV_VISARGA = 'ः';
  function devanagariToLatin(input) {
    if (!input || !/[ऀ-ॿ]/.test(input)) return input;   // no Devanagari → leave as-is
    var chars = String(input).split(''), out = '';
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i], nxt = chars[i + 1];
      if (_DEV_C[ch] != null) {
        var base = _DEV_C[ch];
        if (nxt === _DEV_VIRAMA) { out += base; i++; }                 // halant: bare consonant
        else if (_DEV_M[nxt] != null) { out += base + _DEV_M[nxt]; i++; }
        else {
          // inherent 'a', but drop it when the consonant ends the word
          // (Hindi schwa-deletion: आज -> "aaj" not "aaja").
          var wordFinal = (nxt == null) || !/[ऀ-ॿ]/.test(nxt);
          out += base + (wordFinal ? '' : 'a');
        }
      } else if (_DEV_V[ch] != null) { out += _DEV_V[ch]; }
      else if (ch === _DEV_ANUSVARA || ch === _DEV_CHANDRA) { out += 'n'; }
      else if (ch === _DEV_VISARGA) { out += 'h'; }
      else if (ch === '।' || ch === '॥') { out += '.'; }
      else if (ch >= '०' && ch <= '९') { out += String(ch.charCodeAt(0) - 0x0966); }
      else { out += ch; }
    }
    return out;
  }

  /* Strip surrounding punctuation from a word for the clean, modern caption look
     (keeps apostrophes/hyphens inside the word, e.g. don't, well-known). */
  function stripWordPunct(w) {
    return String(w)
      .replace(/^[\s"'“”‘’(\[{¿¡]+/, '')
      .replace(/[\s"'“”‘’.,!?;:)\]}…—–]+$/, '');
  }

  /* Apply a display case to a word. 'title' caps each word; 'lower' lowercases;
     'sentence' lowercases (caller caps the first word of the line). */
  function caseWord(w, mode) {
    var s = String(w);
    if (mode === 'lower' || mode === 'sentence') return s.toLowerCase();
    if (mode === 'title') return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    return s;
  }
  function caseWords(words, mode) {
    var out = words.map(function (w) { return caseWord(w, mode); });
    if (mode === 'sentence') for (var i = 0; i < out.length; i++) {
      if (/[a-z]/i.test(out[i])) { out[i] = out[i].charAt(0).toUpperCase() + out[i].slice(1); break; }
    }
    return out;
  }

  /* Light profanity censor — keep the first letter, star the rest, preserving
     the original word's length so timing/animation is unaffected. */
  var PROFANITY = {
    fuck: 1, shit: 1, bitch: 1, asshole: 1, bastard: 1, dick: 1, cunt: 1,
    pussy: 1, slut: 1, whore: 1, damn: 1, crap: 1, fucking: 1, motherfucker: 1
  };
  function censorWord(w) {
    var bare = String(w).toLowerCase().replace(/[^a-z]/g, '');
    if (!PROFANITY[bare]) return w;
    return String(w).replace(/[A-Za-z]/g, function (ch, idx) { return idx === 0 ? ch : '*'; });
  }

  /*
   * Explode sentence-level cues into word-by-word (or N-words-per-cue) cues
   * with timing interpolated by word length. This is what turns plain
   * captions into the trending "karaoke pop" style using Premiere's own
   * caption engine — no MOGRT required.
   * opts: { wordsPerCue (default 1), uppercase (default false), minCueDur }
   */
  function explodeWords(cues, opts) {
    opts = opts || {};
    var per = Math.max(1, opts.wordsPerCue || 1);
    var minDur = opts.minCueDur != null ? opts.minCueDur : 0.08;
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var words = String((cue && cue.text) || '').replace(/\s+/g, ' ').trim().split(' ');
      if (!words.length || words[0] === '') continue;

      var groups = [];
      for (var g = 0; g < words.length; g += per) {
        groups.push(words.slice(g, g + per).join(' '));
      }
      // Weight timing by character count so long words get more screen time.
      var weights = [], totalW = 0;
      for (var w = 0; w < groups.length; w++) {
        var weight = Math.max(2, groups[w].replace(/\s/g, '').length);
        weights.push(weight);
        totalW += weight;
      }
      var dur = cue.end - cue.start;
      var t = cue.start;
      for (var k = 0; k < groups.length; k++) {
        var d = Math.max(minDur, dur * weights[k] / totalW);
        var end = (k === groups.length - 1) ? cue.end : Math.min(cue.end, t + d);
        var txt = opts.uppercase ? groups[k].toUpperCase() : groups[k];
        out.push({ start: t, end: end, text: txt });
        t = end;
      }
    }
    return out;
  }

  /*
   * Shift cue timings to follow silence removal: given keep-segments in
   * source time, remap each cue into the trimmed timeline. Cues that fall
   * entirely inside removed ranges are dropped.
   */
  function remapCuesToKeeps(cues, keeps) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      var offset = 0; // accumulated kept duration before current segment
      for (var k = 0; k < keeps.length; k++) {
        var seg = keeps[k];
        var s = Math.max(c.start, seg.start);
        var e = Math.min(c.end, seg.end);
        if (e > s) {
          out.push({
            start: offset + (s - seg.start),
            end: offset + (e - seg.start),
            text: c.text
          });
          break; // keep the first overlapping segment's portion
        }
        offset += seg.end - seg.start;
      }
    }
    return out;
  }

  /*
   * Where recording-time items play on the timeline. pieces = every timeline
   * piece that shows the recording: [{ inPoint, outPoint (recording seconds),
   * seqStart (timeline seconds), speed }], speed = recording seconds played per
   * timeline second (a reel sped to 120% is 1.2; missing = 1). Each item is cut
   * to what each piece shows and moved to where that piece plays it, so an
   * item two pieces show appears twice and one no piece shows is dropped, as
   * is a sliver of minLen recording seconds or less (default 0.05) that a
   * piece's edge cuts off. A word a piece shows WHOLE is always kept, however
   * short — speech engines stamp quick Hindi words ("to", "ki", "na") with
   * 0–50 ms, and dropping them took them out of the captions; the caption
   * builder gives them a visible window. Returns [{ start, end, text, conf }]
   * (plus the item's speaker, when it has one) sorted by start. Pure + tested.
   */
  function mediaToTimeline(items, pieces, minLen) {
    var out = [], min = (minLen != null) ? minLen : 0.05;
    var ps = pieces || [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      for (var k = 0; k < ps.length; k++) {
        var p = ps[k], sp = (+p.speed > 0) ? +p.speed : 1;
        var s = Math.max(+it.start, +p.inPoint), e = Math.min(+it.end, +p.outPoint);
        // whole: this piece shows all of it (a zero-length stamp belongs to
        // the one piece whose span holds its instant)
        var whole = s <= +it.start + 1e-9 && e >= +it.end - 1e-9 &&
                    (e > s || (s >= +p.inPoint && s < +p.outPoint));
        if (whole ? (e >= s) : (e - s > min)) {
          var o = { start: +p.seqStart + (s - p.inPoint) / sp, end: +p.seqStart + (e - p.inPoint) / sp,
                    text: it.text, conf: it.conf };
          if (it.speaker != null) o.speaker = it.speaker;
          out.push(o);
        }
      }
    }
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /*
   * The way back: for each timeline-time item, the piece that plays its middle
   * and where that is in the recording — { piece: index into pieces, start,
   * end } in recording seconds, or null when no piece plays it (the words of
   * a stretch that was cut out, or of another recording). Pure + tested.
   */
  function timelineToMedia(items, pieces) {
    var ps = pieces || [], out = [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i], mid = (+it.start + +it.end) / 2, hit = null;
      for (var k = 0; k < ps.length && !hit; k++) {
        var p = ps[k], sp = (+p.speed > 0) ? +p.speed : 1;
        var pEnd = +p.seqStart + (p.outPoint - p.inPoint) / sp;
        if (mid >= +p.seqStart - 1e-6 && mid <= pEnd + 1e-6) {
          hit = { piece: k, start: +p.inPoint + (it.start - p.seqStart) * sp, end: +p.inPoint + (it.end - p.seqStart) * sp };
        }
      }
      out.push(hit);
    }
    return out;
  }

  /*
   * Timeline-time items made for one placement of a recording, moved onto
   * another placement of the SAME recording (the clip was moved, trimmed, cut
   * or re-sped since): through the recording and back. Each item keeps its
   * other fields; one no old piece plays is kept as it was, one no new piece
   * shows is dropped. Sorted by start. Pure + tested.
   */
  function retimeThroughRecording(items, oldPieces, newPieces) {
    var at = timelineToMedia(items, oldPieces), out = [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i], m = at[i];
      if (!m) { out.push(it); continue; }
      var placed = mediaToTimeline([{ start: m.start, end: m.end, text: it.text, conf: it.conf }], newPieces);
      for (var k = 0; k < placed.length; k++) {
        var o = {};
        for (var key in it) if (Object.prototype.hasOwnProperty.call(it, key)) o[key] = it[key];
        o.start = placed[k].start; o.end = placed[k].end;
        out.push(o);
      }
    }
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /*
   * Regroup a transcript into captions of `perCue` words EACH, flowing ACROSS
   * the original line boundaries (unlike explodeWords, which only splits within
   * a line and so can never reduce the caption count). A new caption also
   * starts when the gap to the next word exceeds opts.maxGap, so a caption
   * never spans a long pause. Returns [{start, end, text}]. Pure + tested.
   */
  // --- sentence-aware caption grouping helpers ---------------------------------
  // A caption may wrap to ~2 lines, so the char budget is per-CAPTION, not
  // per-line. A whole sentence stays in ONE caption and is split ONLY when it
  // genuinely exceeds the word/char budget — and then at a balanced, natural
  // boundary so a phrase like "What is your name?" is never stranded as
  // "What is" | "your name". Ordinary breath-pauses inside a sentence never
  // split it; only a real long pause (scene change) does.
  // . ! ? + Devanagari danda ।/॥ (Hindi sentences end with ।, never ".") +
  // Urdu ۔ — without these, Hindi/Hinglish transcripts had NO sentence breaks
  // and were chopped at arbitrary word counts instead.
  var _SOFT_AFTER   = /[,;:—–]["'»)\]”’]?$/;  // , ; : — – → good to break AFTER
  function _set(s) { var o = {}; s.split(' ').forEach(function (w) { if (w) o[w] = 1; }); return o; }
  // Words a new caption (or a new line) reads naturally when they LEAD it:
  // English joiners and prepositions, and the Hindi/Hinglish joiners
  // (aur = and, lekin/magar = but, ya = or, kyunki = because, toh/phir = then,
  // jo = who/which, कि = that). NOT par/पर or ki: those are almost always the
  // postpositions "on" and "of" (YouTube par, Rahul ki shaadi), which belong
  // to the noun BEFORE them — breaking before them split "मेज़ | पर बैठ गए".
  var _CONJ = _set('and but or nor so yet because that which when while if then with to of as at in on for ' +
                   'aur lekin magar ya kyunki kyonki toh phir jo ' +
                   'और लेकिन मगर या क्योंकि तो फिर जो कि');
  // Hindi postpositions follow their noun, so the English "break before a
  // preposition" rule flips: never break BEFORE one (keep "YouTube par" together).
  var _POSTPOS = _set('का की के को ने से में पर तक वाला वाली वाले ' +
                      'ka ki ke ko ne se mein me par tak wala wali wale waala waali waale');
  // Auxiliaries stay with their verb ("kar rahe the", "जा सकता है").
  var _AUX = _set('है हैं था थी थे हूँ हूं हो रहा रही रहे गया गई गए गये सकता सकती सकते चाहिए ' +
                  'hai hain hein tha thi thin hoon hun ho raha rahi rahe gaya gayi gaye sakta sakti sakte chahiye');
  // Words that should never END a line or caption: a joiner, a negation, an
  // English article / preposition / possessive — the reader is left hanging.
  var _BAD_END = _set('aur और and but or so because kyunki क्योंकि lekin लेकिन magar मगर ya या toh तो कि ' +
                      'nahi nahin na mat नहीं न मत not never no dont don\'t cant can\'t wont won\'t ' +
                      'a an of to in on at for with from by about into over under through than ' +
                      'my your his her our their its this these those');
  // The genitive (का की के / ka ki ke) ties its noun to the NEXT one
  // ("Rahul ki shaadi" = Rahul's wedding): a poor place to break after.
  var _GENITIVE = _set('का की के ka ki ke');
  // A few Hinglish verb forms that "the" (थे) follows as an auxiliary.
  var _HI_THE = /(te|ti|ta|ye|ae|aye|rahe|gaye|hue|baithe|kar|liye|diye|kiye)$/;
  var _ABBR = _set('mr mrs ms dr st vs jr sr prof sh smt shri');
  /* The bare form of a word for the lists above: lower case, edge punctuation
     and dandas off (Devanagari letters and signs stay). */
  function _bareWord(t) { return String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9'ऀ-ॣ०-ॿ]/g, ''); }
  function _isConj(t) { return _CONJ[_bareWord(t)] === 1; }                 // good to break BEFORE
  /* Does a sentence end with this word? . ! ? and the Hindi danda । ॥ — but
     not the period of "Dr." / "Mr." or an initial ("U.S.", "A."), which used
     to split "Dr. | Sharma" into two captions. */
  function isSentenceEnd(t) {
    var s = String(t == null ? '' : t).replace(/["'»)\]”’]+$/, '');
    if (!/[.!?।॥۔]$/.test(s)) return false;
    if (/[!?।॥۔]$/.test(s)) return true;
    var core = s.replace(/\.+$/, '');
    if (_ABBR[core.toLowerCase()]) return false;
    if (/^([A-Za-z]\.)*[A-Za-z]$/.test(core) && /[A-Z]/.test(core)) return false;   // U.S. / A.
    return true;
  }
  /* "the" is the Hinglish auxiliary थे after a verb form ("kar rahe the"),
     the English article everywhere else. */
  function _theIsAux(prevBare, ctx) {
    if (ctx && ctx.hinglish != null) return !!ctx.hinglish && (_HI_THE.test(prevBare) || !!_AUX[prevBare]);
    return _HI_THE.test(prevBare) && !/^(the|to|be|we|he|she|me|ye)$/.test(prevBare);
  }
  /*
   * How good a break is between two words — used both for where one caption
   * ends and the next begins, and for where the renderer breaks a caption
   * into lines. 0 = a natural place (after a sentence end or comma, before a
   * joiner), 1 = neutral, 3 = poor (it leaves "aur" / "the" / "nahi" hanging),
   * Infinity = never (before a Hindi postposition or auxiliary, or before a
   * danda). Pure + tested.
   */
  function lineBreakCost(prev, next, ctx) {
    var p = String(prev == null ? '' : prev), n = String(next == null ? '' : next);
    if (!p || !n) return 0;
    if (/^[।॥]/.test(n)) return Infinity;
    var nb = _bareWord(n), pb = _bareWord(p);
    if (_POSTPOS[nb] || _AUX[nb]) return Infinity;
    var theAux = (nb === 'the') && _theIsAux(pb, ctx);
    if (theAux) return Infinity;
    if (isSentenceEnd(p)) return 0;
    if (_SOFT_AFTER.test(p)) return 0.1;
    var cost = _CONJ[nb] ? 0.25 : 1;
    // "the" ends a line badly only as the English article
    var badEnd = _BAD_END[pb] || (pb === 'the' && !(ctx && ctx.hinglish));
    if (badEnd) cost = 3;
    else if (_GENITIVE[pb]) cost = 2.5;                                         // "Rahul ki | shaadi" splits "Rahul's wedding"
    else if (/^\d[\d,.]*$/.test(pb) && !/^\d/.test(nb)) cost = 2.5;            // keep "50 lakh" together
    else if (/^[A-Z][a-z]+$/.test(p) && /^[A-Z][a-z]+$/.test(n)) cost = 2;     // keep "Shah Rukh Khan" together
    return cost;
  }

  /* The letters a word DRAWS as, one entry per grapheme cluster (a Devanagari
     consonant with its vowel signs, halant and conjunct is ONE). Intl.Segmenter
     where the runtime has it; otherwise a small rule that keeps Indic signs
     and joiners with the letter before them. Pure + tested. */
  var _SEG = null;
  try { if (typeof Intl !== 'undefined' && Intl.Segmenter) _SEG = new Intl.Segmenter('hi', { granularity: 'grapheme' }); } catch (eSeg) { _SEG = null; }
  function graphemes(s) {
    s = String(s == null ? '' : s);
    var out = [];
    if (_SEG && typeof Symbol !== 'undefined' && Symbol.iterator) {
      try {
        var it = _SEG.segment(s)[Symbol.iterator]();
        for (var r = it.next(); !r.done; r = it.next()) out.push(r.value.segment);
        return out;
      } catch (eIt) { out = []; }
    }
    var cps = s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || [];
    for (var i = 0; i < cps.length; i++) {
      var c = cps[i], code = c.charCodeAt(0);
      var joins = (code >= 0x0900 && code <= 0x0903) || (code >= 0x093A && code <= 0x094F && code !== 0x093D) ||
                  (code >= 0x0951 && code <= 0x0957) || code === 0x0962 || code === 0x0963 ||
                  code === 0x200C || code === 0x200D || code === 0xFE0F || (code >= 0x0300 && code <= 0x036F);
      var afterVirama = out.length && out[out.length - 1].slice(-1) === '्';
      if (out.length && (joins || afterVirama)) out[out.length - 1] += c;
      else out.push(c);
    }
    return out;
  }
  /* Visible length for a character budget: graphemes, a Devanagari cluster
     counted a little wider than a Latin letter (shaped Hindi measures ~1.1x
     a Latin letter per cluster). Counting UTF-16 units instead counted Hindi
     ~1.5x too long, so Hindi captions were split far shorter than English. */
  var _visMemo = {}, _visCount = 0;
  function visLen(s) {
    s = String(s == null ? '' : s);
    if (!/[^\x00-\x7F]/.test(s)) return s.length;           // plain ASCII: one letter a character
    if (_visMemo.hasOwnProperty(s)) return _visMemo[s];     // a podcast repeats its words
    var g = graphemes(s), n = 0;
    for (var i = 0; i < g.length; i++) n += /[ऀ-ॿ]/.test(g[i]) ? 1.1 : 1;
    if (_visCount++ > 20000) { _visMemo = {}; _visCount = 0; }
    _visMemo[s] = n;
    return n;
  }
  function _joinText(ws) { return ws.map(function (w) { return w.text; }).join(' '); }
  function _cueOf(ws) { return { start: ws[0].start, end: ws[ws.length - 1].end, text: _joinText(ws) }; }

  function groupSentenceAware(words, per, maxChars, maxGap, opts) {
    // A real pause still forces a break even without punctuation; an ordinary
    // breath does not. Use the larger of the caller's maxGap and a floor so
    // mid-sentence breaths don't split a sentence.
    var hardGap = (opts && opts.hardGap != null) ? opts.hardGap : Math.max(maxGap, 1.6);
    var sentences = [], cur = [];
    for (var i = 0; i < words.length; i++) {
      cur.push(words[i]);
      var gapNext = (i + 1 < words.length) ? (words[i + 1].start - words[i].end) : 0;
      if (isSentenceEnd(words[i].text) || gapNext > hardGap) { sentences.push(cur); cur = []; }
    }
    if (cur.length) sentences.push(cur);
    var out = [];
    for (var s = 0; s < sentences.length; s++) packSentence(sentences[s], per, maxChars, out);
    return out;
  }

  function packSentence(ws, per, maxChars, out) {
    var fitsWords = !per || ws.length <= per;
    var fitsChars = !maxChars || visLen(_joinText(ws)) <= maxChars;
    if (fitsWords && fitsChars) { out.push(_cueOf(ws)); return; }   // whole sentence = one caption
    var nW = per ? Math.ceil(ws.length / per) : 1;
    var nC = maxChars ? Math.ceil(visLen(_joinText(ws)) / maxChars) : 1;
    var n = Math.max(2, nW, nC);
    var chunks = splitBalanced(ws, n, per, maxChars);
    for (var c = 0; c < chunks.length; c++) out.push(_cueOf(chunks[c]));
  }

  function splitBalanced(ws, n, per, maxChars) {
    var total = ws.length;
    var target = Math.max(1, Math.round(total / n));   // ideal words per chunk
    var chunks = [], cur = [], curChars = 0;
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i], wl = visLen(w.text);
      var projected = cur.length ? (curChars + 1 + wl) : wl;
      var hardOverW = per && cur.length >= per;
      var hardOverC = maxChars && projected > maxChars && cur.length > 0;
      if (cur.length && (hardOverW || hardOverC)) { chunks.push(cur); cur = []; curChars = 0; }
      cur.push(w); curChars = (cur.length === 1) ? wl : (curChars + 1 + wl);
      if (i === ws.length - 1) break;
      var remaining = total - (i + 1);
      var chunksOpen = n - chunks.length;                  // chunks still to fill (incl. current)
      var mustBreakSoon = remaining <= (chunksOpen - 1);   // reserve ≥1 word per remaining chunk
      if (chunks.length >= n - 1 || remaining <= 0) continue;
      var atTarget = cur.length >= target;
      var hereEndsClause = _SOFT_AFTER.test(w.text);
      var nextStartsClause = _isConj(ws[i + 1].text);
      // BALANCED-FIRST: break AT the target size. The old rule kept adding
      // words while hunting for a clause boundary, so "my name is vikas
      // banjare" came out "(my name is vikas) (banjare)" — a stranded word.
      // Now the split lands "(my name is) (vikas banjare)"; the ONLY reason
      // to run one word past target is when the very NEXT position is a real
      // boundary (a comma, or just before a conjunction) that still fits.
      var boundaryHere = hereEndsClause || nextStartsClause;
      var boundaryNext = false;
      if (!boundaryHere && i + 1 < ws.length) {
        var nw = ws[i + 1], nl = visLen(nw.text);
        var fitsNext = (!per || cur.length + 1 <= per) && (!maxChars || (curChars + 1 + nl) <= maxChars);
        boundaryNext = fitsNext && (_SOFT_AFTER.test(nw.text) ||
                                    (i + 2 < ws.length && _isConj(ws[i + 2].text)));
      }
      // never split a noun from its postposition or a verb from its
      // auxiliary ("Rahul | ki shaadi", "jaa | sakta hai") when the next word
      // still fits: run one word past the target instead
      var forbidden = lineBreakCost(w.text, ws[i + 1].text) === Infinity &&
        (!per || cur.length + 1 <= per) && (!maxChars || (curChars + 1 + visLen(ws[i + 1].text)) <= maxChars) &&
        remaining > (chunksOpen - 1);
      if (mustBreakSoon || (atTarget && !boundaryNext && !forbidden)) {
        chunks.push(cur); cur = []; curChars = 0;
      }
    }
    if (cur.length) chunks.push(cur);
    // Orphan fix: a trailing single word looks stranded — merge it back if it fits.
    if (chunks.length >= 2 && chunks[chunks.length - 1].length === 1) {
      var prev = chunks[chunks.length - 2], merged = prev.concat(chunks[chunks.length - 1]);
      if ((!maxChars || visLen(_joinText(merged)) <= maxChars) && (!per || merged.length <= per)) {
        chunks.splice(chunks.length - 2, 2, merged);
      }
    }
    return chunks;
  }

  /* Group per-word cues into caption EVENTS that keep each word's timing — the
     input to the ASS/libass generator (the long-video fallback). The SAME
     grouper as the Pulse-rendered captions (groupCaptionWords: sentence ends,
     pauses of 0.5 s, 7 s, grammar-aware even splits, perCue as an exact cap),
     with the width budget given in characters (maxChars, counted as drawn
     letters) because libass cannot be asked to measure.
     Returns [{ start, end, words:[{text,start,end}] }]. */
  function groupWordEvents(wordCues, opts) {
    opts = opts || {};
    var per = Math.max(0, opts.perCue || 0);            // 0/absent → sentence-driven
    var maxChars = opts.maxChars || 0;
    var words = clampWordDurations(sanitizeWordCues(wordCues || [], 0.04));
    var up = !!opts.uppercase;
    if (up) words = words.map(function (w) { var o = _copyWord(w); o.text = String(w.text).toUpperCase(); return o; });
    var groups = groupCaptionWords(words, {
      maxWords: per,
      fits: maxChars ? function (a, b) {
        var t = []; for (var k = a; k < b; k++) t.push(words[k].text);
        return visLen(t.join(' ')) <= maxChars;
      } : null
    });
    return groups.map(function (g) {
      var ws = words.slice(g[0], g[1]);
      return {
        start: ws[0].start, end: ws[ws.length - 1].end,
        words: ws.map(function (w) { return { text: w.text, start: w.start, end: w.end }; })
      };
    });
  }

  function regroupWords(cues, perCue, opts) {
    opts = opts || {};
    var per = Math.max(1, perCue || 1);
    var maxGap = opts.maxGap != null ? opts.maxGap : 1.5;
    var maxChars = opts.maxChars || 0;            // 0 = no width limit (legacy / tests)
    var sentenceBreak = !!opts.sentenceBreak;     // keep whole sentences together (cohesive grouping)
    var words = explodeWords(cues, { wordsPerCue: 1, uppercase: !!opts.uppercase });
    if (!words.length) return [];

    // Real caption flows pass sentenceBreak:true → sentence-cohesive, balanced
    // grouping (above). The legacy greedy path below is kept byte-for-byte for
    // back-compat and the test-suite contract (callers that pass no sentenceBreak).
    if (sentenceBreak) return groupSentenceAware(words, per, maxChars, maxGap, opts);

    var out = [], group = [], groupChars = 0;
    function flush() {
      if (!group.length) return;
      out.push({
        start: group[0].start,
        end: group[group.length - 1].end,
        text: group.map(function (w) { return w.text; }).join(' ')
      });
      group = []; groupChars = 0;
    }
    for (var i = 0; i < words.length; i++) {
      var wt = words[i].text, wlen = wt.length;
      var projected = group.length ? (groupChars + 1 + wlen) : wlen;   // +1 for the joining space
      if (group.length && (
            group.length >= per ||                                      // word-count cap
            (maxChars && projected > maxChars) ||                       // WIDTH cap → text can't overflow the box
            (words[i].start - group[group.length - 1].end) > maxGap     // long pause
         )) flush();
      group.push(words[i]);
      groupChars = (group.length === 1) ? wlen : (groupChars + 1 + wlen);
    }
    flush();
    return out;
  }

  /*
   * Give every caption enough time on screen to be READ.
   * ASR word timings routinely produce 0.08–0.2s cues (fast speech, one word
   * per caption) — on a 25fps timeline that is a 2-frame flash nobody can
   * read, and it is what makes word-by-word styles feel broken.
   * Rules, in order, and never destructive:
   *   1. extend a short cue into the SILENCE that follows it (never over the
   *      next caption, so nothing desyncs from the voice),
   *   2. if it is still under hardMin, merge it into the previous caption
   *      (their words simply share one card),
   *   3. leave everything else untouched.
   * Pure + tested.
   */
  function enforceMinDuration(cues, opts) {
    opts = opts || {};
    var min = (opts.min != null) ? opts.min : 0.32;        // comfortable read floor
    var hardMin = (opts.hardMin != null) ? opts.hardMin : 0.12;   // below this: merge
    if (!cues || !cues.length) return cues || [];
    var out = [], i;
    for (i = 0; i < cues.length; i++) out.push({ start: cues[i].start, end: cues[i].end, text: cues[i].text });
    // sort first — overlapping SOURCE cues can regroup out of order, and every
    // rule below assumes neighbours really are neighbours in time
    out.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
    // 0. NO TWO CAPTIONS ON SCREEN AT ONCE: ASR (and hand-edited SRTs) emit
    //    overlapping cues; left alone they stack two captions over each other.
    for (i = 0; i + 1 < out.length; i++) {
      if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
      if (out[i].end < out[i].start) out[i].end = out[i].start;
    }
    // 1. grow into following silence
    for (i = 0; i < out.length; i++) {
      var dur = out[i].end - out[i].start;
      if (dur >= min) continue;
      var limit = (i + 1 < out.length) ? out[i + 1].start : (out[i].end + min);
      var want = out[i].start + min;
      out[i].end = Math.min(want, limit);
      if (out[i].end < out[i].start) out[i].end = out[i].start;
    }
    // 2. merge what is still too short into its neighbour
    var merged = [];
    for (i = 0; i < out.length; i++) {
      var c = out[i], d = c.end - c.start;
      if (d < hardMin && merged.length) {
        var prev = merged[merged.length - 1];
        prev.end = Math.max(prev.end, c.end);
        prev.text = (String(prev.text || '') + ' ' + String(c.text || '')).replace(/\s+/g, ' ').replace(/^ | $/g, '');
        continue;
      }
      if (d < hardMin && !merged.length && i + 1 < out.length) {
        // first caption too short: hand its words to the next one
        out[i + 1].start = c.start;
        out[i + 1].text = (String(c.text || '') + ' ' + String(out[i + 1].text || '')).replace(/\s+/g, ' ').replace(/^ | $/g, '');
        continue;
      }
      merged.push(c);
    }
    return merged;
  }

  /*
   * Style presets — the catalog the panel UI shows. Each preset carries:
   *  - native:  recommended settings for Premiere's built-in caption styling
   *  - mogrt:   parameter hints applied when inserting a .mogrt per cue
   *  - anim:    the animation concept (used by MOGRT templates / docs)
   * Based on 2026 short-form trends: word-by-word karaoke, bold statement,
   * highlight-box, clean minimal, neon, typewriter.
   */
  /* wordsPerCue is now exactly what a caption holds. The punchy styles that
     said 1 were always SHOWN two words at a time (word-by-word captions forced
     at least two), so they say 2 now: the look the owner knows, the number
     telling the truth, and every colour / spacing / dim / reveal control
     still has a second word to act on. 1 (one word at a time) is a press of
     "−" away. */
  var STYLE_PRESETS = [
    {
      id: 'hormozi',
      name: 'Bold Statement',
      description: 'Confident ALL-CAPS word-by-word in a clean heavy sans, with a crisp outline and a single accent colour on the spoken word.',
      font: 'Montserrat', weight: 900, fallbackFonts: ['Anton', 'Bebas Neue', 'Arial Black'],
      fontSize: 90, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 12,
      uppercase: true, wordsPerCue: 2, anim: 'pop-scale',
      animNotes: 'Each word scales 0%→110%→100% over ~120ms with ease-out.'
    },
    {
      id: 'karaoke',
      name: 'Karaoke Highlight',
      description: 'Full phrase visible, the spoken word lights up in a highlight color as it is said. Best retention for educational content (~+15% engagement).',
      font: 'Poppins', weight: 600, fallbackFonts: ['Inter', 'Arial'],
      fontSize: 70, fill: '#FFFFFF', highlight: '#00E676', stroke: '#000000', strokeWidth: 8,
      uppercase: false, wordsPerCue: 3, anim: 'color-sweep',
      animNotes: 'Active word fill animates white→highlight; others stay white.'
    },
    {
      id: 'highlight-box',
      name: 'Highlight Box',
      description: 'The spoken word sits on a solid rounded pill that snaps word to word (Submagic/CapCut style).',
      font: 'Inter', weight: 700, fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FF3B6B', stroke: '#000000', strokeWidth: 6,
      boxRadius: 14, highlightStyle: 'box',
      uppercase: false, wordsPerCue: 3, anim: 'box-snap',
      animNotes: 'Background box width-animates to each new word in ~80ms.'
    },
    {
      id: 'minimal',
      name: 'Clean Minimal',
      description: 'Lower-third sentence captions, soft shadow, no gimmicks. For long-form YouTube and corporate.',
      font: 'Inter', weight: 500, fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: null, stroke: '#000000', strokeWidth: 3,
      uppercase: false, wordsPerCue: 0 /* keep full sentences */, anim: 'fade',
      animNotes: 'Simple 150ms opacity fade in/out.'
    },
    {
      id: 'neon',
      name: 'Neon Pop',
      description: 'Glowing neon text with chromatic flicker on entry. Gaming / music content.',
      font: 'Bebas Neue', fallbackFonts: ['Anton', 'Impact'],
      fontSize: 80, fill: '#F8F8FF', highlight: '#00F0FF', stroke: '#7B2FFF', strokeWidth: 6,
      glow: '#00F0FF',
      uppercase: true, wordsPerCue: 2, anim: 'glitch-in',
      animNotes: '2-frame RGB-split glitch on entry, outer glow pulses with audio.'
    },
    {
      id: 'typewriter',
      name: 'Typewriter',
      description: 'Characters type on with a blinking caret. Storytelling and documentary openers.',
      font: 'JetBrains Mono', fallbackFonts: ['Courier New'],
      fontSize: 54, fill: '#EAEAEA', highlight: null, stroke: null, strokeWidth: 0, glow: '#000000',
      uppercase: false, wordsPerCue: 0, anim: 'typewriter',
      animNotes: 'Per-character reveal at ~30 chars/sec with caret.'
    },
    {
      id: 'boldyellow',
      name: 'Bold Yellow',
      description: 'Solid yellow ALL-CAPS with a heavy black stroke — high energy, very legible.',
      font: 'Anton', fallbackFonts: ['Bebas Neue', 'Impact', 'Arial Black'],
      fontSize: 88, fill: '#FFD400', highlight: '#FFFFFF', stroke: '#000000', strokeWidth: 12,
      uppercase: true, wordsPerCue: 2, anim: 'pop-scale',
      animNotes: 'Punchy scale-in; emphasized words flip to white.'
    },
    {
      id: 'cleanwhite',
      name: 'Clean White',
      description: 'White words with a crisp thin outline and a soft scale-in. Goes with anything.',
      font: 'Poppins', weight: 600, fallbackFonts: ['Inter', 'Helvetica', 'Arial'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 5,
      uppercase: false, wordsPerCue: 2, anim: 'fade',
      animNotes: 'Gentle scale + fade.'
    },
    {
      id: 'tvnews',
      name: 'News Bar',
      description: 'White text on a translucent dark bar, lower third. Interviews and explainers.',
      font: 'Inter', weight: 500, fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#33C1FF', stroke: null, strokeWidth: 0,
      boxColor: '#000000', boxRadius: 6,
      uppercase: false, wordsPerCue: 0, anim: 'fade',
      animNotes: 'Bar slides/fades in along the lower third.'
    }
  ];

  function uc(s) { return String(s).toUpperCase(); }

  /* The library categories the gallery groups styles into, in chip order —
     named for what a creator is making, not for how the style was built.
     A style has ONE home (`category`) and may also be listed under others
     (`alsoIn`): "🔥 Trending" gathers the current looks from every family,
     and the owner's own "From My Videos" / "Your Styles" tabs stay whole while
     their styles also show up under the look they belong to. Buttons stay last.
     (The old chips — ⭐ Premium, Bold Creator, Dynamic Highlight, Social
     Growth… — sorted by build history; nobody could guess what was inside.)
     🇮🇳 Hindi comes right after 🔥 Trending: Pulse is made for Hindi and
     Hinglish creators, and at the end of the scrolling chip row the Hindi
     styles were off-screen in a docked panel. */
  var CAT_HINDI = '🇮🇳 Hindi (हिंदी)';
  var CATEGORIES = [
    '🔥 Trending',
    CAT_HINDI,
    '💥 Bold & Viral',
    '🎤 Karaoke',
    '🎙️ Podcast',
    '✨ Minimal & Clean',
    '🎬 Cinematic & Editorial',
    '🌈 Neon & Glow',
    '😂 Fun & Meme',
    '🎬 From My Videos',
    '🎥 Your Styles',
    '🔘 Buttons'
  ];
  /* Does this style belong under this chip (home or cross-listed)? */
  function inCategory(t, cat) {
    if (!t || !cat) return false;
    if (t.category === cat) return true;
    var also = t.alsoIn;
    if (!also || !also.length) return false;
    for (var i = 0; i < also.length; i++) if (also[i] === cat) return true;
    return false;
  }

  /* Library metadata for the nine base presets (category / popularity /
     layout / keyword-highlight default). */
  var _baseMeta = {
    hormozi:        { category: '💥 Bold & Viral',          popularity: 99, layout: 'bottom', keyword: true, highlightScale: 1.14 },
    karaoke:        { category: '🎤 Karaoke',               popularity: 95, layout: 'bottom', keyword: false },
    'highlight-box':{ category: '🎤 Karaoke',               popularity: 92, layout: 'bottom', keyword: true },
    minimal:        { category: '✨ Minimal & Clean',       popularity: 80, layout: 'bottom', keyword: false },
    neon:           { category: '🌈 Neon & Glow',           popularity: 88, layout: 'center', keyword: true },
    typewriter:     { category: '🎬 Cinematic & Editorial', popularity: 70, layout: 'center', keyword: false },
    boldyellow:     { category: '💥 Bold & Viral',          popularity: 90, layout: 'bottom', keyword: true, highlightScale: 1.14 },
    cleanwhite:     { category: '✨ Minimal & Clean',       popularity: 78, layout: 'bottom', keyword: false },
    tvnews:         { category: '🎙️ Podcast',              popularity: 65, layout: 'bottom', keyword: false, speaker: true }
  };
  for (var _i = 0; _i < STYLE_PRESETS.length; _i++) {
    var _m = _baseMeta[STYLE_PRESETS[_i].id] || {};
    STYLE_PRESETS[_i].category = _m.category || '💥 Bold & Viral';
    STYLE_PRESETS[_i].popularity = _m.popularity || 60;
    STYLE_PRESETS[_i].layout = _m.layout || 'bottom';
    STYLE_PRESETS[_i].keyword = !!_m.keyword;
    STYLE_PRESETS[_i].speaker = !!_m.speaker;
    if (_m.highlightScale) STYLE_PRESETS[_i].highlightScale = _m.highlightScale;
  }

  /* Extra professionally-designed templates fleshing out every category.
     Names echo the short-form template aesthetic (Impact, Volt, Chalk…). */
  var MORE_TEMPLATES = [
    { id: 'impact', name: 'Impact II', category: 'Bold Creator', popularity: 97, layout: 'bottom', keyword: true, highlightScale: 1.18,
      font: 'Anton', fallbackFonts: ['Bebas Neue', 'Impact', 'Arial Black'],
      fontSize: 92, fill: '#FFFFFF', highlight: '#FFE53B', stroke: '#000000', strokeWidth: 13,
      uppercase: true, wordsPerCue: 2, anim: 'pop' },
    { id: 'prime', name: 'Prime', category: 'Bold Creator', popularity: 94, layout: 'center', keyword: true,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Arial Black'],
      fontSize: 86, fill: '#FFFFFF', highlight: '#7C5CFF', stroke: '#000000', strokeWidth: 10,
      uppercase: true, wordsPerCue: 2, anim: 'zoom' },
    { id: 'byline', name: 'Byline', category: 'Minimal Professional', popularity: 82, layout: 'bottom', keyword: false,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 50, fill: '#FFFFFF', highlight: '#9AD0FF', stroke: '#000000', strokeWidth: 3,
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'magazine', name: 'Magazine', category: 'Minimal Professional', popularity: 74, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 58, fill: '#F5F1E8', highlight: '#D9B36A', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'focus', name: 'Focus', category: 'Dynamic Highlight', popularity: 93, layout: 'bottom', keyword: true,
      font: 'Poppins', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 66, fill: '#FFFFFF', highlight: '#FF3B6B', boxRadius: 14, highlightStyle: 'box', stroke: '#000000', strokeWidth: 6,
      uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    { id: 'volt', name: 'Volt', category: 'Dynamic Highlight', popularity: 91, layout: 'bottom', keyword: true,
      font: 'Bebas Neue', fallbackFonts: ['Anton', 'Impact'],
      fontSize: 82, fill: '#FFFFFF', highlight: '#39FF14', stroke: '#000000', strokeWidth: 8,
      uppercase: true, wordsPerCue: 3, anim: 'pop' },
    { id: 'rocket', name: 'Rocket', category: 'Social Growth', popularity: 90, layout: 'bottom', keyword: true,
      font: 'Montserrat', fallbackFonts: ['Inter', 'Arial Black'],
      fontSize: 70, fill: '#FFFFFF', highlight: '#FF2D7E', boxRadius: 16, highlightStyle: 'box', stroke: '#000000', strokeWidth: 7,
      uppercase: true, wordsPerCue: 3, anim: 'karaoke' },
    { id: 'mars', name: 'Mars', category: 'Social Growth', popularity: 87, layout: 'bottom', keyword: true,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 64, fill: '#111111', highlight: '#111111', boxColor: '#FFE53B', boxRadius: 10, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 2, anim: 'pop' },
    { id: 'lift', name: 'Lift', category: 'Podcast Pro', popularity: 76, layout: 'bottom', keyword: false, speaker: true,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 52, fill: '#FFFFFF', highlight: '#5CC8FF', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 0, anim: 'slide' },
    { id: 'lumen', name: 'Lumen', category: 'Storytelling', popularity: 72, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 56, fill: '#F3EEE6', highlight: '#E0C189', stroke: null, strokeWidth: 0, glow: '#000000',
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'ember', name: 'Ember', category: 'Storytelling', popularity: 68, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['serif'],
      fontSize: 54, fill: '#FFE9D6', highlight: '#FF9E5A', stroke: '#1a1a1a', strokeWidth: 2,
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'rebel', name: 'Rebel', category: 'Gaming Stream', popularity: 85, layout: 'center', keyword: true,
      font: 'Bebas Neue', fallbackFonts: ['Anton', 'Impact'],
      fontSize: 84, fill: '#C6FF00', highlight: '#FFFFFF', stroke: '#000000', strokeWidth: 9, glow: '#C6FF00',
      uppercase: true, wordsPerCue: 2, anim: 'shake' },
    { id: 'cinema', name: 'Cinematic', category: 'Cinematic', popularity: 79, layout: 'bottom', keyword: false,
      font: 'Futura', fallbackFonts: ['Oswald', 'Helvetica'],
      fontSize: 44, fill: '#EDEDED', highlight: '#EDEDED', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 4, uppercase: true, wordsPerCue: 0, anim: 'fade' },
    { id: 'align', name: 'Align', category: 'Cinematic', popularity: 71, layout: 'center', keyword: false,
      font: 'JetBrains Mono', fallbackFonts: ['Courier New', 'monospace'],
      fontSize: 40, fill: '#FFFFFF', highlight: '#9AD0FF', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 6, uppercase: true, wordsPerCue: 0, anim: 'fade' },
    { id: 'grind', name: 'Grind', category: 'Motivation', popularity: 89, layout: 'bottom', keyword: true, highlightScale: 1.16,
      font: 'Anton', fallbackFonts: ['Bebas Neue', 'Impact'],
      fontSize: 90, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 12,
      uppercase: true, wordsPerCue: 2, anim: 'scale' },
    { id: 'chalk', name: 'Chalk', category: 'Education', popularity: 73, layout: 'bottom', keyword: true,
      font: 'Bradley Hand', fallbackFonts: ['Comic Sans MS', 'cursive'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFE53B', stroke: '#000000', strokeWidth: 5,
      uppercase: false, wordsPerCue: 2, anim: 'wave' },
    { id: 'paper', name: 'Paper II', category: 'Education', popularity: 75, layout: 'bottom', keyword: true,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 58, fill: '#1A1A1A', highlight: '#1A1A1A', boxColor: '#FFFFFF', boxRadius: 8, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 2, anim: 'pop' },

    // --- Captions.ai signature looks (recreated from the gallery) ---
    { id: 'prism', name: 'Prism Pro', category: 'Bold Creator', popularity: 96, layout: 'bottom', keyword: true,
      font: 'Montserrat', fallbackFonts: ['Inter', 'Arial Black'],
      fontSize: 74, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 7,
      uppercase: false, wordsPerCue: 0, anim: 'pop' },
    { id: 'evo', name: 'Evo', category: 'Bold Creator', popularity: 88, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Poppins', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 66, fill: '#FFFFFF', highlight: '#FFD400', stroke: '#000000', strokeWidth: 5,
      uppercase: false, wordsPerCue: 0, anim: 'pop' },
    { id: 'stack', name: 'Stack', category: 'Bold Creator', popularity: 84, layout: 'bottom', keyword: true,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 60, fill: '#FFFFFF', highlight: '#FF4D6D', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'kai', name: 'Kai', category: 'Social Growth', popularity: 86, layout: 'bottom', keyword: false,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Arial Black'],
      fontSize: 80, fill: '#FF2D9B', highlight: '#FFFFFF', stroke: '#000000', strokeWidth: 8,
      uppercase: true, wordsPerCue: 2, anim: 'pop' },
    { id: 'y2k', name: 'Y2K', category: 'Gaming Stream', popularity: 81, layout: 'center', keyword: false,
      font: 'Verdana', fallbackFonts: ['Tahoma', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#00F0FF', boxColor: '#141414', boxRadius: 4, stroke: null, strokeWidth: 0,
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'glitch' },
    { id: 'elevate', name: 'Cinema', category: 'Cinematic', popularity: 77, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 60, fill: '#F3ECE0', highlight: '#D9B36A', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'sketch', name: 'Sketch', category: 'Storytelling', popularity: 74, layout: 'center', keyword: false,
      font: 'Bradley Hand', fallbackFonts: ['Comic Sans MS', 'cursive'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFE53B', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'bloom', name: 'Bloom', category: 'Storytelling', popularity: 71, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['serif'],
      fontSize: 58, fill: '#FFF3E9', highlight: '#E6A0B0', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'linen', name: 'Linen', category: 'Minimal Professional', popularity: 73, layout: 'bottom', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#C9A36A', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },
    { id: 'sonnet', name: 'Sonnet', category: 'Storytelling', popularity: 67, layout: 'center', keyword: false,
      font: 'Georgia', fallbackFonts: ['Times New Roman', 'serif'],
      fontSize: 48, fill: '#EFE8DF', highlight: '#CBB68B', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: false, wordsPerCue: 0, anim: 'fade' },

    // --- Cinematic serif quote looks (recreated from a reference reel:
    //     elegant Playfair serif, white ALL-CAPS, centered, short phrases.
    //     "Monolith" = clean hero word; "Quote Pill" sits the phrase on a
    //     dark rounded pill like the reel's highlighted lines.) ---
    { id: 'monolith', name: 'Monolith', category: 'Cinematic', popularity: 83, layout: 'center', keyword: false,
      font: 'Playfair Display', fallbackFonts: ['Georgia', 'Times New Roman', 'serif'],
      fontSize: 78, fill: '#FFFFFF', highlight: '#FFFFFF', stroke: null, strokeWidth: 0, glow: '#000000',
      letterSpacing: 1, uppercase: true, wordsPerCue: 2, anim: 'scale' },
    { id: 'quotepill', name: 'Quote Pill', category: 'Cinematic', popularity: 81, layout: 'center', keyword: false,
      font: 'Playfair Display', fallbackFonts: ['Georgia', 'Times New Roman', 'serif'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#FFFFFF', boxColor: '#0B1020', boxRadius: 46, stroke: null, strokeWidth: 0,
      letterSpacing: 1, uppercase: true, wordsPerCue: 3, anim: 'fade' },

    // --- Trending creator styles: word-by-word reveal of a short centered
    //     phrase with the SPOKEN word emphasized — 'karaoke' lights up + scales
    //     the active word, highlightStyle:'box' sits it on a colored pill. ---
    { id: 'cap-core', name: 'Core', category: 'Trending', popularity: 99, layout: 'center', keyword: false,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 68, fill: '#FFFFFF', highlight: '#FFE000', highlightScale: 1.14, stroke: '#000000', strokeWidth: 6,
      uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    { id: 'cap-clarity', name: 'Crisp', category: 'Trending', popularity: 92, layout: 'center', keyword: false,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 56, fill: '#FFFFFF', highlight: '#FFFFFF', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 4, anim: 'fade' },
    { id: 'cap-grit', name: 'Grit', category: 'Trending', popularity: 96, layout: 'center', keyword: false,
      font: 'Anton', fallbackFonts: ['Bebas Neue', 'Impact', 'Arial Black'],
      fontSize: 86, fill: '#FFFFFF', highlight: '#FFD400', highlightScale: 1.16, stroke: '#000000', strokeWidth: 11,
      uppercase: true, wordsPerCue: 3, anim: 'karaoke' },
    { id: 'cap-hype', name: 'Surge', category: 'Trending', popularity: 95, layout: 'center', keyword: false,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 70, fill: '#FFFFFF', highlight: '#22C55E', highlightStyle: 'box', boxRadius: 16, stroke: '#000000', strokeWidth: 6,
      uppercase: true, wordsPerCue: 3, anim: 'karaoke' }
  ];

  /* ⭐ Premium — refined, modern, "expensive"-looking styles (NOT the loud
     bold-caps look). Clean grotesk/serif faces, tasteful muted accents,
     soft bars/pills, gentle fade/slide/scale. These lead the library. */
  var PREMIUM_TEMPLATES = [
    // Spotlight — the signature Captions.ai look: clean white modern sans, soft
    // drop-shadow (NOT a thick outline), the key word on a tasteful blue pill.
    { id: 'pro-spotlight', name: 'Spotlight', category: '⭐ Premium', popularity: 100, layout: 'bottom', keyword: false, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#2D7CFF', highlightStyle: 'box', boxRadius: 12,
      glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Subs Light — light pill, dark text, spoken word blue, upcoming words dimmed
    // (matches the uploaded "SUBS 1" reference exactly).
    { id: 'pro-subs-light', name: 'Subs Light', category: '⭐ Premium', popularity: 100, layout: 'bottom', keyword: false, highlightScale: 1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 58, fill: '#15181E', highlight: '#2D7CFF', highlightStyle: 'color',
      boxColor: '#F1F2F4', boxRadius: 16, boxOpacity: 1, upcomingOpacity: 0.4,
      glow: null, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    // Clean Glow — bold white, soft glow, no box, spoken word pops (matches the
    // uploaded "SUBS 2" reference).
    { id: 'pro-clean-glow', name: 'Clean Glow', category: '⭐ Premium', popularity: 99, layout: 'center', keyword: false, highlightScale: 1.12,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial Black'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      glow: '#000000', glowBlur: 0.5, stroke: null, strokeWidth: 0, boxColor: null,
      upcomingOpacity: 0.55, uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    // Karaoke Bar — white words on a translucent dark rounded bar; the spoken
    // word rides in a SOLID amber box with auto-contrast (dark) text. The classic
    // reel/explainer look (matches the uploaded m.Stock reference).
    { id: 'pro-karaokebar', name: 'Karaoke Bar', category: '⭐ Premium', popularity: 99, layout: 'bottom', keyword: false, highlightScale: 1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#F5A623', highlightStyle: 'box', boxRadius: 9,
      boxColor: '#0C0D11', boxOpacity: 0.72, boxPad: 1.15,
      glow: null, stroke: null, strokeWidth: 0, weight: 800, uppercase: false, wordsPerCue: 5, anim: 'karaoke' },
    // Pulse — UPPERCASE clean sans, key word on a blue pill (Captions.ai "Pulse")
    { id: 'pro-pulse', name: 'Pulse', category: '⭐ Premium', popularity: 99, layout: 'center', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 66, fill: '#FFFFFF', highlight: '#3B5BFF', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    // Thuban — key word on a yellow pill (black text auto-contrasts)
    { id: 'pro-thuban', name: 'Thuban', category: '⭐ Premium', popularity: 98, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#FFE000', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    // Runway — lowercase clean, key word on a pink pill
    { id: 'pro-runway', name: 'Runway', category: '⭐ Premium', popularity: 97, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Poppins', fallbackFonts: ['Montserrat', 'Inter', 'Arial'],
      fontSize: 58, fill: '#FFFFFF', highlight: '#FF2D9B', highlightStyle: 'box', boxRadius: 14, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'reveal' },
    // Copernicus — key word on a green pill
    { id: 'pro-copernicus', name: 'Copernicus', category: '⭐ Premium', popularity: 96, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#15C47E', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    // Clarity — minimal clean white, sentence case, soft shadow (Captions.ai "Clarity")
    { id: 'pro-clarity', name: 'Clarity', category: '⭐ Premium', popularity: 95, layout: 'center', keyword: false,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#FFFFFF', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'fade' },
    // Evo — clean white, key word pops in a soft gold (no box)
    { id: 'pro-evo', name: 'Evo', category: '⭐ Premium', popularity: 94, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Poppins', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 60, fill: '#FFFFFF', highlight: '#FFD400', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'reveal' },
    // Nova — UPPERCASE clean, key word in coral-pink (no box)
    { id: 'pro-nova', name: 'Nova', category: '⭐ Premium', popularity: 93, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Poppins', 'Arial Black'],
      fontSize: 64, fill: '#FFFFFF', highlight: '#FF3B6B', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    // Andromeda — clean white on a soft dark rounded bar (lower-third, Captions.ai "Byline")
    { id: 'pro-andromeda', name: 'Andromeda', category: '⭐ Premium', popularity: 92, layout: 'bottom', keyword: false,
      font: 'Outfit', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#9FE7FF', boxColor: '#10131A', boxRadius: 16, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 0, anim: 'slide' },
    // Elevate — cinematic serif, soft gold accent (Captions.ai "Elevate")
    { id: 'pro-elevate', name: 'Elevate', category: '⭐ Premium', popularity: 91, layout: 'center', keyword: false,
      font: 'Playfair Display', fallbackFonts: ['Lora', 'Georgia', 'serif'],
      fontSize: 60, fill: '#F6F2EC', highlight: '#E8C77A', glow: '#000000', stroke: null, strokeWidth: 0, letterSpacing: 0.5,
      uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Quintessence — elegant warm-gold serif, centered (Captions.ai "Quintessence")
    { id: 'pro-quint', name: 'Quintessence', category: '⭐ Premium', popularity: 90, layout: 'center', keyword: false,
      font: 'Playfair Display', fallbackFonts: ['Lora', 'Georgia', 'serif'],
      fontSize: 66, fill: '#F3E9D2', highlight: '#D9B36A', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'scale' },
    // Velocity — bold word-by-word caps with a blue accent (Captions.ai "Velocity")
    { id: 'pro-velocity', name: 'Velocity', category: '⭐ Premium', popularity: 89, layout: 'bottom', keyword: true, highlightScale: 1.12,
      font: 'Montserrat', fallbackFonts: ['Archivo Black', 'Arial Black'],
      fontSize: 78, fill: '#FFFFFF', highlight: '#2D7CFF', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 2, anim: 'pop-scale' },
    // Neon — glowing gaming/music look (Captions.ai "Neon" / "Rocket")
    { id: 'pro-neon', name: 'Neon', category: '⭐ Premium', popularity: 88, layout: 'center', keyword: true,
      font: 'Bebas Neue', fallbackFonts: ['Anton', 'Impact'],
      fontSize: 84, fill: '#FFFFFF', highlight: '#FF2D9B', glow: '#22D3FF', stroke: '#0A0A0A', strokeWidth: 3,
      uppercase: true, wordsPerCue: 2, anim: 'glitch-in' },

    // ---- v1.0 creator presets (word reveal + viral-word pop built in) ----
    { id: 'v1-hormozi26', name: 'Statement Pro', category: '⭐ Premium', popularity: 87, layout: 'bottom', keyword: true, highlightScale: 1.12,
      font: 'Montserrat', fallbackFonts: ['Archivo Black', 'Arial Black'],
      fontSize: 72, fill: '#FFFFFF', highlight: '#FFE000', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 3, anim: 'reveal' },
    { id: 'v1-finance', name: 'Finance Pro', category: '⭐ Premium', popularity: 86, layout: 'bottom', keyword: true, highlightScale: 1.1,
      font: 'Montserrat', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 60, fill: '#FFFFFF', highlight: '#16C784', highlightStyle: 'box', boxRadius: 10, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'reveal' },
    { id: 'v1-podcast', name: 'Podcast Pro', category: '⭐ Premium', popularity: 85, layout: 'bottom', keyword: false, speaker: true,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: '#5CC8FF', boxColor: '#10131A', boxRadius: 14, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 0, anim: 'slide' },
    { id: 'v1-reels', name: 'Indian Reels', category: '⭐ Premium', popularity: 84, layout: 'bottom', keyword: true, highlightScale: 1.12,
      font: 'Poppins', fallbackFonts: ['Montserrat', 'Inter', 'Arial'],
      fontSize: 62, fill: '#FFFFFF', highlight: '#FF2D9B', highlightStyle: 'box', boxRadius: 14, glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'reveal' },
    { id: 'v1-beast', name: 'MrBeast Inspired', category: '⭐ Premium', popularity: 83, layout: 'bottom', keyword: true, highlightScale: 1.18,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Arial Black'],
      fontSize: 78, fill: '#FFFFFF', highlight: '#FF2A2A', glow: '#000000', stroke: '#000000', strokeWidth: 4,
      uppercase: true, wordsPerCue: 2, anim: 'pop-scale' },
    { id: 'v1-ali', name: 'Ali Abdaal Inspired', category: '⭐ Premium', popularity: 82, layout: 'bottom', keyword: false,
      font: 'Inter', fallbackFonts: ['Helvetica Neue', 'Arial'],
      fontSize: 50, fill: '#FFFFFF', highlight: '#FFFFFF', glow: '#000000', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'fade' }
  ];

  /* The full catalog the library browses (base + extras). */
  // ---- Fresh, distinct aesthetic styles (each a clearly different look) ----
  var NEW_TEMPLATES = [
    // Gradient sky text, soft glow — premium cinematic
    { id: 'cap-aurora', name: 'Aurora', category: 'Cinematic', popularity: 96, layout: 'center', keyword: false, highlightScale: 1.12,
      font: 'Outfit', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 64, fill: '#FFFFFF', fill2: '#B9C7FF', highlight: '#7FE7FF', highlightStyle: 'color',
      glow: '#0A1030', glowBlur: 0.5, stroke: null, strokeWidth: 0, boxColor: null,
      upcomingOpacity: 0.55, uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    // Comic-poster energy — Bangers, thick outline, white active word
    { id: 'cap-motiv', name: 'Hype', category: 'Motivation', popularity: 95, layout: 'center', keyword: false, highlightScale: 1.2,
      font: 'Bangers', fallbackFonts: ['Luckiest Guy', 'Anton', 'Impact'],
      fontSize: 96, fill: '#FFE53B', highlight: '#FFFFFF', highlightStyle: 'color',
      stroke: '#000000', strokeWidth: 13, glow: null, boxColor: null,
      uppercase: true, wordsPerCue: 3, anim: 'karaoke' },
    // Terminal mono on a dark pill — techy / gaming
    { id: 'cap-mono', name: 'Mono', category: 'Gaming Stream', popularity: 91, layout: 'bottom', keyword: false, highlightScale: 1.05,
      font: 'JetBrains Mono', fallbackFonts: ['Roboto Mono', 'Space Mono', 'Courier New'],
      fontSize: 46, fill: '#E6FBFF', highlight: '#00F0FF', highlightStyle: 'color',
      boxColor: '#0B1118', boxRadius: 8, boxOpacity: 0.92, glow: null, stroke: null, strokeWidth: 0,
      upcomingOpacity: 0.5, uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Rounded white pill, soft pink active — friendly social look
    { id: 'cap-pastel', name: 'Pastel', category: 'Social Growth', popularity: 92, layout: 'bottom', keyword: false, highlightScale: 1.08,
      font: 'Nunito', fallbackFonts: ['Poppins', 'Inter', 'Arial'],
      fontSize: 56, fill: '#2A2233', highlight: '#FF5DA2', highlightStyle: 'box', boxColor: '#FFFFFF', boxRadius: 24, boxOpacity: 1,
      glow: null, stroke: null, strokeWidth: 0, upcomingOpacity: 0.5, uppercase: false, wordsPerCue: 3, anim: 'karaoke' },
    // Elegant serif, gold active — storytelling / luxury
    { id: 'cap-editorial', name: 'Column', category: 'Storytelling', popularity: 90, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Playfair Display', fallbackFonts: ['Georgia', 'Merriweather', 'Times New Roman'],
      fontSize: 60, fill: '#F6F2EA', highlight: '#E7B45A', highlightStyle: 'color',
      glow: '#000000', glowBlur: 0.45, stroke: null, strokeWidth: 0, boxColor: null,
      upcomingOpacity: 0.6, uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Condensed news ticker, teal bar under the spoken word
    { id: 'cap-ticker', name: 'Ticker', category: 'Education', popularity: 88, layout: 'bottom', keyword: false, highlightScale: 1.02,
      font: 'Oswald', fallbackFonts: ['Bebas Neue', 'Inter', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#13C2A8', highlightStyle: 'bar', boxOpacity: 1,
      glow: null, stroke: '#000000', strokeWidth: 5, uppercase: true, wordsPerCue: 4, anim: 'karaoke' },
    // Crisp white subtitle card, blue active — minimal & professional
    { id: 'cap-card', name: 'Clean Card', category: 'Minimal Professional', popularity: 93, layout: 'bottom', keyword: false, highlightScale: 1,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 52, fill: '#11151C', highlight: '#2D7CFF', highlightStyle: 'color',
      boxColor: '#FFFFFF', boxRadius: 12, boxOpacity: 0.96, glow: null, stroke: null, strokeWidth: 0,
      upcomingOpacity: 0.45, uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Clean white-box subtitle where the SPOKEN word darkens (grey → near-black),
    // following the voice word-by-word. The reliable, burned-in version of the
    // "clean subtitle" look — no MOGRT overlap, no Premiere-internals.
    { id: 'cap-clean-sub', name: 'Clean Subtitle', category: 'Minimal Professional', popularity: 96, layout: 'bottom', keyword: false, highlightScale: 1,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 50, fill: '#8A93A3', highlight: '#0B0F17', highlightStyle: 'color',
      boxColor: '#FFFFFF', boxRadius: 18, boxOpacity: 1, glow: null, stroke: null, strokeWidth: 0,
      upcomingOpacity: 1, uppercase: false, wordsPerCue: 5, anim: 'karaoke' },
    // Warm clean studio caption — podcast/interview
    { id: 'cap-studio', name: 'Studio', category: 'Podcast Pro', popularity: 90, layout: 'bottom', keyword: false, highlightScale: 1.06,
      font: 'Manrope', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#FFC857', highlightStyle: 'color',
      glow: '#000000', glowBlur: 0.42, stroke: null, strokeWidth: 0, boxColor: null,
      upcomingOpacity: 0.55, uppercase: false, wordsPerCue: 4, anim: 'karaoke' },

    // ---- Extracted from reference video: centered MULTI-WORD caption, heavy sans,
    //      the AUTO-DETECTED keyword pops bigger in a GLOSSY (shiny) gradient.
    //      White words carry a subtle sheen; soft shadow for depth. ----
    // Warm glossy orange keyword
    { id: 'pro-boldpop', name: 'Bold Pop', category: '⭐ Premium', popularity: 100, layout: 'center', keyword: true, wordHl: false, highlightScale: 1.5,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', fill2: '#D2D7DE', highlight: '#FFE45C', highlight2: '#EF6C0A', highlightStyle: 'color', glossy: true,
      stroke: '#2A1A06', strokeWidth: 5, glow: '#000000', glowBlur: 0.5,
      weight: 900, uppercase: false, wordsPerLine: 3, wordsPerCue: 6, lineGap: 1.04, build: true, anim: 'pop' },
    // Cool glossy blue keyword
    { id: 'pro-coolpop', name: 'Cool Pop', category: '⭐ Premium', popularity: 99, layout: 'center', keyword: true, wordHl: false, highlightScale: 1.5,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', fill2: '#D2D7DE', highlight: '#BFE3FF', highlight2: '#1E63E6', highlightStyle: 'color', glossy: true,
      stroke: '#06101A', strokeWidth: 5, glow: '#000000', glowBlur: 0.5,
      weight: 900, uppercase: false, wordsPerLine: 3, wordsPerCue: 6, lineGap: 1.04, build: true, anim: 'pop' },
    // Clean all-white — the keyword just pops bigger with a subtle sheen + shadow
    { id: 'pro-cleanbold', name: 'Clean Bold', category: '⭐ Premium', popularity: 98, layout: 'center', keyword: true, wordHl: false, highlightScale: 1.5,
      font: 'Archivo Black', fallbackFonts: ['Montserrat', 'Poppins', 'Arial Black'],
      fontSize: 62, fill: '#FFFFFF', fill2: '#CED2D8', highlight: '#FFFFFF', highlightStyle: 'color',
      glow: '#000000', glowBlur: 0.55, stroke: null, strokeWidth: 0, boxColor: null,
      weight: 900, uppercase: false, wordsPerLine: 3, wordsPerCue: 6, lineGap: 1.04, build: true, anim: 'pop' },

    // ---- Extracted from reference video #2: an EDITORIAL/anchor caption — a big
    //      bold grotesque headline line over a smaller second line (two-tier), the
    //      AUTO-DETECTED keyword set in an italic SERIF with a soft white glow, all
    //      sitting on a soft dark shadow so it reads over any footage. ----
    { id: 'pro-editorial', name: 'Editorial', category: '⭐ Premium', popularity: 100, layout: 'center', keyword: true, wordHl: false, highlightScale: 1.08,
      font: 'Helvetica', fallbackFonts: ['Arial', 'Inter', 'Montserrat'],
      fontSize: 60, fill: '#FFFFFF', fill2: '#DDE1E6',
      highlight: '#FFFFFF', highlightStyle: 'color',
      highlightFont: 'Playfair Display', highlightFallbacks: 'Georgia, "Times New Roman", serif',
      highlightItalic: true, highlightWeight: 800, highlightGlow: '#FFFFFF', highlightGlowBlur: 0.4,
      subScale: 0.62, build: true,
      glow: '#000000', glowBlur: 0.6, stroke: null, strokeWidth: 0, boxColor: null,
      weight: 700, uppercase: false, wordsPerLine: 3, wordsPerCue: 6, lineGap: 0.95, build: true, anim: 'pop' }
  ];

  /* "Buttons" pack — caption pills recreated from the user's SVG button set
     (uiverse-style). Each carries exact colours/gradients/borders/glow/3D from
     the source SVG, and every one is fully editable in the customizer
     (colours, gradient stops, border, glow, gloss, 3D depth, corner radius,
     font, animation). Box-level styling is driven by render.js's new
     boxStroke / boxGlow / box3d / boxGloss / boxShadow / boxStops props. */
  var BUTTON_TEMPLATES = [
    // Neon — glowing border + text on a near-black pill (Neon.svg #14FF8E)
    { id: 'btn-neon', name: 'Neon', category: '🔘 Buttons', popularity: 97, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Space Mono', fallbackFonts: ['JetBrains Mono', 'Roboto Mono', 'monospace'],
      fontSize: 54, fill: '#14FF8E', highlight: '#A8FFD2', highlightStyle: 'color',
      boxColor: '#0A0A0A', boxRadius: 18, boxPad: 1.2, boxStroke: '#14FF8E', boxStrokeWidth: 4,
      boxGlow: '#14FF8E', boxGlowBlur: 0.8, glow: '#14FF8E', glowBlur: 0.45,
      uppercase: false, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Spotify — solid green pill, white uppercase (Spotify.svg)
    { id: 'btn-spotify', name: 'Spotify', category: '🔘 Buttons', popularity: 95, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#1DB954', boxRadius: 120, boxPad: 1.4, letterSpacing: 3, uppercase: true, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Pop 3D — Duolingo-style extruded green button (darkened for caption contrast)
    { id: 'btn-pop3d', name: 'Pop 3D', category: '🔘 Buttons', popularity: 96, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Nunito', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 50, fill: '#FFFFFF', highlight: '#EAFFD0', highlightStyle: 'color',
      boxColor: '#3FA000', boxRadius: 120, boxPad: 1.35, box3d: '#2C7000', box3dDepth: 11,
      letterSpacing: 1, uppercase: true, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // 3D Red — red face, dark-red extruded edge, black border (3D Red.svg)
    { id: 'btn-3dred', name: '3D Red', category: '🔘 Buttons', popularity: 90, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Nunito', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 50, fill: '#7A1E1E', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#FF6666', boxRadius: 120, boxPad: 1.35, box3d: '#8B2626', box3dDepth: 11,
      boxStroke: '#000000', boxStrokeWidth: 3, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Neomorphism — soft peach pill, soft drop shadow, dark text (Neomorphism.svg)
    { id: 'btn-neo', name: 'Neo', category: '🔘 Buttons', popularity: 92, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Nunito', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 48, fill: '#6B4A33', highlight: '#3F2A1C', highlightStyle: 'color',
      boxColor: '#F2C4A3', boxColor2: '#E5A878', boxGradient: 'v', boxRadius: 120, boxPad: 1.35,
      boxShadow: 'rgba(120,95,75,0.55)', boxShadowBlur: 0.55, boxShadowDY: 9, weight: 700, wordsPerCue: 3, anim: 'scale' },
    // Aura — 8-stop pastel horizontal gradient, black border, dark text (Your Stack.svg)
    { id: 'btn-aura', name: 'Aura', category: '🔘 Buttons', popularity: 94, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 50, fill: '#111111', highlight: '#111111', highlightStyle: 'color',
      boxColor: '#F4C5C1', boxStops: [[0, '#FCF1B2'], [0.229, '#F4C5C1'], [0.406, '#EEC2EA'], [0.588, '#C0C8F9'], [0.75, '#C9F2FC'], [1, '#E7FCC5']],
      boxGradient: 'h', boxRadius: 120, boxPad: 1.35, boxStroke: '#000000', boxStrokeWidth: 4, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Candy — glossy pink pill, white script italic + top sheen (Candy Crush.svg)
    { id: 'btn-candy', name: 'Candy', category: '🔘 Buttons', popularity: 93, layout: 'center', keyword: false, highlightScale: 1.06,
      font: 'Pacifico', fallbackFonts: ['Caveat', 'Inter'],
      fontSize: 54, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#F75BA2', boxColor2: '#D73F6E', boxGradient: 'v', boxGloss: 0.9, boxRadius: 120, boxPad: 1.35,
      boxStroke: '#E0367E', boxStrokeWidth: 2, weight: 700, wordsPerCue: 2, anim: 'pop' },
    // Gold Gloss — Paypal glossy gold, navy bold italic (Paypal.svg)
    { id: 'btn-gold', name: 'Gold Gloss', category: '🔘 Buttons', popularity: 91, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 50, fill: '#1B3661', highlight: '#1B3661', highlightStyle: 'color', highlightItalic: true,
      boxColor: '#F9BC5C', boxColor2: '#F9A92A', boxGradient: 'v', boxGloss: 0.85, boxRadius: 120, boxPad: 1.35, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Glass — dark frosted pill, white text, light hairline border (glassmorphism)
    { id: 'btn-glass', name: 'Glass', category: '🔘 Buttons', popularity: 90, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 50, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#15171C', boxOpacity: 0.4, boxRadius: 120, boxPad: 1.35,
      boxStroke: '#FFFFFF', boxStrokeWidth: 2, boxGlow: '#FFFFFF', boxGlowBlur: 0.3, weight: 700, wordsPerCue: 3, anim: 'scale' },
    // Outline — transparent pill, coloured border + matching text
    { id: 'btn-outline', name: 'Outline', category: '🔘 Buttons', popularity: 89, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 50, fill: '#FFD23F', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: null, boxRadius: 120, boxPad: 1.35, boxStroke: '#FFD23F', boxStrokeWidth: 4,
      glow: '#000000', glowBlur: 0.3, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Pixel — Minecraft dirt block, pixel mono font, hard text shadow (Minecraft.svg)
    { id: 'btn-pixel', name: 'Pixel', category: '🔘 Buttons', popularity: 88, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Space Mono', fallbackFonts: ['Roboto Mono', 'Courier New', 'monospace'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#7CF03F', highlightStyle: 'color',
      boxColor: '#6B4423', boxRadius: 2, boxPad: 1.25, boxStroke: '#1C1208', boxStrokeWidth: 6,
      shadowDX: 3, shadowDY: 3, uppercase: true, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Basic Blue — solid blue gradient pill, white (Basic Blue.svg)
    { id: 'btn-blue', name: 'Basic Blue', category: '🔘 Buttons', popularity: 87, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#4363F8', boxColor2: '#2748E1', boxGradient: 'v', boxRadius: 120, boxPad: 1.35, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Paper — clean white pill, dark text, soft drop shadow (Paper / MacOS)
    { id: 'btn-paper', name: 'Paper', category: '🔘 Buttons', popularity: 86, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 48, fill: '#15171C', highlight: '#2D7CFF', highlightStyle: 'color',
      boxColor: '#FFFFFF', boxRadius: 120, boxPad: 1.35, boxShadow: 'rgba(0,0,0,0.35)', boxShadowBlur: 0.45, boxShadowDY: 7, weight: 800, wordsPerCue: 3, anim: 'scale' },
    // Twitter — solid sky-blue pill, white (Twitter.svg #1BA1F2)
    { id: 'btn-twitter', name: 'Sky', category: '🔘 Buttons', popularity: 85, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#1BA1F2', boxRadius: 120, boxPad: 1.35, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Twitch — purple rounded button, white (Twitch.svg #9147FF)
    { id: 'btn-twitch', name: 'Purple', category: '🔘 Buttons', popularity: 84, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 48, fill: '#FFFFFF', highlight: '#E9DDFF', highlightStyle: 'color',
      boxColor: '#9147FF', boxRadius: 16, boxPad: 1.3, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Windows Classic — grey 3D bevelled button, dark text (Windows Classic.svg)
    { id: 'btn-win', name: 'Retro Win', category: '🔘 Buttons', popularity: 83, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Inter', fallbackFonts: ['Tahoma', 'Arial'],
      fontSize: 46, fill: '#111111', highlight: '#0A0AC8', highlightStyle: 'color',
      boxColor: '#C8C8C8', boxRadius: 3, boxPad: 1.25, box3d: '#707070', box3dDepth: 6,
      boxStroke: '#1A1A1A', boxStrokeWidth: 2, boxGloss: 0.35, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Bios — retro terminal: deep-blue box, mono text (Bios.svg #0300E4)
    { id: 'btn-bios', name: 'BIOS', category: '🔘 Buttons', popularity: 82, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Space Mono', fallbackFonts: ['JetBrains Mono', 'Courier New', 'monospace'],
      fontSize: 44, fill: '#FFFFFF', highlight: '#5BFF8A', highlightStyle: 'color',
      boxColor: '#0300E4', boxRadius: 2, boxPad: 1.25, boxStroke: '#6A78FF', boxStrokeWidth: 2, uppercase: true, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // Figma — blue rounded-rect chip, white (Figma.svg #18A0FB)
    { id: 'btn-figma', name: 'Chip', category: '🔘 Buttons', popularity: 84, layout: 'center', keyword: false, highlightScale: 1.05,
      font: 'Inter', fallbackFonts: ['Helvetica', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#FFFFFF', highlightStyle: 'color',
      boxColor: '#18A0FB', boxRadius: 16, boxPad: 1.3, weight: 700, wordsPerCue: 3, anim: 'pop' },
    // De Stijl — Mondrian: white card, thick black border, red active word (De Stijl.svg)
    { id: 'btn-destijl', name: 'De Stijl', category: '🔘 Buttons', popularity: 83, layout: 'center', keyword: false, highlightScale: 1.08,
      font: 'Archivo Black', fallbackFonts: ['Inter', 'Arial'],
      fontSize: 46, fill: '#111111', highlight: '#E64043', highlightStyle: 'color',
      boxColor: '#F1F1F1', boxRadius: 2, boxPad: 1.3, boxStroke: '#000000', boxStrokeWidth: 7, weight: 800, wordsPerCue: 3, anim: 'pop' },
    // Google — dark grey rounded button, white (Google.svg #3D4043)
    { id: 'btn-google', name: 'Slate', category: '🔘 Buttons', popularity: 85, layout: 'center', keyword: false, highlightScale: 1.04,
      font: 'Inter', fallbackFonts: ['Roboto', 'Arial'],
      fontSize: 46, fill: '#FFFFFF', highlight: '#8AB4F8', highlightStyle: 'color',
      boxColor: '#3D4043', boxRadius: 26, boxPad: 1.3, weight: 600, wordsPerCue: 3, anim: 'scale' }
  ];
  // A button is ONE pill on ONE line — force single-line (the renderer shrinks the
  // font to fit) so the caption never wraps into two stacked pills.
  BUTTON_TEMPLATES.forEach(function (bt) {
    if (bt.maxLines == null) bt.maxLines = 1;
    if (bt.maxWidthPct == null) bt.maxWidthPct = 0.9;
  });

  var TEMPLATES = STYLE_PRESETS.concat(PREMIUM_TEMPLATES, MORE_TEMPLATES, NEW_TEMPLATES, BUTTON_TEMPLATES);
  // Retire near-duplicate styles that differed from a kept one only by colour or
  // size (both editable in the customizer) — keeps the gallery curated & distinct.
  var _RETIRED = { evo: 1, cleanwhite: 1, byline: 1, 'pro-neon': 1, rebel: 1, boldyellow: 1,
    grind: 1, 'v1-podcast': 1, paper: 1, tvnews: 1, 'v1-finance': 1, 'pro-copernicus': 1,
    'v1-hormozi26': 1, 'v1-reels': 1, 'pro-velocity': 1, 'pro-quint': 1, magazine: 1,
    lumen: 1, bloom: 1, sonnet: 1,
    // curation round 2 — exact same look (box/fill/highlight/caps/glow signature)
    // as a kept style, differing only in name:
    'cap-grit': 1, 'highlight-box': 1, 'pro-clarity': 1, 'v1-ali': 1, sketch: 1,
    // curation round 3 — the user's rule: if a style is reachable from another
    // by the customization tab alone (colours, box, opacity, shadow, caps,
    // word-by-word, gradient highlight, size, position, entrance), it is a
    // duplicate. Identity = what the tab CANNOT change: font family, bold vs
    // regular, and box-corner class — EXCEPT the 🔘 Buttons pack, which the
    // user explicitly keeps whole as a themed set. One keeper per group:
    'pro-spotlight': 1, 'pro-subs-light': 1, 'pro-clean-glow': 1, 'pro-karaokebar': 1, 'pro-pulse': 1, 'pro-thuban': 1, 'pro-nova': 1, 'pro-andromeda': 1, rocket: 1, prism: 1, 'cap-core': 1, 'cap-hype': 1, 'cap-aurora': 1, mars: 1, stack: 1, 'cap-clarity': 1, 'cap-card': 1, 'cap-studio': 1, 'v1-beast': 1, prime: 1, kai: 1, 'pro-coolpop': 1, 'pro-cleanbold': 1, 'pro-runway': 1, 'pro-evo': 1, focus: 1, cinema: 1, neon: 1, volt: 1, align: 1, 'cap-mono': 1, 'pro-elevate': 1, monolith: 1, ember: 1, linen: 1 };
  TEMPLATES = TEMPLATES.filter(function (t) { return !_RETIRED[t.id]; });

  // ---- timeline-safe faces --------------------------------------------------
  // Styles were authored with Google webfonts, which are NOT installed on a
  // stock Mac/Windows — the canvas preview loaded them from the web while the
  // TIMELINE silently substituted something else. Remap each to the closest
  // face that ships with macOS (with sane Windows twins), and keep the original
  // webfont as the preview's first fallback so machines that DO have it render
  // the closest possible look. Preview and output stay in agreement.
  var FONT_SAFE = {
    'Inter': 'Helvetica Neue',
    'Manrope': 'Helvetica Neue',
    'Montserrat': 'Avenir Next',
    'Outfit': 'Avenir Next',
    'Poppins': 'Futura',
    'Archivo Black': 'Arial Black',
    'Anton': 'Impact',
    'Bebas Neue': 'Impact',
    'Oswald': 'Arial Narrow',
    'JetBrains Mono': 'Menlo',
    'Space Mono': 'Courier New',
    'Playfair Display': 'Didot',
    'Nunito': 'Trebuchet MS',
    'Bangers': 'Marker Felt',
    'Pacifico': 'Snell Roundhand'
  };
  /* CREATOR PACK — the styles learned from the user's own reference videos.
     They were removed in the 72→22 dedupe; restored verbatim under their own
     gallery tab ("they're mine — bring them back"). Fonts are already the
     system-safe faces, so the FONT_SAFE remap below leaves them untouched. */
  var CREATOR_PACK = [
    {
      "id": "pack-orange-word-pop",
      "name": "Orange Word Pop",
      "category": "🎬 From My Videos",
      "popularity": 100,
      "layout": "bottom",
      "posPct": 62,
      "keyword": true,
      "highlightScale": 1,
      "font": "Poppins",
      "fallbackFonts": ["Montserrat", "Inter", "Arial", "sans-serif"],
      "fontSize": 62,
      "fill": "#FFFFFF",
      "highlight": "#FFA51E",
      "highlightStyle": "box",
      "boxColor": "#0B0B0D",
      "boxOpacity": 0.92,
      "boxRadius": 6,
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": false,
      "wordsPerCue": 5,
      "anim": "karaoke",
      "animNotes": "White sentence on a tight black bar; the SPOKEN word pops in an orange pill (learned from the m.Stock reel)."
    },
    {
      "id": "pack-script-glow",
      "name": "Script Glow",
      "category": "🎬 From My Videos",
      "popularity": 100,
      "layout": "bottom",
      "posPct": 72,
      "keyword": false,
      "highlightScale": 1,
      "font": "Snell Roundhand",
      "fallbackFonts": ["Pacifico", "Caveat", "Georgia", "serif"],
      "fontSize": 56,
      "fill": "#FFFFFF",
      "highlight": "#FFFFFF",
      "glow": "#FFFFFF",
      "glowBlur": 0.45,
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": false,
      "wordsPerCue": 3,
      "wordHl": false,
      "anim": "fade",
      "animNotes": "Elegant white script with a soft halo glow, no box — the 'of the world' overlay look (learned from the Sequence 05 export)."
    },
    {
      "id": "pack-neon",
      "name": "Neon Pop",
      "description": "Glowing neon text with chromatic flicker on entry. Gaming / music content.",
      "font": "Impact",
      "fallbackFonts": [
        "Bebas Neue",
        "Anton",
        "Impact",
        "sans-serif"
      ],
      "fontSize": 80,
      "fill": "#F8F8FF",
      "highlight": "#00F0FF",
      "stroke": "#7B2FFF",
      "strokeWidth": 6,
      "glow": "#00F0FF",
      "uppercase": true,
      "wordsPerCue": 2,
      "anim": "glitch-in",
      "animNotes": "2-frame RGB-split glitch on entry, outer glow pulses with audio.",
      "category": "🎥 Your Styles",
      "popularity": 88,
      "layout": "center",
      "keyword": true,
      "speaker": false
    },
    {
      "id": "pro-spotlight",
      "name": "Spotlight",
      "category": "🎥 Your Styles",
      "popularity": 100,
      "layout": "bottom",
      "keyword": false,
      "highlightScale": 1.1,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Poppins",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 62,
      "fill": "#FFFFFF",
      "highlight": "#2D7CFF",
      "highlightStyle": "box",
      "boxRadius": 12,
      "glow": "#000000",
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": false,
      "wordsPerCue": 4,
      "anim": "karaoke"
    },
    {
      "id": "pro-subs-light",
      "name": "Subs Light",
      "category": "🎥 Your Styles",
      "popularity": 100,
      "layout": "bottom",
      "keyword": false,
      "highlightScale": 1,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Poppins",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 58,
      "fill": "#15181E",
      "highlight": "#2D7CFF",
      "highlightStyle": "color",
      "boxColor": "#F1F2F4",
      "boxRadius": 16,
      "boxOpacity": 1,
      "upcomingOpacity": 0.4,
      "glow": null,
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": false,
      "wordsPerCue": 3,
      "anim": "karaoke"
    },
    {
      "id": "pro-clean-glow",
      "name": "Clean Glow",
      "category": "🎥 Your Styles",
      "popularity": 99,
      "layout": "center",
      "keyword": false,
      "highlightScale": 1.12,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Poppins",
        "Inter",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 64,
      "fill": "#FFFFFF",
      "highlight": "#FFFFFF",
      "highlightStyle": "color",
      "glow": "#000000",
      "glowBlur": 0.5,
      "stroke": null,
      "strokeWidth": 0,
      "boxColor": null,
      "upcomingOpacity": 0.55,
      "uppercase": false,
      "wordsPerCue": 3,
      "anim": "karaoke"
    },
    {
      "id": "pro-karaokebar",
      "name": "Karaoke Bar",
      "category": "🎥 Your Styles",
      "popularity": 99,
      "layout": "bottom",
      "keyword": false,
      "highlightScale": 1,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Poppins",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 54,
      "fill": "#FFFFFF",
      "highlight": "#F5A623",
      "highlightStyle": "box",
      "boxRadius": 9,
      "boxColor": "#0C0D11",
      "boxOpacity": 0.72,
      "boxPad": 1.15,
      "glow": null,
      "stroke": null,
      "strokeWidth": 0,
      "weight": 800,
      "uppercase": false,
      "wordsPerCue": 5,
      "anim": "karaoke"
    },
    {
      "id": "pro-pulse",
      "name": "Pulse",
      "category": "🎥 Your Styles",
      "popularity": 99,
      "layout": "center",
      "keyword": true,
      "highlightScale": 1.1,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Poppins",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 66,
      "fill": "#FFFFFF",
      "highlight": "#3B5BFF",
      "highlightStyle": "box",
      "boxRadius": 10,
      "glow": "#000000",
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": true,
      "wordsPerCue": 3,
      "anim": "reveal"
    },
    {
      "id": "pro-thuban",
      "name": "Thuban",
      "category": "🎥 Your Styles",
      "popularity": 98,
      "layout": "bottom",
      "keyword": true,
      "highlightScale": 1.1,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Poppins",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 62,
      "fill": "#FFFFFF",
      "highlight": "#FFE000",
      "highlightStyle": "box",
      "boxRadius": 10,
      "glow": "#000000",
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": true,
      "wordsPerCue": 3,
      "anim": "reveal"
    },
    {
      "id": "pro-runway",
      "name": "Runway",
      "category": "🎥 Your Styles",
      "popularity": 97,
      "layout": "bottom",
      "keyword": true,
      "highlightScale": 1.1,
      "font": "Futura",
      "fallbackFonts": [
        "Poppins",
        "Montserrat",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 58,
      "fill": "#FFFFFF",
      "highlight": "#FF2D9B",
      "highlightStyle": "box",
      "boxRadius": 14,
      "glow": "#000000",
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": false,
      "wordsPerCue": 3,
      "anim": "reveal"
    },
    {
      "id": "pro-evo",
      "name": "Evo",
      "category": "🎥 Your Styles",
      "popularity": 94,
      "layout": "bottom",
      "keyword": true,
      "highlightScale": 1.1,
      "font": "Futura",
      "fallbackFonts": [
        "Poppins",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 60,
      "fill": "#FFFFFF",
      "highlight": "#FFD400",
      "glow": "#000000",
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": false,
      "wordsPerCue": 4,
      "anim": "reveal"
    },
    {
      "id": "pro-nova",
      "name": "Nova",
      "category": "🎥 Your Styles",
      "popularity": 93,
      "layout": "bottom",
      "keyword": true,
      "highlightScale": 1.1,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Poppins",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 64,
      "fill": "#FFFFFF",
      "highlight": "#FF3B6B",
      "glow": "#000000",
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": true,
      "wordsPerCue": 3,
      "anim": "reveal"
    },
    {
      "id": "pro-andromeda",
      "name": "Andromeda",
      "category": "🎥 Your Styles",
      "popularity": 92,
      "layout": "bottom",
      "keyword": false,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Outfit",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 46,
      "fill": "#FFFFFF",
      "highlight": "#9FE7FF",
      "boxColor": "#10131A",
      "boxRadius": 16,
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": false,
      "wordsPerCue": 0,
      "anim": "slide"
    },
    {
      "id": "pro-elevate",
      "name": "Elevate II",
      "category": "🎥 Your Styles",
      "popularity": 91,
      "layout": "center",
      "keyword": false,
      "font": "Didot",
      "fallbackFonts": [
        "Playfair Display",
        "Lora",
        "Georgia",
        "serif"
      ],
      "fontSize": 60,
      "fill": "#F6F2EC",
      "highlight": "#E8C77A",
      "glow": "#000000",
      "stroke": null,
      "strokeWidth": 0,
      "letterSpacing": 0.5,
      "uppercase": false,
      "wordsPerCue": 4,
      "anim": "karaoke"
    },
    {
      "id": "v1-beast",
      "name": "MrBeast Inspired",
      "category": "🎥 Your Styles",
      "popularity": 83,
      "layout": "bottom",
      "keyword": true,
      "highlightScale": 1.18,
      "font": "Arial Black",
      "fallbackFonts": [
        "Archivo Black",
        "Montserrat",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 78,
      "fill": "#FFFFFF",
      "highlight": "#FF2A2A",
      "glow": "#000000",
      "stroke": "#000000",
      "strokeWidth": 4,
      "uppercase": true,
      "wordsPerCue": 2,
      "anim": "pop-scale"
    },
    {
      "id": "prime",
      "name": "Prime",
      "category": "🎥 Your Styles",
      "popularity": 94,
      "layout": "center",
      "keyword": true,
      "font": "Arial Black",
      "fallbackFonts": [
        "Archivo Black",
        "Montserrat",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 86,
      "fill": "#FFFFFF",
      "highlight": "#7C5CFF",
      "stroke": "#000000",
      "strokeWidth": 10,
      "uppercase": true,
      "wordsPerCue": 2,
      "anim": "zoom"
    },
    {
      "id": "focus",
      "name": "Focus",
      "category": "🎥 Your Styles",
      "popularity": 93,
      "layout": "bottom",
      "keyword": true,
      "font": "Futura",
      "fallbackFonts": [
        "Poppins",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 66,
      "fill": "#FFFFFF",
      "highlight": "#FF3B6B",
      "boxRadius": 14,
      "highlightStyle": "box",
      "stroke": "#000000",
      "strokeWidth": 6,
      "uppercase": false,
      "wordsPerCue": 3,
      "anim": "karaoke"
    },
    {
      "id": "volt",
      "name": "Volt",
      "category": "🎥 Your Styles",
      "popularity": 91,
      "layout": "bottom",
      "keyword": true,
      "font": "Impact",
      "fallbackFonts": [
        "Bebas Neue",
        "Anton",
        "Impact",
        "sans-serif"
      ],
      "fontSize": 82,
      "fill": "#FFFFFF",
      "highlight": "#39FF14",
      "stroke": "#000000",
      "strokeWidth": 8,
      "uppercase": true,
      "wordsPerCue": 3,
      "anim": "pop"
    },
    {
      "id": "rocket",
      "name": "Rocket",
      "category": "🎥 Your Styles",
      "popularity": 90,
      "layout": "bottom",
      "keyword": true,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Inter",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 70,
      "fill": "#FFFFFF",
      "highlight": "#FF2D7E",
      "boxRadius": 16,
      "highlightStyle": "box",
      "stroke": "#000000",
      "strokeWidth": 7,
      "uppercase": true,
      "wordsPerCue": 3,
      "anim": "karaoke"
    },
    {
      "id": "mars",
      "name": "Mars",
      "category": "🎥 Your Styles",
      "popularity": 87,
      "layout": "bottom",
      "keyword": true,
      "font": "Helvetica Neue",
      "fallbackFonts": [
        "Inter",
        "Helvetica",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 64,
      "fill": "#111111",
      "highlight": "#111111",
      "boxColor": "#FFE53B",
      "boxRadius": 10,
      "stroke": null,
      "strokeWidth": 0,
      "uppercase": false,
      "wordsPerCue": 2,
      "anim": "pop"
    },
    {
      "id": "ember",
      "name": "Ember",
      "category": "🎥 Your Styles",
      "popularity": 68,
      "layout": "center",
      "keyword": false,
      "font": "Georgia",
      "fallbackFonts": [
        "serif"
      ],
      "fontSize": 54,
      "fill": "#FFE9D6",
      "highlight": "#FF9E5A",
      "stroke": "#1a1a1a",
      "strokeWidth": 2,
      "uppercase": false,
      "wordsPerCue": 0,
      "anim": "fade"
    },
    {
      "id": "pack-cinema",
      "name": "Cinematic",
      "category": "🎥 Your Styles",
      "popularity": 79,
      "layout": "bottom",
      "keyword": false,
      "font": "Futura",
      "fallbackFonts": [
        "Oswald",
        "Helvetica"
      ],
      "fontSize": 44,
      "fill": "#EDEDED",
      "highlight": "#EDEDED",
      "stroke": null,
      "strokeWidth": 0,
      "glow": "#000000",
      "letterSpacing": 4,
      "uppercase": true,
      "wordsPerCue": 0,
      "anim": "fade"
    },
    {
      "id": "align",
      "name": "Align",
      "category": "🎥 Your Styles",
      "popularity": 71,
      "layout": "center",
      "keyword": false,
      "font": "Menlo",
      "fallbackFonts": [
        "JetBrains Mono",
        "Courier New",
        "monospace"
      ],
      "fontSize": 40,
      "fill": "#FFFFFF",
      "highlight": "#9AD0FF",
      "stroke": null,
      "strokeWidth": 0,
      "glow": "#000000",
      "letterSpacing": 6,
      "uppercase": true,
      "wordsPerCue": 0,
      "anim": "fade"
    },
    {
      "id": "prism",
      "name": "Prism Pro",
      "category": "🎥 Your Styles",
      "popularity": 96,
      "layout": "bottom",
      "keyword": true,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Inter",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 74,
      "fill": "#FFFFFF",
      "highlight": "#FFD400",
      "stroke": "#000000",
      "strokeWidth": 7,
      "uppercase": false,
      "wordsPerCue": 0,
      "anim": "pop"
    },
    {
      "id": "stack",
      "name": "Stack",
      "category": "🎥 Your Styles",
      "popularity": 84,
      "layout": "bottom",
      "keyword": true,
      "font": "Helvetica Neue",
      "fallbackFonts": [
        "Inter",
        "Helvetica",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 60,
      "fill": "#FFFFFF",
      "highlight": "#FF4D6D",
      "stroke": "#000000",
      "strokeWidth": 4,
      "uppercase": false,
      "wordsPerCue": 0,
      "anim": "fade"
    },
    {
      "id": "kai",
      "name": "Kai",
      "category": "🎥 Your Styles",
      "popularity": 86,
      "layout": "bottom",
      "keyword": false,
      "font": "Arial Black",
      "fallbackFonts": [
        "Archivo Black",
        "Montserrat",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 80,
      "fill": "#FF2D9B",
      "highlight": "#FFFFFF",
      "stroke": "#000000",
      "strokeWidth": 8,
      "uppercase": true,
      "wordsPerCue": 2,
      "anim": "pop"
    },
    {
      "id": "linen",
      "name": "Linen",
      "category": "🎥 Your Styles",
      "popularity": 73,
      "layout": "bottom",
      "keyword": false,
      "font": "Georgia",
      "fallbackFonts": [
        "Times New Roman",
        "serif"
      ],
      "fontSize": 54,
      "fill": "#FFFFFF",
      "highlight": "#C9A36A",
      "stroke": null,
      "strokeWidth": 0,
      "glow": "#000000",
      "letterSpacing": 1,
      "uppercase": false,
      "wordsPerCue": 0,
      "anim": "fade"
    },
    {
      "id": "monolith",
      "name": "Monolith",
      "category": "🎥 Your Styles",
      "popularity": 83,
      "layout": "center",
      "keyword": false,
      "font": "Didot",
      "fallbackFonts": [
        "Playfair Display",
        "Georgia",
        "Times New Roman",
        "serif"
      ],
      "fontSize": 78,
      "fill": "#FFFFFF",
      "highlight": "#FFFFFF",
      "stroke": null,
      "strokeWidth": 0,
      "glow": "#000000",
      "letterSpacing": 1,
      "uppercase": true,
      "wordsPerCue": 2,
      "anim": "scale"
    },
    {
      "id": "cap-core",
      "name": "Core",
      "category": "🎥 Your Styles",
      "popularity": 99,
      "layout": "center",
      "keyword": false,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Poppins",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 68,
      "fill": "#FFFFFF",
      "highlight": "#FFE000",
      "highlightScale": 1.14,
      "stroke": "#000000",
      "strokeWidth": 6,
      "uppercase": false,
      "wordsPerCue": 3,
      "anim": "karaoke"
    },
    {
      "id": "cap-clarity",
      "name": "Crisp",
      "category": "🎥 Your Styles",
      "popularity": 92,
      "layout": "center",
      "keyword": false,
      "font": "Helvetica Neue",
      "fallbackFonts": [
        "Inter",
        "Helvetica",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 56,
      "fill": "#FFFFFF",
      "highlight": "#FFFFFF",
      "stroke": "#000000",
      "strokeWidth": 4,
      "uppercase": false,
      "wordsPerCue": 4,
      "anim": "fade"
    },
    {
      "id": "cap-hype",
      "name": "Surge",
      "category": "🎥 Your Styles",
      "popularity": 95,
      "layout": "center",
      "keyword": false,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Montserrat",
        "Poppins",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 70,
      "fill": "#FFFFFF",
      "highlight": "#22C55E",
      "highlightStyle": "box",
      "boxRadius": 16,
      "stroke": "#000000",
      "strokeWidth": 6,
      "uppercase": true,
      "wordsPerCue": 3,
      "anim": "karaoke"
    },
    {
      "id": "cap-aurora",
      "name": "Aurora",
      "category": "🎥 Your Styles",
      "popularity": 96,
      "layout": "center",
      "keyword": false,
      "highlightScale": 1.12,
      "font": "Avenir Next",
      "fallbackFonts": [
        "Outfit",
        "Poppins",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 64,
      "fill": "#FFFFFF",
      "fill2": "#B9C7FF",
      "highlight": "#7FE7FF",
      "highlightStyle": "color",
      "glow": "#0A1030",
      "glowBlur": 0.5,
      "stroke": null,
      "strokeWidth": 0,
      "boxColor": null,
      "upcomingOpacity": 0.55,
      "uppercase": false,
      "wordsPerCue": 3,
      "anim": "karaoke"
    },
    {
      "id": "cap-mono",
      "name": "Mono",
      "category": "🎥 Your Styles",
      "popularity": 91,
      "layout": "bottom",
      "keyword": false,
      "highlightScale": 1.05,
      "font": "Menlo",
      "fallbackFonts": [
        "JetBrains Mono",
        "Roboto Mono",
        "Space Mono",
        "Courier New",
        "sans-serif"
      ],
      "fontSize": 46,
      "fill": "#E6FBFF",
      "highlight": "#00F0FF",
      "highlightStyle": "color",
      "boxColor": "#0B1118",
      "boxRadius": 8,
      "boxOpacity": 0.92,
      "glow": null,
      "stroke": null,
      "strokeWidth": 0,
      "upcomingOpacity": 0.5,
      "uppercase": false,
      "wordsPerCue": 4,
      "anim": "karaoke"
    },
    {
      "id": "cap-card",
      "name": "Clean Card",
      "category": "🎥 Your Styles",
      "popularity": 93,
      "layout": "bottom",
      "keyword": false,
      "highlightScale": 1,
      "font": "Helvetica Neue",
      "fallbackFonts": [
        "Inter",
        "Helvetica",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 52,
      "fill": "#11151C",
      "highlight": "#2D7CFF",
      "highlightStyle": "color",
      "boxColor": "#FFFFFF",
      "boxRadius": 12,
      "boxOpacity": 0.96,
      "glow": null,
      "stroke": null,
      "strokeWidth": 0,
      "upcomingOpacity": 0.45,
      "uppercase": false,
      "wordsPerCue": 4,
      "anim": "karaoke"
    },
    {
      "id": "cap-studio",
      "name": "Studio",
      "category": "🎥 Your Styles",
      "popularity": 90,
      "layout": "bottom",
      "keyword": false,
      "highlightScale": 1.06,
      "font": "Helvetica Neue",
      "fallbackFonts": [
        "Manrope",
        "Inter",
        "Arial",
        "sans-serif"
      ],
      "fontSize": 54,
      "fill": "#FFFFFF",
      "highlight": "#FFC857",
      "highlightStyle": "color",
      "glow": "#000000",
      "glowBlur": 0.42,
      "stroke": null,
      "strokeWidth": 0,
      "boxColor": null,
      "upcomingOpacity": 0.55,
      "uppercase": false,
      "wordsPerCue": 4,
      "anim": "karaoke"
    },
    {
      "id": "pro-coolpop",
      "name": "Cool Pop",
      "category": "🎥 Your Styles",
      "popularity": 99,
      "layout": "center",
      "keyword": true,
      "wordHl": false,
      "highlightScale": 1.5,
      "font": "Arial Black",
      "fallbackFonts": [
        "Archivo Black",
        "Montserrat",
        "Poppins",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 62,
      "fill": "#FFFFFF",
      "fill2": "#D2D7DE",
      "highlight": "#BFE3FF",
      "highlight2": "#1E63E6",
      "highlightStyle": "color",
      "glossy": true,
      "stroke": "#06101A",
      "strokeWidth": 5,
      "glow": "#000000",
      "glowBlur": 0.5,
      "weight": 900,
      "uppercase": false,
      "wordsPerLine": 3,
      "wordsPerCue": 6,
      "lineGap": 1.04,
      "build": true,
      "anim": "pop"
    },
    {
      "id": "pro-cleanbold",
      "name": "Clean Bold",
      "category": "🎥 Your Styles",
      "popularity": 98,
      "layout": "center",
      "keyword": true,
      "wordHl": false,
      "highlightScale": 1.5,
      "font": "Arial Black",
      "fallbackFonts": [
        "Archivo Black",
        "Montserrat",
        "Poppins",
        "Arial Black",
        "sans-serif"
      ],
      "fontSize": 62,
      "fill": "#FFFFFF",
      "fill2": "#CED2D8",
      "highlight": "#FFFFFF",
      "highlightStyle": "color",
      "glow": "#000000",
      "glowBlur": 0.45,
      "stroke": null,
      "strokeWidth": 0,
      "boxColor": null,
      "weight": 900,
      "uppercase": false,
      "wordsPerLine": 3,
      "wordsPerCue": 6,
      "lineGap": 1.04,
      "build": true,
      "anim": "pop"
    }
  ];
  CREATOR_PACK.forEach(function (t) { TEMPLATES.push(t); });

  // ---- gallery reorganisation ------------------------------------------------
  // Every existing style keeps its id (saved looks, recents and favourites are
  // keyed by id); only its chip — and two names that were a creator's name and
  // a trademark — change. [home, cross-listed…]
  var _T = '🔥 Trending', _B = '💥 Bold & Viral', _K = '🎤 Karaoke', _P = '🎙️ Podcast',
      _M = '✨ Minimal & Clean', _C = '🎬 Cinematic & Editorial', _N = '🌈 Neon & Glow',
      _F = '😂 Fun & Meme', _H = CAT_HINDI, _MV = '🎬 From My Videos', _YS = '🎥 Your Styles', _BT = '🔘 Buttons';
  var RECAT = {
    hormozi: [_B, _T], karaoke: [_K], minimal: [_M, _P], typewriter: [_C], impact: [_B], lift: [_P],
    chalk: [_F], y2k: [_N], elevate: [_C], quotepill: [_C], 'cap-motiv': [_F, _B], 'cap-pastel': [_K],
    'cap-editorial': [_C], 'cap-ticker': [_P], 'cap-clean-sub': [_M, _P],
    // the two former ⭐ Premium headline looks now head 🔥 Trending
    'pro-boldpop': [_T, _B], 'pro-editorial': [_T, _C],
    'pack-orange-word-pop': [_MV, _K], 'pack-script-glow': [_MV, _C],
    'pack-neon': [_YS, _N], 'pro-spotlight': [_YS, _K], 'pro-subs-light': [_YS, _M], 'pro-clean-glow': [_YS, _M],
    'pro-karaokebar': [_YS, _K, _P], 'pro-pulse': [_YS, _K], 'pro-thuban': [_YS, _K], 'pro-runway': [_YS, _K],
    'pro-evo': [_YS, _M], 'pro-nova': [_YS, _B], 'pro-andromeda': [_YS, _P], 'pro-elevate': [_YS, _C],
    'v1-beast': [_YS, _B], prime: [_YS, _B], focus: [_YS, _K], volt: [_YS, _B], rocket: [_YS, _K],
    mars: [_YS, _B], ember: [_YS, _C], 'pack-cinema': [_YS, _C], align: [_YS, _C], prism: [_YS, _B],
    stack: [_YS, _M], kai: [_YS, _B], linen: [_YS, _C], monolith: [_YS, _C], 'cap-core': [_YS, _K],
    'cap-clarity': [_YS, _M], 'cap-hype': [_YS, _K], 'cap-aurora': [_YS, _N], 'cap-mono': [_YS, _N],
    'cap-card': [_YS, _M, _P], 'cap-studio': [_YS, _P], 'pro-coolpop': [_YS, _B], 'pro-cleanbold': [_YS, _B]
  };
  var RENAME = { 'v1-beast': 'Red Punch Caps', 'btn-spotify': 'Green Pill' };
  /* Near-duplicate Buttons: each has the same face, box shape and box effects
     as the one it points at, so it differs only by what the editor changes in
     one tap (colours, gradient on/off, border, weight, exact roundness).
     Hidden from browsing, NOT deleted — a saved look, a favourite or a recent
     that points at one still opens it. */
  var GALLERY_HIDDEN = {
    'btn-twitter': 'btn-blue',     // solid sky pill = Basic Blue without its gradient
    'btn-figma':   'btn-twitch',   // radius-16 chip, only the colour differs
    'btn-google':  'btn-twitch',   // radius-26 chip, colour + weight differ
    'btn-3dred':   'btn-pop3d',    // extruded pill + a border
    'btn-bios':    'btn-pixel'     // square mono box with a border
  };
  TEMPLATES.forEach(function (t) {
    var rc = RECAT[t.id];
    if (!rc && t.category === _BT) rc = [_BT];
    if (rc) { t.category = rc[0]; t.alsoIn = rc.slice(1); }
    if (RENAME[t.id]) t.name = RENAME[t.id];
    if (GALLERY_HIDDEN[t.id]) { t.galleryHidden = true; t.dupOf = GALLERY_HIDDEN[t.id]; }
  });

  /* Fallback chains. A Latin display face has no Devanagari, so every chain
     names a Devanagari face that suits the look (loaded from Google Fonts)
     and the system Devanagari faces (macOS, Windows) after it. The Latin
     system face comes FIRST so Latin letters never fall into a Devanagari
     family's Latin glyphs; Devanagari skips the Latin faces (they have none)
     and lands on the matching Devanagari design. */
  var DEVA_SYSTEM = ['Kohinoor Devanagari', 'Nirmala UI'];
  function devaChain(latin, deva, generic) {
    return (latin || []).concat(deva ? [deva] : [], DEVA_SYSTEM, [generic || 'sans-serif']);
  }

  /* ---- Pulse twins of the bundled caption .mogrt looks ----------------------
     The five caption templates shipped in mogrts/ (plus the Flux caption) only
     expose the few colours their designer wired up. Each twin is the SAME look
     — colours and face read from that template's own definition.json — drawn
     by Pulse, so it opens the full editor: outline, glow, highlight look,
     animation, position, everything. The .mogrt originals stay available under
     "Premiere templates · advanced". */
  var TWIN_TEMPLATES = [
    // Subtitle_2.mogrt: Poppins-SemiBold, Text #000000 on a #FFFFFF BG (roundness 30), no word highlight
    { id: 'twin-plain-subtitle', name: 'Plain Subtitle', category: _M, alsoIn: [_P], twinOf: 'Subtitle_2.mogrt',
      popularity: 86, layout: 'center', keyword: false, wordHl: false,
      font: 'Poppins', weight: 600, fallbackFonts: devaChain(['Arial'], 'Mukta'),
      fontSize: 56, fill: '#000000', highlight: '#000000', stroke: null, strokeWidth: 0,
      boxColor: '#FFFFFF', boxOpacity: 1, boxRadius: 30, boxPad: 1.2,
      uppercase: false, wordsPerCue: 4, anim: 'fade' },
    // Subtitle_1.mogrt: Arvo, Text #FFFAFA, Highlighted Word #FF0000, BG #000000 @60%, square bar
    { id: 'twin-word-highlight', name: 'Word Highlight', category: _P, alsoIn: [_K], twinOf: 'Subtitle_1.mogrt',
      popularity: 88, layout: 'center', keyword: false,
      font: 'Arvo', weight: 400, fallbackFonts: devaChain(['Rockwell', 'Georgia'], 'Tiro Devanagari Hindi', 'serif'),
      fontSize: 60, fill: '#FFFAFA', highlight: '#FF0000', stroke: null, strokeWidth: 0,
      boxColor: '#000000', boxOpacity: 0.6, boxRadius: 2, boxPad: 1.3,
      uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Subtitle_3.mogrt: Inter-SemiBold, Text #FFFFFF, Highlighted Word #29FF00 at 120%, BG #000000 (roundness 40)
    { id: 'twin-word-pop', name: 'Word Pop', category: _K, twinOf: 'Subtitle_3.mogrt',
      popularity: 88, layout: 'center', keyword: false, highlightScale: 1.2,
      font: 'Inter', weight: 600, fallbackFonts: devaChain(['Arial'], 'Mukta'),
      fontSize: 60, fill: '#FFFFFF', highlight: '#29FF00', stroke: null, strokeWidth: 0,
      boxColor: '#000000', boxOpacity: 1, boxRadius: 40, boxPad: 1.1,
      uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Subtitle_5.mogrt: SpaceMono-Bold, Text #FFFFFF, a #78FDBA box behind the spoken word, drop shadow 50%
    { id: 'twin-active-box', name: 'Active-Word Box', category: _K, twinOf: 'Subtitle_5.mogrt',
      popularity: 87, layout: 'center', keyword: false,
      font: 'Space Mono', weight: 700, fallbackFonts: devaChain(['Courier New'], 'Mukta', 'monospace'),
      fontSize: 54, fill: '#FFFFFF', highlight: '#78FDBA', highlightStyle: 'box', boxRadius: 10,
      stroke: null, strokeWidth: 0, glow: '#000000', glowBlur: 0.25, shadowDX: 5, shadowDY: 5,
      uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Subtitle_4_r3.mogrt: Inter-SemiBold, Text #FFFFFF, highlight gradient #CC00FF → #0018FF, BG #000000
    { id: 'twin-gradient-highlight', name: 'Gradient Highlight', category: _N, alsoIn: [_K], twinOf: 'Subtitle_4_r3.mogrt',
      popularity: 86, layout: 'center', keyword: false,
      font: 'Inter', weight: 600, fallbackFonts: devaChain(['Arial'], 'Mukta'),
      fontSize: 60, fill: '#FFFFFF', highlight: '#CC00FF', highlight2: '#0018FF', stroke: null, strokeWidth: 0,
      boxColor: '#000000', boxOpacity: 1, boxRadius: 2, boxPad: 1.2,
      uppercase: false, wordsPerCue: 4, anim: 'karaoke' },
    // Flux_Halo2_r3.mogrt: Inter-SemiBold, Text #FFFFFF, Highlighted Word #C5FF00, BG #003CFF
    { id: 'twin-flux-halo', name: 'Halo Box', category: _K, alsoIn: [_B], twinOf: 'Flux_Halo2_r3.mogrt',
      popularity: 89, layout: 'center', keyword: false,
      font: 'Inter', weight: 600, fallbackFonts: devaChain(['Arial'], 'Mukta'),
      fontSize: 62, fill: '#FFFFFF', highlight: '#C5FF00', stroke: null, strokeWidth: 0,
      boxColor: '#003CFF', boxOpacity: 1, boxRadius: 2, boxPad: 1.2,
      uppercase: false, wordsPerCue: 4, anim: 'karaoke' }
  ];
  TWIN_TEMPLATES.forEach(function (t) { TEMPLATES.push(t); });

  /* Devanagari-first faces draw BOTH scripts themselves (Hinglish lines stay in
     one family); offline, the system Devanagari faces also carry Latin. */
  function devaFirstChain(extra, generic) {
    return (extra || []).concat(DEVA_SYSTEM, ['Arial', generic || 'sans-serif']);
  }

  /* ---- Trending library -----------------------------------------------------
     48 looks from the 2025-26 short-form research (52 specs; see NOT BUILT
     below), each built ONLY from what the renderer already draws: word colour /
     Pill / Bar / Underline highlight, gradient fill, glow + offset shadow,
     box + border + 3D edge, dim-until-spoken, a different face for the spoken
     word, stacked lines — and only the engine's existing animations (pop,
     pop-scale, bounce, zoom, slide, wave, glitch, fade, reveal, karaoke,
     typewriter). Names describe the look — never a creator, a brand or a font.
     An offset "hard" shadow keeps a little blur (0.06–0.08): editable (.mogrt)
     captions can only draw the shadow as a centred halo, and a 0-blur halo is
     invisible there.
     NOT BUILT: "Behind-Subject Hook" (needs person segmentation to put the text
     behind the speaker — nothing in the renderer can do that); "Weight-Shift
     Lowercase" (the spoken word would switch weight through the keyword-face
     control, which the editor labels "italic serif"); "Emoji Pop Caps" (its
     identity is a per-keyword emoji — without it, it duplicates Punch Caps
     Gold; the ✨ Auto-emoji switch covers emoji); "Aftershock Shake" (the same
     as Condensed Slam in everything the editor cannot change). */
  var MONT = function (deva) { return devaChain(['Arial Black'], deva || 'Mukta'); };
  var TRENDING_TEMPLATES = [
    // ---- 🔥 / 💥 bold word-by-word caps ----
    // The spoken word is METALLIC gold (bright band, darker gold edges). With
    // a flat yellow it drew exactly like Bold Statement, and both sit in the
    // same two chips. The flat colour (the editable sweep) stays clear of white.
    { id: 'tr-punch-gold', name: 'Punch Caps Gold', category: _T, alsoIn: [_B], popularity: 99, layout: 'center', posPct: 62,
      font: 'Montserrat', weight: 900, fallbackFonts: MONT(), fontSize: 96, fill: '#FFFFFF', highlight: '#FFD75E', highlightScale: 1.15,
      highlight2: '#B8860B', glossy: true,
      stroke: '#000000', strokeWidth: 10, glow: '#000000', glowBlur: 0.08, shadowDY: 7,
      uppercase: true, wordsPerCue: 2, anim: 'pop-scale', keyword: false },
    { id: 'tr-tritone', name: 'Tri-Tone Caps', category: _B, alsoIn: [_T], popularity: 95, layout: 'center',
      font: 'Montserrat', weight: 900, fallbackFonts: MONT(), fontSize: 86, fill: '#FFFFFF', highlight: '#22E55B', highlightScale: 1.1,
      numberColor: '#FFE500', stroke: '#000000', strokeWidth: 9,
      uppercase: true, wordsPerCue: 3, anim: 'pop', keyword: false },
    { id: 'tr-purple-plate', name: 'Purple Active Plate', category: _T, alsoIn: [_K], popularity: 98, layout: 'center',
      font: 'Montserrat', weight: 800, fallbackFonts: MONT(), fontSize: 80, fill: '#FFFFFF', highlight: '#7C3AED', highlightStyle: 'box', boxRadius: 14,
      stroke: '#000000', strokeWidth: 5, uppercase: true, wordsPerCue: 3, anim: 'karaoke', keyword: false },
    { id: 'tr-comic-burst', name: 'Comic Burst', category: _F, alsoIn: [_B], popularity: 92, layout: 'center',
      font: 'Bangers', weight: 400, fallbackFonts: devaChain(['Impact'], 'Baloo 2'), fontSize: 100, fill: '#FFFFFF', highlight: '#FFD400', highlightScale: 1.15,
      stroke: '#000000', strokeWidth: 12, glow: '#000000', glowBlur: 0.08, shadowDY: 8,
      uppercase: true, wordsPerCue: 2, anim: 'bounce', keyword: false },
    { id: 'tr-sticker', name: 'Double-Stroke Sticker', category: _F, popularity: 90, layout: 'center',
      font: 'Luckiest Guy', weight: 400, fallbackFonts: devaChain(['Arial Black'], 'Baloo 2'), fontSize: 92, fill: '#FFFFFF', highlight: '#3BFF6A',
      stroke: '#000000', strokeWidth: 12, glow: '#FFFFFF', glowBlur: 0.12,
      uppercase: true, wordsPerCue: 2, anim: 'zoom', keyword: false },
    { id: 'tr-slam', name: 'Condensed Slam', category: _T, alsoIn: [_B], popularity: 97, layout: 'center',
      font: 'Anton', weight: 400, fallbackFonts: devaChain(['Impact'], 'Teko'), fontSize: 110, fill: '#FFFFFF', highlight: '#FF2E4D', highlightScale: 1.15,
      stroke: '#000000', strokeWidth: 8, uppercase: true, wordsPerCue: 2, anim: 'zoom', keyword: false },
    { id: 'tr-poster', name: 'Tall Poster', category: _B, popularity: 91, layout: 'center',
      font: 'Bebas Neue', weight: 400, fallbackFonts: devaChain(['Impact'], 'Teko'), fontSize: 110, fill: '#FFFFFF', highlight: '#FFE600',
      letterSpacing: 2, glow: '#000000', glowBlur: 0.45, shadowDY: 8, stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 2, anim: 'pop', keyword: false },
    { id: 'tr-ghost-solid', name: 'Ghost to Solid', category: _B, popularity: 88, layout: 'center',
      font: 'Archivo Black', weight: 400, fallbackFonts: devaChain(['Arial Black'], 'Baloo 2'), fontSize: 82, fill: '#FFFFFF', highlight: '#FFFFFF',
      upcomingOpacity: 0.35, stroke: '#FFFFFF', strokeWidth: 2, glow: '#000000', glowBlur: 0.4, shadowDY: 5,
      uppercase: true, wordsPerCue: 3, anim: 'pop', keyword: false },
    { id: 'tr-extrude', name: '3D Extrude', category: _B, alsoIn: [_F], popularity: 90, layout: 'center',
      font: 'Archivo Black', weight: 400, fallbackFonts: devaChain(['Arial Black'], 'Baloo 2'), fontSize: 96, fill: '#FFFFFF', highlight: '#FFE600', highlightScale: 1.1,
      stroke: '#000000', strokeWidth: 6, glow: '#FF3B30', glowBlur: 0.06, shadowDX: 0, shadowDY: 9,
      uppercase: true, wordsPerCue: 2, anim: 'bounce', keyword: false },
    { id: 'tr-two-tone-stack', name: 'Two-Tone Stack', category: _T, alsoIn: [_B], popularity: 96, layout: 'center',
      font: 'Montserrat', weight: 900, fallbackFonts: MONT(), fontSize: 80, fill: '#FFFFFF', highlight: '#FFD400', highlightScale: 1.3,
      stroke: '#000000', strokeWidth: 8, wordsPerLine: 2, lineGap: 1.05,
      uppercase: true, wordsPerCue: 4, anim: 'slide', keyword: false },
    { id: 'tr-kinetic', name: 'Kinetic Size Pop', category: _B, popularity: 89, layout: 'center',
      font: 'Poppins', weight: 900, fallbackFonts: devaChain(['Arial Black'], 'Mukta'), fontSize: 76, fill: '#FFFFFF', highlight: '#00E0FF', highlightScale: 1.5,
      align: 'left', glow: '#000000', glowBlur: 0.4, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'zoom', keyword: false },
    { id: 'tr-sunset', name: 'Sunset Gradient', category: _B, alsoIn: [_N], popularity: 90, layout: 'center',
      font: 'Poppins', weight: 900, fallbackFonts: devaChain(['Arial Black'], 'Mukta'), fontSize: 88, fill: '#FF7A18', fill2: '#FF3D77', highlight: '#FFFFFF',
      stroke: '#1A0B2E', strokeWidth: 7, uppercase: true, wordsPerCue: 2, anim: 'pop-scale', keyword: false },
    // ---- 🎤 karaoke / highlight looks ----
    { id: 'tr-dim-bright', name: 'Dim-to-Bright', category: _T, alsoIn: [_K], popularity: 98, layout: 'bottom', posPct: 70,
      font: 'Montserrat', weight: 800, fallbackFonts: MONT(), fontSize: 70, fill: '#FFFFFF', highlight: '#FFFFFF', highlightScale: 1.06,
      upcomingOpacity: 0.45, stroke: '#000000', strokeWidth: 5, maxLines: 2,
      uppercase: false, wordsPerCue: 4, anim: 'karaoke', keyword: false },
    { id: 'tr-yellow-wipe', name: 'Yellow Wipe', category: _K, alsoIn: [_T], popularity: 95, layout: 'bottom', posPct: 72,
      font: 'Poppins', weight: 800, fallbackFonts: devaChain(['Arial Black'], 'Mukta'), fontSize: 76, fill: '#FFFFFF', highlight: '#FFD60A',
      stroke: '#000000', strokeWidth: 6, glow: '#000000', glowBlur: 0.08, shadowDY: 4,
      uppercase: false, wordsPerCue: 3, anim: 'karaoke', keyword: false },
    { id: 'tr-highlighter', name: 'Highlighter Swipe', category: _T, alsoIn: [_K], popularity: 97, layout: 'bottom', posPct: 72,
      font: 'Inter', weight: 800, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 68, fill: '#FFFFFF', highlight: '#FFE14D', highlightStyle: 'bar',
      stroke: '#000000', strokeWidth: 5, uppercase: false, wordsPerCue: 3, anim: 'karaoke', keyword: false },
    { id: 'tr-acid-lime', name: 'Acid Lime Box', category: _T, alsoIn: [_K], popularity: 96, layout: 'bottom', posPct: 72,
      font: 'Space Grotesk', weight: 700, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 68, fill: '#FFFFFF', highlight: '#C6FF00', highlightStyle: 'box', boxRadius: 8,
      stroke: '#000000', strokeWidth: 4, textCase: 'lower', uppercase: false, wordsPerCue: 3, anim: 'karaoke', keyword: false },
    { id: 'tr-underline', name: 'Underline Sweep', category: _K, popularity: 90, layout: 'bottom', posPct: 74,
      font: 'Space Grotesk', weight: 700, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 64, fill: '#FFFFFF', highlight: '#FF5C39', highlightStyle: 'underline',
      stroke: '#000000', strokeWidth: 4, uppercase: false, wordsPerCue: 4, anim: 'reveal', keyword: false },
    // ---- 🎙️ podcast ----
    { id: 'tr-podcast-bar', name: 'Podcast Dark Bar', category: _P, alsoIn: [_M], popularity: 94, layout: 'bottom', posPct: 78,
      font: 'Inter', weight: 700, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 56, fill: '#FFFFFF', highlight: '#FFC940',
      boxColor: '#000000', boxOpacity: 0.6, boxRadius: 16, boxPad: 1.1, stroke: null, strokeWidth: 0, maxLines: 2,
      uppercase: false, wordsPerCue: 5, anim: 'fade', keyword: false },
    { id: 'tr-two-speaker', name: 'Two-Speaker Talk', category: _P, popularity: 88, layout: 'bottom', posPct: 74, speaker: true,
      font: 'Montserrat', weight: 800, fallbackFonts: MONT(), fontSize: 70, fill: '#FFFFFF', highlight: '#FFD60A', highlightScale: 1.1,
      stroke: '#000000', strokeWidth: 6, uppercase: false, wordsPerCue: 3, anim: 'pop', keyword: false },
    { id: 'tr-news-bar', name: 'News Lower-Third', category: _P, popularity: 86, layout: 'bottom', posPct: 80,
      font: 'Inter', weight: 800, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 52, fill: '#FFFFFF', highlight: '#FFFFFF',
      boxColor: '#E10600', boxOpacity: 1, boxRadius: 2, boxPad: 1.2, stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 5, anim: 'slide', keyword: false },
    // ---- ✨ minimal & clean ----
    { id: 'tr-frosted', name: 'Smoked Glass Card', category: _M, popularity: 90, layout: 'bottom', posPct: 76,
      font: 'Inter', weight: 600, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 54, fill: '#FFFFFF', highlight: '#A7F3D0',
      boxColor: '#0B0B0B', boxOpacity: 0.45, boxRadius: 22, boxPad: 1.2, boxStroke: '#FFFFFF', boxStrokeWidth: 1,
      stroke: null, strokeWidth: 0, maxLines: 2, uppercase: false, wordsPerCue: 5, anim: 'slide', keyword: false },
    { id: 'tr-quiet-lower', name: 'Quiet Lowercase', category: _M, popularity: 87, layout: 'center',
      font: 'Inter', weight: 500, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 56, fill: '#FFFFFF', highlight: '#DCE8FF',
      upcomingOpacity: 0.5, glow: '#000000', glowBlur: 0.4, stroke: null, strokeWidth: 0,
      textCase: 'lower', uppercase: false, wordsPerCue: 3, anim: 'fade', keyword: false },
    { id: 'tr-soft-explainer', name: 'Soft Explainer', category: _M, popularity: 89, layout: 'bottom', posPct: 76,
      font: 'Poppins', weight: 700, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 64, fill: '#FFFFFF', highlight: '#7DD3FC',
      stroke: '#000000', strokeWidth: 4, glow: '#000000', glowBlur: 0.3,
      uppercase: false, wordsPerCue: 3, anim: 'pop', keyword: false },
    { id: 'tr-explainer-lower', name: 'Explainer Clean Lower', category: _M, alsoIn: [_H], popularity: 88, layout: 'bottom', posPct: 80,
      font: 'Poppins', weight: 600, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 56, fill: '#FFFFFF', highlight: '#FFB703', highlightStyle: 'underline',
      glow: '#000000', glowBlur: 0.45, stroke: null, strokeWidth: 0, maxLines: 2,
      uppercase: false, wordsPerCue: 5, anim: 'fade', keyword: false },
    // ---- 🎬 cinematic & editorial ----
    { id: 'tr-editorial-serif', name: 'Editorial Serif', category: _C, popularity: 92, layout: 'center',
      font: 'Playfair Display', weight: 600, fallbackFonts: devaChain(['Georgia'], 'Tiro Devanagari Hindi', 'serif'), fontSize: 68,
      fill: '#FFFFFF', highlight: '#F5D9A8', highlightFont: 'Playfair Display', highlightItalic: true, highlightWeight: 700,
      highlightFallbacks: 'Georgia, "Tiro Devanagari Hindi", "Kohinoor Devanagari", serif',
      glow: '#000000', glowBlur: 0.45, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 4, anim: 'reveal', keyword: false },
    { id: 'tr-serif-mix', name: 'Serif Keyword Mix', category: _T, alsoIn: [_C], popularity: 95, layout: 'center',
      font: 'Inter', weight: 700, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 70, fill: '#FFFFFF', highlight: '#FFD8A8', highlightScale: 1.2,
      highlightFont: 'DM Serif Display', highlightItalic: true, highlightWeight: 400,
      highlightFallbacks: 'Georgia, "Tiro Devanagari Hindi", "Kohinoor Devanagari", serif',
      glow: '#000000', glowBlur: 0.4, stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'slide', keyword: false },
    { id: 'tr-cinema-sub', name: 'Cinema Subtitle', category: _C, alsoIn: [_P], popularity: 89, layout: 'bottom', posPct: 80,
      font: 'EB Garamond', weight: 500, fallbackFonts: devaChain(['Georgia'], 'Tiro Devanagari Hindi', 'serif'), fontSize: 58,
      fill: '#E6E6E6', highlight: '#FFFFFF', upcomingOpacity: 0.6, glow: '#000000', glowBlur: 0.5, stroke: null, strokeWidth: 0, maxLines: 2,
      uppercase: false, wordsPerCue: 6, anim: 'fade', keyword: false },
    // 64, not 56: Syne's capitals are short (0.65 of the font size), so at 56
    // this all-caps look drew the smallest caption in the gallery — its tile
    // read as a thin line of 7-pixel capitals (sim-preview-check: 6% of the
    // tile against 11% for its size, once the real Syne loaded).
    { id: 'tr-luxe-wide', name: 'Luxe Wide', category: _C, popularity: 87, layout: 'center',
      font: 'Syne', weight: 700, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 64, fill: '#FFFFFF', highlight: '#D9C9A3',
      letterSpacing: 6, glow: '#000000', glowBlur: 0.35, stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 2, anim: 'fade', keyword: false },
    // ---- 🌈 neon & glow ----
    { id: 'tr-neon-ignite', name: 'Neon Ignite', category: _T, alsoIn: [_N], popularity: 96, layout: 'center',
      font: 'Montserrat', weight: 800, fallbackFonts: MONT(), fontSize: 76, fill: '#E6FFFB', highlight: '#00F0FF',
      glow: '#00F0FF', glowBlur: 0.6, highlightGlow: '#00F0FF', stroke: null, strokeWidth: 0,
      uppercase: false, wordsPerCue: 3, anim: 'karaoke', keyword: false },
    { id: 'tr-magenta-night', name: 'Magenta Night', category: _N, popularity: 90, layout: 'center',
      font: 'Poppins', weight: 800, fallbackFonts: devaChain(['Arial Black'], 'Mukta'), fontSize: 82, fill: '#FFFFFF', highlight: '#FF2BD6',
      glow: '#FF2BD6', glowBlur: 0.55, highlightGlow: '#FF2BD6', stroke: null, strokeWidth: 0,
      uppercase: true, wordsPerCue: 2, anim: 'pop', keyword: false },
    { id: 'tr-chrome', name: 'Chrome Y2K', category: _N, popularity: 88, layout: 'center',
      font: 'Unbounded', weight: 800, fallbackFonts: devaChain(['Arial Black'], 'Baloo 2'), fontSize: 80, fill: '#FFFFFF', fill2: '#9AA4B2', highlight: '#7DF9FF',
      glow: '#7DF9FF', glowBlur: 0.4, stroke: '#0B0B0B', strokeWidth: 5,
      uppercase: true, wordsPerCue: 2, anim: 'zoom', keyword: false },
    { id: 'tr-terminal', name: 'Terminal Typewriter', category: _N, alsoIn: [_C], popularity: 87, layout: 'bottom', posPct: 78,
      font: 'Space Mono', weight: 700, fallbackFonts: devaChain(['Courier New'], 'Mukta', 'monospace'), fontSize: 52, fill: '#EDEDED', highlight: '#39FF14',
      boxColor: '#000000', boxOpacity: 0.75, boxRadius: 6, boxPad: 1.1, stroke: null, strokeWidth: 0, maxLines: 2,
      uppercase: false, wordsPerCue: 6, anim: 'typewriter', keyword: false },
    { id: 'tr-rgb-glitch', name: 'RGB Glitch', category: _N, alsoIn: [_F], popularity: 89, layout: 'center',
      font: 'Space Grotesk', weight: 700, fallbackFonts: devaChain(['Arial'], 'Mukta'), fontSize: 90, fill: '#FFFFFF', highlight: '#FFFFFF',
      stroke: '#FF0040', strokeWidth: 3, glow: '#00E5FF', glowBlur: 0.06, shadowDX: 5, shadowDY: 0,
      uppercase: true, wordsPerCue: 2, anim: 'glitch', keyword: false },
    // ---- 😂 fun & meme ----
    { id: 'tr-hard-sticker', name: 'Hard Shadow Sticker', category: _F, popularity: 90, layout: 'center',
      font: 'Rubik', weight: 900, fallbackFonts: devaChain(['Arial Black'], 'Baloo 2'), fontSize: 86, fill: '#FFFFFF', highlight: '#FFB800',
      stroke: '#000000', strokeWidth: 6, glow: '#000000', glowBlur: 0.08, shadowDX: 7, shadowDY: 7,
      uppercase: true, wordsPerCue: 2, anim: 'pop', keyword: false },
    { id: 'tr-marker', name: 'Marker Scribble', category: _F, popularity: 88, layout: 'center',
      font: 'Permanent Marker', weight: 400, fallbackFonts: devaChain(['Marker Felt', 'Comic Sans MS'], 'Kalam', 'cursive'), fontSize: 80, fill: '#FFFFFF', highlight: '#FF4D4D',
      highlightStyle: 'underline', stroke: '#000000', strokeWidth: 4,
      uppercase: false, wordsPerCue: 2, anim: 'pop', keyword: false },
    { id: 'tr-meme', name: 'Top Text Meme', category: _F, popularity: 86, layout: 'top',
      font: 'Anton', weight: 400, fallbackFonts: devaChain(['Impact'], 'Teko'), fontSize: 80, fill: '#FFFFFF', highlight: '#FFFFFF',
      stroke: '#000000', strokeWidth: 10, maxLines: 2, uppercase: true, wordsPerCue: 6, anim: 'pop', keyword: false },
    { id: 'tr-speech-bubble', name: 'Comic Speech Bubble', category: _F, popularity: 87, layout: 'top',
      font: 'Bangers', weight: 400, fallbackFonts: devaChain(['Impact'], 'Baloo 2'), fontSize: 72, fill: '#111111', highlight: '#E4002B',
      boxColor: '#FFFFFF', boxOpacity: 1, boxRadius: 28, boxPad: 1.2, boxStroke: '#111111', boxStrokeWidth: 5,
      stroke: null, strokeWidth: 0, uppercase: true, wordsPerCue: 3, anim: 'bounce', keyword: false },
    { id: 'tr-letter-wave', name: 'Letter Wave', category: _F, popularity: 86, layout: 'center',
      font: 'Rubik', weight: 800, fallbackFonts: devaChain(['Arial Black'], 'Baloo 2'), fontSize: 82, fill: '#FFFFFF', highlight: '#7CF3FF',
      stroke: '#0B1A3A', strokeWidth: 7, uppercase: false, wordsPerCue: 2, anim: 'wave', keyword: false },
    // ---- 🔘 a button look ----
    { id: 'tr-push-button', name: '3D Push Button', category: _BT, popularity: 90, layout: 'center',
      font: 'Poppins', weight: 800, fallbackFonts: devaChain(['Arial Black'], 'Mukta'), fontSize: 64, fill: '#111111', highlight: '#111111', highlightScale: 1.12,
      boxColor: '#FFE600', boxOpacity: 1, boxRadius: 18, boxPad: 1.3, box3d: '#C9A800', box3dDepth: 8,
      stroke: null, strokeWidth: 0, maxLines: 1, maxWidthPct: 0.9,
      uppercase: false, wordsPerCue: 2, anim: 'pop-scale', keyword: false },
    // ---- 🇮🇳 Devanagari-first (the face itself draws Hindi AND English) ----
    { id: 'tr-desi-punch', name: 'Desi Punch', category: _H, alsoIn: [_T, _B], script: 'deva', popularity: 97, layout: 'center',
      font: 'Baloo 2', weight: 800, fallbackFonts: devaFirstChain(['Mukta']), fontSize: 84, fill: '#FFFFFF', highlight: '#FFD000', highlightScale: 1.12,
      stroke: '#000000', strokeWidth: 6, letterSpacing: 0, lineGap: 1.4,
      uppercase: false, wordsPerCue: 2, anim: 'pop-scale', keyword: false },
    { id: 'tr-bubble-pop', name: 'Bubble Pop Rounded', category: _H, alsoIn: [_F], script: 'deva', popularity: 93, layout: 'center',
      font: 'Baloo 2', weight: 800, fallbackFonts: devaFirstChain(['Mukta']), fontSize: 84, fill: '#FFFFFF', highlight: '#FF6FB5',
      stroke: '#3A0CA3', strokeWidth: 7, lineGap: 1.35, uppercase: false, wordsPerCue: 2, anim: 'bounce', keyword: false },
    { id: 'tr-hindi-podcast', name: 'Hindi Podcast Bar', category: _H, alsoIn: [_P], script: 'deva', popularity: 95, layout: 'bottom', posPct: 74,
      font: 'Mukta', weight: 700, fallbackFonts: devaFirstChain(['Hind']), fontSize: 60, fill: '#FFFFFF', highlight: '#FFC940',
      boxColor: '#000000', boxOpacity: 0.55, boxRadius: 14, boxPad: 1.15, upcomingOpacity: 0.5, lineGap: 1.3, maxLines: 2,
      stroke: null, strokeWidth: 0, uppercase: false, wordsPerCue: 4, anim: 'karaoke', keyword: false },
    { id: 'tr-hinglish-flip', name: 'Hinglish Flip', category: _H, script: 'deva', popularity: 92, layout: 'center',
      font: 'Hind', weight: 700, fallbackFonts: devaFirstChain(['Mukta']), fontSize: 76, fill: '#FFFFFF', highlight: '#FFD60A', highlightScale: 1.1,
      stroke: '#000000', strokeWidth: 6, lineGap: 1.3, uppercase: false, wordsPerCue: 3, anim: 'pop', keyword: false },
    { id: 'tr-rozha-saffron', name: 'Saffron Title', category: _H, alsoIn: [_C], script: 'deva', popularity: 90, layout: 'center',
      font: 'Rozha One', weight: 400, fallbackFonts: devaFirstChain(['Tiro Devanagari Hindi'], 'serif'), fontSize: 84, fill: '#FFF4E0', highlight: '#FF9933',
      glow: '#000000', glowBlur: 0.55, shadowDY: 4, stroke: null, strokeWidth: 0, lineGap: 1.3,
      uppercase: false, wordsPerCue: 2, anim: 'reveal', keyword: false },
    { id: 'tr-kalam', name: 'Handwritten Hindi', category: _H, alsoIn: [_F], script: 'deva', popularity: 89, layout: 'center',
      font: 'Kalam', weight: 700, fallbackFonts: devaFirstChain([], 'cursive'), fontSize: 78, fill: '#FFFFFF', highlight: '#FF5C8A',
      stroke: '#000000', strokeWidth: 4, lineGap: 1.4, uppercase: false, wordsPerCue: 3, anim: 'pop', keyword: false },
    { id: 'tr-teko-hype', name: 'Tall Hype', category: _H, alsoIn: [_B], script: 'deva', popularity: 91, layout: 'center',
      font: 'Teko', weight: 600, fallbackFonts: devaFirstChain(['Mukta']), fontSize: 110, fill: '#FFFFFF', highlight: '#00E676',
      stroke: '#000000', strokeWidth: 6, lineGap: 1.3, uppercase: true, wordsPerCue: 2, anim: 'zoom', keyword: false },
    { id: 'tr-tiro-doc', name: 'Documentary Serif', category: _H, alsoIn: [_C], script: 'deva', popularity: 88, layout: 'bottom', posPct: 80,
      font: 'Tiro Devanagari Hindi', weight: 400, fallbackFonts: devaFirstChain(['Georgia'], 'serif'), fontSize: 60, fill: '#E6E6E6', highlight: '#FFFFFF',
      upcomingOpacity: 0.6, glow: '#000000', glowBlur: 0.55, stroke: null, strokeWidth: 0, lineGap: 1.3, maxLines: 2,
      uppercase: false, wordsPerCue: 6, anim: 'fade', keyword: false },
    { id: 'tr-anek-box', name: 'Warm Word Box', category: _H, alsoIn: [_K], script: 'deva', popularity: 92, layout: 'bottom', posPct: 74,
      font: 'Anek Devanagari', weight: 700, fallbackFonts: devaFirstChain(['Mukta']), fontSize: 70, fill: '#FFFFFF', highlight: '#FF6B00', highlightStyle: 'box',
      boxRadius: 10, boxPad: 1.15, stroke: '#000000', strokeWidth: 4, lineGap: 1.3,
      uppercase: false, wordsPerCue: 3, anim: 'karaoke', keyword: false }
  ];
  TRENDING_TEMPLATES.forEach(function (t) { TEMPLATES.push(t); });

  /* FONT_SAFE, decided on purpose (independent review: on a Mac 34 of the 54
     new styles and 5 of the 6 .mogrt twins never drew their designed face —
     Anton and Bebas Neue became Impact, Bangers became Marker Felt, the Plain
     Subtitle twin Futura instead of Poppins).
     The remap exists for EDITABLE captions: Premiere draws those with its own
     text engine, which only has installed fonts. Pulse-rendered captions (the
     default, and the long-video overlay) are drawn by the panel itself, which
     loads the Google faces — so for them the designed face is the right one.
       · the 54 new styles (trending + twins) keep their designed face FIRST and
         put the Mac stand-in right after it: online it draws the designed
         face, offline the stand-in (exactly what the remap gave before);
       · the editable send swaps a face that is not installed for its stand-in
         (timelineFace below; main.js drawableFamily), and for Hindi words for
         an installed Devanagari face — Premiere cannot draw a missing font;
       · the older styles keep the remap as it was: the owner has used them
         with the Mac faces for months, and their tiles are what he knows. */
  var DESIGNED_FACE = {};
  TRENDING_TEMPLATES.concat(TWIN_TEMPLATES).forEach(function (t) { DESIGNED_FACE[t.id] = 1; });
  TEMPLATES.forEach(function (t) {
    var safe = FONT_SAFE[t.font];
    if (!safe) return;
    var fb;
    if (DESIGNED_FACE[t.id]) {
      fb = [safe].concat((t.fallbackFonts || []).filter(function (f) { return f !== safe; }));
      if (fb.indexOf('sans-serif') < 0 && fb.indexOf('serif') < 0 && fb.indexOf('monospace') < 0) fb.push('sans-serif');
      t.fallbackFonts = fb;
      return;
    }
    fb = [t.font].concat(t.fallbackFonts || []);
    if (fb.indexOf('sans-serif') < 0 && fb.indexOf('serif') < 0 && fb.indexOf('monospace') < 0) fb.push('sans-serif');
    t.fallbackFonts = fb;
    t.font = safe;
  });
  /* The installed Mac face that stands in for a Google face on the timeline
     (editable captions), or null. */
  function timelineFace(family) { return FONT_SAFE.hasOwnProperty(family) ? FONT_SAFE[family] : null; }
  /* Faces that ship with macOS. The panel's installed-font scan skips font
     files over 8 MB, and some macOS system collections are big, so on a Mac
     "not found by the scan" never means "not installed" for these. */
  var MAC_FACES = ['helvetica neue', 'helvetica', 'avenir next', 'avenir', 'futura', 'impact', 'arial', 'arial black',
    'arial narrow', 'menlo', 'monaco', 'courier new', 'courier', 'didot', 'marker felt', 'snell roundhand', 'trebuchet ms',
    'georgia', 'times new roman', 'times', 'verdana', 'tahoma', 'comic sans ms', 'bradley hand', 'palatino', 'gill sans',
    'optima', 'baskerville', 'rockwell', 'american typewriter', 'chalkboard se', 'noteworthy', 'kohinoor devanagari',
    'devanagari mt', 'itf devanagari'];
  function isMacFace(family) { return MAC_FACES.indexOf(String(family || '').toLowerCase()) >= 0; }

  /* Niche → recommended template id (the "AI Caption Styling" suggester). */
  var NICHE_RECOMMEND = {
    Podcast: 'lift', Business: 'lift', Finance: 'minimal', Education: 'lift',
    Fitness: 'impact', Motivation: 'hormozi', Gaming: 'impact', Tech: 'typewriter', Vlog: 'karaoke'
  };
  var NICHES = ['Podcast', 'Business', 'Finance', 'Education', 'Fitness', 'Motivation', 'Gaming', 'Tech', 'Vlog'];

  /* Curated font list for the customizer. First fallback keeps it readable
     if the chosen face is not installed on the editing machine. */
  var FONTS = [
    // Bold / display — the caption workhorses
    'Anton', 'Bebas Neue', 'Archivo Black', 'Oswald', 'Teko', 'Fjalla One',
    'Bangers', 'Luckiest Guy', 'Passion One', 'Alfa Slab One', 'Bungee', 'Titan One',
    'Impact', 'Arial Black',
    // Sans
    'Montserrat', 'Poppins', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Raleway',
    'Work Sans', 'Nunito', 'Rubik', 'DM Sans', 'Outfit', 'Sora', 'Barlow', 'Manrope',
    'Helvetica', 'Verdana', 'Tahoma', 'Futura',
    // System faces (ship with macOS/Windows — nothing to load; these are the
    // timeline-safe primaries the FONT_SAFE remap points styles at)
    'Helvetica Neue', 'Avenir Next', 'Arial Narrow', 'Trebuchet MS',
    'Menlo', 'Didot', 'Marker Felt', 'Snell Roundhand',
    // Serif
    'Playfair Display', 'Merriweather', 'Lora', 'Georgia', 'Times New Roman', 'Arvo',
    // Mono
    'JetBrains Mono', 'Roboto Mono', 'Space Mono', 'Courier New',
    // Handwriting / marker
    'Caveat', 'Permanent Marker', 'Shadows Into Light', 'Pacifico', 'Bradley Hand', 'Comic Sans MS',
    // Trending display faces (loaded from Google Fonts, see index.html)
    'Space Grotesk', 'Syne', 'Unbounded', 'DM Serif Display', 'EB Garamond',
    // Devanagari faces — each draws Hindi AND English, so Hinglish stays in one family
    'Baloo 2', 'Mukta', 'Hind', 'Anek Devanagari', 'Rozha One', 'Kalam', 'Tiro Devanagari Hindi'
  ];

  /*
   * ── PostScript font-name resolution ────────────────────────────────────
   * Premiere identifies a face inside a template's "source text" by its
   * POSTSCRIPT name ("BebasNeue-Regular"), never the family name pickers
   * show ("Bebas Neue"). Writing a family name is silently ignored — the
   * caption keeps the template's authored face ("not able to change the
   * fonts"). Three rules cover every picker:
   *   1. system faces whose PS names follow no pattern → exact table
   *   2. families that ship exactly ONE face → never ask for a Bold that
   *      doesn't exist (the write would be ignored again)
   *   3. everything else (all the Google faces) → StripSpaces + "-Weight"
   * A name that already looks PostScript ("Poppins-Light") passes through.
   */
  var PS_EXACT = {
    'arial':           { Regular: 'ArialMT', Bold: 'Arial-BoldMT', Italic: 'Arial-ItalicMT', BoldItalic: 'Arial-BoldItalicMT' },
    'arial black':     { Regular: 'Arial-Black' },
    'arial narrow':    { Regular: 'ArialNarrow', Bold: 'ArialNarrow-Bold', Italic: 'ArialNarrow-Italic', BoldItalic: 'ArialNarrow-BoldItalic' },
    'impact':          { Regular: 'Impact' },
    'times new roman': { Regular: 'TimesNewRomanPSMT', Bold: 'TimesNewRomanPS-BoldMT', Italic: 'TimesNewRomanPS-ItalicMT', BoldItalic: 'TimesNewRomanPS-BoldItalicMT' },
    'courier new':     { Regular: 'CourierNewPSMT', Bold: 'CourierNewPS-BoldMT', Italic: 'CourierNewPS-ItalicMT', BoldItalic: 'CourierNewPS-BoldItalicMT' },
    'comic sans ms':   { Regular: 'ComicSansMS', Bold: 'ComicSansMS-Bold' },
    'trebuchet ms':    { Regular: 'TrebuchetMS', Bold: 'TrebuchetMS-Bold', Italic: 'TrebuchetMS-Italic', BoldItalic: 'Trebuchet-BoldItalic' },
    'verdana':         { Regular: 'Verdana', Bold: 'Verdana-Bold', Italic: 'Verdana-Italic', BoldItalic: 'Verdana-BoldItalic' },
    'tahoma':          { Regular: 'Tahoma', Bold: 'Tahoma-Bold' },
    'georgia':         { Regular: 'Georgia', Bold: 'Georgia-Bold', Italic: 'Georgia-Italic', BoldItalic: 'Georgia-BoldItalic' },
    'helvetica':       { Regular: 'Helvetica', Bold: 'Helvetica-Bold', Italic: 'Helvetica-Oblique', BoldItalic: 'Helvetica-BoldOblique' },
    'helvetica neue':  { Regular: 'HelveticaNeue', Bold: 'HelveticaNeue-Bold', Medium: 'HelveticaNeue-Medium', Light: 'HelveticaNeue-Light', Italic: 'HelveticaNeue-Italic', BoldItalic: 'HelveticaNeue-BoldItalic' },
    'avenir next':     { Regular: 'AvenirNext-Regular', Medium: 'AvenirNext-Medium', SemiBold: 'AvenirNext-DemiBold', Bold: 'AvenirNext-Bold', Italic: 'AvenirNext-Italic', BoldItalic: 'AvenirNext-BoldItalic' },
    'menlo':           { Regular: 'Menlo-Regular', Bold: 'Menlo-Bold', Italic: 'Menlo-Italic', BoldItalic: 'Menlo-BoldItalic' },
    'didot':           { Regular: 'Didot', Bold: 'Didot-Bold', Italic: 'Didot-Italic' },
    'marker felt':     { Regular: 'MarkerFelt-Thin', Bold: 'MarkerFelt-Wide' },
    'snell roundhand': { Regular: 'SnellRoundhand', Bold: 'SnellRoundhand-Bold', Black: 'SnellRoundhand-Black' },
    'bradley hand':    { Regular: 'BradleyHandITCTT-Bold' },
    'futura':          { Regular: 'Futura-Medium', Medium: 'Futura-Medium', Bold: 'Futura-Bold', Italic: 'Futura-MediumItalic' }
  };
  /* Families that ship exactly one face — asking for "-Bold" would name a
     face that doesn't exist and Premiere would ignore the whole write. */
  var PS_SINGLE_FACE = {
    'anton': 1, 'bebas neue': 1, 'archivo black': 1, 'bangers': 1,
    'luckiest guy': 1, 'alfa slab one': 1, 'bungee': 1, 'titan one': 1,
    'permanent marker': 1, 'pacifico': 1, 'shadows into light': 1, 'fjalla one': 1,
    'rozha one': 1, 'dm serif display': 1, 'tiro devanagari hindi': 1
  };
  function psFontName(family, weight, italic) {
    var f = String(family == null ? '' : family).replace(/^\s+|\s+$/g, '');
    if (!f) return '';
    if (f.indexOf('-') !== -1 && f.indexOf(' ') === -1) return f;   // already PostScript-style
    var w = (weight === true) ? 'Bold' : (weight || 'Regular');
    if (w === false) w = 'Regular';
    var it = !!italic, key = f.toLowerCase();
    var ex = PS_EXACT[key];
    if (ex) {
      var name = null;
      if (it && ex[w + 'Italic']) name = ex[w + 'Italic'];
      else if (it && w === 'Regular' && ex.Italic) name = ex.Italic;
      if (!name) name = ex[w] || null;
      if (!name && w !== 'Regular') name = ex.Bold || null;   // closest heavy face this family has
      return name || ex.Regular;
    }
    var fam = f.replace(/\s+/g, '');
    if (PS_SINGLE_FACE[key]) return fam + '-Regular';
    var sfx = (w === 'Regular') ? (it ? 'Italic' : 'Regular') : (w + (it ? 'Italic' : ''));
    return fam + '-' + sfx;
  }
  /* True when a resolved name already IS a heavy face — the caller then skips
     the synthetic-bold flag (synthetic bold on top of a real Bold face renders
     smudged and over-thick). */
  function psIsBoldFace(ps) {
    return /bold|black|heavy|-wide$/i.test(String(ps || ''));
  }

  /*
   * Drop OVERLAPPING duplicate cues — the same words at nearly the same time
   * ("same text 2 times"). Sources: a linked clip mapped once per track copy,
   * chunked-cloud boundary overlap, and whisper's own repetition glitch.
   * A cue is a duplicate only when an earlier kept cue has the SAME text AND
   * their windows overlap (starts within `slack`) — a speaker legitimately
   * repeating a line later is never touched (no overlap). The kept cue's
   * window widens to cover both. opts.word uses tighter limits for per-word
   * cues (short words legitimately repeat often). Pure + tested.
   */
  function dedupeRepeatedCues(cues, opts) {
    if (!cues || !cues.length) return cues;
    opts = opts || {};
    var slack = opts.word ? 0.15 : 2.0;      // max start-to-start distance to count as "the same moment"
    var margin = opts.word ? 0.05 : 0.3;     // windows must overlap (or nearly touch) this closely
    function norm(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').replace(/^ | $/g, '').toLowerCase(); }
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i], cn = norm(c.text), dup = false;
      if (cn) {
        var back = Math.max(0, out.length - 4);          // duplicates land adjacent — check the last few
        for (var j = out.length - 1; j >= back; j--) {
          var p = out[j];
          if (norm(p.text) === cn && c.start < p.end + margin && Math.abs(c.start - p.start) <= slack) {
            if (c.end > p.end) p.end = c.end;            // keep the wider window
            dup = true; break;
          }
        }
      }
      if (!dup) out.push({ start: c.start, end: c.end, text: c.text });
    }
    return out;
  }

  /*
   * Merge a base preset with explicit user overrides into a flat style
   * object (absolute 1080p sizes — the renderer scales later). Empty/null
   * overrides fall back to the preset. Pure + tested.
   */
  function mergeStyle(preset, o) {
    o = o || {};
    preset = preset || {};   // a stale/removed preset id resolves to null — don't crash
    function has(k) { return o[k] !== undefined && o[k] !== null && o[k] !== ''; }
    return {
      font: has('font') ? o.font : preset.font,
      fallbackFonts: preset.fallbackFonts || [],
      fontSize: has('fontSize') ? o.fontSize : preset.fontSize,
      fill: has('fill') ? o.fill : preset.fill,
      highlight: has('highlight') ? o.highlight : (preset.highlight || '#FFD400'),
      stroke: (o.stroke !== undefined) ? o.stroke : (preset.stroke || null),
      strokeWidth: (o.strokeWidth != null) ? o.strokeWidth : (preset.strokeWidth || 0),
      boxColor: (o.boxColor !== undefined) ? o.boxColor : (preset.boxColor || null),
      boxRadius: (o.boxRadius != null) ? o.boxRadius : (preset.boxRadius || 10),
      glow: (o.glow !== undefined) ? o.glow : (preset.glow || null),
      letterSpacing: (o.letterSpacing != null) ? o.letterSpacing : (preset.letterSpacing || 0),
      highlightScale: (o.highlightScale != null) ? o.highlightScale : (preset.highlightScale || 1),
      highlightStyle: o.highlightStyle || preset.highlightStyle || 'color',
      uppercase: (o.uppercase != null) ? o.uppercase : !!preset.uppercase,
      yPct: (o.yPct != null) ? o.yPct : 0.76
    };
  }

  /*
   * The spoken-word colour for EDITABLE (.mogrt) captions. The template engine
   * can mark the spoken word only with a COLOUR, so a style whose highlight
   * equals its text colour (Pulse makes that word pop by SIZE, which the engine
   * cannot do) needs a colour of its own. The old rule forced #FFD400 on all of
   * them — a yellow word on a yellow (Mars), gold (Gold Gloss) or pastel (Aura)
   * pill measured 1.1:1 contrast, i.e. invisible. Now: keep the style's own
   * highlight when it already differs from the text; otherwise take the first
   * candidate that looks different from the text AND reads at >= 3:1 on the
   * style's box (anything reads over footage when there is no box — the text's
   * own outline/shadow carries it). Pure + tested.
   *
   * NEVER NEAR-BLACK. On the owner's Mac the editable (Flux Halo) engine drew
   * NO visible text for the styles with dark text on a light box. What inside
   * the template causes it is unknown; dark colours are the common factor. So
   * until a test on that Mac clears them, no colour darker than SWEEP_MIN_LUM
   * is sent as the spoken-word colour: #111111 was a candidate here (Green
   * Pill, Candy, Sky and Chip got it), and a designed near-black highlight is
   * lifted toward white just enough to leave the danger zone, keeping its hue
   * (or, if that makes it look like the text, replaced by a candidate). On a
   * mid-tone box (Green Pill's green) no colour that is not near-black reaches
   * 3:1, so the best-reading one is used.
   */
  var SWEEP_CANDIDATES = ['#FFD400', '#00E0FF', '#FF3B6B', '#2D7CFF', '#7C3AED', '#E10600', '#FFFFFF'];
  var SWEEP_MIN_LUM = 0.1;
  function _hexRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function _relLum(h) {
    var c = _hexRgb(h); if (!c) return 0;
    var l = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  }
  function contrastRatio(a, b) {
    var la = _relLum(a), lb = _relLum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function _rgbDist(a, b) {
    var x = _hexRgb(a), y = _hexRgb(b);
    if (!x || !y) return 999;
    return Math.sqrt(Math.pow(x[0] - y[0], 2) + Math.pow(x[1] - y[1], 2) + Math.pow(x[2] - y[2], 2));
  }
  /* `hex` moved toward white (t > 0) or black (t < 0) by |t| (0..1). */
  function shadeHex(hex, t) {
    var c = _hexRgb(hex); if (!c) return hex;
    var to = t >= 0 ? 255 : 0, a = Math.min(1, Math.abs(t));
    function h(v) { v = Math.round(v + (to - v) * a); var s = v.toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }
  /* Luminance below SWEEP_MIN_LUM (#111111, dark navy, pure blue…). */
  function isNearBlack(h) { return !!_hexRgb(h) && _relLum(h) < SWEEP_MIN_LUM; }
  /* A near-black colour moved toward white just enough to leave near-black
     (same hue); any other colour, or a non-hex value, comes back unchanged. */
  function liftDark(hex) {
    if (!isNearBlack(hex)) return hex;
    var lo = 0, hi = 1;
    for (var i = 0; i < 14; i++) {
      var mid = (lo + hi) / 2;
      if (_relLum(shadeHex(hex, mid)) >= SWEEP_MIN_LUM) hi = mid; else lo = mid;
    }
    return shadeHex(hex, hi);
  }
  function sweepColor(fill, highlight, box) {
    var f = String(fill || '#FFFFFF');
    if (highlight && String(highlight).toLowerCase() !== f.toLowerCase()) {
      var own = liftDark(highlight);
      if (own === highlight || _rgbDist(own, f) >= 120) return own;   // lifted but still its own colour
    }
    var best = null, bestC = -1;
    for (var i = 0; i < SWEEP_CANDIDATES.length; i++) {
      var c = SWEEP_CANDIDATES[i];
      if (_rgbDist(c, f) < 120) continue;              // must look different from the words around it
      var onBox = box ? contrastRatio(c, box) : 21;
      if (onBox >= 3) return c;
      if (onBox > bestC) { bestC = onBox; best = c; }
    }
    return best || '#FFD400';
  }
  /* DARK TEXT ON A LIGHT BOX: the look the editable (Flux Halo) engine drew
     with no visible words on the owner's Mac (10 styles; the 3 new ones
     twin-plain-subtitle, tr-speech-bubble and tr-push-button make 13). The
     editable path does not place these silently: it offers Pulse-rendered
     captions, which draw them reliably. Judge the colours the owner will
     actually get — pass the edited preset. */
  function isDarkOnLight(p) {
    if (!p || !p.boxColor || !_hexRgb(p.boxColor) || !_hexRgb(p.fill)) return false;
    var op = (p.boxOpacity != null && isFinite(p.boxOpacity)) ? +p.boxOpacity : 1;
    if (op > 1) op = op / 100;
    return op >= 0.35 && _relLum(p.fill) < 0.2 && _relLum(p.boxColor) > 0.3;
  }

  /*
   * Built-in animation catalog (Pulse's own engine — no MOGRTs needed).
   * 'keyframed' anims are realized as Premiere Motion/Opacity keyframes on
   * rendered caption images; 'framed' anims are realized as a sequence of
   * rendered frames (the swap is the animation).
   */
  var ANIMATIONS = [
    { id: 'pop',        name: 'Pop',        kind: 'keyframed', demo: 'anim-pop',    description: 'Word scales in with a punchy overshoot' },
    { id: 'scale',      name: 'Scale',      kind: 'keyframed', demo: 'anim-scale',  description: 'Smooth grow-in, no overshoot' },
    { id: 'zoom',       name: 'Zoom',       kind: 'keyframed', demo: 'anim-zoom',   description: 'Zooms in from oversized to settle' },
    { id: 'bounce',     name: 'Bounce',     kind: 'keyframed', demo: 'anim-bounce', description: 'Drops in and settles with a bounce' },
    { id: 'slide',      name: 'Slide up',   kind: 'keyframed', demo: 'anim-slide',  description: 'Rises from below while fading in' },
    { id: 'wave',       name: 'Wave',       kind: 'keyframed', demo: 'anim-wave',   description: 'Gentle vertical wave on entry' },
    { id: 'shake',      name: 'Shake',      kind: 'keyframed', demo: 'anim-shake',  description: 'Quick attention-grabbing shake' },
    { id: 'fade',       name: 'Fade',       kind: 'keyframed', demo: 'anim-fade',   description: 'Soft opacity fade-in' },
    { id: 'glitch',     name: 'Glitch',     kind: 'keyframed', demo: 'anim-glitch', description: 'Two-frame jitter + flicker on entry' },
    { id: 'whoosh',     name: 'Whoosh',     kind: 'keyframed', demo: 'anim-whoosh', description: 'FilmImpact-style push: flies in fast with blur + overshoot' },
    { id: 'zoompunch',  name: 'Zoom Punch', kind: 'keyframed', demo: 'anim-zoompunch', description: 'FilmImpact-style zoom blur: punches in from oversized' },
    { id: 'blurdissolve', name: 'Blur Dissolve', kind: 'keyframed', demo: 'anim-blurdissolve', description: 'FilmImpact-style soft blur dissolve in' },
    { id: 'glide',      name: 'Glide',      kind: 'keyframed', demo: 'anim-glide',  description: 'FilmImpact-style smooth rise with motion blur' },
    { id: 'reveal',     name: 'Word reveal', kind: 'framed',   demo: 'anim-type',   description: 'Words appear one at a time as spoken, the newest pops in' },
    { id: 'karaoke',    name: 'Karaoke',    kind: 'framed',    demo: 'anim-sweep',  description: 'Phrase stays up, spoken word lights up' },
    { id: 'typewriter', name: 'Typewriter', kind: 'framed',    demo: 'anim-type',   description: 'Words accumulate as they are spoken' },
    { id: 'none',       name: 'None',       kind: 'keyframed', demo: '',            description: 'Hard cut, no motion' }
  ];

  function getAnimation(id) {
    for (var i = 0; i < ANIMATIONS.length; i++) if (ANIMATIONS[i].id === id) return ANIMATIONS[i];
    return ANIMATIONS[0];
  }

  /* Map preset.anim concept names onto engine animation ids. */
  var PRESET_ANIM_MAP = {
    'pop-scale': 'pop', 'color-sweep': 'karaoke', 'box-snap': 'karaoke',
    'fade': 'fade', 'glitch-in': 'glitch', 'typewriter': 'typewriter'
  };

  /*
   * Karaoke planning: phrase stays on screen, the active word is rendered
   * highlighted. One frame per spoken word.
   * Returns [{start, end, words:[...], active}] — render highlights words[active].
   */
  function planKaraoke(cues, wordsPerPhrase, accumulate) {
    var k = Math.max(2, wordsPerPhrase || 3);
    var frames = [];
    for (var c = 0; c < cues.length; c++) {
      var words = explodeWords([cues[c]], { wordsPerCue: 1 });
      for (var p = 0; p < words.length; p += k) {
        var phrase = words.slice(p, p + k);
        var texts = [];
        for (var i = 0; i < phrase.length; i++) texts.push(phrase[i].text);
        for (i = 0; i < phrase.length; i++) {
          // accumulate = 'reveal' (phrase grows); otherwise full phrase + sweep
          var shown = accumulate ? texts.slice(0, i + 1) : texts;
          frames.push({ start: phrase[i].start, end: phrase[i].end, words: shown, active: i });
        }
      }
    }
    return frames;
  }

  /*
   * Typewriter planning: words accumulate within each cue.
   * Returns [{start, end, text}] with growing text.
   */
  function planTypewriter(cues) {
    var frames = [];
    for (var c = 0; c < cues.length; c++) {
      var words = explodeWords([cues[c]], { wordsPerCue: 1 });
      var acc = [];
      for (var i = 0; i < words.length; i++) {
        acc.push(words[i].text);
        frames.push({ start: words[i].start, end: words[i].end, text: acc.join(' ') });
      }
    }
    return frames;
  }

  function getPreset(id) {
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === id) return TEMPLATES[i];
    }
    return null;
  }

  /* Resolve a template's `anim` (which may be a concept name like
     'pop-scale' or a direct engine id like 'zoom') to a real animation id. */
  function animIdForConcept(concept) {
    if (PRESET_ANIM_MAP[concept]) return PRESET_ANIM_MAP[concept];
    if (getAnimation(concept).id === concept) return concept;
    return 'pop';
  }

  // ----------------------------------------------- keyword highlight engine --
  var CTA_WORDS = {
    subscribe: 1, follow: 1, like: 1, share: 1, comment: 1, now: 1, free: 1,
    today: 1, new: 1, watch: 1, click: 1, save: 1, join: 1, download: 1,
    limited: 1, secret: 1, proven: 1, instantly: 1, guaranteed: 1, never: 1,
    best: 1, viral: 1, money: 1, growth: 1, results: 1, win: 1, stop: 1, start: 1
  };
  var STOP_WORDS = {
    the: 1, a: 1, an: 1, and: 1, or: 1, but: 1, of: 1, to: 1, in: 1, on: 1,
    for: 1, is: 1, are: 1, was: 1, it: 1, this: 1, that: 1, with: 1, as: 1,
    at: 1, by: 1, be: 1, you: 1, your: 1, i: 1, we: 1, they: 1, he: 1, she: 1,
    my: 1, me: 1, so: 1, if: 1, do: 1, not: 1, can: 1, will: 1, just: 1
  };

  function _clean(w) { return String(w).replace(/[^A-Za-z0-9$%']/g, ''); }

  // ---- v1.0: viral-word emphasis + emoji enrichment -----------------------
  /* Words that should ALWAYS pop (highlighted + scaled up) — the ones that make
     short-form hooks land. Used by markKeywords and the renderer's wordScale. */
  var VIRAL_WORDS = {
    secret: 1, biggest: 1, mistake: 1, profit: 1, loss: 1, million: 1, billion: 1,
    trillion: 1, crore: 1, lakh: 1, warning: 1, never: 1, always: 1, money: 1,
    free: 1, ai: 1, stocks: 1, growth: 1, rich: 1, viral: 1, proven: 1, huge: 1,
    instantly: 1, guaranteed: 1, results: 1, win: 1, stop: 1, now: 1
  };
  /* Optional auto-emoji after a keyword (opt-in, "✨ Auto-emoji"). */
  var EMOJI_MAP = {
    money: '💰', cash: '💰', profit: '📈', growth: '📈', loss: '📉', stock: '📊',
    stocks: '📊', secret: '🤫', warning: '⚠️', ai: '🤖', success: '🚀', rich: '🤑',
    idea: '💡', time: '⏰', fire: '🔥', love: '❤️', win: '🏆', million: '💸',
    crore: '💸', target: '🎯', up: '⬆️', down: '⬇️', best: '⭐'
  };
  /* ✨ Auto-emoji: ONE fitting emoji for a caption (or a transcript line) —
     the first of these that its words match. English, Hinglish and Hindi.
     (The Premiere-graphics paths and the Pulse-rendered captions share it, so
     the same caption gets the same emoji everywhere.) */
  var EMOJI_LEX = [
    [/\b(money|cash|paid|price|prices|cost|profit|revenue|rupees?|dollars?|lakhs?|crores?|paisa|paise|rupaye|kamai)\b|पैस[ाे]|रुपय[ेा]|कमाई|लाख|करोड़/i, '💰'],
    [/\b(grow|growth|growing|increase|increasing|rising|rise|scale|scaling|boost|badh|badhega|badhegi)\b|बढ़/i, '📈'],
    [/\b(drop|fall|falling|decrease|crash|collapse)\b|गिर/i, '📉'],
    [/\b(fire|hot|burn|burning|lit|heat|heatwaves?|aag)\b|आग/i, '🔥'],
    [/\b(idea|ideas|think|thinking|brain|smart|genius|soch|socho)\b|सोच|आइडिया/i, '💡'],
    [/\b(love|heart|care|caring|pyaar|pyar|dil)\b|प्यार|दिल/i, '❤️'],
    [/\b(warning|danger|dangerous|careful|risk|risky|alert|crisis|khatra|savdhaan)\b|खतरा|सावधान/i, '⚠️'],
    [/\b(time|clock|minutes?|hours?|deadline|schedule|samay|waqt)\b|समय|वक़्त|वक्त/i, '⏰'],
    [/\b(goal|goals|target|aim|focus|focused|lakshya)\b|लक्ष्य/i, '🎯'],
    [/\b(win|winner|won|success|successful|victory|jeet|safalta|kamyabi)\b|जीत|सफलता|कामयाबी/i, '🏆'],
    [/\b(work|working|grind|hustle|effort|mehnat)\b|मेहनत/i, '💪'],
    [/\b(secret|secrets|hidden|nobody tells|raaz)\b|राज़|राज/i, '🤫'],
    [/\b(crazy|insane|unbelievable|shocking|shocked|mind ?blown)\b/i, '🤯'],
    [/\b(stop|never|avoid|quit)\b/i, '🚫'],
    [/\b(new|launch|launched|launching|announcement|announcing)\b/i, '🚀'],
    [/\b(look|watch|see this|attention|dekho)\b|देखो/i, '👀'],
    [/\b(health|healthy|doctor|hospital|medicine|disease|sehat)\b|सेहत|डॉक्टर/i, '🩺'],
    [/\b(food|eat|eating|meal|diet|nutrition|khana)\b|खाना/i, '🍽️'],
    [/\b(video|camera|filming|shoot|record)\b|वीडियो/i, '🎬'],
    [/\b(music|song|sound|audio|voice|gaana)\b|गाना/i, '🎵'],
    [/\b(free|gift|bonus|giveaway)\b|फ्री/i, '🎁'],
    [/\b(number one|the best|top rated|first place)\b/i, '🥇'],
    [/\b(world|global|everyone|everywhere|planet|duniya)\b|दुनिया/i, '🌍'],
    [/\b(phone|mobile|app|apps)\b|फ़ोन|फोन|मोबाइल/i, '📱'],
    [/\b(sleep|sleeping|tired|exhausted|rest|neend)\b|नींद/i, '😴'],
    [/\b(happy|happiness|smile|joy|fun|khush|khushi)\b|खुश/i, '😊'],
    [/\b(sad|crying|pain|painful|hurt|dukh)\b|दुख|दर्द/i, '😢'],
    [/\b(india|indian|desi|bharat)\b|भारत|इंडिया/i, '🇮🇳']
  ];
  function emojiForText(text) {
    var t = String(text == null ? '' : text);
    for (var i = 0; i < EMOJI_LEX.length; i++) if (EMOJI_LEX[i][0].test(t)) return EMOJI_LEX[i][1];
    return null;
  }

  /* Append an emoji after each word that has one (opt-in). Pure + tested. */
  function enrichCaptionText(text) {
    return String(text == null ? '' : text).replace(/[A-Za-z]+/g, function (m) {
      var e = EMOJI_MAP[m.toLowerCase()];
      return e ? m + ' ' + e : m;
    });
  }

  /*
   * Decide which words in a list to highlight.
   * opts.mode: 'smart' (numbers + CTAs + capitalized names + the longest
   * content word), 'numbers', 'cta', 'names', 'keywords' (longest words),
   * 'all'. Returns a boolean[] aligned to `words`. Pure + tested.
   */
  function markKeywords(words, opts) {
    opts = opts || {};
    var mode = opts.mode || 'smart';
    var flags = [];
    var i, w, clean, lc;
    for (i = 0; i < words.length; i++) flags.push(false);
    if (mode === 'all') { for (i = 0; i < words.length; i++) flags[i] = true; return flags; }
    // 'auto' (TF-IDF): highlight words present in a transcript-wide salient set
    // precomputed by CPTranscript.topKeywordSet and passed as opts.set.
    if (mode === 'auto') {
      var set = opts.set || {};
      for (i = 0; i < words.length; i++) {
        var key = String(words[i]).toLowerCase().replace(/[^a-z0-9']/g, '');
        flags[i] = !!set[key] || !!VIRAL_WORDS[key];   // v1.0: viral words always pop
      }
      return flags;
    }

    var set = opts.set || null;
    var bestIdx = -1, bestScore = 0;
    for (i = 0; i < words.length; i++) {
      w = words[i]; clean = _clean(w); lc = clean.toLowerCase();
      var hasNum = /\d/.test(w);
      var isCta = !!CTA_WORDS[lc];
      var isName = /^[A-Z][a-z]{2,}$/.test(clean) && i > 0;   // capitalised mid-sentence ≈ proper noun

      if (mode === 'numbers') { if (hasNum) flags[i] = true; continue; }
      if (mode === 'cta') { if (isCta) flags[i] = true; continue; }
      if (mode === 'names') { if (isName) flags[i] = true; continue; }

      // 'keywords' / 'smart': score each word for salience and pick the BEST one
      // (not merely the longest), so the highlight lands on a meaningful word.
      var sc = wordSalienceScore(w, i, set);
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    }
    if ((mode === 'keywords' || mode === 'smart') && bestIdx >= 0) flags[bestIdx] = true;
    // 'smart' also always pops numbers/money and viral power-words (they're worth
    // highlighting even when they aren't the single most salient word).
    if (mode === 'smart') {
      for (i = 0; i < words.length; i++) {
        var c2 = _clean(words[i]).toLowerCase();
        if (/\d/.test(words[i]) || VIRAL_WORDS[c2]) flags[i] = true;
      }
    }
    return flags;
  }

  /* Filler / low-value words that should never be picked as the keyword. */
  var FILLER_WORDS = {
    um: 1, uh: 1, er: 1, ah: 1, hmm: 1, like: 1, well: 1, okay: 1, ok: 1, yeah: 1,
    yep: 1, kinda: 1, sorta: 1, basically: 1, literally: 1, actually: 1, really: 1,
    just: 1, very: 1, stuff: 1, things: 1, thing: 1, gonna: 1, wanna: 1, gotta: 1,
    today: 1, also: 1, then: 1, there: 1, here: 1, this: 1, that: 1, these: 1, those: 1
  };
  /*
   * Salience score for a single word (0 = never a keyword). Favours nouns/proper
   * nouns, numbers/money, named CTAs/power-words and TF-IDF-salient words; longer
   * content words rank higher; stop/filler words score 0. Pure + tested.
   */
  function wordSalienceScore(w, i, set) {
    var clean = _clean(w), lc = clean.toLowerCase();
    if (!clean) return 0;
    var hasNum = /\d/.test(w);
    if (!hasNum && (clean.length < 3 || STOP_WORDS[lc] || FILLER_WORDS[lc])) return 0;
    var s = 1;
    s += Math.min(4, Math.max(0, clean.length - 3) * 0.5);     // length (capped)
    if (hasNum) s += 3.5;                                       // 2026, $4, 50%, 10x
    if (/^[A-Z][a-z]{2,}/.test(clean) && i > 0) s += 2.5;       // proper noun
    if (CTA_WORDS[lc]) s += 2;
    if (VIRAL_WORDS[lc]) s += 2.5;
    if (set && set[lc]) s += 3;                                 // salient across the whole transcript
    return s;
  }

  /*
   * Split a leading "Name:" speaker prefix off a cue.
   * "Sarah: let's begin" -> { speaker:'Sarah', text:"let's begin" }.
   * Only fires for a short (<=3 word) name followed by a colon + space, so
   * normal sentences with colons are left alone. Pure + tested.
   */
  function extractSpeaker(text) {
    var m = /^\s*([A-Za-z][\w .'\-]{0,24}?)\s*[:：]\s+(.+)$/.exec(text || '');
    if (m && m[2] && m[1].trim().split(/\s+/).length <= 3) {
      return { speaker: m[1].trim(), text: m[2] };
    }
    return { speaker: null, text: text };
  }

  /*
   * Detect speech-energy onsets within [startT, endT] of a dB envelope
   * (samples: [{t, db}]). An onset is where the level rises above an adaptive
   * threshold after being below it. Returns onset times. Pure + tested.
   */
  function detectOnsets(samples, startT, endT, opts) {
    opts = opts || {};
    var win = [];
    for (var i = 0; i < samples.length; i++) {
      if (samples[i].t >= startT - 1e-6 && samples[i].t <= endT + 1e-6) win.push(samples[i]);
    }
    if (win.length < 2) return [];
    var sorted = win.map(function (s) { return s.db; }).sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(sorted.length * 0.3)];
    var thr = floor + (opts.rise != null ? opts.rise : 6);
    var minSpacing = opts.minSpacing != null ? opts.minSpacing : 0.12;
    var onsets = [], prevAbove = false, last = -1e9;
    for (i = 0; i < win.length; i++) {
      var above = win[i].db >= thr;
      if (above && !prevAbove && (win[i].t - last) >= minSpacing) { onsets.push(win[i].t); last = win[i].t; }
      prevAbove = above;
    }
    return onsets;
  }

  /*
   * Time a phrase's words across [start, end]: start with length-weighted
   * boundaries, then SNAP each interior word boundary to the nearest speech
   * onset (if one is close). This pulls word timing onto the real speech.
   * Returns [{start, end, text}] per word. Pure + tested.
   */
  function alignPhrase(words, start, end, onsets, snapWin) {
    var n = words.length;
    if (n <= 1) return [{ start: start, end: end, text: words[0] || '' }];
    snapWin = snapWin != null ? snapWin : 0.18;
    var weights = [], total = 0, i;
    for (i = 0; i < n; i++) { var wt = Math.max(2, words[i].replace(/\s/g, '').length); weights.push(wt); total += wt; }
    var bounds = [start], t = start;
    for (i = 0; i < n - 1; i++) { t += (end - start) * weights[i] / total; bounds.push(t); }
    bounds.push(end);
    // snap interior boundaries to nearest onset
    for (i = 1; i < n; i++) {
      var b = bounds[i], best = null, bd = snapWin;
      for (var o = 0; o < onsets.length; o++) {
        var d = Math.abs(onsets[o] - b);
        if (d < bd) { bd = d; best = onsets[o]; }
      }
      if (best != null) bounds[i] = best;
    }
    for (i = 1; i < bounds.length; i++) if (bounds[i] < bounds[i - 1]) bounds[i] = bounds[i - 1];
    var out = [];
    for (i = 0; i < n; i++) out.push({ start: bounds[i], end: bounds[i + 1], text: words[i] });
    return out;
  }

  /*
   * Re-time every cue's words to the audio envelope. inPoint is the audio
   * clip's sync offset (sequence time + inPoint = media time). Returns a flat
   * list of word-level cues [{start, end, text}]. Pure + tested.
   */
  function alignCuesToAudio(cues, samples, inPoint, opts) {
    inPoint = inPoint || 0;
    var out = [];
    for (var c = 0; c < cues.length; c++) {
      var words = cues[c].text.replace(/\s+/g, ' ').trim().split(' ');
      if (words.length <= 1) { out.push({ start: cues[c].start, end: cues[c].end, text: words[0] || '' }); continue; }
      var onsetsMedia = detectOnsets(samples, cues[c].start + inPoint, cues[c].end + inPoint, opts);
      var onsetsSeq = onsetsMedia.map(function (o) { return o - inPoint; });
      var aligned = alignPhrase(words, cues[c].start, cues[c].end, onsetsSeq, opts && opts.snapWin);
      for (var k = 0; k < aligned.length; k++) out.push(aligned[k]);
    }
    return out;
  }

  /* Clean a word-cue list so EVERY word survives placement and the highlight
     can't skip one. Drops empties, sorts by start, and forces strictly
     increasing starts spaced by at least minWin (≈1-2 video frames) with a
     minimum on-screen window — a zero-length word the speech engine stamped
     gets a window of its own. Without this, two cues at the same/!ascending
     time make Premiere's overwriteClip stomp the earlier word — so it never
     lights up — and rapid sub-frame words vanish. Who said a word (speaker)
     rides along. Pure + tested. */
  function sanitizeWordCues(cues, minWin) {
    minWin = minWin || 0.06;
    var s = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (!c || c.text == null || !String(c.text).length) continue;
      var o = { start: +c.start || 0, end: +c.end || 0, text: c.text };
      if (c.speaker != null && c.speaker !== '') o.speaker = c.speaker;
      s.push(o);
    }
    s.sort(function (a, b) { return a.start - b.start; });
    for (i = 0; i < s.length; i++) {
      if (i > 0 && s[i].start < s[i - 1].start + minWin) s[i].start = s[i - 1].start + minWin;
      if (s[i].end < s[i].start + minWin) s[i].end = s[i].start + minWin;
    }
    return s;
  }

  /* ==== ONE caption grouper + timer for every word-timed caption ============
     What a caption may hold and how long it stays (Netflix / BBC subtitle
     practice, with the timing numbers checked against the owner's Hindi and
     Hinglish podcasts and reels):
       · a caption never runs across a sentence end (. ? ! । ॥), a pause of
         0.5 s or more, or a change of speaker;
       · it holds at most "Words per caption" words — exactly that cap, so 1
         means one word at a time — and ✨ Auto means no word cap at all;
       · it fits the frame at the style's OWN font size within its line limit
         (the renderer measures it: opts.fits), so nothing has to shrink;
       · its words are spoken within 7 s;
       · where a sentence must split, it splits where the grammar allows
         (lineBreakCost) into captions of even length, never one word alone,
         none so dense it cannot be read in the time it has (20 characters a
         second, 22 for Hindi) and none that would flash by in under 0.2 s
         when another split avoids it.
     Timing, on the sequence's own frames:
       · a caption starts on its first word and stays at least 0.833 s
         (a one-word caption 0.3 s), growing only into the silence after it;
       · it holds 0.5 s after its last word when nothing follows soon;
       · two captions are exactly 2 frames apart or at least half a second —
         a shorter gap is closed to 2 frames (it read as a flicker);
       · it stays long enough to read (20 characters a second, 22 for Hindi):
         a caption spoken faster than that stays on into the silence after
         it, up to the next caption (2 frames before it) and 7 s on screen. */
  var CAPTION_RULES = {
    pause: 0.5, maxDur: 7, minMulti: 0.833, minSingle: 0.3, lagOut: 0.5,
    cps: 20, cpsDeva: 22, gapFrames: 2, flash: 0.2
  };
  function _copyWord(w) {
    var o = { start: w.start, end: w.end, text: w.text };
    if (w.speaker != null) o.speaker = w.speaker;
    return o;
  }
  /* Speech engines stretch the first word after a silence back into it, and
     the last word before one forward (the caption then appears before the
     voice, or lingers after it). A word longer than 2.5x the median word (at
     most 1.4 s) is cut back to that length on its silence side (stable-ts
     clamp_max). Pure + tested. */
  function clampWordDurations(words) {
    var ds = [], i;
    for (i = 0; i < words.length; i++) { var d = words[i].end - words[i].start; if (d > 0) ds.push(d); }
    if (!ds.length) return words.map(_copyWord);
    ds.sort(function (a, b) { return a - b; });
    var med = ds[Math.floor(ds.length / 2)];
    var cap = Math.min(1.4, Math.max(0.3, 2.5 * med));
    var out = [];
    for (i = 0; i < words.length; i++) {
      var w = words[i], o = _copyWord(w);
      if (w.end - w.start > cap) {
        var prev = words[i - 1];
        if (!prev || (w.start - prev.end) > 0.1) o.start = w.end - cap;   // first word after a pause
        else o.end = w.start + cap;                                       // the silence is after it
      }
      out.push(o);
    }
    return out;
  }
  /* Is this Hindi / Hinglish? (Decides whether "the" is the auxiliary थे or
     the English article.) */
  var _HI_MARK = _set('hai hain ka ki ke ko se mein ne aur nahi nahin toh bhi yeh ye woh wo kya tha thi raha rahe kar karna karte bhai ji bahut apna apne hum mujhe aap tum');
  var _EN_MARK = _set('is are was were and of you that it this for with have be will can');
  /* Hindi / Hinglish / English function words — never a "key word" for
     🔠 CAPS (the picker used to capitalise "HAI" and "THA"). */
  var FUNCTION_WORDS = (function () {
    var o = {}, k, lists = [_POSTPOS, _AUX, _CONJ, _BAD_END, _HI_MARK, _GENITIVE,
      _set('bhi hi yahi wahi kuch sab sabse ek do jaisa jaise waisa itna utna bas bilkul sach kaafi abhi phir yeh woh ye wo is us in un ham main mera meri mere tera teri tere apna apni apne unka unki unke iska iski iske uska uski uske agar jab tab kab kaise kyun kya kaun zyada ' +
           'भी ही यही वही कुछ सब सबसे एक जैसा जैसे बस अभी यह वह ये वो इस उस मैं मेरा मेरी मेरे हम आप तुम अपना अपनी अपने उनका उनकी उनके इसका इसकी इसके अगर जब तब कब कैसे क्यों क्या कौन')];
    for (var i = 0; i < lists.length; i++) for (k in lists[i]) if (lists[i].hasOwnProperty(k)) o[k] = 1;
    return o;
  })();
  function textContext(words) {
    var hi = 0, en = 0, dev = 0;
    for (var i = 0; i < (words || []).length; i++) {
      var t = String((words[i] && words[i].text != null) ? words[i].text : words[i]);
      if (/[ऀ-ॿ]/.test(t)) dev++;
      var b = _bareWord(t);
      if (_HI_MARK[b]) hi++;
      if (_EN_MARK[b]) en++;
    }
    return { hinglish: dev > 0 || (hi >= 2 && hi >= en * 0.6) };
  }

  /*
   * Group timed words into captions (the rules above). words: sanitized
   * [{start, end, text, speaker?}]. opts: { maxWords (0 = Auto), fits(i, j)
   * → may words[i..j) be one caption on screen, pause, maxDur, ctx,
   * lenOf(k) → visible length of word k }. Returns [[from, to), …] word index
   * ranges, in order. Pure + tested.
   */
  function groupCaptionWords(words, opts) {
    opts = opts || {};
    var N = Math.max(0, Math.floor(+opts.maxWords || 0));
    var pause = (opts.pause != null) ? opts.pause : CAPTION_RULES.pause;
    var maxDur = (opts.maxDur != null) ? opts.maxDur : CAPTION_RULES.maxDur;
    var fits = (typeof opts.fits === 'function') ? opts.fits : null;
    var lenOf = opts.lenOf || function (k) { return visLen(words[k].text) + 1; };
    var ctx = opts.ctx || textContext(words);
    var groups = [], segStart = 0, i;
    function hardBreakAfter(k) {
      if (k >= words.length - 1) return true;
      var w = words[k], nx = words[k + 1];
      if (isSentenceEnd(w.text)) return true;
      if (nx.start - w.end >= pause - 1e-9) return true;
      return (w.speaker != null && nx.speaker != null && w.speaker !== nx.speaker);
    }
    function packSeg(a, b) {
      var m = b - a, k, j, i2, g;
      if (m <= 1) { groups.push([a, b]); return; }
      var bc = {}, forb = {}, pre = [0];
      for (k = a + 1; k < b; k++) {
        var c = lineBreakCost(words[k - 1].text, words[k].text, ctx);
        forb[k] = (c === Infinity) ? 1 : 0;
        bc[k] = (c === Infinity) ? 0 : c;
      }
      for (k = a; k < b; k++) pre.push(pre[pre.length - 1] + lenOf(k));
      // letters a caption shows (code points, as reading speed is counted)
      var cpre = [0], deva = false;
      for (k = a; k < b; k++) {
        cpre.push(cpre[cpre.length - 1] + _codePoints(words[k].text) + 1);
        if (/[ऀ-ॿ]/.test(words[k].text)) deva = true;
      }
      var cpsLimit = deva ? CAPTION_RULES.cpsDeva : CAPTION_RULES.cps;
      var segRoom = (b < words.length) ? words[b].start : Infinity;   // the next caption's start
      /* What a caption [x, y) costs in time: on screen until the next one in
         this stretch of speech starts (2 frames ≈ 0.07 s before it), or — the
         last one — into the silence after the stretch (at most 7 s). Too
         dense to read in that time, or a flash under 0.2 s, costs extra, so
         the split that reads best wins. */
      function timeCost(x, y) {
        var until = (y < b) ? words[y].start - 0.07 : Math.min(segRoom - 0.07, words[x].start + maxDur);
        var shown = Math.max(0.04, until - words[x].start);
        var c2 = 0, rate = (cpre[y - a] - cpre[x - a] - 1) / shown;
        if (rate > cpsLimit) c2 += 6 * (rate / cpsLimit - 1);
        if (y < b && shown < CAPTION_RULES.flash) c2 += 6;
        return c2;
      }
      var memo = {};
      function ok(x, y) {                       // may words [x, y) be one caption?
        if (y - x === 1) return true;
        if (N && y - x > N) return false;
        if (words[y - 1].end - words[x].start > maxDur + 1e-9) return false;
        if (!fits) return true;
        var key = x + ':' + y;
        if (memo[key] == null) memo[key] = !!fits(x, y);
        return memo[key];
      }
      // pass 1: the fewest breaks the grammar forbids, then the fewest captions
      var P = {};
      P[a] = { f: 0, g: 0 };
      for (j = a + 1; j <= b; j++) {
        var best = null;
        for (i2 = j - 1; i2 >= a; i2--) {
          if (!ok(i2, j)) break;
          var pv = P[i2]; if (!pv) continue;
          var f = pv.f + (i2 > a ? forb[i2] : 0), gg = pv.g + 1;
          if (!best || f < best.f || (f === best.f && gg < best.g)) best = { f: f, g: gg };
        }
        P[j] = best;
      }
      var G = P[b].g;
      if (G === 1) { groups.push([a, b]); return; }
      // pass 2: exactly that many captions — the best breaks, the most even
      // lengths, no caption of one lone word (unless it is one word a caption)
      var avg = (pre[m] - pre[0]) / G;
      var D = [];
      for (g = 0; g <= G; g++) D.push({});
      D[0][a] = { f: 0, c: 0, from: -1 };
      for (g = 1; g <= G; g++) {
        for (j = a + 1; j <= b; j++) {
          var bestc = null;
          for (i2 = j - 1; i2 >= a; i2--) {
            if (!ok(i2, j)) break;
            var pv2 = D[g - 1][i2]; if (!pv2) continue;
            var len = pre[j - a] - pre[i2 - a];
            var dev = (len - avg) / Math.max(1, avg);
            var cc = pv2.c + (i2 > a ? bc[i2] : 0) + 2 * dev * dev + ((j - i2 === 1 && N !== 1) ? 4 : 0) + timeCost(i2, j);
            var ff = pv2.f + (i2 > a ? forb[i2] : 0);
            if (!bestc || ff < bestc.f || (ff === bestc.f && cc < bestc.c - 1e-12)) bestc = { f: ff, c: cc, from: i2 };
          }
          if (bestc) D[g][j] = bestc;
        }
      }
      var cuts = [], at = b;
      for (g = G; g >= 1; g--) { var st = D[g][at]; cuts.push([st.from, at]); at = st.from; }
      for (k = cuts.length - 1; k >= 0; k--) groups.push(cuts[k]);
    }
    for (i = 0; i < words.length; i++) {
      if (hardBreakAfter(i)) { packSeg(segStart, i + 1); segStart = i + 1; }
    }
    return groups;
  }

  /* A sequence frame rate as Premiere counts it (29.97 is 30000/1001). */
  function fpsExact(fps) {
    fps = +fps || 30;
    var ntsc = [24000, 30000, 48000, 60000, 120000];
    for (var i = 0; i < ntsc.length; i++) if (Math.abs(fps - ntsc[i] / 1001) < 0.01) return ntsc[i] / 1001;
    return fps;
  }
  function _codePoints(s) { return (String(s).match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || []).length; }

  /*
   * Time grouped captions on the sequence's frames (the rules above).
   * Returns per caption { a, b, s, e, ws:[each word's start frame], fps } in
   * FRAMES — seconds = frame / fps. opts: { fps, textOf(a, b) → the text the
   * caption shows }. Pure + tested.
   */
  function timeCaptions(words, groups, opts) {
    opts = opts || {};
    var R = CAPTION_RULES, F = fpsExact(opts.fps);
    var half = Math.round(F * 0.5), two = R.gapFrames;
    var lag = Math.round(R.lagOut * F), maxD = Math.round(R.maxDur * F);
    var textOf = opts.textOf || function (a, b) { return words.slice(a, b).map(function (w) { return w.text; }).join(' '); };
    var caps = [], last = -Infinity, c, j;
    for (c = 0; c < groups.length; c++) {
      var a = groups[c][0], b = groups[c][1], ws = [];
      for (j = a; j < b; j++) {
        var f = Math.round(words[j].start * F);
        if (f <= last) f = last + 1;            // every word gets a frame of its own
        ws.push(f); last = f;
      }
      var lastW = ws[ws.length - 1];
      caps.push({ a: a, b: b, ws: ws, s: ws[0], sp: Math.max(lastW + 1, Math.round(words[b - 1].end * F)), fps: F });
      last = lastW + two;                       // room for this caption's last word + the 2-frame gap
    }
    for (c = 0; c < caps.length; c++) {
      var cp = caps[c], nx = caps[c + 1], lw = cp.ws[cp.ws.length - 1];
      var minF = Math.ceil(((cp.b - cp.a) > 1 ? R.minMulti : R.minSingle) * F - 1e-6);
      var want = Math.max(cp.sp + lag, cp.s + minF);
      var txt = textOf(cp.a, cp.b);
      var limit = /[ऀ-ॿ]/.test(txt) ? R.cpsDeva : R.cps;
      var needF = Math.ceil(_codePoints(txt) / limit * F);
      // spoken faster than it can be read: stay on into the silence after it
      if (cp.s + needF > want) want = cp.s + needF;
      want = Math.min(want, Math.max(cp.sp, cp.s + maxD));      // at most 7 s on screen
      var e = want;
      if (nx) {
        e = Math.min(e, nx.s - two);
        if (nx.s - e < half) {
          var chained = nx.s - two, alt = nx.s - half;
          if (chained - cp.s <= Math.max(maxD, cp.sp - cp.s) || alt < lw + 1) e = chained;
          else e = alt;                          // chaining would pass 7 s: leave half a second instead
        }
      }
      if (e < lw + 1) e = lw + 1;
      cp.e = e;
    }
    return caps;
  }

  /* Windowed/diagonal frames: each frame is [prevWord, spokenWord, nextWord] with
     the SPOKEN word active (centre) — used by the dynamic diagonal styles so the
     highlighted word is always the middle line. */
  function framesWindowed(wordCues, up) {
    var frames = [];
    for (var i = 0; i < wordCues.length; i++) {
      var words = [], active;
      if (i > 0) words.push(wordCues[i - 1].text);
      active = words.length;
      words.push(wordCues[i].text);
      if (i < wordCues.length - 1) words.push(wordCues[i + 1].text);
      if (up) words = words.map(uc);
      // hold until the next word starts so the window never blanks between words
      var wend = (i + 1 < wordCues.length) ? wordCues[i + 1].start : wordCues[i].end;
      frames.push({ start: wordCues[i].start, end: wend, words: words, active: active });
    }
    return frames;
  }
  /* Keyword-build frames: the phrase GROWS one word at a time (like reveal), but
     instead of lighting the newest word, the AUTO-DETECTED keyword stays
     emphasised (italic-serif/colour) the whole time. Used by the Editorial style
     so the caption animates in word-by-word while the keyword reads cleanly.
     Timing is contiguous so each new word lands exactly on the spoken word. */
  function framesKeywordBuild(wordCues, per, kw, up) {
    function ucw(arr) { return up ? arr.map(uc) : arr; }
    per = Math.max(2, per || 6);
    var frames = [], i = 0;
    while (i < wordCues.length) {
      // accumulate up to `per` words, but END EARLY at sentence punctuation so a
      // caption never resets mid-sentence (the old fixed-N grouping did, which
      // looked like the phrase randomly restarting).
      var group = [];
      while (group.length < per && i < wordCues.length) {
        group.push(wordCues[i]); i++;
        if (/[.!?]["')\]]?$/.test(group[group.length - 1].text)) break;
      }
      var words = ucw(group.map(function (g) { return g.text; }));
      // pick the keyword once on the WHOLE phrase so it's stable as words appear
      var flags = (kw && kw.on) ? markKeywords(words, kw) : null;
      for (var j = 0; j < group.length; j++) {
        var fend = (j + 1 < group.length) ? group[j + 1].start : group[j].end;
        // words = the FULL phrase every frame (stable layout); `reveal` grows so
        // each word appears in its final spot — no recentering, no re-pop.
        var fr = { start: group[j].start, end: fend, words: words, reveal: j + 1 };
        if (flags) fr.highlightSet = flags;
        frames.push(fr);
      }
    }
    return frames;
  }

  /*
   * Single entry point that turns cues into render-ready frames for any
   * animation. EVERY animation now groups the words the same way
   * (groupCaptionWords) and times them on the sequence's frames
   * (timeCaptions), so the preview, the per-image render and the one-clip
   * overlay all show the same captions.
   * opts: { anim, wordsPerCue (0 = ✨ Auto, N = at most N words — exactly),
   *         uppercase, textCase, stripPunctuation, censor,
   *         capsWords { word: 1 } ("CAPS on key words"), emoji,
   *         keyword:{on,mode}, speaker:{on}, build, window,
   *         wordCues (real word timing; else the lines are spread by length),
   *         fit(words[], { wordSync, highlightSet }) → does this caption fit
   *           the frame drawn that way (CPRender.fitter),
   *         fps (the sequence's; default 30) }
   * Frame shapes (cap = which caption the frame belongs to):
   *   static        -> { start, end, words:[...], highlightSet?, cap }
   *   karaoke       -> { start, end, words:[...], active, cap }
   *   reveal        -> { start, end, words:[...], active, reveal, cap }
   *   build         -> { start, end, words:[...], reveal, highlightSet?, cap }
   *   typewriter    -> { start, end, text }
   * In karaoke/reveal/build every frame of one caption carries the WHOLE
   * caption, so the renderer lays it out once and nothing moves while it is
   * spoken (reveal draws only the first `reveal` words). Pure + tested.
   */
  function buildCaptionFrames(cues, opts) {
    opts = opts || {};
    cues = cues || [];
    var anim = opts.anim || 'pop';
    var wpc = Math.max(0, parseInt(opts.wordsPerCue, 10) || 0);
    var up = !!opts.uppercase;
    var kw = opts.keyword || {};
    var spk = opts.speaker || {};
    var tc = opts.textCase;
    var i, frames;

    // Pull "Name:" speaker prefixes off the cues so they don't pollute the
    // caption words; remember them by time.
    var speakers = null;
    if (spk.on) {
      speakers = [];
      cues = cues.map(function (c) {
        var s = extractSpeaker(c.text);
        speakers.push({ start: c.start, end: c.end, speaker: s.speaker });
        return { start: c.start, end: c.end, text: s.text };
      });
    }
    function speakerAt(t) {
      if (!speakers) return null;
      for (var s = 0; s < speakers.length; s++) {
        // start-inclusive, end-exclusive so a caption on a cue boundary
        // belongs to the cue that is starting, not the one that ended
        if (t >= speakers[s].start - 1e-3 && t < speakers[s].end - 1e-3) return speakers[s].speaker || null;
      }
      return null;
    }

    if (anim === 'typewriter') {
      frames = planTypewriter(cues);
      if (up) for (i = 0; i < frames.length; i++) frames[i].text = frames[i].text.toUpperCase();
      return _legacyFinish(frames, opts, speakerAt);
    }

    // The words, cleaned so none can be lost: real word timing when there is
    // some, else each line's words spread over the line by length.
    var src = (opts.wordCues && opts.wordCues.length) ? opts.wordCues : explodeWords(cues, { wordsPerCue: 1 });
    var words = clampWordDurations(sanitizeWordCues(src));
    if (!words.length) return [];
    // a "Name:" label starts a new caption (who is talking changed)
    if (speakers) for (i = 0; i < words.length; i++) {
      var nm = speakerAt((words[i].start + words[i].end) / 2);
      if (nm && words[i].speaker == null) words[i].speaker = nm;
    }

    // What each word SHOWS — every text setting applied once, here, so the
    // fit is measured on exactly what will be drawn.
    var capsSet = opts.capsWords || null;
    var D = words.map(function (w) {
      var t = String(w.text);
      if (opts.stripPunctuation) { var sp = stripWordPunct(t); if (sp) t = sp; }
      if (up) t = t.toUpperCase();
      if (tc === 'lower' || tc === 'sentence') t = t.toLowerCase();
      else if (tc === 'title') t = caseWord(t, 'title');
      else if (tc === 'upper') t = t.toUpperCase();
      if (opts.censor) t = censorWord(t);
      if (capsSet && capsSet[capsKey(w.text)]) t = t.toUpperCase();
      return t;
    });
    // The words of one caption as drawn: Sentence case caps its first word,
    // ✨ Auto-emoji adds one fitting emoji at its end.
    function capWords(a, b) {
      var arr = D.slice(a, b), k;
      if (tc === 'sentence') {
        for (k = 0; k < arr.length; k++) if (/[a-z]/i.test(arr[k])) { arr[k] = arr[k].charAt(0).toUpperCase() + arr[k].slice(1); break; }
      }
      if (opts.emoji) {
        var raw = [];
        for (k = a; k < b; k++) raw.push(words[k].text);
        var e = emojiForText(raw.join(' '));
        if (e) arr[arr.length - 1] = arr[arr.length - 1] + ' ' + e;
      }
      return arr;
    }

    if (opts.window) {
      // diagonal styles: a sliding [previous, spoken, next] window per word
      var wd = words.map(function (w, k) { return { start: w.start, end: w.end, text: D[k] }; });
      frames = framesWindowed(wd, false);
      for (i = 0; i < frames.length; i++) {
        // never hold a word through a real pause
        frames[i].end = Math.min(frames[i].end, wd[i].end + CAPTION_RULES.lagOut);
        var sw = speakerAt(frames[i].start); if (sw) frames[i].speaker = sw;
      }
      return frames;
    }

    var fit = (typeof opts.fit === 'function') ? opts.fit : null;
    var swept = (anim === 'karaoke' || anim === 'reveal');
    // The fit is asked about a caption as its frames will DRAW it: in
    // karaoke / reveal one word is lit at a time; otherwise every word at
    // once at its own size, the lit keywords (and 🔠 Bigger punchy words) at
    // their bigger size — so a static caption is never grouped too long
    // and then shrunk below the style's size.
    function fitHow(cw) {
      if (swept) return { wordSync: true };
      return { wordSync: false, highlightSet: (kw && kw.on) ? markKeywords(cw, kw) : null };
    }
    var groups = groupCaptionWords(words, {
      maxWords: wpc,
      fits: fit ? function (a, b) { var cw = capWords(a, b); return fit(cw, fitHow(cw)); } : null,
      lenOf: function (k) { return visLen(D[k]) + 1; }
    });
    var timed = timeCaptions(words, groups, { fps: opts.fps, textOf: function (a, b) { return capWords(a, b).join(' '); } });

    frames = [];
    for (var c = 0; c < timed.length; c++) {
      var cp = timed[c], F = cp.fps, n = cp.b - cp.a;
      var cw = capWords(cp.a, cp.b);
      var who = speakerAt(words[cp.a].start);
      var flags = (kw && kw.on && !swept) ? markKeywords(cw, kw) : null;
      if (opts.build || swept) {
        // one frame per spoken word, held until the next word starts
        for (var j = 0; j < n; j++) {
          var fr = { start: cp.ws[j] / F, end: ((j + 1 < n) ? cp.ws[j + 1] : cp.e) / F, words: cw, cap: c };
          if (opts.build) { fr.reveal = j + 1; if (flags) fr.highlightSet = flags; }
          else {
            // Only the ACTIVE (spoken) word is highlighted — no keyword boxes,
            // so ONE clean highlight rides the voice
            fr.active = j;
            if (anim === 'reveal') fr.reveal = j + 1;
          }
          if (who) fr.speaker = who;
          frames.push(fr);
        }
      } else {
        var fs = { start: cp.s / F, end: cp.e / F, words: cw, cap: c };
        if (flags) fs.highlightSet = flags;
        if (who) fs.speaker = who;
        frames.push(fs);
      }
    }
    return frames;
  }

  /* The text passes for the line-based (typewriter) frames. */
  function _legacyFinish(frames, opts, speakerAt) {
    var i, tc = opts.textCase;
    for (i = 0; i < frames.length; i++) {
      var who = speakerAt(frames[i].start); if (who) frames[i].speaker = who;
      if (opts.stripPunctuation) {
        if (frames[i].words) frames[i].words = frames[i].words.map(stripWordPunct);
        if (frames[i].text != null) frames[i].text = frames[i].text.split(/\s+/).map(stripWordPunct).join(' ').replace(/\s+/g, ' ').trim();
      }
      if (tc && tc !== 'original' && tc !== 'upper') {
        if (frames[i].words) frames[i].words = caseWords(frames[i].words, tc);
        if (frames[i].text != null) frames[i].text = caseWords(frames[i].text.split(/\s+/), tc).join(' ');
      }
      if (opts.censor) {
        if (frames[i].words) frames[i].words = frames[i].words.map(censorWord);
        if (frames[i].text != null) frames[i].text = frames[i].text.split(/\s+/).map(censorWord).join(' ');
      }
    }
    // hold each line through a short breath, never through a real pause
    fillFrameGaps(frames, CAPTION_RULES.lagOut);
    return frames;
  }

  /* The key "CAPS on key words" matches on: lower case, edge punctuation off,
     Latin letters, digits and Hindi letters. */
  function capsKey(w) { return _bareWord(w); }

  /* Hold each frame until the next one begins so brief pauses don't blink the
     caption off; cap the hold (maxLinger seconds) so a long silence still clears
     it. Frames must be in start order. Pure + tested. */
  function fillFrameGaps(frames, maxLinger) {
    if (!frames || frames.length < 2) return frames;
    var cap = (maxLinger == null) ? 2 : maxLinger;
    for (var i = 0; i < frames.length - 1; i++) {
      var nextStart = frames[i + 1].start;
      if (nextStart > frames[i].end) {
        frames[i].end = Math.min(nextStart, frames[i].end + cap);
      }
    }
    return frames;
  }

  /* Gaps (>= threshold seconds) between consecutive cues — used to find stretches
     where the speech engine produced nothing (a "no-speech misfire"), so we can
     re-check just those spans. Returns [{from,to}] in the cues' own time base. */
  function findCueGaps(cues, threshold) {
    var gaps = [];
    if (!cues || cues.length < 2) return gaps;
    var s = cues.slice().sort(function (a, b) { return a.start - b.start; });
    for (var i = 0; i < s.length - 1; i++) {
      var d = (s[i + 1].start || 0) - (s[i].end || 0);
      if (d >= threshold) gaps.push({ from: s[i].end, to: s[i + 1].start });
    }
    return gaps;
  }

  /* True for transcript text that is almost certainly NOT real speech — the
     bracketed markers and stock hallucinations whisper emits over silence/music.
     Lets a gap re-check drop junk instead of captioning "[BLANK_AUDIO]". */
  function isLikelyNonSpeech(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return true;
    if (/^[\[(].*[\])]$/.test(t)) return true;                                  // [BLANK_AUDIO], (music), [silence]
    if (t.replace(/[^A-Za-z0-9ऀ-ॿ]/g, '').length <= 1) return true;   // punctuation / single char
    if (/^(thanks for watching|thank you|please subscribe|subscribe|bye|you|okay|ok|so|the|♪+|music)\.?$/i.test(t)) return true;
    return false;
  }

  return {
    srtTimeToSeconds: srtTimeToSeconds,
    secondsToSrtTime: secondsToSrtTime,
    parseSRT: parseSRT,
    toSRT: toSRT,
    findCueGaps: findCueGaps,
    fillFrameGaps: fillFrameGaps,
    isLikelyNonSpeech: isLikelyNonSpeech,
    VIRAL_WORDS: VIRAL_WORDS,
    EMOJI_MAP: EMOJI_MAP,
    enrichCaptionText: enrichCaptionText,
    devanagariToLatin: devanagariToLatin,
    explodeWords: explodeWords,
    framesKeywordBuild: framesKeywordBuild,
    regroupWords: regroupWords,
    remapCuesToKeeps: remapCuesToKeeps,
    mediaToTimeline: mediaToTimeline,
    timelineToMedia: timelineToMedia,
    retimeThroughRecording: retimeThroughRecording,
    STYLE_PRESETS: STYLE_PRESETS,
    TEMPLATES: TEMPLATES,
    CATEGORIES: CATEGORIES,
    inCategory: inCategory,
    sweepColor: sweepColor,
    isNearBlack: isNearBlack,
    liftDark: liftDark,
    isDarkOnLight: isDarkOnLight,
    timelineFace: timelineFace,
    isMacFace: isMacFace,
    contrastRatio: contrastRatio,
    shadeHex: shadeHex,
    NICHES: NICHES,
    NICHE_RECOMMEND: NICHE_RECOMMEND,
    getPreset: getPreset,
    animIdForConcept: animIdForConcept,
    FONTS: FONTS,
    psFontName: psFontName,
    psIsBoldFace: psIsBoldFace,
    dedupeRepeatedCues: dedupeRepeatedCues,
    enforceMinDuration: enforceMinDuration,
    mergeStyle: mergeStyle,
    ANIMATIONS: ANIMATIONS,
    getAnimation: getAnimation,
    PRESET_ANIM_MAP: PRESET_ANIM_MAP,
    planKaraoke: planKaraoke,
    planTypewriter: planTypewriter,
    markKeywords: markKeywords,
    wordSalienceScore: wordSalienceScore,
    extractSpeaker: extractSpeaker,
    detectOnsets: detectOnsets,
    alignPhrase: alignPhrase,
    alignCuesToAudio: alignCuesToAudio,
    sanitizeWordCues: sanitizeWordCues,
    buildCaptionFrames: buildCaptionFrames,
    groupWordEvents: groupWordEvents,
    // caption grammar, grouping and timing (one set of rules for every path)
    CAPTION_RULES: CAPTION_RULES,
    lineBreakCost: lineBreakCost,
    isSentenceEnd: isSentenceEnd,
    textContext: textContext,
    graphemes: graphemes,
    visLen: visLen,
    clampWordDurations: clampWordDurations,
    groupCaptionWords: groupCaptionWords,
    timeCaptions: timeCaptions,
    fpsExact: fpsExact,
    capsKey: capsKey,
    FUNCTION_WORDS: FUNCTION_WORDS,
    EMOJI_LEX: EMOJI_LEX,
    emojiForText: emojiForText,
    wrapForNative: wrapForNative,
    nativeSubtitleCues: nativeSubtitleCues
  };
});
