/*
 * captions-messy-timing.js — speech-to-text timing that overlaps never makes
 * a caption that ends before it starts.
 *
 * Found by a stress run over thousands of generated transcripts: a repeated
 * word heard twice ("आज आज") whose second stamp starts a little before the
 * first one ends, or words that come back slightly out of order, made the
 * caption builders take the first word's start and the last word's end — a
 * caption from 50.80 s to 50.69 s, which Premiere drops or flashes. Each
 * caption must span its words: earliest start to latest end.
 *   A. regroupWords (the transcript placer, legacy grouping) on overlapping cues;
 *   B. regroupWords with sentence grouping (caption flows);
 *   C. wordsToCues (Deepgram / AssemblyAI words → lines);
 *   D. sentenceCues (a short's captions);
 *   E. well-ordered words come out exactly as before.
 */
'use strict';
const path = require('path');
const J = path.join(__dirname, '..', '..', 'js');
const C = require(path.join(J, 'captions.js'));
const VB = require(path.join(J, 'verbatim.js'));
const SH = require(path.join(J, 'shorts.js'));

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
const inverted = (cs) => (cs || []).filter(c => c.end < c.start - 1e-9);
const show = (cs) => JSON.stringify((cs || []).map(c => [+c.start.toFixed(3), +c.end.toFixed(3), c.text]));

console.log('⏱️ Messy speech timing: every caption spans its words');
// the stress run's case: "आज" heard twice, the second stamp a little early
const ws = [{ start: 50.07, end: 50.26, text: 'x' }, { start: 50.40, end: 50.64, text: 'बात' },
            { start: 50.71, end: 50.96, text: 'आज' }, { start: 50.61, end: 51.16, text: 'आज' },
            { start: 51.24, end: 51.36, text: 'फिर' }, { start: 51.43, end: 52.02, text: 'कल.' }];
const asCues = (list, k) => { const out = []; for (let i = 0; i < list.length; i += k) { const g = list.slice(i, i + k); out.push({ start: Math.min(...g.map(w => w.start)), end: Math.max(...g.map(w => w.end)), text: g.map(w => w.text).join(' '), words: g.map(w => Object.assign({ word: w.text }, w)) }); } return out; };

// A / B: two lines whose times overlap (the second starts before the first
// ends) — the last word of one and the first of the next share a caption
const overlap = [{ start: 50, end: 51, text: 'a b c d e f g h आज' }, { start: 50.61, end: 52, text: 'आज x y z w' }];
let worstA = null, worstB = null;
for (let per = 1; per <= 4; per++) {
  const a = C.regroupWords(overlap, per, {});
  const b = C.regroupWords(overlap, per, { sentenceBreak: true, maxChars: 30 });
  if (inverted(a).length && !worstA) worstA = 'per=' + per + ' ' + show(inverted(a));
  if (inverted(b).length && !worstB) worstB = 'per=' + per + ' ' + show(inverted(b));
}
for (let k = 1; k <= 3; k++) for (let per = 1; per <= 4; per++) {
  if (!worstA && inverted(C.regroupWords(asCues(ws, k), per, {})).length) worstA = 'k=' + k + ' per=' + per;
}
const tight = [{ start: 1.0, end: 1.6, text: 'na' }, { start: 1.1, end: 1.3, text: 'na' }];
(worstA ? bad : ok)('A. regroupWords: no caption ends before it starts' + (worstA ? ' — ' + worstA : ''));
(worstB ? bad : ok)('B. regroupWords (sentence grouping): no caption ends before it starts' + (worstB ? ' — ' + worstB : ''));

// C / D: word lists with a late stamp and a nested repeat
for (const [name, fn] of [['C. wordsToCues', (w) => VB.wordsToCues(w, 0.7)], ['D. sentenceCues', (w) => SH.sentenceCues(w)]]) {
  const outs = [fn(ws), fn(tight), fn([{ start: 3.2, end: 3.5, text: 'late' }, { start: 2.9, end: 3.1, text: 'early.' }])];
  const inv = outs.map(inverted).filter(x => x.length);
  const covers = outs[1].length === 1 && outs[1][0].start === 1.0 && outs[1][0].end === 1.6;
  (!inv.length && covers ? ok : bad)(name + ': each caption spans its words (' + outs.map(show).join(' · ') + ')');
}

// E: tidy words are untouched
const tidy = [{ start: 0, end: 0.4, text: 'so' }, { start: 0.45, end: 0.9, text: 'today' }, { start: 1.0, end: 1.5, text: 'we.' }, { start: 3, end: 3.4, text: 'go' }];
const e1 = VB.wordsToCues(tidy, 0.7), e2 = SH.sentenceCues(tidy), e3 = C.regroupWords(asCues(tidy, 1), 2, {});
(show(e1) === '[[0,1.5,"so today we."],[3,3.4,"go"]]' && show(e2) === show(e1) && show(e3) === '[[0,0.9,"so today"],[1,3.4,"we. go"]]' ? ok : bad)(
  'E. well-ordered words come out as before (' + show(e1) + ' · ' + show(e3) + ')');

if (failed) { console.log('MESSY TIMING: ' + failed + ' failed'); process.exit(1); }
console.log('MESSY TIMING: every caption spans its words ✓');
