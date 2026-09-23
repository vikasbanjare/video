/*
 * Pulse — AI "Smart Cleanup" (the worded dead-air pass).
 *
 * An energy/VAD silence cut can only see SILENCE. It can't see the moments where
 * the speaker IS talking but saying nothing worth keeping — false starts
 * ("so the— so the main thing is…"), "umm let me think", a sentence restated
 * three times, a rambling tangent. Those need to be READ, not heard.
 *
 * This module turns the word-level transcript into a prompt for an LLM and parses
 * the spans it returns. Pure + DOM/Node-free so it unit-tests in Node; the actual
 * network call (Groq chat completions, reusing the transcription key) lives in
 * main.js. Design follows the research: put the instruction BEFORE the transcript,
 * address words by stable INDEX (LLMs drift on raw timestamps), make it return
 * index spans, bias hard toward keeping, and never cut mid-sentence.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPSmartEdit = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var CATEGORIES = ['filler', 'false_start', 'repetition', 'dead_air', 'tangent'];

  var SYSTEM =
    'You are a meticulous video editor cleaning up a spoken-word recording from its ' +
    'transcript. You remove ONLY throwaway speech and keep everything of value. You are ' +
    'conservative: when in doubt, KEEP. You never break a sentence — you only cut whole ' +
    'phrases/clauses. You reply with STRICT JSON and nothing else.';

  var CATEGORY_LINES = {
    false_start: '- "false_start": the speaker began a phrase, stopped, and restarted it (keep the completed restart, cut the aborted fragment).',
    repetition: '- "repetition": the same person said the same line more than once (a retake) — KEEP THE LAST complete attempt, cut the earlier ones.',
    filler: '- "filler": a standalone filler sound or word — English "um", "uh", "you know", "I mean", "like" used as filler; Hindi/Hinglish ' +
      '"aa", "aaa", "umm", "hmm", "उम्म", "हम्म", and "matlab"/"मतलब", "toh"/"तो", "acha"/"अच्छा", "dekho"/"देखो", "yaani"/"यानी", ' +
      '"basically", "kya bolte hain" ONLY when said on their own as a pause-filler.',
    dead_air: '- "dead_air": "let me think", "where was I", "give me a second", "ek second", "kya bol raha tha main" — talking that says nothing.',
    tangent: '- "tangent": a clearly abandoned off-topic aside the speaker drops.'
  };

  /* The categories a cleanup pass may return. opts.fillers === false drops
     "filler" (the Filler words box is unticked); opts.tangents === false drops
     "tangent" (a podcast's side stories are content). */
  function cleanupCategories(opts) {
    opts = opts || {};
    return CATEGORIES.filter(function (c) {
      if (c === 'filler' && opts.fillers === false) return false;
      if (c === 'tangent' && opts.tangents === false) return false;
      return true;
    });
  }

  /* The words a prompt indexes — parse MUST map indices back through the same list. */
  function promptWords(words) { return (words || []).filter(function (w) { return w && w.text != null; }); }
  function speakerTag(s) { return (typeof s === 'number') ? 'S' + (s + 1) : 'S-' + String(s); }

  /* Build the {system, user} messages. `words` = [{text,start,end,conf?,speaker?}].
     opts.aggressive loosens the bias slightly; opts.scripted adds the
     re-recorded-script context; opts.fillers / opts.tangents === false leave
     those categories out. */
  function buildCleanupPrompt(words, opts) {
    opts = opts || {};
    var ws = promptWords(words);
    var lines = [], hasSpeakers = false;
    for (var i = 0; i < ws.length; i++) {
      // index + word only — compact, and we map back to time by index ourselves.
      // A speaker label is written only where the speaker changes.
      var sp = ws[i].speaker, tag = '';
      if (sp != null && sp !== '' && (i === 0 || ws[i - 1].speaker !== sp)) { tag = '(' + speakerTag(sp) + ') '; hasSpeakers = true; }
      lines.push('[' + i + '] ' + tag + String(ws[i].text).replace(/\s+/g, ' ').trim());
    }
    var cats = cleanupCategories(opts);
    var bias = opts.aggressive
      ? 'Lean toward a tighter cut, but never remove a real, on-topic sentence.'
      : 'Strongly bias toward KEEPING. Only cut what is clearly throwaway.';

    // The defining case: a SCRIPT re-recorded many times in one continuous take.
    var scripted = opts.scripted
      ? 'IMPORTANT CONTEXT: this is usually a SCRIPT being re-recorded — the speaker reads the same lines ' +
        'several times without stopping the camera, with off-script talking ("ok again", "wait", "let me redo that", ' +
        '"ruko, ek baar phir se", random chatter) BETWEEN the attempts. Your main job: for every line that is read more than once, KEEP ONLY ' +
        'THE LAST clean, complete take and cut ALL earlier attempts, AND cut every off-script bit between takes. The ' +
        'final result must read like ONE clean pass of the script. (If two or more people are talking, this applies only ' +
        'to a line ONE person re-reads — never to an answer that repeats a question.)\n\n'
      : '';

    var language =
      'LANGUAGE: the transcript may be English, Hindi in Devanagari, Hinglish (Hindi written in English letters) or a mix. ' +
      'Hindi doubles words ON PURPOSE for meaning — "dheere dheere", "jaldi jaldi", "alag alag", "kabhi kabhi", "saath saath", ' +
      '"haan haan", "bahut bahut", "धीरे धीरे", "जल्दी जल्दी" — that is NOT a repetition, a stutter or a retake. Words like ' +
      '"matlab", "toh", "acha", "aa" are real speech when they carry meaning ("iska matlab hai" = "it means", "aa jao" = "come", ' +
      '"phir toh" = "then").\n' +
      'SPEAKERS: ' + (hasSpeakers ? 'a label like (S2) marks where a new person starts talking. ' : '') +
      'If more than one person is talking (a podcast or interview), one person echoing another — an answer that repeats the ' +
      'question\'s words, or agreeing in the same words — is NOT a retake. A retake is the SAME person saying the same line again.\n\n';

    var catLines = [];
    for (var c = 0; c < cats.length; c++) catLines.push(CATEGORY_LINES[cats[c]]);

    var user =
      'Below is a transcript as one indexed token per line: "[index] word".\n' +
      'Find spans that a good editor would CUT, and return them as index ranges.\n\n' + scripted + language +
      'CUT only these, by category:\n' + catLines.join('\n') + '\n\n' +
      'HARD RULES:\n' +
      '1. NEVER cut mid-sentence. A cut must span whole phrases/clauses only.\n' +
      '2. ' + bias + '\n' +
      '3. Do NOT cut intentional rhetorical repetition (e.g. "no, no, no" for emphasis) or Hindi word-doubling ("dheere dheere").\n' +
      '4. For a retake said N times, cut all but the LAST complete one.\n' +
      '5. Never cut what one speaker said because another speaker repeated it.\n' +
      '6. Index ranges are INCLUSIVE and must exist in the list above.\n\n' +
      'Reply with STRICT JSON only:\n' +
      '{"cuts":[{"from":<int>,"to":<int>,"category":"' + cats.join('|') + '","reason":"<short>","confidence":<0..1>}]}\n' +
      'If nothing should be cut, reply {"cuts":[]}.\n\n' +
      'TRANSCRIPT:\n' + lines.join('\n');

    return { system: SYSTEM, user: user, count: ws.length };
  }

  /* Index of the bracket that closes the {…} or […] opening at s[a], or -1
     (a reply cut off by the token limit never closes). Strings are skipped. */
  function closeAt(s, a) {
    var stack = [], inStr = false, esc = false;
    for (var i = a; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
      else if (c === '}' || c === ']') {
        if (stack.pop() !== c) return -1;
        if (!stack.length) return i;
      }
    }
    return -1;
  }
  /* JSON.parse, forgiving the slips models make: trailing commas, curly quotes. */
  function tryParse(str) {
    try { return { v: JSON.parse(str), s: str }; } catch (e) {}
    var t = String(str).replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1');
    try { return { v: JSON.parse(t), s: t }; } catch (e2) {}
    return null;
  }

  /* Pull the first balanced {...} JSON object that actually parses out of a
     model reply wrapped in prose or ```json fences ("Here you go {as asked}:
     {…}" no longer derails it). Returns the JSON text, or null. */
  function extractJson(text) {
    if (text == null) return null;
    var s = String(text), tries = 0;
    for (var a = s.indexOf('{'); a >= 0 && tries < 200; a = s.indexOf('{', a + 1), tries++) {
      var b = closeAt(s, a);
      if (b < 0) continue;
      var p = tryParse(s.slice(a, b + 1));
      if (p && p.v && typeof p.v === 'object') return p.s;
    }
    return null;
  }

  var FROM_KEYS = ['from', 'start', 'start_index', 'startIndex', 'start_idx', 'from_index', 'fromIndex', 'begin', 'first'];
  var TO_KEYS = ['to', 'end', 'end_index', 'endIndex', 'end_idx', 'to_index', 'toIndex', 'stop', 'last'];
  var LIST_KEY = /^(cuts|edits|segments|removals|remove|deletions|deletes|ranges|spans|items|results|cut_list|cutlist)$/i;
  function pick(o, keys) { for (var i = 0; i < keys.length; i++) if (o[keys[i]] != null) return o[keys[i]]; return null; }
  /* An index: 7, "7", "[7]", "w7" — but not 7.5 (that is a time, not an index). */
  function toIndex(v) {
    if (typeof v === 'number') return (isFinite(v) && Math.floor(v) === v) ? v : NaN;
    if (Array.isArray(v) && v.length === 1) return toIndex(v[0]);
    var m = /^[^\d-]*(-?\d+)(?![.\d])/.exec(String(v));
    return m ? parseInt(m[1], 10) : NaN;
  }
  function span(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    var f = pick(o, FROM_KEYS), t = pick(o, TO_KEYS);
    var r = o.range || o.span || o.indices;
    if ((f == null || t == null) && Array.isArray(r) && r.length) { f = r[0]; t = r[r.length - 1]; }
    if (f == null && t == null && (o.index != null || o.idx != null)) f = t = (o.index != null ? o.index : o.idx);
    if (f == null || t == null) return null;
    return { from: toIndex(f), to: toIndex(t) };
  }
  /* The list of cuts inside a whole reply document: a bare array, or an array
     under "cuts" / "edits" / "segments" / … (one or two levels down). A lone
     cut object is not a document — the scan in replyCuts collects those. */
  function docList(v, depth) {
    if (Array.isArray(v)) {
      if (!v.length) return v;
      for (var i = 0; i < v.length; i++) if (span(v[i])) return v;
      return null;
    }
    if (!v || typeof v !== 'object') return null;
    var k;
    for (k in v) if (Object.prototype.hasOwnProperty.call(v, k) && LIST_KEY.test(k) && Array.isArray(v[k])) return v[k];
    if ((depth || 0) < 2) for (k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k) && v[k] && typeof v[k] === 'object') {
        var l = docList(v[k], (depth || 0) + 1);
        if (l) return l;
      }
    }
    return null;
  }
  /* Every cut the reply holds. A reply cut off mid-list (max_tokens) still
     yields the cuts that were complete, instead of silently nothing. */
  /* The list of cuts from the first complete reply document, or null. */
  function replyDoc(s) {
    var tries = 0, i;
    for (i = 0; i < s.length && tries < 200; i++) {
      var ch = s.charAt(i);
      if (ch !== '{' && ch !== '[') continue;
      tries++;
      var b = closeAt(s, i);
      if (b < 0) continue;                       // never closes (cut off) — look inside it
      var p = tryParse(s.slice(i, b + 1));
      var l = p ? docList(p.v, 0) : null;
      if (l) return l;
      if (p) i = b;                              // parsed, but not a reply document: skip past it
    }
    return null;
  }
  function replyCuts(text) {
    if (text == null) return [];
    var s = String(text), doc = replyDoc(s);
    if (doc) return doc;
    // no complete reply document: recover each complete flat {...} that is a cut
    var out = [], m, re = /\{[^{}]*\}/g;
    while ((m = re.exec(s))) {
      var q = tryParse(m[0]);
      if (q && span(q.v)) out.push(q.v);
    }
    return out;
  }
  /* Was the reply cut off (the token limit hit mid-list)? No complete reply
     document, but a bracket that opens and never closes. parseCleanupResponse
     still keeps the cuts that were complete; everything after the cut-off
     point is lost, so the caller asks again about the chunk in two halves. */
  function replyTruncated(text) {
    if (text == null) return false;
    var s = String(text), a = s.search(/[\[{]/);
    return a >= 0 && !replyDoc(s) && closeAt(s, a) < 0;
  }
  var CAT_ALIAS = {
    filler: 'filler', fillers: 'filler', filler_word: 'filler', filler_words: 'filler', disfluency: 'filler', um: 'filler',
    false_start: 'false_start', falsestart: 'false_start', false_starts: 'false_start', restart: 'false_start', stutter: 'false_start',
    repetition: 'repetition', repeat: 'repetition', repeated: 'repetition', retake: 'repetition', retakes: 'repetition',
    duplicate: 'repetition', repeated_take: 'repetition',
    dead_air: 'dead_air', deadair: 'dead_air', silence: 'dead_air', pause: 'dead_air', thinking: 'dead_air',
    tangent: 'tangent', off_topic: 'tangent', offtopic: 'tangent', aside: 'tangent', off_script: 'tangent'
  };
  function normCategory(c) {
    var k = String(c == null ? '' : c).toLowerCase().trim().replace(/[\s\-]+/g, '_');
    return CAT_ALIAS[k] || (CATEGORIES.indexOf(k) >= 0 ? k : 'cut');
  }

  /*
   * Parse the model reply into delete ranges in the words' own time base.
   * Returns [{start,end,text,reason,label,confidence,fromIdx,toIdx,needsReview?}]
   * — validated, in-range, non-empty, sorted. Never throws: a flaky reply
   * degrades to fewer cuts, never to a crash.
   *   - accepts {"cuts":[…]}, a bare array, other list keys (edits, segments…),
   *     start/end for from/to, "[7]"/"7" indices, trailing commas, prose around
   *     the JSON, and a reply cut off mid-list (the complete cuts are kept);
   *   - an end index 1–2 past the last word is the model's off-by-one and is
   *     clamped; anything further out is DROPPED — it used to be stretched to
   *     the end of the chunk, deleting minutes of speech;
   *   - a cut longer than 45 s or a quarter of the chunk is kept but marked
   *     needsReview (the review list leaves it unticked);
   *   - opts.categories limits which labels are returned.
   */
  function parseCleanupResponse(text, words, opts) {
    opts = opts || {};
    var minConf = (opts.minConfidence != null) ? opts.minConfidence : 0;
    var allowed = opts.categories || null;
    var ws = promptWords(words), N = ws.length;
    var cuts = replyCuts(text);
    var out = [];
    for (var i = 0; i < cuts.length; i++) {
      var c = cuts[i] || {}, sp = span(c);
      if (!sp) continue;
      var from = sp.from, to = sp.to;
      if (isNaN(from) || isNaN(to)) continue;
      if (from < 0 || from >= N || to < from) continue;
      if (to >= N) { if (to <= N + 1) to = N - 1; else continue; }
      if (!ws[from] || !ws[to]) continue;
      var conf = (c.confidence != null) ? parseFloat(c.confidence) : 1;
      if (isNaN(conf)) conf = 1;
      if (conf > 1 && conf <= 100) conf = conf / 100;
      if (conf < minConf) continue;
      var label = normCategory(c.category != null ? c.category : (c.type != null ? c.type : c.label));
      if (allowed && allowed.indexOf(label) < 0) continue;
      var txt = [];
      for (var k = from; k <= to; k++) txt.push(String(ws[k].text).trim());
      var start = +ws[from].start, end = +ws[to].end;
      if (!(end > start)) continue;
      var o = {
        start: start, end: end, text: txt.join(' '),
        reason: (c.reason ? String(c.reason) : label).slice(0, 80),
        label: label, confidence: conf, fromIdx: from, toIdx: to
      };
      if (end - start > 45 || (N >= 40 && (to - from + 1) > N * 0.25)) o.needsReview = true;
      out.push(o);
    }
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /* Split n words into chunks of `size` that OVERLAP by `overlap` words, so a
     retake straddling a boundary is seen whole by one chunk. Each chunk owns
     the half of each overlap nearest to it: a cut is taken from the chunk that
     owns its first word, which saw it with the most context around it.
     Returns [{from,to,ownFrom,ownTo}] (to/ownTo exclusive). */
  function planChunks(n, size, overlap) {
    size = Math.max(1, size || 1000);
    overlap = Math.max(0, Math.min(overlap || 0, Math.floor(size / 2)));
    var out = [], from = 0;
    if (!(n > 0)) return out;
    for (;;) {
      var to = Math.min(n, from + size);
      out.push({ from: from, to: to });
      if (to >= n) break;
      from = to - overlap;
    }
    for (var k = 0; k < out.length; k++) {
      out[k].ownFrom = (k === 0) ? 0 : Math.floor((out[k].from + out[k - 1].to) / 2);
      out[k].ownTo = (k === out.length - 1) ? n : Math.floor((out[k + 1].from + out[k].to) / 2);
    }
    return out;
  }
  /* A chunk from planChunks split into two halves that overlap by `overlap`
     words and share the chunk's own range between them — the re-ask when a
     reply about the whole chunk was cut off. Same shape as planChunks. */
  function splitChunk(pc, overlap) {
    var mid = Math.floor((pc.from + pc.to) / 2), h = Math.floor(Math.max(0, overlap || 0) / 2);
    var ownFrom = (pc.ownFrom != null) ? pc.ownFrom : pc.from, ownTo = (pc.ownTo != null) ? pc.ownTo : pc.to;
    var cut = Math.min(Math.max(mid, ownFrom), ownTo);
    return [{ from: pc.from, to: Math.min(pc.to, mid + h), ownFrom: ownFrom, ownTo: cut },
            { from: Math.max(pc.from, mid - h), to: pc.to, ownFrom: cut, ownTo: ownTo }];
  }
  /* Combine per-chunk parsed cuts (perChunk[k] = parseCleanupResponse of chunk
     k) into one sorted list: keep each cut only from the chunk that owns its
     first word, then merge cuts that overlap in time. */
  function mergeChunkCuts(plan, perChunk) {
    var all = [];
    for (var k = 0; k < plan.length; k++) {
      var list = (perChunk && perChunk[k]) || [];
      for (var i = 0; i < list.length; i++) {
        var g = plan[k].from + (list[i].fromIdx || 0);
        if (g < plan[k].ownFrom || g >= plan[k].ownTo) continue;
        var o = {}; for (var p in list[i]) if (Object.prototype.hasOwnProperty.call(list[i], p)) o[p] = list[i][p];
        o.fromIdx = g; o.toIdx = plan[k].from + (list[i].toIdx || 0);
        all.push(o);
      }
    }
    all.sort(function (a, b) { return a.start - b.start; });
    var out = [];
    for (var j = 0; j < all.length; j++) {
      var last = out[out.length - 1];
      if (last && all[j].start < last.end) {
        if (all[j].end > last.end) {
          last.end = all[j].end; last.toIdx = all[j].toIdx;
          if (all[j].text && last.text.indexOf(all[j].text) < 0) last.text += ' / ' + all[j].text;
        }
        if (all[j].needsReview) last.needsReview = true;
      } else out.push(all[j]);
    }
    return out;
  }
  // ====================================================== VIRAL HIGHLIGHTS ==
  // Long video → short clips. The LLM reads the transcript (segment-indexed) and
  // returns the most clippable moments — each a self-contained thought that opens
  // on a hook — scored Opus-style on hook/flow/value. We address SEGMENTS by
  // index (not raw timestamps the model drifts on) and map back to time here.

  var HL_SYSTEM =
    'You are a viral short-form video editor who has studied thousands of TikToks, Reels and ' +
    'YouTube Shorts. You find the moments in a long video that would perform best as standalone ' +
    'short clips. You only pick self-contained moments that make sense with no other context, ' +
    'that open with a strong hook, and that end on a clean payoff. You reply with STRICT JSON only.';

  function mmss(sec) {
    sec = Math.max(0, Math.round(+sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* Build the {system,user} highlight prompt from sentence-level segments
     [{text,start,end}]. opts: {min,max} target clip length in seconds, count. */
  function buildHighlightPrompt(segments, opts) {
    opts = opts || {};
    var minS = opts.min || 15, maxS = opts.max || 60, want = opts.count || 8;
    var segs = (segments || []).filter(function (s) { return s && s.text != null; });
    var lines = [];
    for (var i = 0; i < segs.length; i++) {
      lines.push('[' + i + '] (' + mmss(segs[i].start) + ') ' + String(segs[i].text).replace(/\s+/g, ' ').trim());
    }
    var user =
      'Below is a video transcript, one indexed segment per line: "[index] (m:ss) text".\n' +
      'Pick the best moments to cut as vertical short clips and return them as INCLUSIVE index ranges.\n\n' +
      'Each clip MUST:\n' +
      '- be a self-contained thought that makes sense on its own (no "as I said earlier"),\n' +
      '- OPEN on a hook (a question, bold claim, surprising line, or strong statement),\n' +
      '- end on a clean payoff/punchline — never mid-sentence,\n' +
      '- be roughly ' + minS + '–' + maxS + ' seconds long.\n\n' +
      'Score each 0–100 on: HOOK (grabs attention in 3s), FLOW (complete arc), VALUE (emotional or useful payoff).\n' +
      'Return up to ' + want + ' clips, best first. Prefer fewer, stronger clips over many weak ones.\n\n' +
      'Reply with STRICT JSON only:\n' +
      '{"clips":[{"from":<int>,"to":<int>,"title":"<catchy 3-6 word title>","hook":"<the opening hook line>","score":<0-100>,"reason":"<why it pops, short>"}]}\n' +
      'If nothing is clip-worthy, reply {"clips":[]}.\n\n' +
      'TRANSCRIPT:\n' + lines.join('\n');
    return { system: HL_SYSTEM, user: user, count: segs.length };
  }

  /* Parse highlight reply → [{start,end,title,hook,score,reason,text}] sorted by
     score desc, duration-guarded. Malformed entries are dropped (never throws). */
  function parseHighlightResponse(text, segments, opts) {
    opts = opts || {};
    var minS = opts.min != null ? opts.min : 6, maxS = opts.max != null ? opts.max : 120;
    var segs = segments || [];
    var raw = extractJson(text);
    if (!raw) return [];
    var obj; try { obj = JSON.parse(raw); } catch (e) { return []; }
    var clips = obj && obj.clips;
    if (!clips || !clips.length) return [];
    var out = [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i] || {};
      var from = parseInt(c.from, 10), to = parseInt(c.to, 10);
      if (isNaN(from) || isNaN(to)) continue;
      if (from < 0) from = 0;
      if (to >= segs.length) to = segs.length - 1;
      if (to < from) continue;
      if (!segs[from] || !segs[to]) continue;
      var start = +segs[from].start, end = +segs[to].end, dur = end - start;
      if (!(dur > 0) || dur < minS || dur > maxS) continue;
      var score = (c.score != null) ? Math.max(0, Math.min(100, +c.score || 0)) : 50;
      var bodyTxt = [];
      for (var k = from; k <= to; k++) bodyTxt.push(String(segs[k].text).trim());
      out.push({
        start: start, end: end, dur: dur,
        title: (c.title ? String(c.title) : 'Clip').slice(0, 60),
        hook: (c.hook ? String(c.hook) : '').slice(0, 120),
        score: score,
        reason: (c.reason ? String(c.reason) : '').slice(0, 120),
        text: bodyTxt.join(' ')
      });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  /* Body for the Groq (OpenAI-compatible) chat call — main.js curls this.
     maxTokens caps the RESPONSE so the request total stays under the tier's
     tokens-per-minute limit (the whole transcript in one shot blew past it). */
  function chatBody(prompt, model, maxTokens) {
    var b = {
      model: model || 'llama-3.3-70b-versatile',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ]
    };
    if (maxTokens) b.max_tokens = maxTokens;
    return b;
  }

  /* Prompt for a short title from a transcript (names new sequences). */
  function buildTitlePrompt(text) {
    return {
      system: 'You write short, punchy video titles. Reply with STRICT JSON only, no emojis, no surrounding quotes.',
      user: 'Give a catchy 3–6 word title for this video, usable as a clip/sequence name.\n' +
        'Reply: {"title":"..."}\n\nTRANSCRIPT:\n' + String(text || '').slice(0, 4000)
    };
  }
  function parseTitle(textResp) {
    var raw = extractJson(textResp); if (!raw) return '';
    try { var o = JSON.parse(raw); return (o && o.title != null) ? String(o.title).replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 60) : ''; }
    catch (e) { return ''; }
  }

  /* Split an array into chunks of at most `size` items (used to keep each
     transcript request under the token-per-minute limit). Pure. */
  function chunk(arr, size) {
    arr = arr || []; size = Math.max(1, size || 800);
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  return {
    CATEGORIES: CATEGORIES,
    buildCleanupPrompt: buildCleanupPrompt,
    extractJson: extractJson,
    parseCleanupResponse: parseCleanupResponse,
    buildHighlightPrompt: buildHighlightPrompt,
    parseHighlightResponse: parseHighlightResponse,
    buildTitlePrompt: buildTitlePrompt,
    parseTitle: parseTitle,
    mmss: mmss,
    chunk: chunk,
    planChunks: planChunks,
    splitChunk: splitChunk,
    mergeChunkCuts: mergeChunkCuts,
    replyTruncated: replyTruncated,
    cleanupCategories: cleanupCategories,
    chatBody: chatBody
  };
});
