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
  /* The panel's language choice → Deepgram's language parameter. Deepgram
     does NOT auto-detect when the parameter is missing: it assumes English,
     so Hindi speech came back as English-sounding nonsense. nova-3's "multi"
     model understands Hindi and English mixed in one sentence (the owner's
     Hinglish), so Auto-detect and Hinglish both send language=multi; a
     language picked explicitly is sent as is (a Sarvam-style "hi-IN" → "hi"). */
  function deepgramLanguage(ui) {
    var l = String(ui == null ? '' : ui).trim();
    if (!l || l === 'auto' || l === 'hinglish' || l === 'multi' || l === 'unknown') return 'multi';
    if (/^[a-z]{2,3}-[A-Z]{2}$/.test(l) && !/^(en|pt|zh|es|fr|de|nl)-/.test(l)) return l.split('-')[0];
    return l;
  }
  /* Listen URL — nova-3 keeps every utterance; filler_words keeps um/uh; word
     timings + confidence come standard. opts:{model,language,diarize}.
     opts.language is the panel's choice (mapped by deepgramLanguage);
     diarize asks for a speaker label on every word, which the retake finder
     uses so one person echoing another is never taken for a retake. */
  function deepgramUrl(opts) {
    opts = opts || {};
    var q = [
      'model=' + (opts.model || 'nova-3'),
      'smart_format=true', 'punctuate=true', 'filler_words=true', 'utterances=true'
    ];
    if (opts.language) q.push('language=' + encodeURIComponent(deepgramLanguage(opts.language)));
    if (opts.diarize) q.push('diarize=true');
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
        var o = { text: t, start: +w.start || 0, end: +w.end || 0, conf: (w.confidence != null ? +w.confidence : null) };
        if (w.speaker != null) o.speaker = w.speaker;          // diarize=true
        out.push(o);
      }
    } catch (e) {}
    return out;
  }

  // --------------------------------------------------------- AssemblyAI ----
  /* Body for POST /v2/transcript — disfluencies keeps um/uh + false starts.
     AssemblyAI assumes English (en_us) when no language is given, so the
     panel's choice is always sent: Hindi and Hinglish → "hi", Auto-detect →
     language_detection, anything else as picked. opts:{language,
     speakerLabels, disfluencies (default true)}. */
  function assemblySubmitBody(audioUrl, opts) {
    opts = opts || {};
    var b = { audio_url: audioUrl, disfluencies: opts.disfluencies !== false, punctuate: true, format_text: true };
    var l = String(opts.language == null ? '' : opts.language).trim();
    if (l === 'hinglish') l = 'hi';
    if (/^[a-z]{2,3}-[A-Z]{2}$/.test(l)) l = l.split('-')[0];
    if (l === 'auto' || l === 'multi' || l === 'unknown') b.language_detection = true;
    else if (l) b.language_code = l;
    if (opts.speakerLabels) b.speaker_labels = true;
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
        var o = { text: t, start: (+w.start || 0) / 1000, end: (+w.end || 0) / 1000, conf: (w.confidence != null ? +w.confidence : null) };
        if (w.speaker != null) o.speaker = w.speaker;          // speaker_labels:true
        out.push(o);
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
      var endsSentence = /[.!?।॥۔؟…]["'”’)\]]*$/.test(words[i].text);   // incl. the Hindi full stop "।"
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
    deepgramLanguage: deepgramLanguage,
    deepgramUrl: deepgramUrl,
    parseDeepgram: parseDeepgram,
    assemblySubmitBody: assemblySubmitBody,
    parseAssembly: parseAssembly,
    wordsToCues: wordsToCues
  };
});
