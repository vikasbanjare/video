/*
 * captions-transcript-text.js — the small text rules between the speech
 * engine and the captions keep what was really said.
 *
 * What the owner sees:
 *   1. a short line said twice ("Haan." "Haan.", "No no.") stays two lines —
 *      it used to be merged into one when the second came within 0.3 s; a
 *      long line repeated end to end (whisper's repetition glitch) and two
 *      copies of a line at the same moment are still merged;
 *   2. Deepgram is always asked for "um"/"uh" (the stored transcript stays
 *      word for word: Clean up and the retake finder need them; captions
 *      leave them out themselves — see captions-transcript-timing);
 *   3. Hindi words are weighed by their syllables (counted from the vowel
 *      signs) when the highlight timing is shaped, so a long Hindi word gets
 *      more time than a short one — every Devanagari word used to count 1.
 *
 * Exit 0 = pass, 1 = fail.
 */
'use strict';
const path = require('path');
const JS = path.join(__dirname, '..', '..', 'js');
const CPCaptions = require(path.join(JS, 'captions.js'));
const CPVerbatim = require(path.join(JS, 'verbatim.js'));
const CPAlign = require(path.join(JS, 'align.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); }
}

console.log('captions: transcript text rules keep what was said');

// 1 — repeated lines
{
  const haan = CPCaptions.dedupeRepeatedCues([
    { start: 1.0, end: 1.3, text: 'Haan.' }, { start: 1.5, end: 1.8, text: 'Haan.' },
    { start: 2.0, end: 2.6, text: 'No no.' }, { start: 2.7, end: 3.2, text: 'No no.' }]);
  check('a short line said twice in a row stays two lines (Haan. / Haan., No no. / No no.)', haan.length === 4, JSON.stringify(haan));
  const hindi = CPCaptions.dedupeRepeatedCues([{ start: 4.0, end: 4.4, text: 'हाँ जी' }, { start: 4.6, end: 5.0, text: 'हाँ जी' }]);
  check('…in Devanagari too (हाँ जी / हाँ जी)', hindi.length === 2, JSON.stringify(hindi));
  const same = CPCaptions.dedupeRepeatedCues([{ start: 1.0, end: 1.3, text: 'Haan.' }, { start: 1.02, end: 1.32, text: 'Haan.' }]);
  check('two copies of a short line at the same moment are still one', same.length === 1, JSON.stringify(same));
  const glitch = CPCaptions.dedupeRepeatedCues([{ start: 5, end: 6.5, text: 'thank you so much for watching' }, { start: 6.6, end: 8, text: 'thank you so much for watching' }]);
  check('a long line repeated end to end (the repetition glitch) is still merged', glitch.length === 1, JSON.stringify(glitch));
}

// 2 — Deepgram fillers
{
  const tr = CPVerbatim.deepgramUrl({ language: 'hi' });
  const ret = CPVerbatim.deepgramUrl({ language: 'hi', diarize: true });
  check('transcribing asks Deepgram for every word, fillers included', /filler_words=true/.test(tr) && !/filler_words=false/.test(tr), tr);
  check('the retake finder still asks for them', /filler_words=true/.test(ret), ret);
}

// 3 — Hindi syllables
{
  const n = (w) => CPAlign.syllableCount(w);
  const cases = [['कमल', 2], ['बहुत', 2], ['अच्छा', 2], ['लेकिन', 2], ['क्योंकि', 2], ['है', 1], ['की', 1], ['मैं', 1], ['सुनाता', 3], ['प्रोडक्ट', 2]];
  const bad = cases.filter(c => n(c[0]) !== c[1]).map(c => c[0] + '=' + n(c[0]) + ' (want ' + c[1] + ')');
  check('Devanagari syllables come from the vowel signs (कमल 2, सुनाता 3, है 1 …)', bad.length === 0, bad.join(', '));
  check('a long Hindi word weighs more than a short one (सुनाता > है)', n('सुनाता') > n('है'));
  check('English counting is unchanged (podcast 2, entrepreneurship 5)', n('podcast') === 2 && n('entrepreneurship') === 5);
  // the shape pass inside one run of speech gives the long word more time
  const ws = [{ text: 'है', start: 0, end: 0.5 }, { text: 'सुनाता', start: 0.5, end: 1.0 }];
  const r = CPAlign.refineWords(ws, [], { blend: 0.5 });
  const d = r.map(w => w.end - w.start);
  check('the timing shape gives "सुनाता" more time than "है"', d[1] > d[0] + 0.05, JSON.stringify(r));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
