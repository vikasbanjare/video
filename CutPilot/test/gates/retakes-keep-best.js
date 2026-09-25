/*
 * retakes-keep-best.js — "Keep the last complete take" keeps a final take that
 * is deliberately SHORTER but finished.
 *
 * keep:'best' (Find's default) walked back from the last take and kept the
 * first one with at least 75% of the fullest take's words — whether or not
 * it was a finished sentence. So a speaker who tightened the line on the
 * last try lost the tight version:
 *   "So the secret to growing on Instagram is posting consistency every
 *    single day."  →  "The secret to growing on Instagram is consistency."
 * deleted the concise final take and kept the long one.
 *
 * Now a shorter final take counts as complete when it ends in a sentence
 * mark, has at least half the words, does not end on a word no line can end
 * on ("…is.", "…to."), is not simply the fullest take cut off ("So the secret
 * to growing on Instagram is posting." — Whisper puts a full stop on
 * fragments too), and
 * ends on a word the fullest take also says.
 *
 * Checked (Node, pure) at the Find defaults (Balanced, keep best):
 *   1. English, Hinglish and Devanagari: the concise finished final take is
 *      kept and the long first take is cut;
 *   2. still cut, the full take kept: a final take that is the full one cut
 *      off with a full stop, one ending "…is.", one trailing off "…", one
 *      ending on a new word the full take never says.
 *
 * Exit 0 = pass, 1 = fail.
 */
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'js', 'takes.js'));

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
/* 0.3 s words, 0.36 s apart, 0.8 s between lines */
function stream(lines) {
  const out = []; let t = 0.3;
  lines.forEach((l) => { l.split(' ').forEach((w) => { out.push({ text: w, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3) }); t += 0.36; }); t += 0.8; });
  return out;
}
const run = (lines) => T.findRepeatedTakes(stream(lines), { minRun: 3, sim: 0.6, keep: 'best' }).deletes.map(d => d.text);

console.log('keep the last complete take: a shorter, finished final take');
const KEEP_SHORT = {
  English: ['So the secret to growing on Instagram is posting consistency every single day.', 'The secret to growing on Instagram is consistency.', 'Let me show you how.'],
  Hinglish: ['Toh instagram pe grow karne ka secret hai roz consistency rakhna.', 'Instagram pe grow karne ka secret hai consistency.', 'Chalo dekhte hain kaise.'],
  Devanagari: ['तो इंस्टाग्राम पे ग्रो करने का सीक्रेट है रोज़ कंसिस्टेंसी रखना।', 'इंस्टाग्राम पे ग्रो करने का सीक्रेट है कंसिस्टेंसी।', 'चलो देखते हैं कैसे।']
};
for (const k of Object.keys(KEEP_SHORT)) {
  const d = run(KEEP_SHORT[k]);
  check(k + ': the concise finished final take is kept, the long first take is cut', d.length === 1 && d[0] === KEEP_SHORT[k][0], JSON.stringify(d));
}

console.log('…but a take that only LOOKS finished is still cut');
const FULL = 'So the secret to growing on Instagram is posting consistency every single day.';
// (each is close enough to the full take to be linked with it as a retake)
const STILL_CUT = {
  'the full take cut off, with a full stop': 'So the secret to growing on Instagram is posting.',
  'ending on a word no line ends on ("…is.")': 'So the secret to growing on Instagram is.',
  'trailing off ("…")': 'The secret to growing on Instagram is posting…',
  'ending on a word the full take never says': 'So the secret to growing on Instagram is patience.'
};
for (const k of Object.keys(STILL_CUT)) {
  const d = run([FULL, STILL_CUT[k], 'Let me show you how.']);
  check(k + ': the final take is cut, the full take kept', d.length === 1 && d[0] === STILL_CUT[k], JSON.stringify(d));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
