/*
 * Pulse — verbatim transcription (for retake removal).
 *
 * Groq's Whisper produces a CLEAN "intended" transcript — it drops/merges
 * repeated re-reads by design, so the retakes the editor needs to find aren't
 * even in the text. This module talks to a VERBATIM engine that keeps every
 * take + filler with a per-word confidence:
 *   - Deepgram  (one POST: ?filler_words=true&punctuate=true)
 *   - AssemblyAI (upload → submit disfluencies=true → poll)
 * Pure request-builders + response parsers (DOM/Node-free, unit-tested); the
 * actual curl/upload/poll lives in main.js. Every parser returns the same shape:
 *   [{ text, start, end, conf }]  (seconds; conf 0..1)
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPVerbatim = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // ----------------------------------------------------------- Deepgram ----
  /* Listen URL — nova-3 keeps every utterance; filler_words keeps um/uh; word
     timings + confidence come standard. opts:{model,language}. */
  function deepgramUrl(opts) {
    opts = opts || {};
    var q = [
      'model=' + (opts.model || 'nova-3'),
      'smart_format=true', 'punctuate=true', 'filler_words=true', 'utterances=true'
    ];
    if (opts.language && opts.language !== 'auto') q.push('language=' + encodeURIComponent(opts.language));
    return 'https://api.deepgram.com/v1/listen?' + q.join('&');
  }
  /* Deepgram JSON → words. Prefers the punctuated_word form when present. */
  function parseDeepgram(json) {
    var out = [];
    try {
      var alts = json.results.channels[0].alternatives;
      var words = (alts && alts[0] && alts[0].words) || [];
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var t = (w.punctuated_word != null ? w.punctuated_word : w.word);
        if (t == null) continue; t = String(t).trim(); if (!t) continue;
        out.push({ text: t, start: +w.start || 0, end: +w.end || 0, conf: (w.confidence != null ? +w.confidence : null) });
      }
    } catch (e) {}
    return out;
  }

  // --------------------------------------------------------- AssemblyAI ----
  /* Body for POST /v2/transcript — disfluencies keeps um/uh + false starts. */
  function assemblySubmitBody(audioUrl, opts) {
    opts = opts || {};
    var b = { audio_url: audioUrl, disfluencies: true, punctuate: true, format_text: true };
    if (opts.language && opts.language !== 'auto') b.language_code = opts.language;
    return b;
  }
  /* AssemblyAI completed-transcript JSON → words (start/end are MILLISECONDS). */
  function parseAssembly(json) {
    var out = [];
    try {
      var words = json.words || [];
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var t = (w.text != null) ? String(w.text).trim() : '';
        if (!t) continue;
        out.push({ text: t, start: (+w.start || 0) / 1000, end: (+w.end || 0) / 1000, conf: (w.confidence != null ? +w.confidence : null) });
      }
    } catch (e) {}
    return out;
  }

  /* Group a word stream into sentence-ish cues (so the rest of the pipeline,
     which expects {text,start,end}, can use a verbatim transcript). Splits on
     sentence punctuation or a pause > gap. */
  function wordsToCues(words, gap) {
    gap = (gap != null) ? gap : 0.7;
    var cues = [], cur = [];
    for (var i = 0; i < (words || []).length; i++) {
      cur.push(words[i]);
      var endsSentence = /[.!?]["')\]]?$/.test(words[i].text);
      var g = (i + 1 < words.length) ? (words[i + 1].start - words[i].end) : 99;
      if (endsSentence || g > gap || cur.length >= 16) {
        cues.push({ text: cur.map(function (x) { return x.text; }).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
        cur = [];
      }
    }
    if (cur.length) cues.push({ text: cur.map(function (x) { return x.text; }).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
    return cues;
  }

  return {
    deepgramUrl: deepgramUrl,
    parseDeepgram: parseDeepgram,
    assemblySubmitBody: assemblySubmitBody,
    parseAssembly: parseAssembly,
    wordsToCues: wordsToCues
  };
});
