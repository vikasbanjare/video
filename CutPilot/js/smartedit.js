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

  /* Build the {system, user} messages. `words` = [{text,start,end,conf?}].
     opts.aggressive (bool) loosens the bias slightly; opts.maxWords caps size. */
  function buildCleanupPrompt(words, opts) {
    opts = opts || {};
    var ws = (words || []).filter(function (w) { return w && w.text != null; });
    var lines = [];
    for (var i = 0; i < ws.length; i++) {
      // index + word only — compact, and we map back to time by index ourselves.
      lines.push('[' + i + '] ' + String(ws[i].text).replace(/\s+/g, ' ').trim());
    }
    var bias = opts.aggressive
      ? 'Lean toward a tighter cut, but never remove a real, on-topic sentence.'
      : 'Strongly bias toward KEEPING. Only cut what is clearly throwaway.';

    // The defining case: a SCRIPT re-recorded many times in one continuous take.
    var scripted = opts.scripted
      ? 'IMPORTANT CONTEXT: this is usually a SCRIPT being re-recorded — the speaker reads the same lines ' +
        'several times without stopping the camera, with off-script talking ("ok again", "wait", "let me redo that", ' +
        'random chatter) BETWEEN the attempts. Your main job: for every line that is read more than once, KEEP ONLY ' +
        'THE LAST clean, complete take and cut ALL earlier attempts, AND cut every off-script bit between takes. The ' +
        'final result must read like ONE clean pass of the script.\n\n'
      : '';

    var user =
      'Below is a transcript as one indexed token per line: "[index] word".\n' +
      'Find spans that a good editor would CUT, and return them as index ranges.\n\n' + scripted +
      'CUT only these, by category:\n' +
      '- "false_start": the speaker began a phrase, stopped, and restarted it (keep the completed restart, cut the aborted fragment).\n' +
      '- "repetition": the same line was said more than once (a retake) — KEEP THE LAST/best attempt, cut the earlier ones.\n' +
      '- "filler": standalone filler ("um", "uh", "you know", "I mean", "like" used as filler).\n' +
      '- "dead_air": "let me think", "where was I", "give me a second" — talking that says nothing.\n' +
      '- "tangent": a clearly abandoned off-topic aside the speaker drops.\n\n' +
      'HARD RULES:\n' +
      '1. NEVER cut mid-sentence. A cut must span whole phrases/clauses only.\n' +
      '2. ' + bias + '\n' +
      '3. Do NOT cut intentional rhetorical repetition (e.g. "no, no, no" for emphasis).\n' +
      '4. For a retake said N times, cut all but the LAST complete one.\n' +
      '5. Index ranges are INCLUSIVE and must exist in the list above.\n\n' +
      'Reply with STRICT JSON only:\n' +
      '{"cuts":[{"from":<int>,"to":<int>,"category":"false_start|repetition|filler|dead_air|tangent","reason":"<short>","confidence":<0..1>}]}\n' +
      'If nothing should be cut, reply {"cuts":[]}.\n\n' +
      'TRANSCRIPT:\n' + lines.join('\n');

    return { system: SYSTEM, user: user, count: ws.length };
  }

  /* Pull the first balanced {...} JSON object out of a model reply that may be
     wrapped in prose or ```json fences. */
  function extractJson(text) {
    if (text == null) return null;
    var s = String(text);
    var a = s.indexOf('{');
    if (a < 0) return null;
    var depth = 0, inStr = false, esc = false;
    for (var i = a; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return s.slice(a, i + 1); }
    }
    return null;
  }

  /*
   * Parse the model reply into delete ranges in the words' own time base.
   * Returns [{start,end,text,reason,label,confidence}] — validated, in-range,
   * non-empty, sorted. Anything malformed is dropped (never throws), so a flaky
   * model reply degrades to "found nothing" rather than a crash.
   */
  function parseCleanupResponse(text, words, opts) {
    opts = opts || {};
    var minConf = (opts.minConfidence != null) ? opts.minConfidence : 0;
    var ws = words || [];
    var raw = extractJson(text);
    if (!raw) return [];
    var obj; try { obj = JSON.parse(raw); } catch (e) { return []; }
    var cuts = obj && obj.cuts;
    if (!cuts || !cuts.length) return [];
    var out = [];
    for (var i = 0; i < cuts.length; i++) {
      var c = cuts[i] || {};
      var from = parseInt(c.from, 10), to = parseInt(c.to, 10);
      if (isNaN(from) || isNaN(to)) continue;
      if (from < 0) from = 0;
      if (to >= ws.length) to = ws.length - 1;
      if (to < from) continue;
      if (!ws[from] || !ws[to]) continue;
      var conf = (c.confidence != null) ? +c.confidence : 1;
      if (isNaN(conf)) conf = 1;
      if (conf < minConf) continue;
      var label = (CATEGORIES.indexOf(c.category) >= 0) ? c.category : 'cut';
      var txt = [];
      for (var k = from; k <= to; k++) txt.push(String(ws[k].text).trim());
      var start = +ws[from].start, end = +ws[to].end;
      if (!(end > start)) continue;
      out.push({
        start: start, end: end, text: txt.join(' '),
        reason: (c.reason ? String(c.reason) : label).slice(0, 80),
        label: label, confidence: conf
      });
    }
    out.sort(function (a, b) { return a.start - b.start; });
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
    // No hardcoded id here either — main.js resolves a live model against Groq's
    // own /models list and passes it in. A stale pin is what broke every AI fix
    // when Groq decommissioned llama-3.3-70b-versatile.
    if (!model) throw new Error('chatBody: pass the model main.js resolved via groqChat — do not pin one here.');
    var b = {
      model: model,
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
    chatBody: chatBody
  };
});
