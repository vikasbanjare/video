/*
 * The words the owner should never have to read — the names of the tools
 * under the hood — shared by the plain-words gates (test/gates/ui-*.js).
 *
 *   JARGON        [name, regex] pairs
 *   hits(text)    the jargon names found in text. A web address the owner
 *                 must visit (console.groq.com/keys) is not jargon, and a term
 *                 said in plain words first with its name in brackets
 *                 ("word-for-word (Verbatim)") is explained, not jargon.
 */
'use strict';

const JARGON = [
  ['ffmpeg', /ffmpeg/i], ['libass', /libass/i], ['mogrt', /mogrt/i], ['overlay', /overlay/i], ['PNG', /\bPNG\b/i],
  ['ASS', /\bASS\b/], ['QE', /\bQE\b/], ['Groq', /groq/i], ['Deepgram', /deepgram/i], ['AssemblyAI', /assembly ?ai/i],
  ['API', /\bAPI\b/], ['nova-3', /nova-?3/i], ['whisper', /whisper/i], ['large-v3', /large-v3/i], ['Flux', /\bflux\b/i],
  ['TF-IDF', /tf-?idf/i], ['keyframe', /keyframe/i], ['brew', /\bbrew\b|homebrew/i], ['dB', /\bdB\b/], ['ripple', /ripple/i],
  ['verbatim', /verbatim/i], ['safe copy', /safe copy/i], ['cut in place', /cut in place/i],
  ['Essential Graphics', /essential graphics/i], ['drop-frame', /drop-?frame/i], ['timecode', /timecode/i],
  ['CEP', /\bCEP\b/], ['ExtendScript', /extendscript/i], ['JSX', /\bJSX\b/], ['codec', /\bcodec/i], ['JSON', /\bJSON\b/i]
];
const URLISH = /\S*(?:\.com|\.io|\.ai|:\/\/|www\.)\S*/gi;
const GLOSSED = /word-for-word \(verbatim\)/gi;
function hits(t) {
  const s = String(t || '').replace(URLISH, ' ').replace(GLOSSED, ' ');
  return JARGON.filter(([, re]) => re.test(s)).map(([n]) => n);
}

module.exports = { JARGON, hits };
