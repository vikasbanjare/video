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

    var user =
      'Below is a transcript as one indexed token per line: "[index] word".\n' +
      'Find spans that a good editor would CUT, and return them as index ranges.\n\n' +
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

  /* Body for the Groq (OpenAI-compatible) chat call — main.js curls this. */
  function chatBody(prompt, model) {
    return {
      model: model || 'llama-3.3-70b-versatile',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ]
    };
  }

  return {
    CATEGORIES: CATEGORIES,
    buildCleanupPrompt: buildCleanupPrompt,
    extractJson: extractJson,
    parseCleanupResponse: parseCleanupResponse,
    chatBody: chatBody
  };
});
