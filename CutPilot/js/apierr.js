/*
 * Pulse — provider failure → plain language + what to do.
 *
 * Every cloud call used to surface the provider's raw string:
 *     reject(new Error('Groq: ' + j.error.message))
 * which is how a non-technical user came to read
 *     "Cloud: The model `llama-3.3-70b-versatile` does not exist or you do not
 *      have access to it."
 * — accurate, unactionable, and repeated verbatim in three places for three
 * different providers.
 *
 * This maps any provider failure to { kind, message, action }:
 *   kind    — a stable code the caller can branch on (the model-retired path
 *             retries on 'model_gone'; nothing else should string-match)
 *   message — what happened, in words the owner can act on
 *   action  — the single next step, or '' when there is nothing to do
 *
 * DOM/Node-free and unit-tested, like ass.js and verbatim.js. The raw provider
 * text is preserved on .detail so diagnostics keep the full story.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPApiErr = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* Friendly provider names — never leak an internal id into a message. */
  var LABEL = { groq: 'Cloud transcription', deepgram: 'Deepgram', sarvam: 'Indian Voices', assemblyai: 'AssemblyAI' };
  function label(p) { return LABEL[p] || 'The transcription service'; }

  /* Where the user fixes a key for each provider. */
  var KEYBOX = {
    groq: 'Settings → Auto-transcribe (the ☁️ box)',
    deepgram: 'Settings → Auto-transcribe → More speech options (the 🎧 box)',
    sarvam: 'Settings → Auto-transcribe → More speech options (the 🇮🇳 box)',
    assemblyai: 'Settings → Retake finder'
  };
  function keybox(p) { return KEYBOX[p] || 'Settings → Auto-transcribe'; }

  /* curl exit codes that mean "the request never left / never landed". */
  var NET_CURL = { 5: 1, 6: 1, 7: 1, 28: 1, 35: 1, 52: 1, 56: 1 };

  /* Classify. Accepts whatever the call sites actually have: an http status, a
     curl exit code, the parsed JSON body, and/or a raw string. Any subset. */
  function classify(provider, info) {
    info = info || {};
    var status = info.status != null ? +info.status : null;
    var curl = info.curl != null ? +info.curl : null;
    var body = info.body || null;
    // Providers disagree on where the reason lives: OpenAI-style nests it under
    // error.message, Deepgram puts prose in err_msg and a CODE in err_code
    // ("INVALID_AUTH"), Sarvam uses error.message. Match against ALL of it —
    // reading only the prose classified Deepgram's bad key as "unknown".
    var parts = [];
    if (info.raw != null) parts.push(String(info.raw));
    if (body) {
      if (body.error) parts.push(typeof body.error === 'string' ? body.error : (body.error.message || body.error.code || ''));
      if (body.error && body.error.code) parts.push(String(body.error.code));
      ['message', 'err_msg', 'err_code', 'reason', 'detail', 'code', 'status'].forEach(function (k) {
        if (body[k] != null && typeof body[k] !== 'object') parts.push(String(body[k]));
      });
    }
    var raw = parts.filter(Boolean).join(' ').trim();
    var L = label(provider);

    function out(kind, message, action) {
      return { kind: kind, provider: provider || '', message: message, action: action || '', detail: raw };
    }

    // --- the request never completed -------------------------------------
    if (curl != null && NET_CURL[curl]) {
      return out('network', L + ' could not be reached.',
        'Check your internet connection and try again.');
    }
    if (curl != null && curl !== 0) {
      return out('request_failed', L + ' did not answer (connection error ' + curl + ').',
        'Try again. If it keeps happening, check your internet connection or firewall.');
    }

    // --- authentication ---------------------------------------------------
    if (status === 401 || status === 403 ||
        /invalid[ _-]?api[ _-]?key|invalid_api_key|invalid[ _-]?auth|invalid credential|unauthorized|unauthorised|authentication fail|invalid token|not authorized|forbidden|permission denied/i.test(raw)) {
      return out('bad_key', L + ' did not accept your key.',
        'Check the key in ' + keybox(provider) + ' — copy it again from the provider, with no spaces at the ends.');
    }

    // --- the model is gone (the reported failure) -------------------------
    if (/does not exist or you do not have access|model_not_found|decommissioned|(\bmodel\b[\s\S]{0,40}not found)/i.test(raw)) {
      return out('model_gone', 'The AI model Pulse was using has been retired by the provider.',
        'Pulse picks a current one automatically — try again. If it keeps failing, check your internet connection.');
    }

    // --- capacity ---------------------------------------------------------
    if (status === 429 || /rate.?limit|too many requests|quota exceeded|tokens per (minute|day)/i.test(raw)) {
      return out('rate_limit', L + ' is busy or you have hit its free-tier limit.',
        'Wait a minute and try again. Long videos use more of the limit than short ones.');
    }
    if (status === 402 || /insufficient|billing|payment required|out of credit|no credit/i.test(raw)) {
      return out('no_credit', 'Your ' + L + ' account is out of credit.',
        'Top up the account with the provider, then try again.');
    }
    if (status === 503 || status === 502 || status === 500 || /service unavailable|internal server error|over capacity|temporarily unavailable/i.test(raw)) {
      return out('provider_down', L + ' is having trouble on its end right now.',
        'This is not your setup — wait a few minutes and try again.');
    }

    // --- the audio ---------------------------------------------------------
    if (status === 413 || /too large|payload too large|exceeds maximum|file size/i.test(raw)) {
      return out('too_large', 'The audio was too big for one request to ' + L + '.',
        'Trim the clip, or transcribe a shorter section and repeat.');
    }
    if (/no speech|returned no words|empty transcript|no audio|could not detect/i.test(raw)) {
      return out('no_speech', L + ' heard no speech in that clip.',
        'Click the clip that actually carries the sound — the video with the voice, or the audio clip on an A track.');
    }
    if (status === 415 || /unsupported (media|format)|invalid (audio|file|format)|could not decode/i.test(raw)) {
      return out('bad_audio', L + ' could not read that audio format.',
        'Try again — Pulse converts the audio itself, so this usually means the source clip is damaged or offline.');
    }

    // --- anything else -----------------------------------------------------
    if (raw) {
      return out('unknown', L + ' refused the request.',
        'Try again. If it keeps happening, tap 🩺 Run full diagnostic in Settings and send the result.');
    }
    return out('unknown', L + ' failed for an unknown reason.',
      'Try again, then tap 🩺 Run full diagnostic in Settings and send the result.');
  }

  /* One line for a toast: message + action. The raw provider text stays on the
     Error object's .cpDetail so diagnostics keep it. */
  function toMessage(provider, info) {
    var c = classify(provider, info);
    return c.action ? (c.message + ' ' + c.action) : c.message;
  }
  /* Build the Error the call sites reject with, carrying the classification. */
  function toError(provider, info) {
    var c = classify(provider, info);
    var e = new Error(c.action ? (c.message + ' ' + c.action) : c.message);
    e.cpKind = c.kind; e.cpProvider = c.provider; e.cpDetail = c.detail;
    return e;
  }

  return { classify: classify, toMessage: toMessage, toError: toError, KINDS: [
    'network', 'request_failed', 'bad_key', 'model_gone', 'rate_limit', 'no_credit',
    'provider_down', 'too_large', 'no_speech', 'bad_audio', 'unknown'
  ] };
});
