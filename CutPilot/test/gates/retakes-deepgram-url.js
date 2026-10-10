/*
 * retakes-deepgram-url.js — what the verbatim / Deepgram request builders send
 * for EVERY language the panel's picker offers.
 *
 * Deepgram and AssemblyAI do not auto-detect when no language is sent: they
 * transcribe as English. For this owner (Hindi / Hinglish) that turned speech
 * into English-sounding gibberish. Auto-detect and Hinglish must go to nova-3's
 * multilingual code-switching model (language=multi); an explicit pick is sent
 * as is. Speaker labels come back on every word so the retake finder can tell
 * host from guest. Exit 0 = pass, 1 = fail.
 */
'use strict';
const path = require('path');
const V = require(path.join(__dirname, '..', '..', 'js', 'verbatim.js'));

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const lang = u => (/[?&]language=([^&]+)/.exec(u) || [])[1] || null;

console.log('Deepgram URL for each language choice');
// the panel's WHISPER_LANGS (main.js) — every value a user can pick
const PICKS = { auto: 'multi', hinglish: 'multi', hi: 'hi', en: 'en', es: 'es', fr: 'fr', de: 'de', pt: 'pt', it: 'it',
  ru: 'ru', ja: 'ja', zh: 'zh', ar: 'ar', ko: 'ko', id: 'id', tr: 'tr', nl: 'nl', pl: 'pl', uk: 'uk' };
Object.keys(PICKS).forEach(k => {
  const u = V.deepgramUrl({ language: k });
  check('"' + k + '" → language=' + PICKS[k], lang(u) === PICKS[k], u);
});
check('Sarvam-style "hi-IN" → language=hi', lang(V.deepgramUrl({ language: 'hi-IN' })) === 'hi', V.deepgramUrl({ language: 'hi-IN' }));
check('the verbatim flags stay on (nova-3, filler_words, punctuation)', /model=nova-3/.test(V.deepgramUrl({ language: 'hi' })) && /filler_words=true/.test(V.deepgramUrl({ language: 'hi' })));
check('diarize=true is sent when asked for (speaker labels for the retake finder)', /[?&]diarize=true/.test(V.deepgramUrl({ language: 'auto', diarize: true })));

console.log('AssemblyAI submit body for each language choice');
{
  const b = l => V.assemblySubmitBody('https://cdn/x', { language: l, speakerLabels: true });
  check('Hindi → language_code "hi"', b('hi').language_code === 'hi', JSON.stringify(b('hi')));
  check('Hinglish → language_code "hi" (AssemblyAI has no Hinglish code)', b('hinglish').language_code === 'hi', JSON.stringify(b('hinglish')));
  check('Auto-detect → language_detection (not the English default)', b('auto').language_detection === true && !b('auto').language_code, JSON.stringify(b('auto')));
  check('English → language_code "en"', b('en').language_code === 'en', JSON.stringify(b('en')));
  check('speaker labels requested', b('hi').speaker_labels === true);
  check('disfluencies can be switched off for a retry', V.assemblySubmitBody('u', { language: 'hi', disfluencies: false }).disfluencies === false);
}

console.log('speaker labels survive parsing');
{
  const dg = V.parseDeepgram({ results: { channels: [{ alternatives: [{ words: [
    { word: 'aapne', punctuated_word: 'Aapne', start: 0, end: 0.3, confidence: 0.9, speaker: 0 },
    { word: 'maine', punctuated_word: 'Maine', start: 1, end: 1.3, confidence: 0.9, speaker: 1 }] }] }] } });
  check('Deepgram words carry their speaker', dg.length === 2 && dg[0].speaker === 0 && dg[1].speaker === 1, JSON.stringify(dg));
  const aa = V.parseAssembly({ words: [{ text: 'Namaste', start: 0, end: 400, confidence: 0.9, speaker: 'A' }] });
  check('AssemblyAI words carry their speaker', aa.length === 1 && aa[0].speaker === 'A', JSON.stringify(aa));
  const cues = V.wordsToCues([{ text: 'मैं', start: 0, end: 0.2 }, { text: 'ठीक', start: 0.2, end: 0.4 }, { text: 'हूँ।', start: 0.4, end: 0.6 },
    { text: 'तुम', start: 0.6, end: 0.8 }, { text: 'कैसे', start: 0.8, end: 1 }, { text: 'हो।', start: 1, end: 1.2 }]);
  check('verbatim words → cues split at the Hindi full stop "।"', cues.length === 2 && cues[0].text === 'मैं ठीक हूँ।', JSON.stringify(cues));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
