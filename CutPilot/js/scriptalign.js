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
      .replace(/[^\wऀ-ॿ']+|[।॥]/g, '')   // the danda ends a Hindi sentence like "." does
      .replace(/^'+|'+$/g, '');
  }

  /* The comparison key: the word's SOUND skeleton when there is one (CPTakes), so
     the same word in Devanagari and Latin matches — a Hinglish script ("yeh toh
     sab jaante hain") against a transcript in Devanagari ("ये तो सब जानते हैं")
     matched 3–31% letter for letter and was refused as "another recording". */
  var _T = null;
  function takesLib() {
    if (_T) return _T;
    try { _T = (typeof CPTakes !== 'undefined' && CPTakes) || (typeof require === 'function' ? require('./takes.js') : null); } catch (e) { _T = null; }
    return _T;
  }
  function key(w) {
    var n = norm(w), T = takesLib();
    if (!T || !T._skel) return n;
    var k = T._skel(T._norm ? T._norm(w) : n);
    return k && k.length >= 2 ? '~' + k : n;
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
        // a block with nothing in common: a pre-show chat the script does not
        // have, or a script intro nobody said. That stretch is passed over —
        // on the side whose next block finds matches — instead of giving up
        // on the whole rest of a 2-hour podcast
        if (!sub.length) {
          var skipA = matchPairs(a.slice(off + cap, off + 2 * cap), sb, cap).length;
          var skipB = matchPairs(sa, b.slice(offB + cap, offB + 2 * cap), cap).length;
          if (skipA >= skipB) off += cap;
          if (skipB >= skipA) offB += cap;
          continue;
        }
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
    // a token with no letters or digits (an emoji, "—", "…") is never a
    // match: '' === '' made a wrong script look like the right one
    for (i = 0; i < tw.length; i++) an.push(key(tw[i]) || '\u0000a' + i);
    for (i = 0; i < sw.length; i++) bn.push(key(sw[i]) || '\u0000b' + i);
    var pairs = matchPairs(an, bn);
    // the share of the SHORTER side heard: a 10-minute recording full of retakes has
    // 3× the script's words, and its own script reached only a third of them
    // counted on real words only (3+ sounds): "hai", "aur", "mein" are in every Hindi
    // script and lifted a wrong one to 18%
    var big = function (k) { return k.charAt(0) === '~' && k.length >= 4; }, ca = 0, cb = 0, cp = 0;
    for (i = 0; i < an.length; i++) if (big(an[i])) ca++;
    for (i = 0; i < bn.length; i++) if (big(bn[i])) cb++;
    for (i = 0; i < pairs.length; i++) if (big(an[pairs[i][0]])) cp++;
    var rate = (ca && cb) ? cp / Math.min(ca, cb) : pairs.length / Math.min(tw.length, sw.length);
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
        // Every word taken from the SCRIPT here is a word the transcript got
        // wrong — that is the correction the owner asked for and the number the
        // panel reports back. Counting matched-but-different pairs instead
        // always gave 0, because matchPairs only pairs words that are EQUAL, so
        // "Script applied — 0 words corrected" was printed after a run that had
        // just fixed four mishearings.
        for (var fill = lastB + 1; fill < bIx; fill++) { perCue[fillCue].push(sw[fill]); replaced++; }
        perCue[cueIx].push(sw[bIx]);
        if (norm(tw[t]) !== norm(sw[bIx])) replaced++;   // paired by sound, spelled differently: a correction too
        lastB = bIx; pi++; gapOwner = -1;
      } else if (gapOwner < 0) {
        gapOwner = cueIx;      // misheard word: its cue owns the coming fill
      }
    }
    // trailing script words go to the cue whose misheard words they replace
    // (the last caption, when its words were all misheard), else to the last
    // cue that has any content
    if (lastB < sw.length - 1) {
      var lastCue = perCue.length - 1;
      if (gapOwner >= 0) lastCue = gapOwner;
      else while (lastCue > 0 && !perCue[lastCue].length) lastCue--;
      for (var r = lastB + 1; r < sw.length; r++) { perCue[lastCue].push(sw[r]); replaced++; }
    }
    var out = [];
    for (i = 0; i < src.length; i++) {
      var txt = perCue[i].join(' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
      out.push({ start: src[i].start, end: src[i].end, text: txt || src[i].text });
    }
    return { cues: out, matched: true, matchRate: rate, replaced: replaced, scriptWords: sw.length };
  }

  /* The language a script is written in, to transcribe the audio in it: on
     Auto, Hinglish speech came back TRANSLATED to English and no longer
     matched its own script. Devanagari → 'hi'; Latin letters full of Hindi's
     everyday words → 'hinglish'; anything else → null (keep Auto). */
  var HINDI_WORDS = { hai: 1, hain: 1, ka: 1, ki: 1, ke: 1, mein: 1, aur: 1, toh: 1, to: 0, ye: 1, yeh: 1, kya: 1, nahi: 1, nahin: 1,
    se: 1, ko: 1, bhi: 1, ho: 1, tha: 1, thi: 1, kar: 1, karte: 1, karna: 1, jo: 1, par: 1, apne: 1, aap: 1, hum: 1, kuch: 1, ek: 1 };
  function scriptLang(txt) {
    txt = String(txt || '');
    var dev = (txt.match(/[\u0900-\u097F]/g) || []).length, lat = (txt.match(/[A-Za-z]/g) || []).length;
    if (dev > 20 && dev > lat) return 'hi';
    var w = txt.toLowerCase().match(/[a-z]+/g) || [], hindi = 0;
    for (var i = 0; i < w.length; i++) if (HINDI_WORDS[w[i]]) hindi++;
    return (w.length >= 8 && hindi / w.length >= 0.08) ? 'hinglish' : null;
  }

  /* What a short probe transcribed IN HINDI says about the speech, for
     Auto on the on-computer engine (its own detector called Hinglish
     "English" at p = 0.85 and wrote an English TRANSLATION, with a 25×
     repetition loop). Forced to Hindi:
       Hinglish → Devanagari Hindi words mixed with Latin English ones;
       English  → Devanagari gibberish ("तोड़ बाग गुट अबाग…"), no Latin.
     'hinglish' when both scripts are there (≥15% Latin words), 'deva' when
     it is all Devanagari (pure Hindi — or English: the caller asks the
     engine's detector to tell them apart), null when there is no Hindi. */
  function probeLang(text) {
    var w = String(text || '').split(/\s+/), dev = 0, lat = 0;
    for (var i = 0; i < w.length; i++) {
      if (/[\u0900-\u097F]/.test(w[i])) dev++;
      else if (/[A-Za-z]{2,}/.test(w[i])) lat++;
    }
    if (dev < 3) return null;
    return lat / (dev + lat) >= 0.15 ? 'hinglish' : 'deva';
  }

  /* A Word file (.docx) is a zip: read word/document.xml from it and keep
     its paragraphs. inflateRaw: zlib.inflateRawSync (Node, in the panel).
     ponytail: no zip64 / encrypted files — Word never writes those for a script. */
  function docxText(buf, inflateRaw) {
    var eocd = -1;
    for (var i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This is not a Word (.docx) file.');
    var n = buf.readUInt16LE(eocd + 10), p = buf.readUInt32LE(eocd + 16);
    for (var k = 0; k < n; k++) {
      var nameLen = buf.readUInt16LE(p + 28), name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (name === 'word/document.xml') {
        var method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), loc = buf.readUInt32LE(p + 42);
        var start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28), data = buf.slice(start, start + size);
        var xml = (method === 8 ? inflateRaw(data) : data).toString('utf8');
        return xml.replace(/<w:tab\/>/g, ' ').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
          .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      }
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    throw new Error('No text found in this Word file.');
  }

  return { norm: norm, scriptWords: scriptWords, matchPairs: matchPairs, alignToScript: alignToScript, docxText: docxText, scriptLang: scriptLang, probeLang: probeLang };
});
